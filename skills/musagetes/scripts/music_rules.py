"""Pure music metadata/path checks, full image decoding, and read-only audio header/metadata inspection."""
from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import date
import hashlib
from io import BytesIO
from pathlib import Path
import re
import struct
from typing import BinaryIO
import unicodedata
import zlib

import mutagen
from mutagen import apev2, flac, id3, mp4
from PIL import Image, ImageOps


class RuleError(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.issue = {"code": code, "detail": detail}


@dataclass(frozen=True)
class Whitelist:
    allowed: frozenset[str]
    common_required: frozenset[str]
    album_required: frozenset[str]
    omittable: frozenset[str]


@dataclass(frozen=True)
class Vocabulary:
    phases: tuple[str, ...]
    execution: frozenset[str]
    match: frozenset[str]
    disposition: frozenset[str]


@dataclass(frozen=True)
class StagingPolicy:
    root_temp_suffixes: frozenset[str]
    root_temp_infixes: frozenset[str]
    staging_temp_suffixes: frozenset[str]
    state_staging_dirs: frozenset[str]
    bypass_dirs: frozenset[str]


@dataclass(frozen=True)
class SidecarRule:
    category: str
    extensions: frozenset[str]
    when_online_verified: str
    when_online_incomplete: str


@dataclass(frozen=True)
class SidecarPolicy:
    rules: dict[str, SidecarRule]
    extension_index: dict[str, SidecarRule]

    def lookup(self, extension: str) -> SidecarRule | None:
        return self.extension_index.get(extension.lower())


SIDECAR_SECTION = "非音乐 sidecar 条件清理规则"
REQUIRED_SIDECAR_CATEGORIES = frozenset({"cue", "playlist", "scan_image", "companion_text"})
SIDECAR_ACTIONS = frozenset({"clean", "preserve"})
EXTENSION_PATTERN = re.compile(r"\.[a-z0-9]+", re.ASCII)


def _parse_sidecar_extensions(cell: str) -> frozenset[str]:
    raw = _parse_backtick_cell(cell, "sidecar extensions")
    parts = [item.strip().lower() for item in raw.split(",")]
    if not parts or any(not EXTENSION_PATTERN.fullmatch(item) for item in parts):
        raise RuleError("INVALID_SIDECAR_POLICY", f"Invalid sidecar extension list: {cell}")
    if len(parts) != len(set(parts)):
        raise RuleError("INVALID_SIDECAR_POLICY", f"Duplicate extension in sidecar row: {cell}")
    return frozenset(parts)


def _parse_sidecar_action(cell: str) -> str:
    action = _parse_backtick_cell(cell, "sidecar action")
    if action not in SIDECAR_ACTIONS:
        raise RuleError("INVALID_SIDECAR_POLICY", f"Unsupported sidecar action: {action}")
    return action


def _parse_sidecar_row(line: str, rules_map: dict[str, SidecarRule], ext_index: dict[str, SidecarRule]) -> None:
    cells = [c.strip() for c in line.strip("|").split("|")]
    if len(cells) < 4:
        raise RuleError("INVALID_SIDECAR_POLICY", "Malformed sidecar policy table row.")
    if cells[0] == "Sidecar 类别" or re.fullmatch(r":?-+:?", cells[0]):
        return
    category = _parse_backtick_cell(cells[0], "sidecar category")
    if category in rules_map:
        raise RuleError("INVALID_SIDECAR_POLICY", f"Duplicate sidecar category: {category}")
    extensions = _parse_sidecar_extensions(cells[1])
    when_verified = _parse_sidecar_action(cells[2])
    when_incomplete = _parse_sidecar_action(cells[3])
    rule = SidecarRule(category, extensions, when_verified, when_incomplete)
    for ext in extensions:
        if ext in ext_index:
            raise RuleError("INVALID_SIDECAR_POLICY", f"Overlapping sidecar extension: {ext}")
        ext_index[ext] = rule
    rules_map[category] = rule


def read_sidecar_policy(delivery: Path | None = None) -> SidecarPolicy:
    """Parse conditional sidecar cleanup rules from delivery.md, never a second copy."""
    path = delivery or Path(__file__).resolve().parent.parent / "references/delivery.md"
    rules_map: dict[str, SidecarRule] = {}
    ext_index: dict[str, SidecarRule] = {}
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## ") or line.startswith("### "):
            section = line.lstrip("#").strip()
        if section == SIDECAR_SECTION and line.startswith("|"):
            _parse_sidecar_row(line, rules_map, ext_index)
    missing = REQUIRED_SIDECAR_CATEGORIES - set(rules_map)
    if missing:
        raise RuleError("INVALID_SIDECAR_POLICY", f"Sidecar policy table is missing categories: {', '.join(sorted(missing))}")
    return SidecarPolicy(rules_map, ext_index)


STAGING_SECTION = "Staging 生命周期与退场"
STAGING_BUCKETS = {
    ("suffix", "root"): "root_temp_suffixes",
    ("infix", "root"): "root_temp_infixes",
    ("suffix", "staging"): "staging_temp_suffixes",
    ("staging_dir", "state"): "state_staging_dirs",
    ("bypass_dir", "root_top"): "bypass_dirs",
}


def _parse_backtick_cell(cell: str, label: str) -> str:
    match = re.fullmatch(r"`([^`]+)`", cell)
    if not match or not match[1].strip():
        raise RuleError("INVALID_STAGING_POLICY", f"Expected one backtick-delimited {label}: {cell}")
    return match[1].strip()


def _parse_staging_policy_row(line: str, buckets: dict[str, set[str]]) -> None:
    cells = [c.strip() for c in line.strip("|").split("|")]
    if len(cells) < 3:
        raise RuleError("INVALID_STAGING_POLICY", "Malformed staging policy table row.")
    if cells[0] == "残留规则类型" or re.fullmatch(r":?-+:?", cells[0]):
        return
    rule_type = _parse_backtick_cell(cells[0], "rule type")
    pattern = _parse_backtick_cell(cells[1], "pattern")
    scope = _parse_backtick_cell(cells[2], "scope")
    bucket_name = STAGING_BUCKETS.get((rule_type, scope))
    if not bucket_name:
        raise RuleError("INVALID_STAGING_POLICY", f"Unsupported staging rule ({rule_type}, {scope}).")
    normalized = unicodedata.normalize("NFC", pattern).casefold()
    if normalized in buckets[bucket_name]:
        raise RuleError("INVALID_STAGING_POLICY", f"Duplicate staging policy entry: {pattern}")
    buckets[bucket_name].add(normalized)


def read_staging_policy(execution: Path | None = None) -> StagingPolicy:
    """Parse staging and temporary-residue rules from execution.md, never a second copy."""
    path = execution or Path(__file__).resolve().parent.parent / "references/execution.md"
    buckets: dict[str, set[str]] = {name: set() for name in STAGING_BUCKETS.values()}
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## ") or line.startswith("### "):
            section = line.lstrip("#").strip()
        if section == STAGING_SECTION and line.startswith("|"):
            _parse_staging_policy_row(line, buckets)
    if not all(buckets.values()):
        raise RuleError("INVALID_STAGING_POLICY", "Staging policy table is missing required rule categories.")
    return StagingPolicy(**{name: frozenset(values) for name, values in buckets.items()})


DIMENSIONS = {"执行": "execution", "匹配": "match", "处置": "disposition"}
# Values the helpers branch on. A reference rename must fail loudly, not silently disable a check.
BRANCHED_ON = {"phases": ("PLANNED", "FINALIZED"),
               "execution": ("COMPLETED", "SKIPPED", "REVIEW_REQUIRED"),
               "match": ("FULL", "PARTIAL_MATCH", "UNCONFIRMED")}


REQUIRED_WHITELIST_SECTION = "必填白名单"
OPTIONAL_WHITELIST_SECTION = "选填白名单"


def _parse_status_row(line: str, groups: dict[str, set[str]]) -> None:
    cells = [c.strip() for c in line.strip("|").split("|")]
    if len(cells) < 3:
        raise RuleError("INVALID_STATUS_TABLE", "Malformed status table row.")
    if cells[0] == "维度" or re.fullmatch(r":?-+:?", cells[0]):
        return
    if cells[0] not in DIMENSIONS:
        raise RuleError("INVALID_STATUS_TABLE", f"Unknown status dimension: {cells[0]}")
    value = re.fullmatch(r"`([A-Z][A-Z_]*)`", cells[1])
    if not value:
        raise RuleError("INVALID_STATUS_TABLE", f"Expected one backtick-delimited status value: {cells[1]}")
    if any(value[1] in group for group in groups.values()):
        raise RuleError("INVALID_STATUS_TABLE", f"Duplicate status declaration: {value[1]}")
    groups[DIMENSIONS[cells[0]]].add(value[1])


def _parse_status_groups(delivery_path: Path) -> dict[str, set[str]]:
    groups: dict[str, set[str]] = {name: set() for name in DIMENSIONS.values()}
    section = None
    for line in delivery_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
        if section == "状态与最终报告" and line.startswith("|"):
            _parse_status_row(line, groups)
    if not all(groups.values()):
        raise RuleError("INVALID_STATUS_TABLE", "References must declare every status dimension.")
    return groups


def _parse_transaction_phases(execution_path: Path) -> tuple[str, ...]:
    section = None
    for line in execution_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
        if section == "事务与恢复" and (found := re.search(r"`([A-Z_]+(?:\s*→\s*[A-Z_]+)+)`", line)):
            phases = tuple(part.strip() for part in found[1].split("→"))
            if len(phases) != len(set(phases)):
                raise RuleError("INVALID_STATUS_TABLE", "Transaction phases must be unique.")
            return phases
    return ()


def read_vocabulary(delivery: Path | None = None, execution: Path | None = None) -> Vocabulary:
    """Parse transaction phases and status values from the reference tables, never a second copy."""
    references = Path(__file__).resolve().parent.parent / "references"
    groups = _parse_status_groups(delivery or references / "delivery.md")
    phases = _parse_transaction_phases(execution or references / "execution.md")
    vocabulary = Vocabulary(phases, frozenset(groups["execution"]),
                            frozenset(groups["match"]), frozenset(groups["disposition"]))
    for name, expected in BRANCHED_ON.items():
        declared = getattr(vocabulary, name)
        if not declared or not set(expected) <= set(declared):
            raise RuleError("INVALID_STATUS_TABLE", f"References must declare {name}: {', '.join(expected)}")
    return vocabulary


def _register_required_field(key: str, scope: str, common: set[str], album: set[str], omittable: set[str]) -> None:
    if scope == "所有音轨":
        common.add(key)
    elif scope == "所有音轨；可记录缺失":
        common.add(key)
        omittable.add(key)
    elif scope == "有专辑归属的音轨":
        album.add(key)
    else:
        raise RuleError("INVALID_WHITELIST", f"Unknown required scope for {key}: {scope}")


def _parse_whitelist_row(line: str, section: str, allowed: set[str],
                         common: set[str], album: set[str], omittable: set[str]) -> None:
    cells = [c.strip() for c in line.strip("|").split("|")]
    match = re.match(r"^`([^`]+)`(?:\s*/.*)?$", cells[0])
    if not match:
        if cells[0] not in {"Vorbis 键 / 语义", "Vorbis 键", "封面"} and not re.fullmatch(r":?-+:?", cells[0]):
            raise RuleError("INVALID_WHITELIST", "Expected a backtick-delimited field in a whitelist row.")
        return
    min_cells = 3 if section == REQUIRED_WHITELIST_SECTION else 2
    if len(cells) < min_cells:
        raise RuleError("INVALID_WHITELIST", "Malformed whitelist table row.")
    key = match[1]
    if key in allowed:
        raise RuleError("INVALID_WHITELIST", f"Duplicate field declaration: {key}")
    allowed.add(key)
    if section == REQUIRED_WHITELIST_SECTION:
        _register_required_field(key, cells[1], common, album, omittable)


def read_whitelist(path: Path | None = None) -> Whitelist:
    path = path or Path(__file__).resolve().parent.parent / "references/metadata-whitelist.md"
    allowed, common, album, omittable = set(), set(), set(), set()
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
        if section in {REQUIRED_WHITELIST_SECTION, OPTIONAL_WHITELIST_SECTION} and line.startswith("|"):
            _parse_whitelist_row(line, section, allowed, common, album, omittable)
    if not common or not album or not (allowed - common - album):
        raise RuleError("INVALID_WHITELIST", "Required or optional field tables could not be parsed.")
    return Whitelist(frozenset(allowed), frozenset(common), frozenset(album), frozenset(omittable))


# Path rendering reads these as one value each; tools.md documents the value rules.
SINGLE_VALUED = ("TITLE", "DATE", "ALBUM")
NUMBER_PAIRS = (("TRACKNUMBER", "TRACKTOTAL"), ("DISCNUMBER", "DISCTOTAL"))
DATE_PATTERN = re.compile(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", re.ASCII)
POSITIVE_INT_PATTERN = re.compile(r"\d+", re.ASCII)


def valid_date(value: str) -> bool:
    if not DATE_PATTERN.fullmatch(value):
        return False
    components = [int(v) for v in value.split("-")]
    try:
        date(*(components + [1] * (3 - len(components))))
    except ValueError:
        return False
    return True


def _has_usable_values(tags: dict, key: str) -> bool:
    values = tags.get(key)
    return isinstance(values, list) and bool(values) and all(isinstance(v, str) and v.strip() for v in values)


def _number_pair_issues(tags: dict, pair: tuple[str, str]) -> list[dict]:
    issues = []
    numbers = {}
    for key in pair:
        if not _has_usable_values(tags, key):
            continue
        values = tags[key]
        if len(values) != 1 or not POSITIVE_INT_PATTERN.fullmatch(values[0]) or int(values[0]) < 1:
            issues.append({"code": "INVALID_NUMBER", "field": key})
        else:
            numbers[key] = int(values[0])
    current, total = pair
    if current in numbers and total in numbers and numbers[current] > numbers[total]:
        issues.append({"code": "NUMBER_EXCEEDS_TOTAL", "field": current})
    return issues


def value_issues(tags: dict) -> list[dict]:
    """Value rules shared by check-tags and render-paths, so a passing check always renders."""
    issues = []
    for key in SINGLE_VALUED:
        if _has_usable_values(tags, key) and len(tags[key]) != 1:
            issues.append({"code": "MULTIPLE_VALUES", "field": key})
    if _has_usable_values(tags, "DATE") and len(tags["DATE"]) == 1 and not valid_date(tags["DATE"][0]):
        issues.append({"code": "INVALID_DATE", "field": "DATE"})
    for pair in NUMBER_PAIRS:
        issues.extend(_number_pair_issues(tags, pair))
    return issues


def _check_omissions(tags: dict, omissions: dict, whitelist: Whitelist) -> tuple[list[dict], dict]:
    issues = []
    accepted: dict = {}
    for key, reason in omissions.items():
        if key not in whitelist.omittable:
            issues.append({"code": "OMISSION_NOT_ALLOWED", "field": key})
        elif key in tags:
            issues.append({"code": "OMITTED_TAG_PRESENT", "field": key})
        elif not isinstance(reason, str) or not reason.strip():
            issues.append({"code": "MISSING_OMISSION_REASON", "field": key})
        else:
            accepted[key] = reason
    return issues, accepted


def _invalid_tag_values(values: object) -> bool:
    return not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values)


def _check_tag_entries(tags: dict, required: frozenset[str], accepted_omissions: dict, whitelist: Whitelist) -> list[dict]:
    issues = []
    for key in tags:
        if key not in whitelist.allowed:
            issues.append({"code": "UNKNOWN_TAG", "field": key})
    for key, values in tags.items():
        if _invalid_tag_values(values):
            issues.append({"code": "INVALID_TAG_VALUES", "field": key})
    for key in sorted(required):
        if key not in tags and key not in accepted_omissions:
            issues.append({"code": "MISSING_REQUIRED_TAG", "field": key})
    return issues


def check_tags(tags: dict, kind: str = "album", whitelist: Whitelist | None = None, *, omissions: dict | None = None) -> dict:
    whitelist = whitelist or read_whitelist()
    if kind not in ("album", "singleton") or not isinstance(tags, dict):
        raise RuleError("INVALID_TAG_INPUT", "Use kind album/singleton and a canonical tag dictionary.")
    omissions = {} if omissions is None else omissions
    if not isinstance(omissions, dict):
        raise RuleError("INVALID_OMISSIONS", "omissions must map permitted missing fields to documented reasons.")
    issues, accepted_omissions = _check_omissions(tags, omissions, whitelist)
    required = whitelist.common_required | (whitelist.album_required if kind == "album" else frozenset())
    issues.extend(_check_tag_entries(tags, required, accepted_omissions, whitelist))
    issues.extend(value_issues(tags))
    return {"ok": not issues, "scope": "canonical_fields_and_values_only", "issues": issues, "omissions": accepted_omissions}


def sanitize_component(value: str) -> str:
    if not isinstance(value, str):
        raise RuleError("INVALID_PATH_VALUE", "Path components must be strings.")
    value = value.replace(":", "：")
    value = "".join(" " if c in '\\/<>"|?*' or unicodedata.category(c) == "Cc" else c for c in value)
    value = re.sub(r"\s+", " ", value).strip().rstrip(" .")
    if not value:
        raise RuleError("EMPTY_PATH_COMPONENT", "Path component is empty after normalization.")
    if re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", value.split(".", 1)[0].rstrip()):
        value = "_" + value
    return value


def scalar(tags: dict, key: str) -> str:
    values = tags.get(key)
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], str) or not values[0].strip():
        raise RuleError("INVALID_SCALAR_TAG", f"{key} needs one nonempty value to render a path.")
    return values[0]


