from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
import zlib

from mutagen import flac, id3, mp4, wave as mutagen_wave
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'skills/musagetes/scripts'))
import library_guard as guard
import music_rules as rules


def album_tags():
    return {'TITLE': ['雨: / 夜'], 'ARTIST': ['麻枝准', '熊木杏里'], 'DATE': ['2024-02-29'],
            'COUNTRY': ['Japan'], 'GENRE': ['J-Pop'], 'ALBUM': ['作品'],
            'ALBUMARTIST': ['麻枝准', '熊木杏里'], 'TRACKNUMBER': ['01'],
            'TRACKTOTAL': ['02'], 'DISCNUMBER': ['01'], 'DISCTOTAL': ['01']}


def png_header(width, height):
    data = b'IHDR' + struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + data + struct.pack('>I', zlib.crc32(data))


def jpeg_header(width, height, marker=0xC0):
    data = b'\x08' + struct.pack('>HH', height, width) + b'\x01\x01\x11\x00'
    return b'\xff\xd8\xff\xe0\x00\x04xx\xff' + bytes([marker]) + struct.pack('>H', len(data) + 2) + data


class VocabularyTests(unittest.TestCase):
    """The reference tables, not a second copy in code, decide the accepted status values."""

    def setUp(self):
        self.references = Path(rules.__file__).resolve().parents[1] / 'references'
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def rewritten(self, name, *replacements):
        path = self.directory / name
        text = (self.references / name).read_text()
        for old, new in replacements:
            self.assertIn(old, text)
            text = text.replace(old, new)
        path.write_text(text)
        return path

    def validate(self, vocabulary, **updates):
        root = self.directory.resolve()
        event = {'schema_version': 1, 'root': str(root), 'run_id': 'r1', 'album_id': 'a1',
                 'sequence': 1, 'skill_version': guard.skill_version(), 'phase': 'FINALIZED',
                 'status': 'COMPLETED', 'match_status': 'FULL',
                 'expected_files': [{'path': 'album/01.flac', 'sha256': '0' * 64, 'role': 'output'}],
                 'removed_paths': [], **updates}
        guard.validate_event(event, root, 'r1', 'a1', '000001.json', None, vocabulary)

    def test_documented_values_are_the_executed_values(self):
        vocabulary = rules.read_vocabulary()
        self.assertEqual(vocabulary.phases, ('PLANNED', 'STAGED', 'VERIFIED', 'COMMITTED', 'FINALIZED'))
        self.assertEqual(vocabulary.execution, frozenset({'COMPLETED', 'SKIPPED', 'REVIEW_REQUIRED', 'FAILED'}))
        self.assertEqual(vocabulary.match, frozenset({'FULL', 'PARTIAL_MATCH', 'UNCONFIRMED'}))
        self.assertEqual(vocabulary.disposition, frozenset({'PRESERVED'}))

    def test_a_status_added_to_the_table_is_accepted_by_history_validation(self):
        delivery = self.rewritten('delivery.md', ('| 处置 | `PRESERVED` |', '| 执行 | `DEFERRED` | 临时测试状态 |\n| 处置 | `PRESERVED` |'))
        vocabulary = rules.read_vocabulary(delivery)
        self.assertIn('DEFERRED', vocabulary.execution)
        self.assertNotIn('DEFERRED', rules.read_vocabulary().execution)
        self.validate(vocabulary, status='DEFERRED')
        default_vocabulary = rules.read_vocabulary()
        with self.assertRaises(guard.GuardError):
            self.validate(default_vocabulary, status='DEFERRED')

    def test_the_documented_phase_order_decides_the_terminal_phase(self):
        execution = self.rewritten('execution.md', ('`PLANNED → STAGED → VERIFIED → COMMITTED → FINALIZED`',
                                                    '`PLANNED → STAGED → VERIFIED → FINALIZED → COMMITTED`'))
        vocabulary = rules.read_vocabulary(None, execution)
        self.validate(vocabulary, phase='COMMITTED')
        with self.assertRaisesRegex(guard.GuardError, 'COMMITTED'):
            self.validate(vocabulary, phase='FINALIZED')

    def test_a_missing_status_dimension_fails(self):
        delivery = self.rewritten('delivery.md', ('| 处置 | `PRESERVED` |', 'Removed disposition row:'))
        with self.assertRaises(rules.RuleError):
            rules.read_vocabulary(delivery)

    def test_duplicate_transaction_phases_fail(self):
        execution = self.rewritten('execution.md', ('PLANNED → STAGED', 'PLANNED → PLANNED → STAGED'))
        with self.assertRaises(rules.RuleError):
            rules.read_vocabulary(None, execution)

    def test_dropping_a_value_the_helpers_branch_on_fails_loudly(self):
        for row in ('| 执行 | `COMPLETED` |', '| 执行 | `SKIPPED` |', '| 匹配 | `FULL` |',
                    '| 匹配 | `PARTIAL_MATCH` |', '| 匹配 | `UNCONFIRMED` |'):
            with self.subTest(row=row):
                text = (self.references / 'delivery.md').read_text()
                start = text.index(row)
                removed = text[:start] + text[text.index('\n', start) + 1:]
                path = self.directory / 'dropped.md'
                path.write_text(removed)
                with self.assertRaisesRegex(rules.RuleError, 'must declare'):
                    rules.read_vocabulary(path)

    def test_an_unparsable_status_table_fails(self):
        cases = {
            'unknown dimension': ('| 执行 | `COMPLETED` |', '| 阶段 | `COMPLETED` |'),
            'unquoted value': ('| 执行 | `FAILED` |', '| 执行 | FAILED |'),
            'duplicate value': ('| 处置 | `PRESERVED` |', '| 执行 | `PRESERVED` |\n| 处置 | `PRESERVED` |'),
        }
        for label, (old, new) in cases.items():
            with self.subTest(case=label):
                delivery = self.rewritten('delivery.md', (old, new))
                with self.assertRaises(rules.RuleError):
                    rules.read_vocabulary(delivery)

    def test_a_missing_phase_sequence_fails(self):
        execution = self.rewritten('execution.md', ('`PLANNED → STAGED → VERIFIED → COMMITTED → FINALIZED`', 'the documented order'))
        with self.assertRaisesRegex(rules.RuleError, 'must declare'):
            rules.read_vocabulary(None, execution)

    def test_history_validation_rejects_values_outside_the_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'album/01.flac'
            output.parent.mkdir()
            output.write_bytes(b'synthetic verified output')
            def event(**updates):
                return {'schema_version': 1, 'root': str(root), 'run_id': 'r1', 'album_id': 'a1',
                        'sequence': 1, 'skill_version': guard.skill_version(), 'phase': 'FINALIZED',
                        'status': 'COMPLETED', 'match_status': 'FULL',
                        'expected_files': [{'path': 'album/01.flac', 'sha256': guard.fingerprint(output), 'role': 'output'}],
                        'removed_paths': [], **updates}
            guard.validate_event(event(), root, 'r1', 'a1', '000001.json', None)
            for updates in ({'status': 'DONE'}, {'match_status': 'PRESERVED'}, {'phase': 'ARCHIVED'},
                            {'status': 'PRESERVED'}, {'match_status': 'COMPLETED'}):
                with self.subTest(updates=updates):
                    candidate = event(**updates)
                    with self.assertRaises(guard.GuardError):
                        guard.validate_event(candidate, root, 'r1', 'a1', '000001.json', None)


