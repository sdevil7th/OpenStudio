"""Native installer/archive qualification with the real support payload and a dummy DAW."""
import argparse
import importlib.util
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    native = load('native_package', 'package-linux-native.py')
    appimage = load('support_appimage', 'package-support-appimage.py')
    with tempfile.TemporaryDirectory(prefix='support-linux-qa-') as directory:
        root = Path(directory)
        bundle = root / 'bundle'
        shutil.copytree(args.bundle, bundle, symlinks=True)
        for name in ('OpenStudio', 'OpenStudioUpdateInstaller'):
            shutil.copy2('/bin/true', bundle / name)
        (bundle / 'OpenStudio.version').write_text(args.version)
        for name in ('webui/index.html', 'effects/fixture', 'scripts/fixture', 'licenses/fixture', 'models/basic_pitch_nmp.onnx'):
            path = bundle / name; path.parent.mkdir(exist_ok=True); path.write_text('QA fixture, not the DAW')
        native.validate_bundle(bundle, args.version)
        stage = root / 'package'
        native.stage_bundle(bundle, stage, 'deb')
        desktop = stage / 'usr/share/applications/OpenStudioSupport.desktop'
        subprocess.run(['desktop-file-validate', str(desktop)], check=True)
        assert 'Exec=OpenStudioSupport\n' in desktop.read_text()
        assert not list(stage.rglob('*autostart*'))
        deb = native.build_deb(stage, root, root, args.version, 'ubuntu', '22.04')
        extracted = root / 'deb-extracted'
        subprocess.run(['dpkg-deb', '-x', str(deb), str(extracted)], check=True)
        subprocess.run([sys.executable, str(ROOT / 'tools/test-packaged-support.py'), '--bundle',
                        str(extracted / 'usr/lib/openstudio')], check=True)
        rpm = native.build_rpm(stage, root, root, args.version, '41')
        rpm_root = root / 'rpm-extracted'; rpm_root.mkdir()
        archive = subprocess.run(['rpm2cpio', str(rpm)], stdout=subprocess.PIPE, check=True)
        subprocess.run(['cpio', '-idm', '--quiet'], input=archive.stdout, cwd=rpm_root, check=True)
        changed = []
        for original in (bundle / 'support-runtime').rglob('*'):
            if original.is_file():
                copy = rpm_root / 'usr/lib/openstudio' / original.relative_to(bundle)
                if not copy.is_file() or hashlib.sha256(copy.read_bytes()).digest() != hashlib.sha256(original.read_bytes()).digest():
                    changed.append(str(original.relative_to(bundle)))
        if changed:
            raise AssertionError('RPM changed frozen runtime files: ' + ', '.join(changed[:20]))
        subprocess.run([sys.executable, str(ROOT / 'tools/test-packaged-support.py'), '--bundle',
                        str(rpm_root / 'usr/lib/openstudio')], check=True)
        image = appimage.package(bundle, ROOT / 'output/support-distribution', args.version)
        report = root / 'appimage-selftest.json'
        tested = subprocess.run([str(image), '--self-test', str(report)], env=dict(os.environ, APPIMAGE_EXTRACT_AND_RUN='1'),
                                capture_output=True, text=True)
        if tested.returncode or not report.is_file():
            raise AssertionError(f'AppImage failed: {tested.stdout}\n{tested.stderr}\n' +
                                 (report.read_text() if report.is_file() else 'No self-test report'))
        assert json.loads(report.read_text())['status'] == 'pass'
    print('PASS real support payload in DEB, RPM, desktop entry and companion AppImage; DAW is a test stub.')


if __name__ == '__main__':
    main()