def positive_number(tags: dict, key: str) -> int:
    value = scalar(tags, key)
    if not POSITIVE_INT_PATTERN.fullmatch(value) or int(value) < 1:
        raise RuleError("INVALID_NUMBER_TAG", f"{key} must be a positive integer without a slash.")
    return int(value)


def render_path(tags: dict, extension: str, kind: str = "album", whitelist: Whitelist | None = None, *, omissions: dict | None = None) -> str:
    checked = check_tags(tags, kind, whitelist, omissions=omissions)
    if not checked["ok"]:
        raise RuleError("INVALID_TAGS", str(checked["issues"]))
    if not isinstance(extension, str) or not re.fullmatch(r"\.[a-z0-9]+", extension):
        raise RuleError("INVALID_EXTENSION", "Supply the actual planned audio extension in lowercase, including its dot.")
    title = scalar(tags, "TITLE")
    artist = " & ".join(tags["ARTIST"])
    release_date = scalar(tags, "DATE")
    if kind == "singleton":
        if any(k in tags for k in (whitelist or read_whitelist()).album_required):
            raise RuleError("KIND_MISMATCH", "A singleton has no album/track/disc fields.")
        return sanitize_component(f"[{artist}][{title}]") + extension
    album = scalar(tags, "ALBUM")
    album_artist = " & ".join(tags["ALBUMARTIST"])
    disc, disc_total = positive_number(tags, "DISCNUMBER"), positive_number(tags, "DISCTOTAL")
    track, _ = positive_number(tags, "TRACKNUMBER"), positive_number(tags, "TRACKTOTAL")
    prefix = f"{disc:02d}{track:02d}" if disc_total > 1 else f"{track:02d}"
    directory = sanitize_component(f"[{album_artist}][{album}][{release_date[:4]}]")
    filename = sanitize_component(f"{prefix} - {title} - {artist}") + extension
    return f"{directory}/{filename}"


