#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "mutagen>=1.47.0",
#   "pillow>=11.0.0",
#   "PyYAML>=6.0.0",
# ]
# ///
"""Read-only music library preflights. Python 3.10+ with Pillow, mutagen, and PyYAML."""
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

import yaml

from music_rules import (RuleError, check_tags, inspect_audio, inspect_cover, read_sidecar_policy,
                         read_staging_policy, read_vocabulary, read_whitelist, render_path, sanitize_component)


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


SKILL_MD_NAME = "SKILL.md"
SEMVER_PATTERN = re.compile(r"\d+\.\d+\.\d+", re.ASCII)


def _format_issue(error: Exception, code: str, path: str) -> dict:
    return error.issue if isinstance(error, GuardError) else {"code": code, "path": path, "detail": str(error)}


def _populate_file_record(record: dict, path: Path, info: os.stat_result, protected: bool, with_hash: bool) -> None:
    record.update(kind="file", hint="state_artifact" if protected else hint(path), links=info.st_nlink)
    if info.st_nlink > 1:
        record["disposition"] = "REVIEW_REQUIRED"
    if with_hash:
        record["sha256"] = fingerprint(path)


def _inventory_entry(path: Path, rel: str, with_hash: bool, state_dirs: list[str] | None,
                     include_state: bool) -> tuple[dict, Path | None]:
    info = path.lstat()
    record: dict = {"path": rel, "size": info.st_size, "mtime_ns": info.st_mtime_ns}
    protected = is_protected(rel, state_dirs)
    if protected:
        record.update(protected_state=True, disposition="SKIPPED")
        if not include_state:
            record.update(kind="state_boundary", contents_scanned=False)
            return record, None
    if stat.S_ISLNK(info.st_mode):
        record.update(kind="symlink", target=os.readlink(path), disposition="SKIPPED")
    elif stat.S_ISDIR(info.st_mode):
        record["kind"] = "directory"
        return record, path
    elif stat.S_ISREG(info.st_mode):
        _populate_file_record(record, path, info, protected, with_hash)
    else:
        record.update(kind="special", disposition="REVIEW_REQUIRED")
    return record, None


def _scan_directory(root: Path, directory: Path, with_hash: bool, state_dirs: list[str] | None,
                    include_state: bool) -> tuple[list[dict], list[Path], list[dict]]:
    # Recheck queued directories so replaced symlinks are not intentionally followed.
    if not stat.S_ISDIR(directory.lstat().st_mode):
        raise GuardError("DIRECTORY_CHANGED", str(directory), "Directory changed during inventory.")
    with os.scandir(directory) as scan:
        entries = sorted(scan, key=lambda e: e.name)
    records, subdirs, issues = [], [], []
    for entry in entries:
        path = directory / entry.name
        rel = path.relative_to(root).as_posix()
        try:
            record, subdir = _inventory_entry(path, rel, with_hash, state_dirs, include_state)
            records.append(record)
            if subdir is not None:
                subdirs.append(subdir)
        except (OSError, GuardError) as error:
            issues.append(_format_issue(error, "READ_ERROR", rel))
    return records, subdirs, issues


def inventory(root: Path, with_hash: bool = False, state_dirs: list[str] | None = None, include_state: bool = False) -> dict:
    protected_roots(state_dirs)
    records, issues = [], []
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            dir_records, subdirs, dir_issues = _scan_directory(root, directory, with_hash, state_dirs, include_state)
            records.extend(dir_records)
            pending.extend(subdirs)
            issues.extend(dir_issues)
        except (OSError, GuardError) as error:
            issues.append(_format_issue(error, "READ_ERROR", str(directory)))
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


def _record_target_spellings(components: tuple[str, ...], key: tuple[str, ...], target: str,
                             targets: dict, spellings: dict) -> None:
    if key in targets:
        raise GuardError("PLAN_COLLISION", target, "Multiple entries address the same normalized target.")
    for i in range(1, len(key) + 1):
        prefix, spelling = key[:i], components[:i]
        if prefix in spellings and spellings[prefix] != spelling:
            raise GuardError("PLAN_ALIAS_COLLISION", target, "Planned path components differ only by case or Unicode normalization.")
        spellings[prefix] = spelling
    targets[key] = target


