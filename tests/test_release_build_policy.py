import json
import tempfile
import unittest
from pathlib import Path
from tools.release_build_policy import validate


class ReleaseBuildPolicyTest(unittest.TestCase):
    def test_release_requires_explicit_false_and_matching_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            for suffix in ('', 'OpenStudio.app/Contents/Resources'):
                root = Path(temporary) / suffix
                root.mkdir(parents=True, exist_ok=True)
                bundle = root if not suffix else root.parent.parent
                policy = root / 'OpenStudio.build-policy.json'
                with self.assertRaises(FileNotFoundError):
                    validate(bundle, '0.1.09')
                for value in (True, None, 0, 'false'):
                    policy.write_text(json.dumps({'version': '0.1.09', 'callbackDiagnostics': value}))
                    with self.assertRaises(ValueError):
                        validate(bundle, '0.1.09')
                policy.write_text(json.dumps({'version': '0.1.08', 'callbackDiagnostics': False}))
                with self.assertRaises(ValueError):
                    validate(bundle, '0.1.09')
                policy.write_text(json.dumps({'version': '0.1.09', 'callbackDiagnostics': False}))
                validate(bundle, '0.1.09')
