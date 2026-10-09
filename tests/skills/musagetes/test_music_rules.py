from __future__ import annotations

import copy
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

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

    def test_singleton_required_scope_comes_from_table(self):
        tags = {k: v for k, v in album_tags().items() if k not in rules.read_whitelist().album_required}
        self.assertTrue(rules.check_tags(tags, 'singleton')['ok'])
        self.assertFalse(rules.check_tags(tags, 'album')['ok'])
        self.assertEqual(rules.render_path(tags, '.mp3', 'singleton'), '[麻枝准 & 熊木杏里][雨： 夜].mp3')
        with self.assertRaises(rules.RuleError):
            rules.render_path(album_tags(), '.mp3', 'singleton')

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
            with self.subTest(updates=updates), self.assertRaises(rules.RuleError):
                rules.render_path(album_tags() | updates, '.flac')

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


class CoverTests(unittest.TestCase):
    def inspect(self, data):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / 'cover.bin'
            image.write_bytes(data)
            return rules.inspect_cover(image)

    def test_png_and_baseline_progressive_jpeg_exact_ratio_boundary(self):
        for encode in [png_header, jpeg_header, lambda w, h: jpeg_header(w, h, 0xC2)]:
            for width, height, accepted in [(1400, 1000, True), (1000, 1400, True), (1401, 1000, False), (1000, 1401, False)]:
                with self.subTest(encode=encode, width=width, height=height):
                    result = self.inspect(encode(width, height))
                    self.assertEqual(result['ok'], accepted)
                    self.assertEqual((result['width'], result['height']), (width, height))
                    self.assertEqual(result['pixels'], width * height)
                    self.assertFalse(result['full_decode_verified'])

    def test_headers_do_not_claim_a_full_image_decode(self):
        self.assertEqual(self.inspect(png_header(10, 10))['scope'], 'header_geometry_only')

    def test_invalid_headers_and_zero_dimensions_fail(self):
        png = png_header(10, 10)
        jpeg = jpeg_header(10, 10)
        for data in [b'GIF89a', png[:-1], png[:-1] + bytes([png[-1] ^ 1]), png_header(0, 10),
                     b'\xff\xd8', jpeg[:-1], b'\xff\xd8\xff\xe0\x00\x01',
                     b'\xff\xd8\xff\xc0\x00\x08\x08\x00\x01\x00\x01\x00']:
            with self.subTest(data=data), self.assertRaises(rules.RuleError):
                self.inspect(data)


if __name__ == '__main__':
    unittest.main()