def _check_path_entry(root: Path, entry: dict, state_dirs: list[str] | None, targets: dict, spellings: dict) -> None:
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
    _record_target_spellings(components, key, entry["target"], targets, spellings)
    check_existing_target(root, entry["target"], keep)


def check_paths(root: Path, plan: dict, state_dirs: list[str] | None = None) -> dict:
    protected_roots(state_dirs)
    validate_plan_shape(plan)
    issues, targets, spellings = [], {}, {}
    for index, entry in enumerate(plan["entries"]):
        try:
            _check_path_entry(root, entry, state_dirs, targets, spellings)
        except (OSError, GuardError) as error:
            issue = _format_issue(error, "FILESYSTEM_ERROR", entry["source"])
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


def skill_version(skill_md: Path | None = None) -> str:
    target = skill_md or (Path(__file__).resolve().parent.parent / SKILL_MD_NAME)
    text = target.read_text(encoding="utf-8")
    front = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.S)
    if not front:
        raise GuardError("INVALID_SKILL_VERSION", SKILL_MD_NAME, "Missing YAML frontmatter in SKILL.md.")
    try:
        parsed = yaml.safe_load(front[1])
    except yaml.YAMLError as error:
        raise GuardError("INVALID_SKILL_VERSION", SKILL_MD_NAME, f"Invalid YAML frontmatter: {error}") from error
    metadata = parsed.get("metadata") if isinstance(parsed, dict) else None
    version = metadata.get("version") if isinstance(metadata, dict) else None
    if not isinstance(version, str) or not SEMVER_PATTERN.fullmatch(version):
        raise GuardError("INVALID_SKILL_VERSION", SKILL_MD_NAME, "Expected metadata.version as a quoted semantic version.")
    return version


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


def _validate_event_header(event: dict, root: Path, run_id: str, album_id: str, filename: str, vocabulary) -> None:
    required = {"schema_version", "root", "run_id", "album_id", "sequence", "skill_version", "phase", "status", "match_status", "expected_files", "removed_paths"}
    if not isinstance(event, dict) or set(event) not in (required, required | {"details"}):
        raise GuardError("INVALID_HISTORY", filename, "Event fields do not match the documented schema.")
    sequence = event["sequence"]
    identity_ok = (type(event["schema_version"]) is int and event["schema_version"] == 1
                   and event["root"] == str(root) and event["run_id"] == run_id and event["album_id"] == album_id
                   and type(sequence) is int and sequence >= 1 and filename == f"{sequence:06d}.json")
    fields_ok = (isinstance(event["skill_version"], str) and bool(event["skill_version"])
                 and event["phase"] in vocabulary.phases
                 and event["status"] in (None, *vocabulary.execution)
                 and isinstance(event["match_status"], str) and event["match_status"] in vocabulary.match
                 and isinstance(event["expected_files"], list) and bool(event["expected_files"])
                 and isinstance(event["removed_paths"], list)
                 and ("details" not in event or isinstance(event["details"], dict)))
    if not identity_ok or not fields_ok:
        raise GuardError("INVALID_HISTORY", filename, "Invalid event identity, phase, status or file manifest.")


def _validate_expected_files(expected_files: list, filename: str, state_dirs: list[str] | None, seen: set) -> tuple[int, int]:
    outputs, staging = 0, 0
    for entry in expected_files:
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
        elif entry["role"] == "staging":
            staging += 1
    return outputs, staging


def validate_event(event: dict, root: Path, run_id: str, album_id: str, filename: str,
                   state_dirs: list[str] | None, vocabulary=None) -> None:
    vocabulary = vocabulary or read_vocabulary()
    _validate_event_header(event, root, run_id, album_id, filename, vocabulary)
    seen: set = set()
    outputs, staging = _validate_expected_files(event["expected_files"], filename, state_dirs, seen)
    for removed in event["removed_paths"]:
        key = tuple(collision_key(p) for p in parts(removed))
        if key in seen:
            raise GuardError("INVALID_HISTORY", removed, "Removed path duplicates an expected or removed path.")
        seen.add(key)
    if event["status"] == "COMPLETED" and (event["phase"] != vocabulary.phases[-1] or not outputs or staging):
        raise GuardError("INVALID_HISTORY", filename,
                         f"COMPLETED requires {vocabulary.phases[-1]}, verified output manifest entries, and no remaining staging files.")


