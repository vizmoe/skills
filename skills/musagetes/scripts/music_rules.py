"""Pure music metadata/path checks, full image decoding, and read-only audio header/metadata inspection."""
from __future__ import annotations

import base64
import binascii
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
from PIL import Image, ImageOps, UnidentifiedImageError


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


DIMENSIONS = {"执行": "execution", "匹配": "match", "处置": "disposition"}
# Values the helpers branch on. A reference rename must fail loudly, not silently disable a check.
BRANCHED_ON = {"phases": ("PLANNED", "FINALIZED"),
               "execution": ("COMPLETED", "SKIPPED", "REVIEW_REQUIRED"),
               "match": ("FULL", "PARTIAL_MATCH", "UNCONFIRMED")}


def read_vocabulary(delivery: Path | None = None, execution: Path | None = None) -> Vocabulary:
    """Parse transaction phases and status values from the reference tables, never a second copy."""
    references = Path(__file__).resolve().parent.parent / "references"
    groups: dict[str, set[str]] = {name: set() for name in DIMENSIONS.values()}
    section = None
    for line in (delivery or references / "delivery.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
        if section != "状态与最终报告" or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 3:
            raise RuleError("INVALID_STATUS_TABLE", "Malformed status table row.")
        if cells[0] == "维度" or re.fullmatch(r":?-+:?", cells[0]):
            continue
        if cells[0] not in DIMENSIONS:
            raise RuleError("INVALID_STATUS_TABLE", f"Unknown status dimension: {cells[0]}")
        value = re.fullmatch(r"`([A-Z][A-Z_]*)`", cells[1])
        if not value:
            raise RuleError("INVALID_STATUS_TABLE", f"Expected one backtick-delimited status value: {cells[1]}")
        if any(value[1] in group for group in groups.values()):
            raise RuleError("INVALID_STATUS_TABLE", f"Duplicate status declaration: {value[1]}")
        groups[DIMENSIONS[cells[0]]].add(value[1])
    if not all(groups.values()):
        raise RuleError("INVALID_STATUS_TABLE", "References must declare every status dimension.")
    phases: tuple[str, ...] = ()
    section = None
    for line in (execution or references / "execution.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            section = line[3:].strip()
        if section == "事务与恢复" and (found := re.search(r"`([A-Z_]+(?:\s*→\s*[A-Z_]+)+)`", line)):
            phases = tuple(part.strip() for part in found[1].split("→"))
            break
    if len(phases) != len(set(phases)):
        raise RuleError("INVALID_STATUS_TABLE", "Transaction phases must be unique.")
    vocabulary = Vocabulary(phases, frozenset(groups["execution"]),
                            frozenset(groups["match"]), frozenset(groups["disposition"]))
    for name, expected in BRANCHED_ON.items():
        declared = getattr(vocabulary, name)
        if not declared or not set(expected) <= set(declared):
            raise RuleError("INVALID_STATUS_TABLE", f"References must declare {name}: {', '.join(expected)}")
    return vocabulary


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


# Path rendering reads these as one value each; tools.md documents the value rules.
SINGLE_VALUED = ("TITLE", "DATE", "ALBUM")
NUMBER_PAIRS = (("TRACKNUMBER", "TRACKTOTAL"), ("DISCNUMBER", "DISCTOTAL"))
DATE_PATTERN = re.compile(r"[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?")


def valid_date(value: str) -> bool:
    if not DATE_PATTERN.fullmatch(value):
        return False
    components = [int(v) for v in value.split("-")]
    try:
        date(*(components + [1] * (3 - len(components))))
    except ValueError:
        return False
    return True


def value_issues(tags: dict) -> list[dict]:
    """Value rules shared by check-tags and render-paths, so a passing check always renders."""
    issues = []
    usable = lambda key: isinstance(tags.get(key), list) and tags[key] and all(isinstance(v, str) and v.strip() for v in tags[key])
    for key in SINGLE_VALUED:
        if usable(key) and len(tags[key]) != 1:
            issues.append({"code": "MULTIPLE_VALUES", "field": key})
    if usable("DATE") and len(tags["DATE"]) == 1 and not valid_date(tags["DATE"][0]):
        issues.append({"code": "INVALID_DATE", "field": "DATE"})
    numbers = {}
    for pair in NUMBER_PAIRS:
        for key in pair:
            if not usable(key):
                continue
            values = tags[key]
            if len(values) != 1 or not re.fullmatch(r"[0-9]+", values[0]) or int(values[0]) < 1:
                issues.append({"code": "INVALID_NUMBER", "field": key})
            else:
                numbers[key] = int(values[0])
        current, total = pair
        if current in numbers and total in numbers and numbers[current] > numbers[total]:
            issues.append({"code": "NUMBER_EXCEEDS_TOTAL", "field": current})
    return issues


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
    if kind == "singleton":
        if any(k in tags for k in (whitelist or read_whitelist()).album_required):
            raise RuleError("KIND_MISMATCH", "A singleton has no album/track/disc fields.")
        return sanitize_component(f"[{artist}][{title}]") + extension
    album = scalar(tags, "ALBUM")
    album_artist = " & ".join(tags["ALBUMARTIST"])
    disc, disc_total = positive_number(tags, "DISCNUMBER"), positive_number(tags, "DISCTOTAL")
    track, track_total = positive_number(tags, "TRACKNUMBER"), positive_number(tags, "TRACKTOTAL")
    prefix = f"{disc:02d}{track:02d}" if disc_total > 1 else f"{track:02d}"
    directory = sanitize_component(f"[{album_artist}][{album}][{release_date[:4]}]")
    filename = sanitize_component(f"{prefix} - {title} - {artist}") + extension
    return f"{directory}/{filename}"


def decode_image(source: Path | bytes) -> dict:
    """Decode raster pixels via Pillow and verify dimensions and cover aspect ratio."""
    try:
        stream = BytesIO(source) if isinstance(source, bytes) else source.open("rb")
        with stream:
            with Image.open(stream) as raw:
                image_format = raw.format or "UNKNOWN"
                transposed = ImageOps.exif_transpose(raw)
                try:
                    transposed.load()
                    width, height = transposed.size
                    mode = transposed.mode
                finally:
                    if transposed is not raw:
                        transposed.close()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError,
            ValueError, EOFError, struct.error, zlib.error) as error:
        raise RuleError("INVALID_IMAGE", f"Cannot decode image: {error}") from error
    if min(width, height) <= 0:
        raise RuleError("INVALID_IMAGE_DIMENSIONS", "Image dimensions must be positive.")
    ok = max(width, height) * 5 <= min(width, height) * 7
    return {
        "ok": ok,
        "format": image_format,
        "mode": mode,
        "width": width,
        "height": height,
        "ratio": max(width, height) / min(width, height),
        "pixels": width * height,
        "scope": "decoded_image",
        "full_decode_verified": True,
        "issues": [] if ok else [{"code": "COVER_RATIO_EXCEEDED"}],
    }


def inspect_cover(path: Path) -> dict:
    """Full image decode and cover geometry check; does not prove release identity."""
    return decode_image(path)


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


def _wav_codec(info: object, stream: BinaryIO) -> tuple[str, bool | None]:
    fmt = getattr(info, "audio_format", None)
    if fmt == 1:
        return "pcm", True
    if fmt == 3:
        return "pcm_float", True
    if fmt == 0xFFFE:
        stream.seek(0)
        header = stream.read(12)
        if len(header) == 12 and header[:4] in {b"RIFF", b"RF64"} and header[8:12] == b"WAVE":
            while True:
                chunk_hdr = stream.read(8)
                if len(chunk_hdr) < 8:
                    break
                chunk_id, chunk_size = chunk_hdr[:4], struct.unpack("<I", chunk_hdr[4:8])[0]
                if chunk_id == b"fmt ":
                    fmt_data = stream.read(min(chunk_size, 40))
                    if len(fmt_data) >= 40:
                        subfmt = struct.unpack("<I", fmt_data[24:28])[0]
                        if subfmt == 1:
                            return "pcm", True
                        if subfmt == 3:
                            return "pcm_float", True
                        return f"wav_extensible_0x{subfmt:04x}", None
                    break
                stream.seek(chunk_size + (chunk_size & 1), 1)
        return "wav_extensible", None
    if isinstance(fmt, int):
        return f"wav_format_0x{fmt:04x}", False
    return "unknown", None


def _aiff_codec(stream: BinaryIO) -> tuple[str, bool | None]:
    stream.seek(0)
    header = stream.read(12)
    if len(header) == 12 and header[:4] == b"FORM":
        form_type = header[8:12]
        if form_type == b"AIFF":
            return "pcm", True
        if form_type == b"AIFC":
            while True:
                chunk_hdr = stream.read(8)
                if len(chunk_hdr) < 8:
                    break
                chunk_id, chunk_size = chunk_hdr[:4], struct.unpack(">I", chunk_hdr[4:8])[0]
                if chunk_id == b"COMM":
                    comm = stream.read(min(chunk_size, 22))
                    if len(comm) >= 22:
                        comp = comm[18:22]
                        if comp in {b"NONE", b"twos", b"sowt", b"in24", b"in32"}:
                            return "pcm", True
                        if comp in {b"fl32", b"FL32", b"fl64", b"FL64"}:
                            return "pcm_float", True
                        if comp == b"alac":
                            return "alac", True
                        label = comp.decode("latin1", errors="replace").strip().lower() or "unknown"
                        return f"aifc_{label}", False
                    break
                stream.seek(chunk_size + (chunk_size & 1), 1)
    return "pcm", True


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


def _extract_metadata(audio: mutagen.FileType, issues: list[dict]) -> tuple[str | None, dict[str, list[str]], list[dict], list[dict]]:
    tags: dict[str, list[str]] = {}
    embedded_cue: list[dict] = []
    pictures: list[dict] = []

    cuesheet = getattr(audio, "cuesheet", None)
    if cuesheet is not None:
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

    for pic in getattr(audio, "pictures", None) or ():
        pictures.append(_describe_picture(len(pictures), pic.data, int(pic.type), pic.mime, pic.desc, issues))

    raw_tags = audio.tags
    if raw_tags is None:
        return None, tags, embedded_cue, pictures

    if hasattr(raw_tags, "vendor"):
        for raw_key, raw_val in list(raw_tags):
            norm_key = str(raw_key).upper()
            text_val = str(raw_val)
            if norm_key == "METADATA_BLOCK_PICTURE":
                try:
                    pic = flac.Picture(base64.b64decode(text_val, validate=True))
                except (binascii.Error, mutagen.MutagenError, ValueError) as error:
                    idx = len(pictures)
                    pictures.append({"index": idx, "decoded": False, "full_decode_verified": False})
                    issues.append({"code": "INVALID_EMBEDDED_IMAGE", "index": idx, "detail": str(error)})
                else:
                    pictures.append(_describe_picture(len(pictures), pic.data, int(pic.type), pic.mime, pic.desc, issues))
                continue
            tags.setdefault(norm_key, []).append(text_val)
            if norm_key == "CUESHEET" and text_val.strip():
                embedded_cue.append(_text_cue_entry(str(raw_key), text_val))
        return "vorbis", tags, embedded_cue, pictures

    if isinstance(raw_tags, id3.ID3):
        for frame in raw_tags.values():
            if isinstance(frame, id3.APIC):
                pictures.append(_describe_picture(len(pictures), frame.data, int(frame.type), frame.mime, frame.desc, issues))
            elif hasattr(frame, "text") and isinstance(frame.text, list):
                values = [str(v) for v in frame.text if str(v) != ""]
                if values:
                    tags.setdefault(frame.HashKey, []).extend(values)
                if isinstance(frame, id3.TXXX) and frame.desc.strip().upper() == "CUESHEET":
                    for text_val in values:
                        if text_val.strip():
                            embedded_cue.append(_text_cue_entry(frame.HashKey, text_val))
            elif isinstance(frame, id3.USLT) and frame.text:
                tags.setdefault(frame.HashKey, []).append(str(frame.text))
        return "id3", tags, embedded_cue, pictures

    if isinstance(raw_tags, mp4.MP4Tags):
        for key, values in raw_tags.items():
            if key == "covr":
                for cover in values:
                    fmt = getattr(cover, "imageformat", None)
                    mime = ("image/png" if fmt == mp4.MP4Cover.FORMAT_PNG
                            else "image/jpeg" if fmt == mp4.MP4Cover.FORMAT_JPEG else None)
                    pictures.append(_describe_picture(len(pictures), bytes(cover), 3, mime, "", issues))
                continue
            if isinstance(values, bool):
                rendered = ["1" if values else "0"]
            else:
                rendered = []
                for item in values:
                    if isinstance(item, (bytes, bytearray)):
                        rendered.append(bytes(item).decode("utf-8", errors="replace"))
                    elif isinstance(item, tuple) and len(item) == 2:
                        rendered.append(f"{item[0]}/{item[1]}" if item[1] else str(item[0]))
                    else:
                        rendered.append(str(item))
            if rendered:
                tags[str(key)] = rendered
            if str(key).lower().endswith(":cuesheet"):
                for text_val in rendered:
                    if text_val.strip():
                        embedded_cue.append(_text_cue_entry(str(key), text_val))
        return "mp4", tags, embedded_cue, pictures

    if isinstance(raw_tags, apev2.APEv2):
        for key, item in raw_tags.items():
            if item.kind == apev2.BINARY:
                if str(key).lower().startswith("cover art"):
                    raw_bytes = bytes(item.value)
                    desc_bytes, sep, img_bytes = raw_bytes.partition(b"\x00")
                    payload = img_bytes if sep else raw_bytes
                    desc = desc_bytes.decode("utf-8", errors="replace") if sep else ""
                    pic_type = 3 if "front" in str(key).lower() else (4 if "back" in str(key).lower() else 0)
                    pictures.append(_describe_picture(len(pictures), payload, pic_type, None, desc, issues))
                continue
            rendered = [str(v) for v in item if str(v) != ""]
            if rendered:
                tags[str(key)] = rendered
            if str(key).strip().upper() == "CUESHEET":
                for text_val in rendered:
                    if text_val.strip():
                        embedded_cue.append(_text_cue_entry(str(key), text_val))
        return "apev2", tags, embedded_cue, pictures

    for key, values in raw_tags.items():
        items = values if isinstance(values, (list, tuple)) else [values]
        rendered = [str(v) for v in items if v is not None and str(v) != ""]
        if rendered:
            tags[str(key)] = rendered
    return type(raw_tags).__name__.lower(), tags, embedded_cue, pictures


def inspect_audio(path: Path) -> dict:
    """Read-only audio container, codec, stream header, native tags, embedded CUE, and artwork inspection."""
    try:
        with path.open("rb") as stream:
            audio = mutagen.File(stream)
            if audio is None:
                raise RuleError("UNRECOGNIZED_AUDIO", "Unrecognized audio container or stream header.")
            kind_name = type(audio).__name__
            if kind_name in {"ID3FileType", "APEv2File", "SMF", "OggTheora"}:
                raise RuleError("UNRECOGNIZED_AUDIO", f"Unsupported or non-audio stream type: {kind_name}")
            info = audio.info
            dsd = False
            if kind_name in FIXED_AUDIO_TYPES:
                container, codec, lossless, dsd = FIXED_AUDIO_TYPES[kind_name]
            elif kind_name == "WAVE":
                container = "wav"
                codec, lossless = _wav_codec(info, stream)
            elif kind_name == "AIFF":
                container = "aiff"
                codec, lossless = _aiff_codec(stream)
            elif kind_name == "MP4":
                container = "mp4"
                codec, lossless = _mp4_codec(info)
            elif kind_name == "ASF":
                container = "asf"
                codec_name = str(getattr(info, "codec_name", "") or getattr(info, "codec_type", ""))
                lossless = "lossless" in codec_name.lower()
                codec = "wma_lossless" if lossless else "wma"
            else:
                raise RuleError("UNRECOGNIZED_AUDIO", f"Unsupported audio container type: {kind_name}")

            issues: list[dict] = []
            extension = path.suffix.lower()
            expected_exts = CONTAINER_EXTENSIONS.get(container, frozenset())
            extension_matches = bool(extension and extension in expected_exts)
            if not extension_matches:
                issues.append({"code": "CONTAINER_EXTENSION_MISMATCH", "extension": extension, "container": container})

            tag_format, tags, embedded_cue, pictures = _extract_metadata(audio, issues)
            md5_raw = getattr(info, "md5_signature", None)
            total_samples = getattr(info, "total_samples", None)
            sample_rate = getattr(info, "sample_rate", None)
            channels = getattr(info, "channels", None)
            bits_per_sample = getattr(info, "bits_per_sample", None)
            bitrate = getattr(info, "bitrate", None)
            length = getattr(info, "length", None)

            return {
                "ok": not issues,
                "container": container,
                "codec": codec,
                "lossless": lossless,
                "dsd": dsd,
                "extension": extension,
                "extension_matches_container": extension_matches,
                "stream": {
                    "duration_seconds": float(length) if isinstance(length, (int, float)) else None,
                    "sample_rate": int(sample_rate) if isinstance(sample_rate, int) and sample_rate > 0 else None,
                    "channels": int(channels) if isinstance(channels, int) and channels > 0 else None,
                    "bits_per_sample": int(bits_per_sample) if isinstance(bits_per_sample, int) and bits_per_sample > 0 else None,
                    "bitrate": int(bitrate) if isinstance(bitrate, (int, float)) and bitrate > 0 else None,
                    "total_samples": int(total_samples) if isinstance(total_samples, int) and total_samples >= 0 else None,
                    "md5_signature": f"{md5_raw:032x}" if isinstance(md5_raw, int) and md5_raw > 0 else None,
                },
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
