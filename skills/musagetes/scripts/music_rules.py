"""Pure music metadata/path checks and bounded image-header inspection."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re
import struct
import unicodedata
import zlib


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


def read_whitelist(path: Path | None = None) -> Whitelist:
    path = path or Path(__file__).resolve().parent.parent / "references/metadata-whitelist.md"
    allowed, common, album, omittable = set(), set(), set(), set()
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
        if section not in {"必填白名单", "选填白名单"} or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        match = re.match(r"^`([^`]+)`(?:\s*/.*)?$", cells[0])
        if not match:
            if cells[0] not in {"Vorbis 键 / 语义", "Vorbis 键", "封面"} and not re.fullmatch(r":?-+:?", cells[0]):
                raise RuleError("INVALID_WHITELIST", "Expected a backtick-delimited field in a whitelist row.")
            continue
        if len(cells) < (3 if section == "必填白名单" else 2):
            raise RuleError("INVALID_WHITELIST", "Malformed whitelist table row.")
        key = match[1]
        if key in allowed:
            raise RuleError("INVALID_WHITELIST", f"Duplicate field declaration: {key}")
        allowed.add(key)
        if section == "必填白名单":
            if cells[1] in {"所有音轨", "所有音轨；可记录缺失"}:
                common.add(key)
                if cells[1] == "所有音轨；可记录缺失":
                    omittable.add(key)
            elif cells[1] == "有专辑归属的音轨":
                album.add(key)
            else:
                raise RuleError("INVALID_WHITELIST", f"Unknown required scope for {key}: {cells[1]}")
    if not common or not album or not (allowed - common - album):
        raise RuleError("INVALID_WHITELIST", "Required or optional field tables could not be parsed.")
    return Whitelist(frozenset(allowed), frozenset(common), frozenset(album), frozenset(omittable))


def check_tags(tags: dict, kind: str = "album", whitelist: Whitelist | None = None, *, omissions: dict | None = None) -> dict:
    whitelist = whitelist or read_whitelist()
    if kind not in ("album", "singleton") or not isinstance(tags, dict):
        raise RuleError("INVALID_TAG_INPUT", "Use kind album/singleton and a canonical tag dictionary.")
    omissions = {} if omissions is None else omissions
    if not isinstance(omissions, dict):
        raise RuleError("INVALID_OMISSIONS", "omissions must map permitted missing fields to documented reasons.")
    issues = []
    accepted_omissions = {}
    for key, reason in omissions.items():
        if key not in whitelist.omittable:
            issues.append({"code": "OMISSION_NOT_ALLOWED", "field": key})
        elif key in tags:
            issues.append({"code": "OMITTED_TAG_PRESENT", "field": key})
        elif not isinstance(reason, str) or not reason.strip():
            issues.append({"code": "MISSING_OMISSION_REASON", "field": key})
        else:
            accepted_omissions[key] = reason
    required = whitelist.common_required | (whitelist.album_required if kind == "album" else frozenset())
    for key in tags:
        if key not in whitelist.allowed:
            issues.append({"code": "UNKNOWN_TAG", "field": key})
    for key, values in tags.items():
        if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values):
            issues.append({"code": "INVALID_TAG_VALUES", "field": key})
    for key in sorted(required):
        if key not in tags and key not in accepted_omissions:
            issues.append({"code": "MISSING_REQUIRED_TAG", "field": key})
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
    if not re.fullmatch(r"[0-9]+", value) or int(value) < 1:
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
    if not re.fullmatch(r"[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?", release_date):
        raise RuleError("INVALID_DATE", "DATE must be YYYY, YYYY-MM or YYYY-MM-DD.")
    components = [int(v) for v in release_date.split("-")]
    try:
        date(*(components + [1] * (3 - len(components))))
    except ValueError as error:
        raise RuleError("INVALID_DATE", str(error)) from error
    if kind == "singleton":
        if any(k in tags for k in (whitelist or read_whitelist()).album_required):
            raise RuleError("KIND_MISMATCH", "A singleton has no album/track/disc fields.")
        return sanitize_component(f"[{artist}][{title}]") + extension
    album = scalar(tags, "ALBUM")
    album_artist = " & ".join(tags["ALBUMARTIST"])
    disc, disc_total = positive_number(tags, "DISCNUMBER"), positive_number(tags, "DISCTOTAL")
    track, track_total = positive_number(tags, "TRACKNUMBER"), positive_number(tags, "TRACKTOTAL")
    if disc > disc_total or track > track_total:
        raise RuleError("INVALID_LOCAL_NUMBERING", "Current disc/track exceeds its total.")
    prefix = f"{disc:02d}{track:02d}" if disc_total > 1 else f"{track:02d}"
    directory = sanitize_component(f"[{album_artist}][{album}][{release_date[:4]}]")
    filename = sanitize_component(f"{prefix} - {title} - {artist}") + extension
    return f"{directory}/{filename}"


def inspect_cover(path: Path) -> dict:
    """Read PNG/JPEG headers; this is not a full image decode or identity check."""
    with path.open("rb") as stream:
        signature = stream.read(8)
        if signature == b"\x89PNG\r\n\x1a\n":
            header = stream.read(25)
            if len(header) != 25 or header[:8] != b"\0\0\0\rIHDR":
                raise RuleError("INVALID_IMAGE_HEADER", "Missing PNG IHDR.")
            if zlib.crc32(header[4:21]) & 0xFFFFFFFF != struct.unpack(">I", header[21:25])[0]:
                raise RuleError("INVALID_IMAGE_HEADER", "PNG IHDR checksum failed.")
            width, height = struct.unpack(">II", header[8:16])
            image_format = "PNG"
        elif signature.startswith(b"\xff\xd8"):
            stream.seek(2)
            size = path.stat().st_size
            while True:
                if stream.read(1) != b"\xff":
                    raise RuleError("INVALID_IMAGE_HEADER", "Expected JPEG marker before image data.")
                marker = stream.read(1)
                while marker == b"\xff":
                    marker = stream.read(1)
                if not marker or marker[0] in {0, 0xD8, 0xD9, 0xDA}:
                    raise RuleError("INVALID_IMAGE_HEADER", "JPEG dimensions unavailable before scan data.")
                if marker[0] in {0x01, *range(0xD0, 0xD8)}:
                    continue
                raw_length = stream.read(2)
                if len(raw_length) != 2:
                    raise RuleError("INVALID_IMAGE_HEADER", "Truncated JPEG marker length.")
                length = struct.unpack(">H", raw_length)[0]
                if length < 2 or stream.tell() + length - 2 > size:
                    raise RuleError("INVALID_IMAGE_HEADER", "JPEG segment extends beyond the file.")
                if marker[0] in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                    data = stream.read(length - 2)
                    if len(data) < 6 or data[5] == 0 or len(data) != 6 + 3 * data[5]:
                        raise RuleError("INVALID_IMAGE_HEADER", "Invalid JPEG frame header.")
                    height, width = struct.unpack(">HH", data[1:5])
                    image_format = "JPEG"
                    break
                stream.seek(length - 2, 1)
        else:
            raise RuleError("UNSUPPORTED_IMAGE_HEADER", "Use an installed decoder for formats other than PNG/JPEG.")
    if min(width, height) <= 0:
        raise RuleError("INVALID_IMAGE_DIMENSIONS", "Image dimensions must be positive.")
    return {"ok": max(width, height) * 5 <= min(width, height) * 7,
            "format": image_format, "width": width, "height": height,
            "ratio": max(width, height) / min(width, height), "pixels": width * height,
            "scope": "header_geometry_only", "full_decode_verified": False,
            "issues": [] if max(width, height) * 5 <= min(width, height) * 7 else [{"code": "COVER_RATIO_EXCEEDED"}]}