def _check_expected_file(root: Path, item: dict) -> dict | None:
    actual = None
    try:
        actual = fingerprint(source_path(root, item["path"]))
        if actual != item["sha256"]:
            raise GuardError("HISTORY_FILE_CHANGED", item["path"], "Recorded SHA-256 differs from the current file.")
        return None
    except (OSError, GuardError) as error:
        issue = _format_issue(error, "HISTORY_FILE_MISSING", item["path"])
        return {**issue, "expected_sha256": item["sha256"], "actual_sha256": actual, "role": item["role"]}


def _check_removed_path(root: Path, relative: str) -> dict | None:
    current = root
    try:
        for component in parts(relative):
            current = current / component
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise GuardError("SYMLINK", relative, "Removed path now crosses a symlink.")
        return {"code": "REMOVED_PATH_REAPPEARED", "path": relative}
    except FileNotFoundError:
        return None
    except (OSError, GuardError) as error:
        return _format_issue(error, "HISTORY_PATH_ERROR", relative)


def check_event_files(root: Path, event: dict) -> list[dict]:
    issues = []
    for item in event["expected_files"]:
        issue = _check_expected_file(root, item)
        if issue is not None:
            issues.append(issue)
    for relative in event["removed_paths"]:
        issue = _check_removed_path(root, relative)
        if issue is not None:
            issues.append(issue)
    return issues


def _load_album_events(root: Path, run_name: str, album: Path, state_dirs: list[str] | None,
                       vocabulary, view: dict) -> None:
    album_rel = album.relative_to(root).as_posix()
    try:
        for identity in (run_name, album.name):
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
            validate_event(event, root, run_name, album.name, file.name, state_dirs, vocabulary)
            view["records"].append({"record_path": rel, "event": event})
    except (OSError, ValueError) as error:
        view["issues"].append(_format_issue(error, "INVALID_HISTORY", album_rel))


def _collect_run_history(root: Path, run: Path, state_dirs: list[str] | None,
                         vocabulary, albums: dict, issues: list[dict]) -> None:
    run_rel = run.relative_to(root).as_posix()
    try:
        run_entries = directory_entries(root, run_rel)
        if not any(p.name == "albums" for p in run_entries):
            raise GuardError("UNRECOGNIZED_HISTORY", run_rel, "Run has no canonical albums directory; explicitly review legacy or interrupted setup.")
        for album in directory_entries(root, f"{run_rel}/albums"):
            view = albums.setdefault(album.name, {"album_id": album.name, "records": [], "issues": []})
            _load_album_events(root, run.name, album, state_dirs, vocabulary, view)
    except (OSError, ValueError) as error:
        issues.append(_format_issue(error, "INVALID_HISTORY", run_rel))


def _collect_state_history(root: Path, state: str, state_dirs: list[str] | None,
                           vocabulary, albums: dict, issues: list[dict]) -> None:
    state_entries = directory_entries(root, state)
    if not state_entries:
        return
    if not any(p.name == "runs" for p in state_entries):
        issues.append({"code": "UNRECOGNIZED_HISTORY", "path": state, "detail": "State data has no runs directory; review or migrate existing records."})
        return
    for run in directory_entries(root, f"{state}/runs"):
        _collect_run_history(root, run, state_dirs, vocabulary, albums, issues)


def _finalize_album_view(root: Path, album_id: str, view: dict, version: str, global_issues: list[dict]) -> dict:
    records = sorted(view.pop("records"), key=lambda r: r["event"]["sequence"])
    sequences = [r["event"]["sequence"] for r in records]
    if len(sequences) != len(set(sequences)):
        view["issues"].append({"code": "DUPLICATE_SEQUENCE", "path": album_id})
    latest = records[-1] if records else None
    if latest and not view["issues"]:
        view["issues"].extend({**issue, "record_path": latest["record_path"],
                               "sequence": latest["event"]["sequence"], "run_id": latest["event"]["run_id"]}
                              for issue in check_event_files(root, latest["event"]))
        if latest["event"]["skill_version"] != version:
            view["issues"].append({"code": "SKILL_VERSION_CHANGED", "path": latest["record_path"], "detail": "Revalidate domain rules with the current skill before reuse."})
    valid = bool(latest) and not view["issues"] and not global_issues
    view.update(latest=latest, integrity_ok=valid,
                reuse_candidate=valid and latest["event"]["status"] == "COMPLETED")
    return view


