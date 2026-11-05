"""Bind installed-Snap objective qualification to the exact unpublished artifact."""
import argparse
import hashlib
import json
from pathlib import Path
import yaml
from openstudio_support.identity import native_ids


def qualify(root, snap, project, desktop, safe, support, updater, version):
    meta = yaml.safe_load((root / 'meta/snap.yaml').read_text())
    if (meta.get('name') != 'openstudio' or str(meta.get('version')) != version
            or meta.get('confinement') != 'classic' or meta.get('base') != 'core22'):
        raise ValueError('Installed Snap identity, version or confinement mismatch')
    apps = meta.get('apps', {})
    if set(apps) != {'openstudio', 'support'}:
        raise ValueError('Unexpected applications in Snap')
    if any(any(key in app for key in ('daemon', 'timer', 'activates-on', 'autostart')) for app in apps.values()):
        raise ValueError('Snap must not add services, timers or autostart')
    if (root / 'meta/hooks').exists():
        raise ValueError('Unexpected Snap lifecycle hooks')
    if (root / 'usr/lib/openstudio/OpenStudio.package').read_text().strip() != 'snap':
        raise ValueError('Snap-managed update marker missing')
    for folder in (desktop, safe):
        report = json.loads((folder / 'qualification.json').read_text())
        if report.get('success') is not True or not report.get('checks'):
            raise ValueError('Installed desktop/export qualification failed')
    if json.loads(support.read_text()).get('status') != 'pass':
        raise ValueError('Explicitly opened Support self-test failed')
    report = json.loads((updater / 'result.json').read_text())
    if report.get('pass') is not True or not any(
            item.get('name') == 'snap_updates_use_store_without_appimage_restore' and item.get('pass') is True
            for item in report.get('checks', [])):
        raise ValueError('Installed Snap update routing was not qualified')
    receipt = json.loads((project / 'input-receipt.json').read_text())
    installed_ids = native_ids(root / 'usr/lib/openstudio/OpenStudio')
    if not installed_ids or installed_ids != receipt.get('nativeDebugIds'):
        raise ValueError('Snap ELF patching changed native symbol identity')
    if any((root / 'usr/lib/openstudio/webui').rglob('*.map')):
        raise ValueError('Frontend symbol maps must stay outside runtime packages')
    return {**receipt, 'status': 'pass', 'published': False,
            'snapSha256': hashlib.sha256(snap.read_bytes()).hexdigest(),
            'supportLaunch': 'explicit_only', 'installedDesktopAndExports': 'pass',
            'storeUpdates': 'pass', 'classicApproval': 'not_asserted',
            'hardwareAudio': 'not_asserted', 'refreshWhileRunning': 'not_asserted'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('root', 'snap', 'project', 'desktop', 'safe', 'support', 'updater', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = vars(parser.parse_args())
    output = args.pop('output')
    result = qualify(**args)
    with output.open('x') as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result, indent=2))