class MetadataTests(unittest.TestCase):
    def test_fields_come_from_the_authoritative_tables(self):
        original = rules.read_whitelist()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'fields.md'
            text = (Path(rules.__file__).resolve().parents[1] / 'references/metadata-whitelist.md').read_text()
            text = text.replace('## 表演类 credit 成对规则', '| `TEST_NEW_FIELD` | Temporary test field |\n\n## 表演类 credit 成对规则')
            path.write_text(text)
            updated = rules.read_whitelist(path)
        self.assertEqual(updated.allowed - original.allowed, {'TEST_NEW_FIELD'})
        tags = album_tags() | {'TEST_NEW_FIELD': ['value']}
        self.assertTrue(rules.check_tags(tags, whitelist=updated)['ok'])
        self.assertFalse(rules.check_tags(tags, whitelist=original)['ok'])
        self.assertNotIn('YEAR', updated.allowed)
        self.assertNotIn('ROONALBUMTAG', updated.allowed)

    def test_malformed_and_duplicate_tables_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'broken.md'
            for text in ['# Missing tables', '## 必填白名单\n| `X` |', '## 必填白名单\n| `X` | unknown | value |',
                         '## 必填白名单\n| `X` | 所有音轨 | value |\n| `X` | 所有音轨 | value |']:
                path.write_text(text)
                with self.subTest(text=text), self.assertRaises(rules.RuleError):
                    rules.read_whitelist(path)

    def test_unexplained_missing_fields_still_need_an_omission_record(self):
        for key in ['COUNTRY', 'GENRE']:
            tags = album_tags()
            del tags[key]
            self.assertIn({'code': 'MISSING_REQUIRED_TAG', 'field': key}, rules.check_tags(tags)['issues'])

    def test_documented_missing_country_or_genre_does_not_block_paths(self):
        for missing in [('COUNTRY',), ('GENRE',), ('COUNTRY', 'GENRE')]:
            for kind in ['album', 'singleton']:
                with self.subTest(missing=missing, kind=kind):
                    tags = album_tags()
                    if kind == 'singleton':
                        tags = {k: v for k, v in tags.items() if k not in rules.read_whitelist().album_required}
                    expected_path = rules.render_path(tags, '.flac', kind)
                    for key in missing:
                        del tags[key]
                    original = copy.deepcopy(tags)
                    omissions = {key: '冷门发行查证后仍无可靠信息，见 evidence/search.json' for key in missing}
                    checked = rules.check_tags(tags, kind, omissions=omissions)
                    self.assertTrue(checked['ok'], checked)
                    self.assertEqual(checked['issues'], [])
                    self.assertEqual(checked['omissions'], omissions)
                    self.assertEqual(rules.render_path(tags, '.flac', kind, omissions=omissions), expected_path)
                    self.assertEqual(tags, original)

    def test_omissions_require_reason_and_cannot_bypass_other_fields(self):
        for key in ['TITLE', 'DATE', 'ALBUMARTIST', 'TRACKNUMBER', 'UNKNOWN']:
            with self.subTest(key=key):
                tags = album_tags()
                tags.pop(key, None)
                checked = rules.check_tags(tags, omissions={key: 'Unavailable'})
                self.assertFalse(checked['ok'])
                self.assertIn({'code': 'OMISSION_NOT_ALLOWED', 'field': key}, checked['issues'])
        tags = album_tags()
        del tags['COUNTRY']
        for reason in ['', '   ', [], None]:
            with self.subTest(reason=reason):
                checked = rules.check_tags(tags, omissions={'COUNTRY': reason})
                self.assertFalse(checked['ok'])
                self.assertEqual(checked['omissions'], {})
        with self.assertRaises(rules.RuleError):
            rules.check_tags(tags, omissions=[])

    def test_omission_does_not_remove_or_mask_a_present_value(self):
        for value in [['Japan'], [''], []]:
            tags = album_tags() | {'COUNTRY': value}
            original = copy.deepcopy(tags)
            checked = rules.check_tags(tags, omissions={'COUNTRY': 'Not known'})
            self.assertFalse(checked['ok'])
            self.assertIn({'code': 'OMITTED_TAG_PRESENT', 'field': 'COUNTRY'}, checked['issues'])
            self.assertEqual(tags, original)

    def test_omission_permissions_come_from_table_not_field_names(self):
        original = rules.read_whitelist()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'fields.md'
            text = (Path(rules.__file__).resolve().parents[1] / 'references/metadata-whitelist.md').read_text()
            text = text.replace('| `COUNTRY` / 国家或地区 | 所有音轨；可记录缺失 |', '| `COUNTRY` / 国家或地区 | 所有音轨 |')
            path.write_text(text)
            updated = rules.read_whitelist(path)
        self.assertEqual(original.omittable - updated.omittable, {'COUNTRY'})
        tags = album_tags()
        del tags['COUNTRY']
        omissions = {'COUNTRY': 'No reliable region; evidence/search.json'}
        self.assertTrue(rules.check_tags(tags, whitelist=original, omissions=omissions)['ok'])
        self.assertFalse(rules.check_tags(tags, whitelist=updated, omissions=omissions)['ok'])

    def test_unknown_empty_and_collapsed_values_fail(self):
        for updates in [{'YEAR': ['2024']}, {'ARTIST': 'A & B'}, {'ARTIST': []}, {'GENRE': [' ']}]:
            with self.subTest(updates=updates):
                self.assertFalse(rules.check_tags(album_tags() | updates)['ok'])

    def test_tag_check_rejects_every_value_the_path_renderer_rejects(self):
        cases = [({'DATE': ['2023-02-29']}, 'INVALID_DATE'), ({'DATE': ['20']}, 'INVALID_DATE'),
                 ({'DATE': ['2024/02/29']}, 'INVALID_DATE'), ({'TRACKNUMBER': ['01/02']}, 'INVALID_NUMBER'),
                 ({'DISCNUMBER': ['00']}, 'INVALID_NUMBER'), ({'TRACKTOTAL': ['two']}, 'INVALID_NUMBER'),
                 ({'DISCNUMBER': ['03']}, 'NUMBER_EXCEEDS_TOTAL'), ({'TRACKNUMBER': ['03']}, 'NUMBER_EXCEEDS_TOTAL'),
                 ({'TITLE': ['a', 'b']}, 'MULTIPLE_VALUES'), ({'ALBUM': ['a', 'b']}, 'MULTIPLE_VALUES'),
                 ({'DATE': ['2024', '2025']}, 'MULTIPLE_VALUES')]
        for updates, code in cases:
            with self.subTest(updates=updates):
                candidate_tags = album_tags() | updates
                checked = rules.check_tags(candidate_tags)
                self.assertFalse(checked['ok'])
                self.assertIn(code, [issue['code'] for issue in checked['issues']])
                with self.assertRaises(rules.RuleError):
                    rules.render_path(candidate_tags, '.flac')

    def test_tag_check_keeps_multivalued_and_partial_date_values_valid(self):
        for updates in [{'DATE': ['2024']}, {'DATE': ['2024-02']}, {'GENRE': ['J-Pop', 'Anime']},
                        {'TRACKNUMBER': ['2'], 'TRACKTOTAL': ['2']}]:
            with self.subTest(updates=updates):
                self.assertTrue(rules.check_tags(album_tags() | updates)['ok'])

    def test_singleton_required_scope_comes_from_table(self):
        tags = {k: v for k, v in album_tags().items() if k not in rules.read_whitelist().album_required}
        self.assertTrue(rules.check_tags(tags, 'singleton')['ok'])
        self.assertFalse(rules.check_tags(tags, 'album')['ok'])
        self.assertEqual(rules.render_path(tags, '.mp3', 'singleton'), '[麻枝准 & 熊木杏里][雨： 夜].mp3')
        full_album_tags = album_tags()
        with self.assertRaises(rules.RuleError):
            rules.render_path(full_album_tags, '.mp3', 'singleton')

    def test_renderer_preserves_tags_order_and_semantics(self):
        tags = album_tags()
        original = copy.deepcopy(tags)
        self.assertEqual(rules.render_path(tags, '.flac'), '[麻枝准 & 熊木杏里][作品][2024]/01 - 雨： 夜 - 麻枝准 & 熊木杏里.flac')
        self.assertEqual(tags, original)
        tags.update(DISCNUMBER=['02'], DISCTOTAL=['02'])
        self.assertIn('/0201 - ', rules.render_path(tags, '.flac'))

    def test_invalid_numbers_dates_and_scalars_fail(self):
        for updates in [{'DATE': ['2023-02-29']}, {'DATE': ['20']}, {'TRACKNUMBER': ['01/02']},
                        {'DISCNUMBER': ['00']}, {'DISCNUMBER': ['03']}, {'TITLE': ['a', 'b']}]:
            candidate_tags = album_tags() | updates
            with self.subTest(updates=updates), self.assertRaises(rules.RuleError):
                rules.render_path(candidate_tags, '.flac')

    def test_shared_sanitizer_is_idempotent_and_guard_accepts_results(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            for raw, expected in [('CON', '_CON'), ('con.txt', '_con.txt'), ('LPT9.', '_LPT9'),
                                  ('.hidden', '.hidden'), ('a. . ', 'a'), ('a:/\\?\x00b', 'a： b'),
                                  ('雨　光', '雨 光'), ('café', 'café')]:
                with self.subTest(raw=raw):
                    normalized = rules.sanitize_component(raw)
                    self.assertEqual(normalized, expected)
                    self.assertEqual(rules.sanitize_component(normalized), normalized)
                    self.assertEqual(guard.validate_target_name(root, normalized), (normalized,))
            for raw in ['.', '..', ' / * \t']:
                with self.subTest(raw=raw), self.assertRaises(rules.RuleError):
                    rules.sanitize_component(raw)

    def test_render_cli_output_is_usable_by_path_checker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            source = root / 'original.wav'
            source.write_bytes(b'synthetic')
            request = {'tracks': [{'source': source.name, 'source_sha256': guard.fingerprint(source),
                                  'kind': 'album', 'tags': album_tags(), 'extension': '.flac', 'operation': 'create'}]}
            inp = root / 'input.json'
            inp.write_text(json.dumps(request))
            output = subprocess.run([sys.executable, '-B', guard.__file__, 'render-paths', '--root', str(root), '--input', str(inp)], capture_output=True, text=True, cwd=root)
            self.assertEqual(output.returncode, 0, output.stderr + output.stdout)
            plan = json.loads(output.stdout)
            self.assertTrue(guard.check_paths(root, plan)['ok'])
            request['tracks'].append(copy.deepcopy(request['tracks'][0]))
            request['tracks'][1]['tags']['TITLE'] = ['雨： 夜']
            self.assertFalse(guard.check_paths(root, guard.render_paths(root, request))['ok'])
            self.assertEqual(source.read_bytes(), b'synthetic')
            self.assertFalse((root / '[麻枝准 & 熊木杏里][作品][2024]').exists())

    def test_cli_carries_omissions_through_tag_check_and_path_render(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            source = root / 'original.wav'
            source.write_bytes(b'synthetic')
            tags = album_tags()
            omissions = {key: 'Cold release, no reliable value; evidence/search.json' for key in ['COUNTRY', 'GENRE']}
            for key in omissions:
                del tags[key]
            inp = root / 'input.json'
            request = {'kind': 'album', 'tags': tags, 'omissions': omissions}
            inp.write_text(json.dumps(request))
            checked = subprocess.run([sys.executable, '-B', guard.__file__, 'check-tags', '--input', str(inp)], capture_output=True, text=True, cwd=root)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            self.assertEqual(json.loads(checked.stdout)['omissions'], omissions)
            track = request | {'source': source.name, 'source_sha256': guard.fingerprint(source), 'operation': 'create', 'extension': '.flac'}
            inp.write_text(json.dumps({'tracks': [track]}))
            rendered = subprocess.run([sys.executable, '-B', guard.__file__, 'render-paths', '--root', str(root), '--input', str(inp)], capture_output=True, text=True, cwd=root)
            self.assertEqual(rendered.returncode, 0, rendered.stdout + rendered.stderr)
            self.assertTrue(guard.check_paths(root, json.loads(rendered.stdout))['ok'])
            self.assertEqual(source.read_bytes(), b'synthetic')
            self.assertEqual(set(root.iterdir()), {source, inp})


def encode_image(width: int, height: int, fmt: str = 'PNG', **save_kwargs) -> bytes:
    buf = io.BytesIO()
    mode = 'RGBA' if fmt == 'PNG' else 'RGB'
    color = (64, 128, 192, 255) if mode == 'RGBA' else (64, 128, 192)
    Image.new(mode, (width, height), color).save(buf, format=fmt, **save_kwargs)
    return buf.getvalue()


def make_flac_bytes(sample_rate: int = 44100, channels: int = 2, bps: int = 16, total_samples: int = 44100) -> bytes:
    packed = (sample_rate << 44) | ((channels - 1) << 41) | ((bps - 1) << 36) | total_samples
    streaminfo = struct.pack('>HH3s3sQ16s', 4096, 4096, b'\x00\x00\x00', b'\x00\x00\x00',
                             packed, bytes.fromhex('0123456789abcdef0123456789abcdef'))
    return b'fLaC' + bytes([0x80]) + struct.pack('>I', 34)[1:] + streaminfo


def mp4_atom(kind: bytes, payload: bytes) -> bytes:
    return struct.pack('>I4s', len(payload) + 8, kind) + payload


def make_m4a_bytes(fourcc: bytes) -> bytes:
    ftyp = mp4_atom(b'ftyp', b'M4A \x00\x00\x02\x00M4A mp42isom')
    ase_body = (b'\x00' * 6 + struct.pack('>H', 1) + b'\x00' * 8
                + struct.pack('>HH', 2, 16) + b'\x00' * 4 + struct.pack('>I', 44100 << 16))
    if fourcc == b'alac':
        alac_cfg = b'\x00\x00\x00\x00' + struct.pack('>IBBBBBBHIII', 4096, 0, 24, 40, 10, 14, 2, 255, 0, 1411200, 44100)
        ase = mp4_atom(b'alac', ase_body + mp4_atom(b'alac', alac_cfg))
    else:
        ase = mp4_atom(fourcc, ase_body + mp4_atom(b'free', b''))
    stsd = mp4_atom(b'stsd', b'\x00\x00\x00\x00' + struct.pack('>I', 1) + ase)
    stbl = mp4_atom(b'stbl', stsd)
    minf = mp4_atom(b'minf', stbl)
    mdhd = mp4_atom(b'mdhd', b'\x00' * 12 + struct.pack('>II', 44100, 88200) + b'\x00' * 4)
    hdlr = mp4_atom(b'hdlr', b'\x00' * 8 + b'soun' + b'\x00' * 13)
    mdia = mp4_atom(b'mdia', mdhd + hdlr + minf)
    trak = mp4_atom(b'trak', mdia)
    mvhd = mp4_atom(b'mvhd', b'\x00' * 12 + struct.pack('>II', 1000, 2000) + b'\x00' * 80)
    return ftyp + mp4_atom(b'moov', mvhd + trak)


class CoverTests(unittest.TestCase):
    def inspect(self, data: bytes):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / 'cover.bin'
            image.write_bytes(data)
            return rules.inspect_cover(image)

    def test_png_jpeg_and_webp_full_decode_exact_ratio_boundary(self):
        encoders = [
            ('PNG', lambda w, h: encode_image(w, h, 'PNG')),
            ('JPEG', lambda w, h: encode_image(w, h, 'JPEG')),
            ('JPEG', lambda w, h: encode_image(w, h, 'JPEG', progressive=True)),
            ('WEBP', lambda w, h: encode_image(w, h, 'WEBP')),
        ]
        for expected_fmt, encode in encoders:
            for width, height, accepted in [(1400, 1000, True), (1000, 1400, True), (1401, 1000, False), (1000, 1401, False)]:
                with self.subTest(fmt=expected_fmt, width=width, height=height):
                    result = self.inspect(encode(width, height))
                    self.assertEqual(result['ok'], accepted)
                    self.assertEqual(result['format'], expected_fmt)
                    self.assertEqual((result['width'], result['height']), (width, height))
                    self.assertEqual(result['pixels'], width * height)
                    self.assertEqual(result['scope'], 'decoded_image')
                    self.assertTrue(result['full_decode_verified'])

    def test_exif_orientation_transposes_dimensions_before_ratio_check(self):
        exif = Image.Exif()
        exif[0x0112] = 6  # Rotate 90 CW: 1000x1400 stored -> 1400x1000 displayed
        data = encode_image(1000, 1400, 'JPEG', exif=exif.tobytes())
        result = self.inspect(data)
        self.assertEqual((result['width'], result['height']), (1400, 1000))
        self.assertTrue(result['ok'])

    def test_header_only_truncated_and_corrupt_images_fail_full_decode(self):
        valid_png = encode_image(64, 64, 'PNG')
        valid_jpeg = encode_image(64, 64, 'JPEG')
        for data in [b'GIF89a', png_header(10, 10), jpeg_header(10, 10), png_header(0, 10),
                     valid_png[:len(valid_png) // 2], valid_jpeg[:len(valid_jpeg) // 2],
                     b'\xff\xd8', b'\xff\xd8\xff\xe0\x00\x01']:
            with self.subTest(length=len(data)), self.assertRaises(rules.RuleError) as ctx:
                self.inspect(data)
            self.assertEqual(ctx.exception.issue['code'], 'INVALID_IMAGE')


class AudioInspectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_flac_inspects_stream_tags_binary_and_text_cuesheets_and_pictures(self):
        path = self.root / 'disc.flac'
        path.write_bytes(make_flac_bytes())
        audio = flac.FLAC(path)
        audio['TITLE'] = ['アルバム全体']
        audio['ARTIST'] = ['麻枝准', '熊木杏里']
        cue_text = 'FILE "disc.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:30:00\n'
        audio['CUESHEET'] = [cue_text]

        # Build a binary FLAC CUESHEET metadata block (2 audio tracks + CD-DA lead-out track 170)
        t1 = struct.pack('>QB12sB13xB', 0, 1, b'JPXX02400001', 0, 1) + struct.pack('>QB3x', 0, 1)
        t2 = struct.pack('>QB12sB13xB', 22050, 2, b'JPXX02400002', 0, 1) + struct.pack('>QB3x', 0, 1)
        leadout = struct.pack('>QB12sB13xB', 44100, 170, b'\x00' * 12, 0, 0)
        cue_header = struct.pack('>128sQB258xB', b'KSLA-0001'.ljust(128, b'\x00'), 88200, 0x80, 3)
        audio.cuesheet = flac.CueSheet(io.BytesIO(cue_header + t1 + t2 + leadout))

        pic = flac.Picture()
        pic.type = 3
        pic.mime = 'image/png'
        pic.desc = 'Front'
        pic.data = encode_image(120, 100, 'PNG')
        audio.add_picture(pic)
        audio.save()

        before = path.read_bytes()
        result = rules.inspect_audio(path)
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['container'], 'flac')
        self.assertEqual(result['codec'], 'flac')
        self.assertTrue(result['lossless'])
        self.assertFalse(result['dsd'])
        self.assertTrue(result['extension_matches_container'])
        self.assertEqual(result['stream']['sample_rate'], 44100)
        self.assertEqual(result['stream']['channels'], 2)
        self.assertEqual(result['stream']['bits_per_sample'], 16)
        self.assertEqual(result['stream']['total_samples'], 44100)
        self.assertEqual(result['stream']['md5_signature'], '0123456789abcdef0123456789abcdef')
        self.assertEqual(result['tag_format'], 'vorbis')
        self.assertEqual(result['tags']['ARTIST'], ['麻枝准', '熊木杏里'])
        self.assertEqual(result['scope'], 'header_and_metadata_only')
        self.assertFalse(result['full_audio_decode_verified'])

        cues = {entry['kind']: entry for entry in result['embedded_cue']}
        self.assertEqual(set(cues), {'flac_cuesheet_block', 'tag_text'})
        self.assertEqual(cues['flac_cuesheet_block']['catalog_number'], 'KSLA-0001')
        self.assertEqual(cues['flac_cuesheet_block']['track_count'], 2)
        self.assertEqual(cues['flac_cuesheet_block']['tracks'][1]['isrc'], 'JPXX02400002')
        self.assertEqual(cues['tag_text']['track_count'], 2)

        self.assertEqual(len(result['pictures']), 1)
        self.assertTrue(result['pictures'][0]['decoded'])
        self.assertEqual(result['pictures'][0]['type_name'], 'cover_front')
        self.assertEqual((result['pictures'][0]['width'], result['pictures'][0]['height']), (120, 100))
        self.assertTrue(result['pictures'][0]['ratio_ok'])

    def test_m4a_distinguishes_alac_lossless_from_aac_lossy_and_reads_tags(self):
        alac_path = self.root / 'lossless.m4a'
        alac_path.write_bytes(make_m4a_bytes(b'alac'))
        m4a_tags = mp4.MP4(alac_path)
        m4a_tags['\xa9nam'] = ['Song']
        m4a_tags['trkn'] = [(1, 10)]
        m4a_tags['----:com.apple.iTunes:CUESHEET'] = [mp4.MP4FreeForm(b'TRACK 01 AUDIO\n  INDEX 01 00:00:00\n')]
        m4a_tags['covr'] = [mp4.MP4Cover(encode_image(100, 100, 'JPEG'), imageformat=mp4.MP4Cover.FORMAT_JPEG)]
        m4a_tags.save()

        alac_res = rules.inspect_audio(alac_path)
        self.assertTrue(alac_res['ok'], alac_res)
        self.assertEqual(alac_res['container'], 'mp4')
        self.assertEqual(alac_res['codec'], 'alac')
        self.assertTrue(alac_res['lossless'])
        self.assertEqual(alac_res['tags']['\xa9nam'], ['Song'])
        self.assertEqual(alac_res['tags']['trkn'], ['1/10'])
        self.assertEqual(alac_res['embedded_cue'][0]['kind'], 'tag_text')
        self.assertEqual(alac_res['pictures'][0]['format'], 'JPEG')

        aac_path = self.root / 'lossy.m4a'
        aac_path.write_bytes(make_m4a_bytes(b'mp4a'))
        aac_res = rules.inspect_audio(aac_path)
        self.assertTrue(aac_res['ok'], aac_res)
        self.assertEqual(aac_res['container'], 'mp4')
        self.assertEqual(aac_res['codec'], 'aac')
        self.assertFalse(aac_res['lossless'])

    def test_wav_verifies_pcm_vs_compressed_format_and_reads_id3_tags(self):
        pcm_path = self.root / 'track.wav'
        with wave.open(str(pcm_path), 'wb') as writer:
            writer.setnchannels(2)
            writer.setsampwidth(2)
            writer.setframerate(48000)
            writer.writeframes(b'\x00\x00\x00\x00' * 4800)
        wav_file = mutagen_wave.WAVE(pcm_path)
        wav_file.add_tags()
        wav_file.tags.add(id3.TIT2(encoding=3, text=['夜明け']))
        wav_file.tags.add(id3.TXXX(encoding=3, desc='CUESHEET', text=['TRACK 01 AUDIO\n']))
        wav_file.tags.add(id3.APIC(encoding=3, mime='image/png', type=3, desc='', data=encode_image(80, 80, 'PNG')))
        wav_file.save()

        pcm_res = rules.inspect_audio(pcm_path)
        self.assertTrue(pcm_res['ok'], pcm_res)
        self.assertEqual((pcm_res['container'], pcm_res['codec'], pcm_res['lossless']), ('wav', 'pcm', True))
        self.assertEqual(pcm_res['tag_format'], 'id3')
        self.assertEqual(pcm_res['tags']['TIT2'], ['夜明け'])
        self.assertEqual(pcm_res['embedded_cue'][0]['track_count'], 1)
        self.assertTrue(pcm_res['pictures'][0]['decoded'])

        # Construct a WAV header with format tag 0x0055 (MP3 inside WAV container)
        fmt_chunk = struct.pack('<4sIHHIIHH', b'fmt ', 16, 0x0055, 2, 44100, 16000, 1, 16)
        data_chunk = struct.pack('<4sI', b'data', 4) + b'\x00' * 4
        riff = b'RIFF' + struct.pack('<I', 4 + len(fmt_chunk) + len(data_chunk)) + b'WAVE' + fmt_chunk + data_chunk
        non_pcm = self.root / 'compressed.wav'
        non_pcm.write_bytes(riff)
        comp_res = rules.inspect_audio(non_pcm)
        self.assertEqual(comp_res['codec'], 'wav_format_0x0055')
        self.assertFalse(comp_res['lossless'])

    def test_extension_mismatch_and_corrupt_embedded_picture_report_issues(self):
        misnamed = self.root / 'pretend.mp3'
        with wave.open(str(misnamed), 'wb') as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(44100)
            writer.writeframes(b'\x00\x00' * 100)
        mismatch = rules.inspect_audio(misnamed)
        self.assertFalse(mismatch['ok'])
        self.assertEqual(mismatch['container'], 'wav')
        self.assertFalse(mismatch['extension_matches_container'])
        self.assertIn('CONTAINER_EXTENSION_MISMATCH', [i['code'] for i in mismatch['issues']])

        bad_pic_flac = self.root / 'bad-pic.flac'
        bad_pic_flac.write_bytes(make_flac_bytes())
        audio = flac.FLAC(bad_pic_flac)
        pic = flac.Picture()
        pic.type = 3
        pic.mime = 'image/png'
        pic.data = b'not-an-image'
        audio.add_picture(pic)
        audio.save()
        bad_pic = rules.inspect_audio(bad_pic_flac)
        self.assertFalse(bad_pic['ok'])
        self.assertFalse(bad_pic['pictures'][0]['decoded'])
        self.assertIn('INVALID_EMBEDDED_IMAGE', [i['code'] for i in bad_pic['issues']])

    def test_corrupt_or_non_audio_files_fail_closed(self):
        for filename, payload in [('corrupt.flac', b'not a flac'), ('plain.txt', b'hello world')]:
            target = self.root / filename
            target.write_bytes(payload)
            with self.subTest(filename=filename), self.assertRaises(rules.RuleError):
                rules.inspect_audio(target)


class SkillVersionTests(unittest.TestCase):
    def test_yaml_frontmatter_version_parses_cleanly_and_rejects_invalid_shapes(self):
        with tempfile.TemporaryDirectory() as temp:
            md = Path(temp) / 'SKILL.md'
            md.write_text('---\nname: musagetes\nmetadata:\n  # comment\n  note: ok\n  version: "1.2.3"\n---\n# Body\n')
            self.assertEqual(guard.skill_version(md), '1.2.3')
            for invalid in [
                '# No frontmatter\n',
                '---\nmetadata:\n  version: 1.2\n---\n',
                '---\nmetadata: [broken\n---\n',
                '---\nmetadata:\n  version: "v1.2.3"\n---\n',
            ]:
                md.write_text(invalid)
                with self.subTest(invalid=invalid), self.assertRaises(guard.GuardError) as ctx:
                    guard.skill_version(md)
                self.assertEqual(ctx.exception.issue['code'], 'INVALID_SKILL_VERSION')


if __name__ == '__main__':
    unittest.main()