def history(root: Path, state_dirs: list[str] | None = None) -> dict:
    """Rebuild a cross-run view from immutable per-album snapshots; never write state."""
    version = skill_version()
    vocabulary = read_vocabulary()
    issues, albums = [], {}
    try:
        states, state_issues = actual_state_roots(root, state_dirs)
        issues.extend(state_issues)
        for state in states:
            _collect_state_history(root, state, state_dirs, vocabulary, albums, issues)
    except (OSError, ValueError) as error:
        issues.append(_format_issue(error, "INVALID_HISTORY", str(root)))
    results = [_finalize_album_view(root, album_id, view, version, issues)
               for album_id, view in sorted(albums.items())]
    return {"schema_version": 1, "root": str(root), "skill_version": version,
            "ok": not issues and all(a["integrity_ok"] for a in results),
            "scope": "recorded_files_only", "albums": results, "issues": issues}


def _collect_album_staging_refs(root: Path, album_id: str, view: dict,
                                active: set[tuple[str, ...]], issues: list[dict]) -> None:
    records = sorted(view["records"], key=lambda r: r["event"]["sequence"])
    sequences = [r["event"]["sequence"] for r in records]
    if len(sequences) != len(set(sequences)):
        view["issues"].append({"code": "DUPLICATE_SEQUENCE", "path": album_id})
    issues.extend(view["issues"])
    if view["issues"] or not records:
        return
    latest = records[-1]
    event = latest["event"]
    if event["status"] == "COMPLETED":
        return
    for item in event["expected_files"]:
        if item["role"] != "staging":
            continue
        active.add(tuple(collision_key(p) for p in parts(item["path"])))
        issue = _check_expected_file(root, item)
        if issue is not None:
            issues.append({**issue, "record_path": latest["record_path"],
                           "sequence": event["sequence"], "run_id": event["run_id"]})


def _load_latest_staging_state(root: Path, state_dirs: list[str] | None) -> tuple[set[tuple[str, ...]], list[dict]]:
    vocabulary = read_vocabulary()
    states, state_issues = actual_state_roots(root, state_dirs)
    albums: dict = {}
    history_issues: list[dict] = []
    for state in states:
        try:
            entries = directory_entries(root, state)
            if any(p.name == "runs" for p in entries):
                _collect_state_history(root, state, state_dirs, vocabulary, albums, history_issues)
        except (OSError, ValueError) as error:
            history_issues.append(_format_issue(error, "INVALID_HISTORY", state))
    active: set[tuple[str, ...]] = set()
    issues: list[dict] = [*state_issues, *history_issues]
    for album_id, view in sorted(albums.items()):
        _collect_album_staging_refs(root, album_id, view, active, issues)
    return active, issues


def _is_temp_residue(name: str, in_state_or_staging: bool, policy) -> bool:
    normalized = collision_key(name)
    if any(normalized.endswith(suffix) for suffix in policy.root_temp_suffixes):
        return True
    if any(marker in normalized for marker in policy.root_temp_infixes):
        return True
    return in_state_or_staging and any(normalized.endswith(suffix) for suffix in policy.staging_temp_suffixes)


def _has_runs_dir(directory: Path) -> bool:
    with os.scandir(directory) as scan:
        for entry in scan:
            if collision_key(entry.name) == "runs" and stat.S_ISDIR((directory / entry.name).lstat().st_mode):
                return True
    return False


def _inspect_bypass_entry(root: Path, path: Path, pending: list[Path], issues: list[dict]) -> tuple[int, int]:
    rel = path.relative_to(root).as_posix()
    try:
        info = path.lstat()
    except OSError as error:
        issues.append(_format_issue(error, "READ_ERROR", rel))
        return 0, 0
    if stat.S_ISLNK(info.st_mode):
        issues.append({"code": "SYMLINK", "path": rel, "detail": "Bypass staging entry is a symlink; not followed."})
        return 0, 0
    if stat.S_ISDIR(info.st_mode):
        pending.append(path)
        return 0, 0
    if stat.S_ISREG(info.st_mode):
        return 1, info.st_size
    issues.append({"code": "NOT_REGULAR", "path": rel, "detail": "Special file inside bypass staging directory."})
    return 0, 0


