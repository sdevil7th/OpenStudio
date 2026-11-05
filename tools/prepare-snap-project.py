"""Prepare an unpublished Snap from the exact qualified Ubuntu DEB payload."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import yaml

from release_build_policy import validate as validate_policy
from support_package import validate as validate_support
from openstudio_support.identity import native_ids

ROOT = Path(__file__).resolve().parents[1]


def prepare(deb, version, output, diagnostic_source_run=''):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Expected an exact three-part application version')
    if diagnostic_source_run and not re.fullmatch(r'[1-9]\d*', diagnostic_source_run):
        raise ValueError('Expected an explicit prior workflow run ID')
    deb, output = Path(deb).resolve(strict=True), Path(output).absolute()
    if output.exists():
        raise ValueError('Use a fresh Snap project output directory')
    fields = subprocess.run(['dpkg-deb', '-f', str(deb), 'Package', 'Version', 'Architecture'],
                            check=True, capture_output=True, text=True).stdout
    expected = {'Package': 'openstudio', 'Architecture': 'amd64'}
    actual = dict(line.split(': ', 1) for line in fields.splitlines() if ': ' in line)
    if any(actual.get(key) != value for key, value in expected.items()):
        raise ValueError('Expected the qualified OpenStudio amd64 DEB')
    if not re.fullmatch(re.escape(version) + r'-[1-9]\d*', actual.get('Version', '')):
        raise ValueError('DEB version differs from the requested application version')
    with tempfile.TemporaryDirectory() as directory:
        extracted = Path(directory)
        subprocess.run(['dpkg-deb', '-x', str(deb), str(extracted)], check=True)
        bundle = extracted / 'usr/lib/openstudio'
        if (bundle / 'OpenStudio.version').read_text().strip() != version:
            raise ValueError('Application payload version differs from the DEB')
        validate_policy(bundle, version)
        validate_support(bundle, version, platform='linux')
        for path in extracted.rglob('*'):
            if path.is_symlink() and not path.resolve().is_relative_to(extracted):
                raise ValueError('DEB contains an escaping symlink')
        output.mkdir(parents=True)
        payload = output / 'payload'
        shutil.copytree(extracted / 'usr', payload / 'usr', symlinks=True)
    runtime = payload / 'usr/lib/openstudio'
    (runtime / 'OpenStudio.package').write_text('snap\n')
    bin_dir = payload / 'bin'
    bin_dir.mkdir()
    for name in ('openstudio-launch', 'openstudio-support-launch'):
        target = bin_dir / name
        target.write_text((ROOT / 'packaging/snap/launch').read_text(), newline='\n')
        target.chmod(0o755)
    applications = payload / 'usr/share/applications'
    for name, title, command in (
            ('openstudio', 'OpenStudio', 'openstudio'),
            ('openstudio-support', 'OpenStudio Support', 'openstudio.support')):
        (applications / (name + '.desktop')).write_text(
            '[Desktop Entry]\nType=Application\nName=' + title + '\nExec=' + command
            + '\nIcon=${SNAP}/usr/share/icons/hicolor/256x256/apps/OpenStudio.png\n'
              'Terminal=false\nCategories=AudioVideo;Audio;\n', newline='\n')
    # Keep one desktop entry per explicitly launched application.
    for old in ('OpenStudio.desktop', 'OpenStudioSupport.desktop'):
        (applications / old).unlink(missing_ok=True)
    project = yaml.safe_load((ROOT / 'packaging/snap/snapcraft.yaml').read_text())
    listing = json.loads((ROOT / 'packaging/snap/listing.json').read_text())
    if listing['name'] != project['name']:
        raise ValueError('Snap package and Store listing name differ')
    for key in ('title', 'summary', 'description', 'license', 'website', 'contact', 'issues', 'source-code'):
        project[key] = listing[key]
    project['version'] = version
    (output / 'snapcraft.yaml').write_text(yaml.safe_dump(project, sort_keys=False))
    shutil.copyfile(ROOT / 'frontend/public/icon.png', output / 'icon.png')
    shutil.copyfile(ROOT / 'tools/patch-snap-webkit.py', output / 'patch-snap-webkit.py')
    receipt = {'version': version, 'sourceDebSha256': hashlib.sha256(deb.read_bytes()).hexdigest(),
               'applicationSha256': hashlib.sha256((runtime / 'OpenStudio').read_bytes()).hexdigest(),
               'nativeDebugIds': native_ids(runtime / 'OpenStudio'),
               'snapName': 'openstudio', 'snapId': 'Qde7k3B7zO9NGOR8QIyMUWs8l6z6hkZ7',
               'publisher': 'sdevil7th', 'published': False,
               'classicApproval': 'not_asserted', 'hardwareAudio': 'not_asserted'}
    if diagnostic_source_run:
        receipt['diagnosticSourceRun'] = diagnostic_source_run
    (output / 'input-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deb', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--diagnostic-source-run', default='')
    args = parser.parse_args()
    print(json.dumps(prepare(args.deb, args.version, args.output, args.diagnostic_source_run), indent=2))
