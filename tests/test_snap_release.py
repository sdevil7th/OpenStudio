import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from submit_snap_release import SNAP_ID, run
from snap_elf import audit_notes
from tests import test_store_release_workflow as store_workflow

spec = importlib.util.spec_from_file_location('snap_webkit', ROOT / 'tools/patch-snap-webkit.py')
webkit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webkit)
spec = importlib.util.spec_from_file_location('snap_browser_stack', ROOT / 'tools/check-snap-browser-stack.py')
browser_stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser_stack)


def runtime_elf_fixture(note_offset=0x200, note_address=None):
    """A mapped ELF note plus its section, including the old-patchelf failure."""
    data = bytearray(0x400)
    ident = b'\x7fELF\x02\x01\x01' + bytes(9)
    struct.pack_into('<16sHHIQQQIHHHHHH', data, 0, ident, 3, 62, 1, 0, 64, 0x300, 0,
                     64, 56, 2, 64, 3, 2)
    struct.pack_into('<IIQQQQQQ', data, 64, 1, 4, 0, 0, 0, len(data), len(data), 0x1000)
    struct.pack_into('<IIQQQQQQ', data, 120, 4, 4, note_offset,
                     note_offset if note_address is None else note_address, 0, 36, 36, 4)
    note = struct.pack('<III', 4, 20, 3) + b'GNU\0' + bytes([1]) * 20
    data[0x200:0x200 + len(note)] = note
    names = b'\0.note.gnu.build-id\0.shstrtab\0'
    data[0x240:0x240 + len(names)] = names
    struct.pack_into('<IIQQQQIIQQ', data, 0x340, 1, 7, 2, 0x200, 0x200, len(note), 0, 0, 4, 0)
    struct.pack_into('<IIQQQQIIQQ', data, 0x380, 20, 3, 0, 0, 0x240, len(names), 0, 0, 1, 0)
    if note_offset != 0x200:
        data[note_offset:note_offset + 36] = b'X' * 36
    return data