def _summarize_bypass_dir(root: Path, bypass: Path, issues: list[dict]) -> dict:
    file_count, total_bytes = 0, 0
    pending = [bypass]
    while pending:
        current = pending.pop()
        if not stat.S_ISDIR(current.lstat().st_mode):
            continue
        with os.scandir(current) as scan:
            entries = sorted(scan, key=lambda e: e.name)
        for entry in entries:
            count, size = _inspect_bypass_entry(root, current / entry.name, pending, issues)
            file_count += count
            total_bytes += size
    return {"path": bypass.relative_to(root).as_posix(), "file_count": file_count, "bytes": total_bytes}


def _record_regular_staging_file(rel: str, size: int, in_state: bool, in_staging: bool, policy,
                                 active: set[tuple[str, ...]], state: dict) -> None:
    if _is_temp_residue(Path(rel).name, in_state or in_staging, policy):
        state["temp_files"].append({"path": rel, "size": size})
        state["issues"].append({"code": "TEMP_FILE_RESIDUE", "path": rel, "size": size,
                                "detail": "Temporary or decode scratch file remains in workspace."})
        return
    if not in_staging:
        return
    key = tuple(collision_key(p) for p in parts(rel))
    if key in active:
        state["active_recovery_files"].append({"path": rel, "size": size})
    else:
        state["orphaned_staging_files"].append({"path": rel, "size": size})
        state["issues"].append({"code": "ORPHANED_STAGING_FILE", "path": rel, "size": size,
                                "detail": "Staging or quarantine file is not referenced by any active non-COMPLETED snapshot."})


def _handle_staging_subdir(root: Path, directory: Path, path: Path, rel: str, in_state: bool, in_staging: bool,
                           state_dirs: list[str] | None, policy, state: dict) -> tuple[Path, bool, bool] | None:
    name_key = collision_key(path.name)
    protected = is_protected(rel, state_dirs)
    if directory == root and not protected and name_key in policy.bypass_dirs:
        summary = _summarize_bypass_dir(root, path, state["issues"])
        state["unregistered_staging_dirs"].append(summary)
        state["issues"].append({"code": "UNREGISTERED_STAGING_DIR", **summary,
                                "detail": "Unregistered bypass staging directory found at root; register via --state-dir or evict it."})
        return None
    if protected and not in_state:
        whole_staging = collision_key(rel) != ".musagetes" and not _has_runs_dir(path)
        return (path, True, whole_staging)
    next_staging = in_staging or (in_state and name_key in policy.state_staging_dirs)
    return (path, in_state or protected, next_staging)


def _inspect_staging_entry(root: Path, directory: Path, path: Path, in_state: bool, in_staging: bool,
                           state_dirs: list[str] | None, policy, active: set[tuple[str, ...]],
                           state: dict) -> tuple[Path, bool, bool] | None:
    rel = path.relative_to(root).as_posix()
    try:
        info = path.lstat()
    except OSError as error:
        state["issues"].append(_format_issue(error, "READ_ERROR", rel))
        return None
    if stat.S_ISLNK(info.st_mode):
        is_bypass = directory == root and collision_key(path.name) in policy.bypass_dirs
        if in_staging or is_bypass:
            state["issues"].append({"code": "SYMLINK", "path": rel, "detail": "Staging entry is a symlink; not followed."})
        return None
    if stat.S_ISDIR(info.st_mode):
        return _handle_staging_subdir(root, directory, path, rel, in_state, in_staging, state_dirs, policy, state)
    if stat.S_ISREG(info.st_mode):
        _record_regular_staging_file(rel, info.st_size, in_state, in_staging, policy, active, state)
        return None
    if in_staging:
        state["issues"].append({"code": "NOT_REGULAR", "path": rel, "detail": "Special file inside staging directory."})
    return None