def _validate_crop_box(crop: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int, int, int]:
    if not isinstance(crop, (tuple, list)) or len(crop) != 4 or any(type(v) is not int for v in crop):
        raise RuleError("INVALID_CROP_BOX", "Crop box must contain four integers: (left, top, right, bottom).")
    left, top, right, bottom = crop
    if left < 0 or top < 0 or right > width or bottom > height or left >= right or top >= bottom:
        raise RuleError(
            "INVALID_CROP_BOX",
            f"Crop box {(left, top, right, bottom)} is outside EXIF-oriented dimensions {width}x{height} or empty.",
        )
    return left, top, right, bottom


def decode_image(source: Path | bytes, crop: tuple[int, int, int, int] | None = None) -> dict:
    """Decode raster pixels via Pillow and verify dimensions, optional crop box, and cover aspect ratio."""
    try:
        stream = BytesIO(source) if isinstance(source, bytes) else source.open("rb")
        with stream, Image.open(stream) as raw:
            image_format = raw.format or "UNKNOWN"
            transposed = ImageOps.exif_transpose(raw)
            try:
                transposed.load()
                src_width, src_height = transposed.size
                mode = transposed.mode
            finally:
                if transposed is not raw:
                    transposed.close()
    except (Image.DecompressionBombError, OSError, SyntaxError,
            ValueError, EOFError, struct.error, zlib.error) as error:
        raise RuleError("INVALID_IMAGE", f"Cannot decode image: {error}") from error
    if min(src_width, src_height) <= 0:
        raise RuleError("INVALID_IMAGE_DIMENSIONS", "Image dimensions must be positive.")
    width, height = src_width, src_height
    crop_meta: dict = {}
    if crop is not None:
        left, top, right, bottom = _validate_crop_box(crop, src_width, src_height)
        width, height = right - left, bottom - top
        crop_meta = {"source_width": src_width, "source_height": src_height, "crop_box": [left, top, right, bottom]}
    ok = max(width, height) * 5 <= min(width, height) * 7
    return {
        "ok": ok,
        "format": image_format,
        "mode": mode,
        **crop_meta,
        "width": width,
        "height": height,
        "ratio": max(width, height) / min(width, height),
        "pixels": width * height,
        "scope": "decoded_image",
        "full_decode_verified": True,
        "issues": [] if ok else [{"code": "COVER_RATIO_EXCEEDED"}],
    }


