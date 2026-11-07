"""Combine qualified native support runtimes with a universal, manual-only launcher."""
import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
from support_package import validate, write_inventory

ROOT = Path(__file__).resolve().parents[1]


def make_launcher(target, version, shortcut=False):
    if target.exists():
        raise ValueError(f'Launcher already exists: {target}')
    contents = target / 'Contents'
    (contents / 'MacOS').mkdir(parents=True)
    (contents / 'Resources').mkdir()
    info = {'CFBundleIdentifier': 'in.org.openstudio.support-shortcut' if shortcut else 'in.org.openstudio.support',
            'CFBundleName': 'OpenStudio Support', 'CFBundleDisplayName': 'OpenStudio Support',
            'CFBundleExecutable': 'OpenStudioSupport', 'CFBundlePackageType': 'APPL',
            'CFBundleVersion': version, 'CFBundleShortVersionString': version,
            'LSMinimumSystemVersion': '11.0', 'NSHighResolutionCapable': True}
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['xcrun', 'clang', '-Wall', '-Wextra', '-Werror', '-fobjc-arc',
                    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0',
                    *(['-DOPENSTUDIO_SUPPORT_SHORTCUT=1'] if shortcut else []),
                    '-framework', 'Cocoa', str(ROOT / 'packaging/macos/SupportLauncher.m'),
                    '-o', str(contents / 'MacOS/OpenStudioSupport')], check=True)


def assemble(arm64, intel, output, version):
    target = output / 'OpenStudioSupport.app'
    for architecture, source in (('arm64', arm64), ('x86_64', intel)):
        validate(source, version)
        subprocess.run(['lipo', str(source / 'Contents/MacOS/OpenStudioSupport'), '-verify_arch', architecture], check=True)
    make_launcher(target, version)
    for architecture, source in (('arm64', arm64), ('x86_64', intel)):
        shutil.copytree(source, target / 'Contents/Helpers' / architecture / 'OpenStudioSupport.app', symlinks=True)
    # Inventory/version anchors for the outer launcher. Actual analysis runs in a native child bundle.
    for name in ('support-build.json', 'support-midi.js', 'support-midi-sources.json', 'support-licenses'):
        source = arm64 / 'Contents/Resources' / name
        destination = target / 'Contents/Resources' / name
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)
    write_inventory(target, version)
    subprocess.run(['codesign', '--force', '--sign', '-', str(target)], check=True)
    shortcut = output / 'OpenStudio Support.app'
    make_launcher(shortcut, version, shortcut=True)
    subprocess.run(['codesign', '--force', '--sign', '-', str(shortcut)], check=True)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arm64', type=Path, required=True)
    parser.add_argument('--x86-64', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    print(assemble(args.arm64.resolve(), args.x86_64.resolve(), args.output.resolve(), args.version))