def _scan_staging_directory(root: Path, directory: Path, in_state: bool, in_staging: bool,
                            state_dirs: list[str] | None, policy, active: set[tuple[str, ...]],
                            state: dict) -> list[tuple[Path, bool, bool]]:
    if not stat.S_ISDIR(directory.lstat().st_mode):
        raise GuardError("DIRECTORY_CHANGED", str(directory), "Directory changed during staging audit.")
    with os.scandir(directory) as scan:
        entries = sorted(scan, key=lambda e: e.name)
    if in_staging and not entries:
        rel_dir = directory.relative_to(root).as_posix()
        state["empty_staging_dirs"].append(rel_dir)
        state["issues"].append({"code": "EMPTY_STAGING_DIR", "path": rel_dir,
                                "detail": "Empty staging or quarantine directory remains after cleanup."})
        return []
    subdirs: list[tuple[Path, bool, bool]] = []
    for entry in entries:
        queued = _inspect_staging_entry(root, directory, directory / entry.name, in_state, in_staging,
                                        state_dirs, policy, active, state)
        if queued is not None:
            subdirs.append(queued)
    return subdirs


def staging_audit(root: Path, state_dirs: list[str] | None = None) -> dict:
    """Audit staging/quarantine drainage, temp/PCM residue, and unregistered bypass staging dirs."""
    protected_roots(state_dirs)
    policy = read_staging_policy()
    active, initial_issues = _load_latest_staging_state(root, state_dirs)
    state: dict = {
        "active_recovery_files": [],
        "orphaned_staging_files": [],
        "temp_files": [],
        "empty_staging_dirs": [],
        "unregistered_staging_dirs": [],
        "issues": initial_issues,
    }
    pending: list[tuple[Path, bool, bool]] = [(root, False, False)]
    while pending:
        directory, in_state, in_staging = pending.pop()
        try:
            pending.extend(_scan_staging_directory(root, directory, in_state, in_staging, state_dirs, policy, active, state))
        except (OSError, GuardError) as error:
            state["issues"].append(_format_issue(error, "READ_ERROR", str(directory)))

    for key in ("active_recovery_files", "orphaned_staging_files", "temp_files", "unregistered_staging_dirs"):
        state[key].sort(key=lambda item: item["path"])
    state["empty_staging_dirs"].sort()
    active_bytes = sum(item["size"] for item in state["active_recovery_files"])
    orphaned_bytes = sum(item["size"] for item in state["orphaned_staging_files"])
    temp_bytes = sum(item["size"] for item in state["temp_files"])
    unregistered_bytes = sum(item["bytes"] for item in state["unregistered_staging_dirs"])
    return {
        "schema_version": 1,
        "root": str(root),
        "ok": not state["issues"],
        "scope": "staging_and_temp_residue_only",
        "protected_state_dirs": [".musagetes", *(state_dirs or [])],
        **{k: state[k] for k in ("active_recovery_files", "orphaned_staging_files", "temp_files",
                                 "empty_staging_dirs", "unregistered_staging_dirs")},
        "summary": {
            "active_recovery_count": len(state["active_recovery_files"]),
            "active_recovery_bytes": active_bytes,
            "orphaned_staging_count": len(state["orphaned_staging_files"]),
            "orphaned_staging_bytes": orphaned_bytes,
            "temp_file_count": len(state["temp_files"]),
            "temp_file_bytes": temp_bytes,
            "empty_staging_dir_count": len(state["empty_staging_dirs"]),
            "unregistered_staging_dir_count": len(state["unregistered_staging_dirs"]),
            "unregistered_staging_bytes": unregistered_bytes,
            "total_residual_bytes": orphaned_bytes + temp_bytes + unregistered_bytes,
        },
        "issues": state["issues"],
    }


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


COVER_SOURCES = frozenset({"online", "embedded", "local_scan_front", "local_scan_crop", "missing"})


def _parse_crop_arg(raw: str | None) -> tuple[int, int, int, int] | None:
    if raw is None:
        return None
    fields = [part.strip() for part in raw.split(",")]
    if len(fields) != 4 or any(not re.fullmatch(r"-?\d+", field) for field in fields):
        raise RuleError("INVALID_CROP_BOX", f"Expected --crop LEFT,TOP,RIGHT,BOTTOM as four integers: {raw}")
    return (int(fields[0]), int(fields[1]), int(fields[2]), int(fields[3]))