def inspect_cover(path: Path, crop: tuple[int, int, int, int] | None = None) -> dict:
    """Full image decode and cover geometry (or crop rectangle) check; does not prove release identity."""
    return decode_image(path, crop=crop)


CONTAINER_EXTENSIONS: dict[str, frozenset[str]] = {
    "flac": frozenset({".flac"}),
    "wav": frozenset({".wav"}),
    "aiff": frozenset({".aif", ".aiff", ".aifc"}),
    "mp3": frozenset({".mp3"}),
    "aac": frozenset({".aac"}),
    "ac3": frozenset({".ac3"}),
    "mp4": frozenset({".m4a", ".mp4", ".m4b", ".alac"}),
    "ogg": frozenset({".ogg", ".oga", ".opus", ".spx"}),
    "ape": frozenset({".ape"}),
    "wavpack": frozenset({".wv"}),
    "mpc": frozenset({".mpc", ".mp+", ".mpp"}),
    "tta": frozenset({".tta"}),
    "tak": frozenset({".tak"}),
    "ofr": frozenset({".ofr", ".ofs"}),
    "dsf": frozenset({".dsf"}),
    "dsdiff": frozenset({".dff", ".dsdiff"}),
    "asf": frozenset({".wma", ".asf"}),
}

FIXED_AUDIO_TYPES: dict[str, tuple[str, str, bool | None, bool]] = {
    "FLAC": ("flac", "flac", True, False),
    "OggFLAC": ("ogg", "flac", True, False),
    "OggVorbis": ("ogg", "vorbis", False, False),
    "OggOpus": ("ogg", "opus", False, False),
    "OggSpeex": ("ogg", "speex", False, False),
    "MP3": ("mp3", "mp3", False, False),
    "AAC": ("aac", "aac", False, False),
    "AC3": ("ac3", "ac3", False, False),
    "Musepack": ("mpc", "musepack", False, False),
    "MonkeysAudio": ("ape", "ape", True, False),
    "WavPack": ("wavpack", "wavpack", True, False),
    "TrueAudio": ("tta", "tta", True, False),
    "TAK": ("tak", "tak", True, False),
    "OptimFROG": ("ofr", "optimfrog", True, False),
    "DSF": ("dsf", "dsd", True, True),
    "DSDIFF": ("dsdiff", "dsd", True, True),
}


