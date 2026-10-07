"""Exercise native package contents/dependencies with disposable ELF fixtures."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('linux_native', ROOT / 'tools/package-linux-native.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


@unittest.skipUnless(os.name == 'posix' and shutil.which('dpkg-deb') and shutil.which('readelf'),
                     'Debian-compatible ELF packaging tools required')
class NativePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='openstudio-package-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'fixture'
        self.bundle.mkdir()
        for name in ('OpenStudio', 'OpenStudioUpdateInstaller'):
            shutil.copyfile('/bin/true', self.bundle / name)
            (self.bundle / name).chmod(0o755)
        (self.bundle / 'OpenStudio.version').write_text('1.2.3\n')
        for name in ('webui/index.html', 'effects/example.jsfx', 'scripts/example.lua',
                     'models/basic_pitch_nmp.onnx', 'licenses/fixture.txt'):
            path = self.bundle / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('test fixture only')

    def test_release_rejects_system_python_bootstrap(self):
        with self.assertRaisesRegex(ValueError, 'Missing CMake cache'):
            packaging.validate_ai_release_configuration(self.root)
        cache = self.root / 'CMakeCache.txt'
        for setting in ('ON', 'TRUE', '1', ''):
            cache.write_text('OPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK:BOOL=' + setting + '\n')
            with self.assertRaisesRegex(ValueError, 'reconfigure and rebuild'):
                packaging.validate_ai_release_configuration(self.root)
        cache.write_text('// Development AI bootstrap setting\nOPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK:BOOL=OFF\n\n// Another setting\nOTHER:BOOL=ON\n')
        packaging.validate_ai_release_configuration(self.root)

    def test_rejects_missing_frontend_and_mismatched_version(self):
        with self.assertRaisesRegex(ValueError, 'version'):
            packaging.validate_bundle(self.bundle, '1.2.4')
        (self.bundle / 'webui/index.html').unlink()
        with self.assertRaisesRegex(ValueError, 'webui'):
            packaging.validate_bundle(self.bundle, '1.2.3')

    def test_rejects_mixed_browser_libraries_and_escaping_symlinks(self):
        library = self.bundle / 'libglib-2.0.so.0'
        library.write_bytes(b'fixture')
        with self.assertRaisesRegex(ValueError, 'shared library'):
            packaging.validate_bundle(self.bundle, '1.2.3')
        library.unlink()
        (self.bundle / 'external').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'escapes'):
            packaging.validate_bundle(self.bundle, '1.2.3')

    @unittest.skipUnless(shutil.which('dpkg-shlibdeps'), 'dpkg-shlibdeps required')
    def test_deb_round_trip_preserves_launcher_assets_and_dependencies(self):
        packaging.validate_bundle(self.bundle, '1.2.3')
        stage = self.root / 'package'
        runtime = packaging.stage_bundle(self.bundle, stage, "deb")
        package = packaging.build_deb(stage, self.root, self.root, '1.2.3', 'ubuntu', '26.04')
        control = subprocess.check_output(['dpkg-deb', '-f', package], text=True)
        for dependency in ('libc6 (>=', 'libwebkit2gtk-4.1-0', 'ffmpeg', 'libsecret-tools'):
            self.assertIn(dependency, control)
        self.assertNotIn('-dev', control)
        version = subprocess.check_output(['dpkg-deb', '-f', package, 'Version'], text=True).strip()
        self.assertEqual(version, '1.2.3-1')
        self.assertEqual(subprocess.run(['dpkg', '--compare-versions', version, 'gt', '1.2.3']).returncode, 0)
        unpacked = self.root / 'unpacked'
        subprocess.run(['dpkg-deb', '-x', package, unpacked], check=True)
        launcher = unpacked / 'usr/bin/OpenStudio'
        self.assertEqual(launcher.resolve(), unpacked / 'usr/lib/openstudio/OpenStudio')
        self.assertTrue((launcher.parent.parent / 'share/applications/OpenStudio.desktop').exists())
        self.assertTrue((unpacked / 'usr/share/mime/packages/openstudio.xml').exists())
        metadata = unpacked / 'usr/share/metainfo/in.org.openstudio.OpenStudio.metainfo.xml'
        self.assertIn('<name>OpenStudio</name>', metadata.read_text())
        self.assertIn('<launchable type="desktop-id">OpenStudio.desktop</launchable>', metadata.read_text())
        self.assertEqual((unpacked / 'usr/lib/openstudio/webui/index.html').read_text(), 'test fixture only')
        self.assertEqual(subprocess.run([launcher]).returncode, 0)
        self.assertFalse(runtime.stat().st_mode & 0o022)
        self.assertEqual((unpacked / 'usr/lib/openstudio/OpenStudio.package').read_text(), 'deb\n')

    def test_release_entry_point_rejects_missing_notes_before_build(self):
        process = subprocess.run(['python3', ROOT / 'tools/package-linux-native.py',
                                  '--format', 'deb', '--version', '1.2.3',
                                  '--notes-file', self.root / 'missing.md',
                                  '--build-dir', self.root, '--output-dir', self.root / 'output'],
                                 capture_output=True, text=True)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.root / 'output').exists())

    def test_failed_archive_preserves_previous_installer(self):
        stage = self.root / 'package'
        packaging.stage_bundle(self.bundle, stage, 'deb')
        target = self.root / 'OpenStudio-1.2.3-1-ubuntu-22.04-amd64.deb'
        target.write_bytes(b'previous verified installer')
        def fail_archive(args, **kwargs):
            Path(args[-1]).write_bytes(b'truncated archive')
            raise subprocess.CalledProcessError(2, args)
        with mock.patch.object(packaging, 'deb_dependencies', return_value='libc6'), \
             mock.patch.object(packaging, 'run', side_effect=fail_archive):
            with self.assertRaises(subprocess.CalledProcessError):
                packaging.build_deb(stage, self.root, self.root, '1.2.3', 'ubuntu', '22.04')
        self.assertEqual(target.read_bytes(), b'previous verified installer')

    def test_stage_export_can_be_archived_without_recomputing_dependencies(self):
        stage = self.root / 'package'
        packaging.stage_bundle(self.bundle, stage, 'deb')
        with mock.patch.object(packaging, 'deb_dependencies', return_value='libc6 (>= 2.35)'):
            exported = packaging.build_deb(stage, self.root, self.root, '1.2.3', 'ubuntu', '22.04', stage_only=True)
        package = self.root / 'exported.deb'
        subprocess.run(['dpkg-deb', '--root-owner-group', '--build', exported, package], check=True, capture_output=True)
        self.assertEqual(subprocess.check_output(['dpkg-deb', '-f', package, 'Depends'], text=True).strip(), 'libc6 (>= 2.35)')


if __name__ == '__main__':
    unittest.main()