def _validate_sidecar_plan_shape(plan: dict) -> None:
    required = {"schema_version", "album_id", "online_metadata_verified", "online_cover_verified", "cover_source", "entries"}
    if not isinstance(plan, dict) or set(plan) != required:
        raise GuardError("INVALID_SIDECAR_PLAN", "", "Sidecar plan keys do not match schema_version 1.")
    if (type(plan["schema_version"]) is not int or plan["schema_version"] != 1
            or not isinstance(plan["album_id"], str) or not plan["album_id"].strip()
            or type(plan["online_metadata_verified"]) is not bool
            or type(plan["online_cover_verified"]) is not bool
            or plan["cover_source"] not in COVER_SOURCES
            or not isinstance(plan["entries"], list) or not plan["entries"]):
        raise GuardError("INVALID_SIDECAR_PLAN", "", "Invalid sidecar plan header or empty entries.")
    for idx, entry in enumerate(plan["entries"]):
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256", "action"}
                or not isinstance(entry["path"], str)
                or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-fA-F]{64}", entry["sha256"])
                or entry["action"] not in ("clean", "preserve")):
            raise GuardError("INVALID_SIDECAR_PLAN", str(idx), "Entry must contain path, sha256, and action (clean/preserve).")


def _evaluate_sidecar_entry(root: Path, entry: dict, state_dirs: list[str] | None, policy, online_both_verified: bool,
                            seen: set) -> tuple[dict, list[dict]]:
    rel = entry["path"]
    issues: list[dict] = []
    try:
        key = tuple(collision_key(p) for p in parts(rel))
        if key in seen:
            issues.append({"code": "DUPLICATE_SIDECAR_ENTRY", "path": rel, "detail": "Duplicate or aliased sidecar path."})
        seen.add(key)
        reject_state_path(rel, state_dirs)
        resolved = source_path(root, rel)
        actual_sha = fingerprint(resolved)
        if actual_sha != entry["sha256"].lower():
            raise GuardError("SOURCE_CHANGED", rel, "Sidecar SHA-256 differs from the reviewed snapshot.")
    except (OSError, GuardError) as error:
        issues.append(_format_issue(error, "FILESYSTEM_ERROR", rel))
        return {"path": rel, "planned_action": entry["action"], "category": None, "policy_default": None}, issues

    rule = policy.lookup(resolved.suffix.lower())
    if rule is None:
        issues.append({"code": "UNSUPPORTED_SIDECAR_EXTENSION", "path": rel,
                       "detail": f"Extension '{resolved.suffix.lower()}' is not an eligible non-music sidecar."})
        return {"path": rel, "planned_action": entry["action"], "category": None, "policy_default": None}, issues

    policy_default = rule.when_online_verified if online_both_verified else rule.when_online_incomplete
    if entry["action"] == "clean" and policy_default != "clean":
        issues.append({"code": "SIDECAR_CLEANUP_BLOCKED", "path": rel,
                       "detail": "High-quality online cover and metadata are not both verified; preserve this sidecar."})
    return {
        "path": rel,
        "planned_action": entry["action"],
        "category": rule.category,
        "policy_default": policy_default,
    }, issues


def check_sidecars(root: Path, plan: dict, state_dirs: list[str] | None = None,
                   delivery_path: Path | None = None) -> dict:
    """Validate conditional non-music sidecar cleanup/preservation plans against delivery.md policy."""
    protected_roots(state_dirs)
    _validate_sidecar_plan_shape(plan)
    policy = read_sidecar_policy(delivery_path)
    issues: list[dict] = []
    if plan["online_cover_verified"] and plan["cover_source"] != "online":
        issues.append({
            "code": "INCONSISTENT_COVER_SOURCE",
            "path": "",
            "detail": f"online_cover_verified is true but cover_source is '{plan['cover_source']}' (expected 'online').",
        })
    online_both = plan["online_metadata_verified"] and plan["online_cover_verified"] and plan["cover_source"] == "online"
    evaluated, seen = [], set()
    for entry in plan["entries"]:
        record, entry_issues = _evaluate_sidecar_entry(root, entry, state_dirs, policy, online_both, seen)
        evaluated.append(record)
        issues.extend(entry_issues)
    return {
        "schema_version": 1,
        "root": str(root),
        "album_id": plan["album_id"],
        "ok": not issues,
        "scope": "sidecar_cleanup_policy_only",
        "online_cover_and_metadata_verified": online_both,
        "entries": evaluated,
        "issues": issues,
    }