def _find_chunk(stream: BinaryIO, target_id: bytes, max_bytes: int, endian: str) -> bytes | None:
    while True:
        chunk_hdr = stream.read(8)
        if len(chunk_hdr) < 8:
            return None
        chunk_id, chunk_size = chunk_hdr[:4], struct.unpack(f"{endian}I", chunk_hdr[4:8])[0]
        if chunk_id == target_id:
            return stream.read(min(chunk_size, max_bytes))
        stream.seek(chunk_size + (chunk_size & 1), 1)


def _wav_extensible_codec(stream: BinaryIO) -> tuple[str, bool | None]:
    stream.seek(0)
    header = stream.read(12)
    if len(header) != 12 or header[:4] not in {b"RIFF", b"RF64"} or header[8:12] != b"WAVE":
        return "wav_extensible", None
    fmt_data = _find_chunk(stream, b"fmt ", 40, "<")
    if fmt_data is None or len(fmt_data) < 40:
        return "wav_extensible", None
    subfmt = struct.unpack("<I", fmt_data[24:28])[0]
    if subfmt == 1:
        return "pcm", True
    if subfmt == 3:
        return "pcm_float", True
    return f"wav_extensible_0x{subfmt:04x}", None


def _wav_codec(info: object, stream: BinaryIO) -> tuple[str, bool | None]:
    fmt = getattr(info, "audio_format", None)
    if fmt == 1:
        return "pcm", True
    if fmt == 3:
        return "pcm_float", True
    if fmt == 0xFFFE:
        return _wav_extensible_codec(stream)
    if isinstance(fmt, int):
        return f"wav_format_0x{fmt:04x}", False
    return "unknown", None


