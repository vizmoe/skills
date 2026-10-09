#!/usr/bin/env python3
"""Read-only music library preflights. Python 3.10+, standard library only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import sys
import unicodedata

from music_rules import RuleError, check_tags, inspect_cover, read_whitelist, render_path, sanitize_component


class GuardError(ValueError):
    def __init__(self, code: str, path: str, detail: str):
        super().__init__(detail)
        self.issue = {"code": code, "path": path, "detail": detail}


def root_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise GuardError("INVALID_ROOT", str(path), "Use an explicit absolute directory.")
    if path.is_symlink():
        raise GuardError("INVALID_ROOT", str(path), f"Pass the resolved real path as --root: {path.resolve()}")
    path = path.resolve(strict=True)
    if not path.is_dir():
        raise GuardError("INVALID_ROOT", str(path), "Root must be a directory.")
    return path


def parts(value: str) -> tuple[str, ...]:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise GuardError("INVALID_PATH", str(value), "Expected a nonempty relative path.")
    result = tuple(value.split("/"))
    if (PureWindowsPath(value).drive or "\\" in value
            or any(p in {"", ".", ".."} for p in result)):
        raise GuardError("PATH_ESCAPE", value, "Use POSIX relative paths without dot segments or drive names.")
    return result


def collision_key(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def protected_roots(state_dirs: list[str] | None = None) -> tuple[tuple[str, ...], ...]:
    return tuple(dict.fromkeys(tuple(collision_key(p) for p in parts(s)) for s in [".musagetes", *(state_dirs or [])]))


def is_protected(value: str, state_dirs: list[str] | None = None) -> bool:
    key = tuple(collision_key(p) for p in parts(value))
    return any(key[:len(state)] == state for state in protected_roots(state_dirs))


def reject_state_path(value: str, state_dirs: list[str] | None = None) -> None:
    if is_protected(value, state_dirs):
        raise GuardError("PROTECTED_STATE", value, "Music sources and targets must stay outside protected state directories.")


def source_path(root: Path, value: str) -> Path:
    components = parts(value)
    current = root
    for i, component in enumerate(components):
        current = current / component
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise GuardError("SYMLINK", value, "Source or ancestor is a symlink; leave it unchanged.")
        if i < len(components) - 1 and not stat.S_ISDIR(info.st_mode):
            raise GuardError("NOT_DIRECTORY", value, "A source ancestor is not a directory.")
    if not stat.S_ISREG(info.st_mode):
        raise GuardError("NOT_REGULAR", value, "Source must be a regular file.")
    if info.st_nlink > 1:
        raise GuardError("HARDLINK", value, "Source has multiple hard links; review its ownership first.")
    return current


def fingerprint(path: Path) -> str:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise GuardError("NOT_REGULAR", str(path), "Hashing only supports regular files.")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    digest = hashlib.sha256()
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise GuardError("SOURCE_CHANGED", str(path), "File changed before hashing.")
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
        after = os.fstat(stream.fileno())
    signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if signature(before) != signature(after) or signature(after) != signature(path.lstat()):
        raise GuardError("SOURCE_CHANGED", str(path), "File changed during hashing; rescan it.")
    return digest.hexdigest()


def hint(path: Path) -> str:
    extension = path.suffix.lower()
    groups = {
        "audio_candidate": {".flac", ".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".ape", ".ogg", ".opus", ".wma", ".dsf", ".dff", ".wv", ".ac3", ".shn", ".tta", ".tak", ".mpc"},
        "archive": {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"},
        "cue": {".cue"},
        "image": {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"},
        "video_or_disc_image": {".mp4", ".mkv", ".iso", ".bin", ".mds", ".mdf", ".vob", ".bdmv", ".m2ts"},
    }
    return next((label for label, extensions in groups.items() if extension in extensions), "other")


def inventory(root: Path, with_hash: bool = False, state_dirs: list[str] | None = None, include_state: bool = False) -> dict:
    protected_roots(state_dirs)
    records, issues = [], []
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            # Recheck queued directories so replaced symlinks are not intentionally followed.
            if not stat.S_ISDIR(directory.lstat().st_mode):
                raise GuardError("DIRECTORY_CHANGED", str(directory), "Directory changed during inventory.")
            with os.scandir(directory) as scan:
                entries = sorted(scan, key=lambda e: e.name)
            for entry in entries:
                path = directory / entry.name
                rel = path.relative_to(root).as_posix()
                try:
                    info = path.lstat()
                    record = {"path": rel, "size": info.st_size, "mtime_ns": info.st_mtime_ns}
                    protected = is_protected(rel, state_dirs)
                    if protected:
                        record.update(protected_state=True, disposition="SKIPPED")
                        if not include_state:
                            record.update(kind="state_boundary", contents_scanned=False)
                            records.append(record)
                            continue
                    if stat.S_ISLNK(info.st_mode):
                        record.update(kind="symlink", target=os.readlink(path), disposition="SKIPPED")
                    elif stat.S_ISDIR(info.st_mode):
                        record["kind"] = "directory"
                        pending.append(path)
                    elif stat.S_ISREG(info.st_mode):
                        record.update(kind="file", hint="state_artifact" if protected else hint(path), links=info.st_nlink)
                        if info.st_nlink > 1:
                            record["disposition"] = "REVIEW_REQUIRED"
                        if with_hash:
                            record["sha256"] = fingerprint(path)
                    else:
                        record.update(kind="special", disposition="REVIEW_REQUIRED")
                    records.append(record)
                except (OSError, GuardError) as error:
                    issues.append(error.issue if isinstance(error, GuardError) else {"code": "READ_ERROR", "path": rel, "detail": str(error)})
        except (OSError, GuardError) as error:
            issues.append(error.issue if isinstance(error, GuardError) else {"code": "READ_ERROR", "path": str(directory), "detail": str(error)})
    return {
        "schema_version": 1, "root": str(root), "ok": not issues,
        "classification": "Extension hints only; music type and codec remain unverified.",
        "tools": {name: shutil.which(name) for name in ("ffprobe", "ffmpeg", "flac", "metaflac", "kid3-cli", "shntool", "mac", "beet", "7z", "unzip", "bsdtar", "unrar", "iconv")},
        "protected_state_dirs": [".musagetes", *(state_dirs or [])],
        "files": sorted(records, key=lambda r: r["path"]), "issues": issues,
    }


def fs_limit(root: Path, name: str, fallback: int) -> int:
    try:
        result = os.pathconf(root, name)
        return result if result > 0 else fallback
    except (AttributeError, OSError, ValueError):
        return fallback


def validate_target_name(root: Path, value: str) -> tuple[str, ...]:
    components = parts(value)
    for component in components:
        try:
            normalized = sanitize_component(component)
        except RuleError:
            normalized = None
        if normalized != component:
            raise GuardError("INVALID_TARGET_NAME", value, "Apply paths.md display and filename rules first.")
        if len(os.fsencode(component)) > fs_limit(root, "PC_NAME_MAX", 255):
            raise GuardError("NAME_TOO_LONG", value, "A target component is too long; do not truncate it.")
    if len(os.fsencode(str(root.joinpath(*components)))) >= fs_limit(root, "PC_PATH_MAX", 4096):
        raise GuardError("PATH_TOO_LONG", value, "Target path exceeds the filesystem limit.")
    return components


def check_existing_target(root: Path, target: str, keep: bool) -> None:
    components = validate_target_name(root, target)
    current = root
    for i, component in enumerate(components):
        with os.scandir(current) as scan:
            matches = [e.name for e in scan if collision_key(e.name) == collision_key(component)]
        if not matches:
            return
        if matches != [component]:
            raise GuardError("EXISTING_ALIAS_COLLISION", target, "Existing path differs only by case or Unicode normalization.")
        current = current / component
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise GuardError("SYMLINK", target, "Target or ancestor is a symlink.")
        if i == len(components) - 1:
            if not keep:
                raise GuardError("TARGET_EXISTS", target, "Existing targets cannot be overwritten, including source files.")
        elif not stat.S_ISDIR(info.st_mode):
            raise GuardError("NOT_DIRECTORY", target, "A target ancestor is an existing file.")


def validate_plan_shape(plan: dict) -> None:
    if (not isinstance(plan, dict) or set(plan) != {"schema_version", "entries"}
            or type(plan.get("schema_version")) is not int or plan["schema_version"] != 1
            or not isinstance(plan.get("entries"), list) or not plan["entries"]):
        raise GuardError("INVALID_PLAN", "", "Expected schema_version 1 and a nonempty entries list, with no other keys.")
    for index, entry in enumerate(plan["entries"]):
        required = {"source", "target", "source_sha256", "operation"}
        if not isinstance(entry, dict) or set(entry) != required or any(not isinstance(v, str) for v in entry.values()):
            raise GuardError("INVALID_PLAN", str(index), "Entry must contain source, target, source_sha256 and operation strings only.")
        if entry["operation"] not in {"create", "keep"} or not re.fullmatch(r"[0-9a-fA-F]{64}", entry["source_sha256"]):
            raise GuardError("INVALID_PLAN", str(index), "Invalid operation or SHA-256.")


def check_paths(root: Path, plan: dict, state_dirs: list[str] | None = None) -> dict:
    protected_roots(state_dirs)
    validate_plan_shape(plan)
    issues, targets, spellings = [], {}, {}
    for index, entry in enumerate(plan["entries"]):
        try:
            reject_state_path(entry["source"], state_dirs)
            reject_state_path(entry["target"], state_dirs)
            source = source_path(root, entry["source"])
            if fingerprint(source) != entry["source_sha256"].lower():
                raise GuardError("SOURCE_CHANGED", entry["source"], "Source SHA-256 differs from the reviewed snapshot.")
            keep = entry["operation"] == "keep"
            if keep and entry["source"] != entry["target"]:
                raise GuardError("INVALID_KEEP", entry["target"], "keep requires identical source and target paths.")
            components = validate_target_name(root, entry["target"])
            key = tuple(collision_key(c) for c in components)
            if key in targets:
                raise GuardError("PLAN_COLLISION", entry["target"], "Multiple entries address the same normalized target.")
            for i in range(1, len(key) + 1):
                prefix, spelling = key[:i], components[:i]
                if prefix in spellings and spellings[prefix] != spelling:
                    raise GuardError("PLAN_ALIAS_COLLISION", entry["target"], "Planned path components differ only by case or Unicode normalization.")
                spellings[prefix] = spelling
            targets[key] = entry["target"]
            check_existing_target(root, entry["target"], keep)
        except (OSError, GuardError) as error:
            issue = error.issue if isinstance(error, GuardError) else {"code": "FILESYSTEM_ERROR", "path": entry["source"], "detail": str(error)}
            issues.append({"entry": index, **issue})
    for key, target in targets.items():
        if any(key[:i] in targets for i in range(1, len(key))):
            issues.append({"code": "PLAN_FILE_DIRECTORY_COLLISION", "path": target, "detail": "A planned file is also used as a parent directory."})
    return {"schema_version": 1, "root": str(root), "ok": not issues, "checked": len(plan["entries"]), "scope": "paths_only", "issues": issues}


def unique_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise GuardError("INVALID_PLAN", key, "Duplicate JSON keys are not accepted.")
        result[key] = value
    return result


def skill_version() -> str:
    text = (Path(__file__).resolve().parent.parent / "SKILL.md").read_text(encoding="utf-8")
    front = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
    metadata = re.search(r'(?m)^metadata:\n((?:  [^\n]+(?:\n|$))+)', front[1]) if front else None
    match = re.search(r'(?m)^  version: "([0-9]+\.[0-9]+\.[0-9]+)"$', metadata[1]) if metadata else None
    if not match:
        raise GuardError("INVALID_SKILL_VERSION", "SKILL.md", "Expected metadata.version as a quoted semantic version.")
    return match[1]


def directory_entries(root: Path, relative: str) -> list[Path]:
    current = root
    for component in parts(relative):
        current = current / component
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise GuardError("INVALID_HISTORY_DIRECTORY", relative, "History directories must be real directories, never symlinks.")
    return sorted(current.iterdir(), key=lambda p: p.name)


def actual_state_roots(root: Path, state_dirs: list[str] | None) -> tuple[list[str], list[dict]]:
    result, issues = [], []
    for components in protected_roots(state_dirs):
        current = root
        for component in components:
            matches = [p for p in current.iterdir() if collision_key(p.name) == component]
            if not matches:
                break
            if len(matches) != 1 or not stat.S_ISDIR(matches[0].lstat().st_mode):
                issues.append({"code": "INVALID_STATE_DIRECTORY", "path": str(current / component), "detail": "State path is ambiguous, linked or not a directory; it was not traversed."})
                break
            current = matches[0]
        else:
            result.append(current.relative_to(root).as_posix())
    return list(dict.fromkeys(result)), issues


def validate_event(event: dict, root: Path, run_id: str, album_id: str, filename: str, state_dirs: list[str] | None) -> None:
    required = {"schema_version", "root", "run_id", "album_id", "sequence", "skill_version", "phase", "status", "match_status", "expected_files", "removed_paths"}
    if not isinstance(event, dict) or set(event) not in (required, required | {"details"}):
        raise GuardError("INVALID_HISTORY", filename, "Event fields do not match the documented schema.")
    sequence = event["sequence"]
    if (type(event["schema_version"]) is not int or event["schema_version"] != 1
            or event["root"] != str(root) or event["run_id"] != run_id or event["album_id"] != album_id
            or type(sequence) is not int or sequence < 1 or filename != f"{sequence:06d}.json"
            or not isinstance(event["skill_version"], str) or not event["skill_version"]
            or event["phase"] not in ("PLANNED", "STAGED", "VERIFIED", "COMMITTED", "FINALIZED")
            or event["status"] not in (None, "COMPLETED", "SKIPPED", "REVIEW_REQUIRED", "FAILED")
            or event["match_status"] not in ("FULL", "PARTIAL_MATCH", "UNCONFIRMED")
            or not isinstance(event["expected_files"], list) or not event["expected_files"]
            or not isinstance(event["removed_paths"], list)
            or ("details" in event and not isinstance(event["details"], dict))):
        raise GuardError("INVALID_HISTORY", filename, "Invalid event identity, phase, status or file manifest.")
    seen = set()
    outputs = 0
    for entry in event["expected_files"]:
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256", "role"}
                or entry["role"] not in ("source", "output", "preserved", "staging")
                or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])):
            raise GuardError("INVALID_HISTORY", filename, "Invalid expected_files entry.")
        key = tuple(collision_key(p) for p in parts(entry["path"]))
        if key in seen:
            raise GuardError("INVALID_HISTORY", entry["path"], "Duplicate or aliased expected path.")
        seen.add(key)
        if entry["role"] in ("source", "output"):
            reject_state_path(entry["path"], state_dirs)
        if entry["role"] == "output":
            outputs += 1
    for removed in event["removed_paths"]:
        key = tuple(collision_key(p) for p in parts(removed))
        if key in seen:
            raise GuardError("INVALID_HISTORY", removed, "Removed path duplicates an expected or removed path.")
        seen.add(key)
    if event["status"] == "COMPLETED" and (event["phase"] != "FINALIZED" or not outputs):
        raise GuardError("INVALID_HISTORY", filename, "COMPLETED requires FINALIZED and verified output manifest entries.")


def check_event_files(root: Path, event: dict) -> list[dict]:
    issues = []
    for item in event["expected_files"]:
        try:
            if fingerprint(source_path(root, item["path"])) != item["sha256"]:
                raise GuardError("HISTORY_FILE_CHANGED", item["path"], "Recorded SHA-256 differs from the current file.")
        except (OSError, GuardError) as error:
            issues.append(error.issue if isinstance(error, GuardError) else {"code": "HISTORY_FILE_MISSING", "path": item["path"], "detail": str(error)})
    for relative in event["removed_paths"]:
        current = root
        try:
            for component in parts(relative):
                current = current / component
                info = current.lstat()
                if stat.S_ISLNK(info.st_mode):
                    raise GuardError("SYMLINK", relative, "Removed path now crosses a symlink.")
            issues.append({"code": "REMOVED_PATH_REAPPEARED", "path": relative})
        except FileNotFoundError:
            pass
        except (OSError, GuardError) as error:
            issues.append(error.issue if isinstance(error, GuardError) else {"code": "HISTORY_PATH_ERROR", "path": relative, "detail": str(error)})
    return issues


def history(root: Path, state_dirs: list[str] | None = None) -> dict:
    """Rebuild a cross-run view from immutable per-album snapshots; never write state."""
    version = skill_version()
    issues, albums = [], {}
    try:
        states, state_issues = actual_state_roots(root, state_dirs)
        issues.extend(state_issues)
        for state in states:
            state_entries = directory_entries(root, state)
            if not state_entries:
                continue
            runs_rel = f"{state}/runs"
            if not any(p.name == "runs" for p in state_entries):
                issues.append({"code": "UNRECOGNIZED_HISTORY", "path": state, "detail": "State data has no runs directory; review or migrate existing records."})
                continue
            for run in directory_entries(root, runs_rel):
                run_rel = run.relative_to(root).as_posix()
                try:
                    run_entries = directory_entries(root, run_rel)
                    if not any(p.name == "albums" for p in run_entries):
                        raise GuardError("UNRECOGNIZED_HISTORY", run_rel, "Run has no canonical albums directory; explicitly review legacy or interrupted setup.")
                    for album in directory_entries(root, f"{run_rel}/albums"):
                        album_rel = album.relative_to(root).as_posix()
                        view = albums.setdefault(album.name, {"album_id": album.name, "records": [], "issues": []})
                        try:
                            for identity in (run.name, album.name):
                                if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", identity):
                                    raise GuardError("INVALID_HISTORY", album_rel, "Run and album IDs must be opaque ASCII identifiers of 1–64 characters.")
                            events = directory_entries(root, f"{album_rel}/events")
                            if not events:
                                raise GuardError("INVALID_HISTORY", album_rel, "Album has no event snapshots.")
                            for event_path in events:
                                rel = event_path.relative_to(root).as_posix()
                                file = source_path(root, rel)
                                before = fingerprint(file)
                                event = json.loads(file.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
                                if fingerprint(file) != before:
                                    raise GuardError("HISTORY_CHANGED", rel, "History changed while it was being read.")
                                validate_event(event, root, run.name, album.name, file.name, state_dirs)
                                view["records"].append({"record_path": rel, "event": event})
                        except (OSError, ValueError) as error:
                            view["issues"].append(error.issue if isinstance(error, GuardError) else {"code": "INVALID_HISTORY", "path": album_rel, "detail": str(error)})
                except (OSError, ValueError) as error:
                    issues.append(error.issue if isinstance(error, GuardError) else {"code": "INVALID_HISTORY", "path": run_rel, "detail": str(error)})
    except (OSError, ValueError) as error:
        issues.append(error.issue if isinstance(error, GuardError) else {"code": "INVALID_HISTORY", "path": str(root), "detail": str(error)})
    results = []
    for album_id, view in sorted(albums.items()):
        records = sorted(view.pop("records"), key=lambda r: r["event"]["sequence"])
        sequences = [r["event"]["sequence"] for r in records]
        if len(sequences) != len(set(sequences)):
            view["issues"].append({"code": "DUPLICATE_SEQUENCE", "path": album_id})
        latest = records[-1] if records else None
        if latest and not view["issues"]:
            view["issues"].extend(check_event_files(root, latest["event"]))
            if latest["event"]["skill_version"] != version:
                view["issues"].append({"code": "SKILL_VERSION_CHANGED", "path": latest["record_path"], "detail": "Revalidate domain rules with the current skill before reuse."})
        valid = bool(latest) and not view["issues"] and not issues
        view.update(latest=latest, integrity_ok=valid,
                    reuse_candidate=valid and latest["event"]["status"] == "COMPLETED")
        results.append(view)
    return {"schema_version": 1, "root": str(root), "skill_version": version,
            "ok": not issues and all(a["integrity_ok"] for a in results),
            "scope": "recorded_files_only", "albums": results, "issues": issues}


def render_paths(root: Path, request: dict, state_dirs: list[str] | None = None) -> dict:
    if not isinstance(request, dict) or set(request) != {"tracks"} or not isinstance(request["tracks"], list) or not request["tracks"]:
        raise GuardError("INVALID_RENDER_INPUT", "", "Expected a nonempty tracks list.")
    entries = []
    whitelist = read_whitelist()
    for track in request["tracks"]:
        required = {"source", "source_sha256", "kind", "tags", "extension", "operation"}
        if not isinstance(track, dict) or set(track) not in (required, required | {"omissions"}):
            raise GuardError("INVALID_RENDER_INPUT", "", "Track keys must be source, source_sha256, kind, tags, extension, operation and optional omissions.")
        target = render_path(track["tags"], track["extension"], track["kind"], whitelist, omissions=track.get("omissions"))
        reject_state_path(track["source"], state_dirs)
        reject_state_path(target, state_dirs)
        validate_target_name(root, target)
        entries.append({"source": track["source"], "source_sha256": track["source_sha256"], "target": target, "operation": track["operation"]})
    result = {"schema_version": 1, "entries": entries}
    validate_plan_shape(result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scan = commands.add_parser("inventory", help="List files and tool availability without modifying files.")
    scan.add_argument("--root", required=True, help="Explicit authorized absolute root directory.")
    scan.add_argument("--hash", action="store_true", help="Include SHA-256 for regular files.")
    scan.add_argument("--include-state", action="store_true", help="Diagnostic only: include protected state artifacts without classifying them as music.")
    check = commands.add_parser("check-paths", help="Check a JSON path plan; never execute it.")
    check.add_argument("--root", required=True, help="Explicit authorized absolute root directory.")
    check.add_argument("--plan", required=True, type=Path, help="UTF-8 JSON plan path (read only).")
    resume = commands.add_parser("history", help="Enumerate prior runs and verify latest album snapshots against current files.")
    resume.add_argument("--root", required=True)
    render = commands.add_parser("render-paths", help="Render canonical final tags into a JSON plan; follow with check-paths.")
    render.add_argument("--root", required=True)
    render.add_argument("--input", required=True, type=Path)
    tags = commands.add_parser("check-tags", help="Check canonical field names, required fields and nonempty ordered values.")
    tags.add_argument("--input", required=True, type=Path)
    cover = commands.add_parser("cover-info", help="Check PNG/JPEG header dimensions and ratio; not a full image decode.")
    cover.add_argument("--root", required=True)
    cover.add_argument("--image", required=True, help="Root-relative image file; state candidates may be inspected.")
    for command in (scan, check, resume, render):
        command.add_argument("--state-dir", action="append", default=[], help="Additional protected root-relative state directory; repeat for previous locations.")
    args = parser.parse_args(argv)
    try:
        root = root_path(args.root) if hasattr(args, "root") else None
        read_json = lambda path: json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
        if args.command == "inventory":
            result = inventory(root, args.hash, args.state_dir, args.include_state)
        elif args.command == "check-paths":
            result = check_paths(root, read_json(args.plan), args.state_dir)
        elif args.command == "history":
            result = history(root, args.state_dir)
        elif args.command == "render-paths":
            result = render_paths(root, read_json(args.input), args.state_dir)
        elif args.command == "cover-info":
            result = inspect_cover(source_path(root, args.image))
        else:
            request = read_json(args.input)
            if not isinstance(request, dict) or set(request) not in ({"kind", "tags"}, {"kind", "tags", "omissions"}):
                raise GuardError("INVALID_TAG_INPUT", "", "Expected kind and tags, with optional omissions.")
            result = check_tags(request["tags"], request["kind"], omissions=request.get("omissions"))
        code = 0 if result.get("ok", True) else 1
    except (OSError, UnicodeError, ValueError) as error:
        issue = error.issue if isinstance(error, (GuardError, RuleError)) else {"code": "INPUT_ERROR", "path": "", "detail": str(error)}
        result, code = {"ok": False, "issues": [issue]}, 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