def _build_parser() -> argparse.ArgumentParser:
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
    staging = commands.add_parser("staging-audit", help="Audit orphaned staging/quarantine files, temp/PCM residue, empty staging dirs, and bypass .staging dirs.")
    staging.add_argument("--root", required=True)
    sidecars = commands.add_parser("check-sidecars", help="Check a non-music sidecar cleanup/preservation plan against delivery.md policy.")
    sidecars.add_argument("--root", required=True)
    sidecars.add_argument("--input", required=True, help="UTF-8 JSON sidecar plan path, or - for stdin.")
    render = commands.add_parser("render-paths", help="Render canonical final tags into a JSON plan; follow with check-paths.")
    render.add_argument("--root", required=True)
    render.add_argument("--input", required=True, type=Path)
    tags = commands.add_parser("check-tags", help="Check canonical field names, required fields and nonempty ordered values.")
    tags.add_argument("--input", required=True, type=Path)
    cover = commands.add_parser("cover-info", help="Decode an image via Pillow and check cover dimensions, optional crop box, and ratio.")
    cover.add_argument("--root", required=True)
    cover.add_argument("--image", required=True, help="Root-relative image file; state candidates may be inspected.")
    cover.add_argument("--crop", default=None, help="Optional EXIF-oriented crop box LEFT,TOP,RIGHT,BOTTOM (read-only preflight).")
    audio = commands.add_parser("audio-info", help="Inspect audio container, codec, native tags, embedded CUE, and embedded pictures.")
    audio.add_argument("--root", required=True)
    audio.add_argument("--audio", required=True, help="Root-relative audio file; state candidates may be inspected.")
    for command in (scan, check, resume, staging, sidecars, render):
        command.add_argument("--state-dir", action="append", default=[], help="Additional protected root-relative state directory; repeat for previous locations.")
    return parser


def _read_json_file(path: Path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)


def _read_json_source(target: str):
    raw = sys.stdin.read() if target == "-" else Path(target).read_text(encoding="utf-8")
    return json.loads(raw, object_pairs_hook=unique_object)


def _check_tags_request(path: Path) -> dict:
    request = _read_json_file(path)
    if not isinstance(request, dict) or set(request) not in ({"kind", "tags"}, {"kind", "tags", "omissions"}):
        raise GuardError("INVALID_TAG_INPUT", "", "Expected kind and tags, with optional omissions.")
    return check_tags(request["tags"], request["kind"], omissions=request.get("omissions"))


def _dispatch_command(args: argparse.Namespace) -> dict:
    root = root_path(args.root) if hasattr(args, "root") else None
    handlers = {
        "inventory": lambda: inventory(root, args.hash, args.state_dir, args.include_state),
        "check-paths": lambda: check_paths(root, _read_json_file(args.plan), args.state_dir),
        "history": lambda: history(root, args.state_dir),
        "staging-audit": lambda: staging_audit(root, args.state_dir),
        "check-sidecars": lambda: check_sidecars(root, _read_json_source(args.input), args.state_dir),
        "render-paths": lambda: render_paths(root, _read_json_file(args.input), args.state_dir),
        "cover-info": lambda: inspect_cover(source_path(root, args.image), crop=_parse_crop_arg(args.crop)),
        "audio-info": lambda: inspect_audio(source_path(root, args.audio)),
        "check-tags": lambda: _check_tags_request(args.input),
    }
    return handlers[args.command]()


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        result = _dispatch_command(args)
        code = 0 if result.get("ok", True) else 1
    except (OSError, ValueError) as error:
        issue = error.issue if isinstance(error, (GuardError, RuleError)) else {"code": "INPUT_ERROR", "path": "", "detail": str(error)}
        result, code = {"ok": False, "issues": [issue]}, 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