class SnapReleaseTests(unittest.TestCase):
    def fixture(self, path):
        (path / 'openstudio.snap').write_bytes(b'qualified fixture, not an actual Snap')
        report = {'version': '0.1.09', 'snapName': 'openstudio', 'snapId': SNAP_ID,
                  'publisher': 'sdevil7th', 'status': 'pass', 'published': False,
                  'snapSha256': hashlib.sha256((path / 'openstudio.snap').read_bytes()).hexdigest(),
                  'supportLaunch': 'explicit_only', 'installedDesktopAndExports': 'pass', 'storeUpdates': 'pass',
                  'elfMetadata': {'status': 'pass', 'runtimeNoteIntegrity': 'pass', 'runtimeElfFiles': 1}}
        (path / 'qualification.json').write_text(json.dumps(report))
        return report

    def test_read_only_preflight_and_explicit_single_upload(self):
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            self.assertTrue(kwargs['capture_output'])
            return subprocess.CompletedProcess(args, 0, 'private account response', '')
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'SNAPCRAFT_STORE_CREDENTIALS': 'fixture'}):
            path = Path(directory); self.fixture(path)
            options = dict(approval_url='https://forum.snapcraft.io/t/review/123', command=command)
            result = run(path, '0.1.09', 'v0.1.09', preflight=True, **options)
            self.assertEqual(result['status'], 'preflight_passed')
            self.assertFalse(result['mutationsPerformed'])
            self.assertFalse(any('upload' in args for args in calls))
            result = run(path, '0.1.09', 'v0.1.09', submit=True, **options)
            self.assertEqual(sum('upload' in args for args in calls), 1)
            self.assertEqual(result['published'], 'not_asserted')
            self.assertNotIn('private account response', json.dumps(result))

    def test_hash_identity_tag_and_approval_fail_before_network(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'SNAPCRAFT_STORE_CREDENTIALS': 'fixture'}):
            path = Path(directory); report = self.fixture(path)
            def forbidden(*args, **kwargs): self.fail('Unexpected Store command')
            for tag, approval in [('v0.1.08', 'https://forum.snapcraft.io/t/review/123'), ('v0.1.09', '')]:
                with self.assertRaises(ValueError):
                    run(path, '0.1.09', tag, preflight=True, approval_url=approval, command=forbidden)
            for key, value in [('version', '0.1.08'), ('snapId', 'wrong'), ('supportLaunch', 'service'),
                               ('status', 'diagnostic_only'), ('diagnosticSourceRun', '42082337881'),
                               ('elfMetadata', {}),
                               ('elfMetadata', {'status': 'pass', 'runtimeNoteIntegrity': 'fail', 'runtimeElfFiles': 1}),
                               ('elfMetadata', {'status': 'pass', 'runtimeNoteIntegrity': 'pass', 'runtimeElfFiles': 0})]:
                (path / 'qualification.json').write_text(json.dumps({**report, key: value}))
                with self.assertRaises(ValueError): run(path, '0.1.09', 'v0.1.09', command=forbidden)
            (path / 'qualification.json').write_text(json.dumps(report))
            (path / 'openstudio.snap').write_bytes(b'changed after qualification')
            with self.assertRaises(ValueError): run(path, '0.1.09', 'v0.1.09', command=forbidden)

    def test_release_dependency_graph_and_support_inactivity(self):
        store_workflow.StoreReleaseWorkflowTests.setUpClass()
        workflow = store_workflow.StoreReleaseWorkflowTests()
        for job in ('preflight-snap', 'submit-snap', 'publish', 'preflight-store', 'submit-store'):
            self.assertTrue(workflow.job_runs(job, ref='refs/tags/v0.1.09', snap_enabled='true'), job)
        for status in ('failure', 'skipped', 'cancelled'):
            self.assertFalse(workflow.job_runs('publish', {'preflight-snap': status}, snap_enabled='true'))
        self.assertTrue(workflow.job_runs('publish', {'preflight-snap': 'skipped'}, snap_enabled='false'))
        self.assertFalse(workflow.job_runs('submit-snap', {'publish': 'failure'}, snap_enabled='true'))
        self.assertFalse(workflow.job_runs('submit-snap', ref='refs/heads/main', snap_enabled='true'))
        self.assertFalse(workflow.job_runs('submit-snap', snap_enabled='false'))
        recipe = yaml.safe_load((ROOT / 'packaging/snap/snapcraft.yaml').read_text())
        self.assertEqual(set(recipe['apps']), {'openstudio', 'support'})
        for app in recipe['apps'].values():
            self.assertFalse({'daemon', 'timer', 'autostart', 'activates-on'} & set(app))
        # Snapcraft explicitly skips classic ELF fixups for override-prime.
        for part in recipe['parts'].values():
            if 'enable-patchelf' in part.get('build-attributes', []):
                self.assertNotIn('override-prime', part)
        runtime = recipe['parts']['runtime']
        self.assertEqual(runtime['build-attributes'], ['no-patchelf'])
        self.assertIn('"$CRAFT_STAGE/usr/bin/patchelf"', runtime['override-prime'])
        self.assertIn('patchelf', runtime['after'])
        self.assertEqual(recipe['parts']['patchelf']['prime'], ['-*'])

    def test_runtime_elf_notes_match_the_native_symbol_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.so'
            path.write_bytes(runtime_elf_fixture())
            self.assertEqual(audit_notes(path), ['01' * 20])

    def test_browser_stack_accepts_only_bundled_browser_and_matching_base_glib(self):
        with tempfile.TemporaryDirectory() as directory:
            root, base, host = (Path(directory) / name for name in ('snap', 'core22', 'host'))
            loaded = {name: str(root / name) for name in browser_stack.EXPECTED}
            self.assertTrue(browser_stack.coherent_stack(loaded, root, base))
            loaded['libglib-2.0.so'] = str(base / 'libglib-2.0.so')
            self.assertTrue(browser_stack.coherent_stack(loaded, root, base))
            loaded['libglib-2.0.so'] = str(host / 'libglib-2.0.so')
            self.assertFalse(browser_stack.coherent_stack(loaded, root, base))
            loaded['libglib-2.0.so'] = str(base / 'libglib-2.0.so')
            loaded['libwebkit2gtk-4.1.so'] = str(base / 'libwebkit2gtk-4.1.so')
            self.assertFalse(browser_stack.coherent_stack(loaded, root, base))

    def test_reject_old_patchelf_stale_runtime_note_even_when_section_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.so'
            path.write_bytes(runtime_elf_fixture(note_offset=0x180))
            with self.assertRaisesRegex(ValueError, 'matching runtime segment'):
                audit_notes(path)

    def test_reject_runtime_note_virtual_address_mismatch_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.so'
            path.write_bytes(runtime_elf_fixture(note_address=0x208))
            with self.assertRaises(ValueError): audit_notes(path)
            data = runtime_elf_fixture()
            struct.pack_into('<I', data, 0x204, 1024)
            path.write_bytes(data)
            with self.assertRaises(ValueError): audit_notes(path)
            data = runtime_elf_fixture(note_address=0x20000)
            struct.pack_into('<Q', data, 0x340 + 16, 0x20000)
            path.write_bytes(data)
            with self.assertRaisesRegex(ValueError, 'mapped load segments'): audit_notes(path)

    def test_webkit_relocation_preserves_elf_offsets(self):
        source = b'prefix\0' + webkit.OLD + b'/injected-bundle/test.so\0suffix'
        result, count = webkit.patch(source)
        self.assertEqual(count, 1)
        self.assertEqual(len(result), len(source))
        self.assertIn(webkit.NEW + b'/injected-bundle/test.so\0', result)
        self.assertEqual(result.index(b'suffix'), source.index(b'suffix'))
        self.assertEqual(webkit.patch(b'no such prefix'), (b'no such prefix', 0))


if __name__ == '__main__': unittest.main()
