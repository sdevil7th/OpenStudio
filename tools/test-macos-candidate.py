"""Install both apps from an actual candidate DMG into a disposable test directory.

This does not remove quarantine, notarize, publish, or assert Gatekeeper acceptance.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dmg', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    summary = {'status': 'fail', 'version': args.version, 'published': False,
               'notarization': 'not_asserted', 'gatekeeper': 'not_asserted'}
    digest = hashlib.sha256()
    with args.dmg.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    summary['dmgSha256'] = digest.hexdigest()
    try:
        with tempfile.TemporaryDirectory(prefix='openstudio-candidate-') as directory:
            work = Path(directory)
            mount = work / 'mounted'
            subprocess.run(['hdiutil', 'attach', str(args.dmg.resolve()), '-nobrowse',
                            '-readonly', '-mountpoint', str(mount)], check=True, timeout=90)
            try:
                install = work / 'installed'; install.mkdir()
                for name in ('OpenStudio.app', 'OpenStudio Support.app'):
                    subprocess.run(['ditto', str(mount / name), str(install / name)], check=True)
            finally:
                subprocess.run(['hdiutil', 'detach', str(mount)], check=True, timeout=60)
            app = install / 'OpenStudio.app'
            helper = app / 'Contents/Helpers/OpenStudioSupport.app'
            shortcut = install / 'OpenStudio Support.app'
            for bundle in (app, shortcut):
                subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
            subprocess.run(['lipo', str(app / 'Contents/MacOS/OpenStudio'),
                            '-verify_arch', 'arm64', 'x86_64'], check=True)
            for tool in ('release_build_policy.py', 'validate-support-tool.py'):
                subprocess.run([sys.executable, str(ROOT / 'tools' / tool), '--bundle',
                                str(app), '--version', args.version], check=True)
            lifecycle = args.output.resolve() / 'window-lifecycle.json'
            subprocess.run(['pwsh', '-NoProfile', '-File', str(ROOT / 'tools/run-window-lifecycle-smoke.ps1'),
                            '-AppPath', str(app / 'Contents/MacOS/OpenStudio'), '-ReportPath',
                            str(lifecycle), '-TimeoutSeconds', '180'], check=True, timeout=240)
            subprocess.run([sys.executable, str(ROOT / 'tools/test-packaged-support.py'),
                            '--bundle', str(helper)], check=True, timeout=300)
            report = args.output.resolve() / 'finder-support.json'
            subprocess.run(['open', '-n', '-W', str(shortcut), '--args', '--self-test',
                            str(report)], check=True, timeout=90)
            if json.loads(report.read_text())['status'] != 'pass':
                raise RuntimeError('Installed Finder support launch failed')
            summary.update(status='pass', installedLifecycle='pass', frozenSupport='pass',
                           finderSupport='pass', signatureIntegrity='pass')
    except Exception as error:
        summary['reason'] = str(error)
        raise
    finally:
        (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')


if __name__ == '__main__':
    main()