def _aifc_compression_codec(comp: bytes) -> tuple[str, bool | None]:
    if comp in {b"NONE", b"twos", b"sowt", b"in24", b"in32"}:
        return "pcm", True
    if comp in {b"fl32", b"FL32", b"fl64", b"FL64"}:
        return "pcm_float", True
    if comp == b"alac":
        return "alac", True
    label = comp.decode("latin1", errors="replace").strip().lower() or "unknown"
    return f"aifc_{label}", False


def _aiff_codec(stream: BinaryIO) -> tuple[str, bool | None]:
    stream.seek(0)
    header = stream.read(12)
    if len(header) != 12 or header[:4] != b"FORM" or header[8:12] != b"AIFC":
        return "pcm", True
    comm = _find_chunk(stream, b"COMM", 22, ">")
    if comm is None or len(comm) < 22:
        return "pcm", True
    return _aifc_compression_codec(comm[18:22])


def _mp4_codec(info: object) -> tuple[str, bool | None]:
    raw = (getattr(info, "codec", None) or "").strip()
    if not raw:
        raise RuleError("UNSUPPORTED_AUDIO_CONTAINER", "MP4 container has no recognized audio stream.")
    lowered = raw.lower()
    if lowered == "alac":
        return "alac", True
    if lowered == "flac":
        return "flac", True
    if lowered == "mp4a" or lowered.startswith("mp4a."):
        return "aac", False
    if lowered == "opus":
        return "opus", False
    if lowered == "ac-3":
        return "ac3", False
    if lowered == "ec-3":
        return "eac3", False
    return lowered, None


def _describe_picture(index: int, data: bytes, pic_type: int, mime: str | None,
                      description: str, issues: list[dict]) -> dict:
    label = str(id3.PictureType(int(pic_type)))
    type_name = label.removeprefix("PictureType.").lower() if label.startswith("PictureType.") else "other"
    entry: dict = {
        "index": index,
        "type": int(pic_type),
        "type_name": type_name,
        "mime": mime or None,
        "description": description or "",
        "byte_length": len(data),
    }
    try:
        decoded = decode_image(data)
        entry.update(
            decoded=True,
            format=decoded["format"],
            mode=decoded["mode"],
            width=decoded["width"],
            height=decoded["height"],
            ratio=decoded["ratio"],
            pixels=decoded["pixels"],
            ratio_ok=decoded["ok"],
            full_decode_verified=True,
        )
    except RuleError as error:
        entry.update(decoded=False, full_decode_verified=False)
        issues.append({"code": "INVALID_EMBEDDED_IMAGE", "index": index, "detail": error.issue["detail"]})
    return entry


def _text_cue_entry(field: str, text: str) -> dict:
    track_count = len(re.findall(r"(?im)^\s*TRACK\s+\d+\s+AUDIO\b", text))
    return {
        "kind": "tag_text",
        "field": field,
        "track_count": track_count,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "text": text,
    }


MP4_COVER_MIMES = {
    mp4.MP4Cover.FORMAT_PNG: "image/png",
    mp4.MP4Cover.FORMAT_JPEG: "image/jpeg",
}


def _extract_flac_cuesheet(audio: mutagen.FileType, embedded_cue: list[dict]) -> None:
    cuesheet = getattr(audio, "cuesheet", None)
    if cuesheet is None:
        return
    audio_tracks = [t for t in cuesheet.tracks if t.track_number not in (170, 255)]
    embedded_cue.append({
        "kind": "flac_cuesheet_block",
        "compact_disc": bool(cuesheet.compact_disc),
        "catalog_number": cuesheet.media_catalog_number.decode("ascii", errors="replace") or None,
        "track_count": len(audio_tracks),
        "tracks": [
            {
                "track_number": t.track_number,
                "start_offset_samples": t.start_offset,
                "isrc": t.isrc.decode("ascii", errors="replace") or None,
                "indexes": [{"number": idx.index_number, "offset_samples": idx.index_offset} for idx in t.indexes],
            }
            for t in audio_tracks
        ],
    })


def _append_text_cues(field: str, values: list[str], embedded_cue: list[dict]) -> None:
    for text_val in values:
        if text_val.strip():
            embedded_cue.append(_text_cue_entry(field, text_val))


def _decode_vorbis_picture(text_val: str, pictures: list[dict], issues: list[dict]) -> None:
    try:
        pic = flac.Picture(base64.b64decode(text_val, validate=True))
    except (mutagen.MutagenError, ValueError) as error:
        idx = len(pictures)
        pictures.append({"index": idx, "decoded": False, "full_decode_verified": False})
        issues.append({"code": "INVALID_EMBEDDED_IMAGE", "index": idx, "detail": str(error)})
    else:
        pictures.append(_describe_picture(len(pictures), pic.data, int(pic.type), pic.mime, pic.desc, issues))


