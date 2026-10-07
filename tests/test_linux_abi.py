"""Use real ELF providers to exercise missing libraries and version mismatches."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('linux_abi', Path(__file__).parents[1] / 'tools/validate-linux-abi.py')
abi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(abi)


@unittest.skipUnless(all(shutil.which(tool) for tool in ('cc', 'ldd', 'readelf')), 'ELF toolchain required')
class LinuxAbiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'provider.c').write_text('int fixture(void) { return 0; }\n')
        (self.root / 'main.c').write_text('int fixture(void); int main(void) { return fixture(); }\n')
        self.provider('FIXTURE_2')
        subprocess.run(['cc', str(self.root / 'main.c'), '-L' + str(self.root), '-lfixture',
                        '-Wl,-rpath,$ORIGIN', '-o', str(self.root / 'app')], check=True)

    def provider(self, version):
        (self.root / 'versions.map').write_text(version + ' { global: fixture; local: *; };\n')
        subprocess.run(['cc', '-shared', '-fPIC', str(self.root / 'provider.c'),
                        '-Wl,--version-script=' + str(self.root / 'versions.map'),
                        '-Wl,-soname,libfixture.so', '-o', str(self.root / 'libfixture.so')], check=True)

    def test_valid_provider(self):
        result = abi.audit(self.root)
        self.assertTrue(result['success'], result)
        self.assertEqual(len(result['objects']), 2)

    def test_missing_provider(self):
        (self.root / 'libfixture.so').unlink()
        self.assertFalse(abi.audit(self.root)['success'])

    def test_incompatible_provider_with_same_soname(self):
        self.provider('FIXTURE_1')
        result = abi.audit(self.root)
        self.assertFalse(result['success'])
        self.assertIn('FIXTURE_2', result['objects'][0]['loader'])

    def test_glibc_floor_and_wrong_host_fail_closed(self):
        self.assertFalse(abi.audit(self.root, '2.0')['success'])
        self.assertFalse(abi.audit(self.root, require_os='missing:0')['success'])

    def test_empty_artifact_fails(self):
        empty = self.root / 'empty'
        empty.mkdir()
        self.assertFalse(abi.audit(empty)['success'])


if __name__ == '__main__':
    unittest.main()
