import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from submit_snap_release import SNAP_ID, run
from tests import test_store_release_workflow as store_workflow

spec = importlib.util.spec_from_file_location('snap_webkit', ROOT / 'tools/patch-snap-webkit.py')
webkit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webkit)


class SnapReleaseTests(unittest.TestCase):
    def fixture(self, path):
        (path / 'openstudio.snap').write_bytes(b'qualified fixture, not an actual Snap')
        report = {'version': '0.1.09', 'snapName': 'openstudio', 'snapId': SNAP_ID,
                  'publisher': 'sdevil7th', 'status': 'pass', 'published': False,
                  'snapSha256': hashlib.sha256((path / 'openstudio.snap').read_bytes()).hexdigest(),
                  'supportLaunch': 'explicit_only', 'installedDesktopAndExports': 'pass', 'storeUpdates': 'pass'}
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
            for key, value in [('version', '0.1.08'), ('snapId', 'wrong'), ('supportLaunch', 'service')]:
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

    def test_webkit_relocation_preserves_elf_offsets(self):
        source = b'prefix\0' + webkit.OLD + b'/injected-bundle/test.so\0suffix'
        result, count = webkit.patch(source)
        self.assertEqual(count, 1)
        self.assertEqual(len(result), len(source))
        self.assertIn(webkit.NEW + b'/injected-bundle/test.so\0', result)
        self.assertEqual(result.index(b'suffix'), source.index(b'suffix'))
        self.assertEqual(webkit.patch(b'no such prefix'), (b'no such prefix', 0))


if __name__ == '__main__': unittest.main()