def _extract_vorbis_tags(raw_tags, tags: dict[str, list[str]], embedded_cue: list[dict],
                         pictures: list[dict], issues: list[dict]) -> None:
    for raw_key, raw_val in raw_tags:
        norm_key = str(raw_key).upper()
        text_val = str(raw_val)
        if norm_key == "METADATA_BLOCK_PICTURE":
            _decode_vorbis_picture(text_val, pictures, issues)
            continue
        tags.setdefault(norm_key, []).append(text_val)
        if norm_key == "CUESHEET" and text_val.strip():
            embedded_cue.append(_text_cue_entry(str(raw_key), text_val))


def _extract_id3_text_frame(frame, tags: dict[str, list[str]], embedded_cue: list[dict]) -> None:
    values = [str(v) for v in frame.text if str(v) != ""]
    if values:
        tags.setdefault(frame.HashKey, []).extend(values)
    if isinstance(frame, id3.TXXX) and frame.desc.strip().upper() == "CUESHEET":
        _append_text_cues(frame.HashKey, values, embedded_cue)


def _extract_id3_tags(raw_tags: id3.ID3, tags: dict[str, list[str]], embedded_cue: list[dict],
                      pictures: list[dict], issues: list[dict]) -> None:
    for frame in raw_tags.values():
        if isinstance(frame, id3.APIC):
            pictures.append(_describe_picture(len(pictures), frame.data, int(frame.type), frame.mime, frame.desc, issues))
        elif hasattr(frame, "text") and isinstance(frame.text, list):
            _extract_id3_text_frame(frame, tags, embedded_cue)
        elif isinstance(frame, id3.USLT) and frame.text:
            tags.setdefault(frame.HashKey, []).append(str(frame.text))


def _render_mp4_item(item) -> str:
    if isinstance(item, (bytes, bytearray)):
        return bytes(item).decode("utf-8", errors="replace")
    if isinstance(item, tuple) and len(item) == 2:
        return f"{item[0]}/{item[1]}" if item[1] else str(item[0])
    return str(item)


def _render_mp4_values(values) -> list[str]:
    if isinstance(values, bool):
        return ["1" if values else "0"]
    return [_render_mp4_item(item) for item in values]


def _extract_mp4_covers(values, pictures: list[dict], issues: list[dict]) -> None:
    for cover in values:
        mime = MP4_COVER_MIMES.get(getattr(cover, "imageformat", None))
        pictures.append(_describe_picture(len(pictures), bytes(cover), 3, mime, "", issues))


def _extract_mp4_tags(raw_tags: mp4.MP4Tags, tags: dict[str, list[str]], embedded_cue: list[dict],
                      pictures: list[dict], issues: list[dict]) -> None:
    for key, values in raw_tags.items():
        if key == "covr":
            _extract_mp4_covers(values, pictures, issues)
            continue
        rendered = _render_mp4_values(values)
        if rendered:
            tags[str(key)] = rendered
        if str(key).lower().endswith(":cuesheet"):
            _append_text_cues(str(key), rendered, embedded_cue)


def _ape_picture_type(key_lower: str) -> int:
    if "front" in key_lower:
        return 3
    if "back" in key_lower:
        return 4
    return 0


def _handle_apev2_binary(key_str: str, item, pictures: list[dict], issues: list[dict]) -> None:
    key_lower = key_str.lower()
    if not key_lower.startswith("cover art"):
        return
    raw_bytes = bytes(item.value)
    desc_bytes, sep, img_bytes = raw_bytes.partition(b"\x00")
    payload = img_bytes if sep else raw_bytes
    desc = desc_bytes.decode("utf-8", errors="replace") if sep else ""
    pic_type = _ape_picture_type(key_lower)
    pictures.append(_describe_picture(len(pictures), payload, pic_type, None, desc, issues))


def _extract_apev2_tags(raw_tags: apev2.APEv2, tags: dict[str, list[str]], embedded_cue: list[dict],
                        pictures: list[dict], issues: list[dict]) -> None:
    for key, item in raw_tags.items():
        key_str = str(key)
        if item.kind == apev2.BINARY:
            _handle_apev2_binary(key_str, item, pictures, issues)
            continue
        rendered = [str(v) for v in item if str(v) != ""]
        if rendered:
            tags[key_str] = rendered
        if key_str.strip().upper() == "CUESHEET":
            _append_text_cues(key_str, rendered, embedded_cue)


def _extract_generic_tags(raw_tags, tags: dict[str, list[str]]) -> None:
    for key, values in raw_tags.items():
        items = values if isinstance(values, (list, tuple)) else [values]
        rendered = [str(v) for v in items if v is not None and str(v) != ""]
        if rendered:
            tags[str(key)] = rendered


