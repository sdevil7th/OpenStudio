"""Qualify universal support and its Finder launcher in a mounted, disposable DMG."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='support-dmg-qa-') as directory:
        work = Path(directory)
        stage = work / 'stage'; stage.mkdir()
        helper = stage / 'OpenStudio.app/Contents/Helpers/OpenStudioSupport.app'
        shutil.copytree(args.bundle / 'OpenStudioSupport.app', helper, symlinks=True)
        shortcut = stage / 'OpenStudio Support.app'
        shutil.copytree(args.bundle / shortcut.name, shortcut, symlinks=True)
        subprocess.run(['lipo', str(helper / 'Contents/MacOS/OpenStudioSupport'), '-verify_arch', 'arm64', 'x86_64'], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(helper)], check=True)
        image = work / 'support-qualification.dmg'
        subprocess.run(['hdiutil', 'create', '-srcfolder', str(stage), '-format', 'UDZO', str(image)], check=True)
        mount = work / 'mounted'
        subprocess.run(['hdiutil', 'attach', str(image), '-nobrowse', '-readonly', '-mountpoint', str(mount)], check=True)
        try:
            subprocess.run([sys.executable, str(ROOT / 'tools/test-packaged-support.py'), '--bundle',
                            str(mount / 'OpenStudio.app/Contents/Helpers/OpenStudioSupport.app')], check=True)
            report = work / 'finder-launch.json'
            subprocess.run(['open', '-n', '-W', str(mount / 'OpenStudio Support.app'), '--args', '--self-test', str(report)], timeout=90, check=True)
            assert json.loads(report.read_text())['status'] == 'pass'
        finally:
            subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
    print('PASS universal support, mounted DMG, Finder launcher, native diagnostics; main DAW not launched.')


if __name__ == '__main__':
    main()