def _extract_metadata(audio: mutagen.FileType, issues: list[dict]) -> tuple[str | None, dict[str, list[str]], list[dict], list[dict]]:
    tags: dict[str, list[str]] = {}
    embedded_cue: list[dict] = []
    pictures: list[dict] = []
    _extract_flac_cuesheet(audio, embedded_cue)
    for pic in getattr(audio, "pictures", None) or ():
        pictures.append(_describe_picture(len(pictures), pic.data, int(pic.type), pic.mime, pic.desc, issues))
    raw_tags = audio.tags
    if raw_tags is None:
        return None, tags, embedded_cue, pictures
    if hasattr(raw_tags, "vendor"):
        _extract_vorbis_tags(raw_tags, tags, embedded_cue, pictures, issues)
        return "vorbis", tags, embedded_cue, pictures
    if isinstance(raw_tags, id3.ID3):
        _extract_id3_tags(raw_tags, tags, embedded_cue, pictures, issues)
        return "id3", tags, embedded_cue, pictures
    if isinstance(raw_tags, mp4.MP4Tags):
        _extract_mp4_tags(raw_tags, tags, embedded_cue, pictures, issues)
        return "mp4", tags, embedded_cue, pictures
    if isinstance(raw_tags, apev2.APEv2):
        _extract_apev2_tags(raw_tags, tags, embedded_cue, pictures, issues)
        return "apev2", tags, embedded_cue, pictures
    _extract_generic_tags(raw_tags, tags)
    return type(raw_tags).__name__.lower(), tags, embedded_cue, pictures


def _detect_audio_format(audio: mutagen.FileType, stream: BinaryIO) -> tuple[str, str, bool | None, bool]:
    kind_name = type(audio).__name__
    if kind_name in {"ID3FileType", "APEv2File", "SMF", "OggTheora"}:
        raise RuleError("UNRECOGNIZED_AUDIO", f"Unsupported or non-audio stream type: {kind_name}")
    if kind_name in FIXED_AUDIO_TYPES:
        return FIXED_AUDIO_TYPES[kind_name]
    info = audio.info
    if kind_name == "WAVE":
        codec, lossless = _wav_codec(info, stream)
        return "wav", codec, lossless, False
    if kind_name == "AIFF":
        codec, lossless = _aiff_codec(stream)
        return "aiff", codec, lossless, False
    if kind_name == "MP4":
        codec, lossless = _mp4_codec(info)
        return "mp4", codec, lossless, False
    if kind_name == "ASF":
        codec_name = str(getattr(info, "codec_name", "") or getattr(info, "codec_type", ""))
        lossless = "lossless" in codec_name.lower()
        return "asf", ("wma_lossless" if lossless else "wma"), lossless, False
    raise RuleError("UNRECOGNIZED_AUDIO", f"Unsupported audio container type: {kind_name}")


def _positive_int(value: object) -> int | None:
    return int(value) if isinstance(value, int) and value > 0 else None


def _stream_summary(info: object) -> dict:
    length = getattr(info, "length", None)
    bitrate = getattr(info, "bitrate", None)
    total_samples = getattr(info, "total_samples", None)
    md5_raw = getattr(info, "md5_signature", None)
    return {
        "duration_seconds": float(length) if isinstance(length, (int, float)) else None,
        "sample_rate": _positive_int(getattr(info, "sample_rate", None)),
        "channels": _positive_int(getattr(info, "channels", None)),
        "bits_per_sample": _positive_int(getattr(info, "bits_per_sample", None)),
        "bitrate": int(bitrate) if isinstance(bitrate, (int, float)) and bitrate > 0 else None,
        "total_samples": int(total_samples) if isinstance(total_samples, int) and total_samples >= 0 else None,
        "md5_signature": f"{md5_raw:032x}" if isinstance(md5_raw, int) and md5_raw > 0 else None,
    }


def inspect_audio(path: Path) -> dict:
    """Read-only audio container, codec, stream header, native tags, embedded CUE, and artwork inspection."""
    try:
        with path.open("rb") as stream:
            audio = mutagen.File(stream)
            if audio is None:
                raise RuleError("UNRECOGNIZED_AUDIO", "Unrecognized audio container or stream header.")
            container, codec, lossless, dsd = _detect_audio_format(audio, stream)
            issues: list[dict] = []
            extension = path.suffix.lower()
            expected_exts = CONTAINER_EXTENSIONS.get(container, frozenset())
            extension_matches = bool(extension and extension in expected_exts)
            if not extension_matches:
                issues.append({"code": "CONTAINER_EXTENSION_MISMATCH", "extension": extension, "container": container})
            tag_format, tags, embedded_cue, pictures = _extract_metadata(audio, issues)
            return {
                "ok": not issues,
                "container": container,
                "codec": codec,
                "lossless": lossless,
                "dsd": dsd,
                "extension": extension,
                "extension_matches_container": extension_matches,
                "stream": _stream_summary(audio.info),
                "tag_format": tag_format,
                "tags": tags,
                "embedded_cue": embedded_cue,
                "pictures": pictures,
                "scope": "header_and_metadata_only",
                "full_audio_decode_verified": False,
                "issues": issues,
            }
    except RuleError:
        raise
    except (mutagen.MutagenError, OSError, EOFError, struct.error, ValueError) as error:
        raise RuleError("INVALID_AUDIO", f"Cannot parse audio container or metadata: {error}") from error
