#!/usr/bin/env python3
"""Build a distro-native OpenStudio package from a validated Release directory.

Run on the target distribution (or its oldest supported compatible build host).
This tool neither installs packages nor publishes them. Runtime dependencies are
derived from the binaries; dlopen/subprocess dependencies are declared explicitly.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, text=True, **kwargs)


def host_release():
    values = {}
    for line in Path('/etc/os-release').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep:
            values[key] = value.strip('"')
    distro, version = values['ID'], values['VERSION_ID']
    if not re.fullmatch(r'[a-z0-9]+', distro) or not re.fullmatch(r'[0-9.]+', version):
        raise ValueError('Unsupported distribution identifier/version')
    return distro, version


def validate_ai_release_configuration(build_dir):
    cache = Path(build_dir) / 'CMakeCache.txt'
    if not cache.is_file():
        raise ValueError('Missing CMake cache: cannot verify managed AI runtime release configuration')
    settings = dict(re.findall(r'^([^\r\n:#]+):[^\r\n=]+=(.*)$', cache.read_text(), re.MULTILINE))
    if settings.get('OPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK', '').upper() not in ('OFF', 'FALSE', '0'):
        raise ValueError('Release packaging requires OPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK=OFF; reconfigure and rebuild')


def validate_bundle(bundle, version):
    required = ('OpenStudio', 'OpenStudioUpdateInstaller', 'OpenStudio.version',
                'webui/index.html', 'effects', 'scripts', 'models/basic_pitch_nmp.onnx',
                'licenses')
    for name in required:
        if not (bundle / name).exists():
            raise ValueError(f'Missing runtime asset: {name}')
    if (bundle / 'OpenStudio.version').read_text().strip() != version:
        raise ValueError('Runtime version does not match the package version')
    for name in ('OpenStudio', 'OpenStudioUpdateInstaller'):
        binary = bundle / name
        if not os.access(binary, os.X_OK) or binary.read_bytes()[:4] != b'\x7fELF':
            raise ValueError(f'Not an executable ELF binary: {name}')
        header = run(['readelf', '-h', binary], capture_output=True).stdout
        if 'Advanced Micro Devices X86-64' not in header:
            raise ValueError('Only x86-64 Linux packages are currently supported')
    # Browser/toolkit libraries must come from one maintained system stack.
    # Copying an AppImage's mixed host/bundled dependency set is not supported.
    for path in bundle.rglob('*'):
        if path.is_symlink() and not path.resolve().is_relative_to(bundle.resolve()):
            raise ValueError(f'Runtime symlink escapes the bundle: {path}')
        if path.is_file() and '.so' in path.name and not path.name.startswith('libonnxruntime.so'):
            raise ValueError(f'Unexpected bundled shared library: {path}')
    if (bundle / 'python').exists() or (bundle / 'ffmpeg').exists():
        raise ValueError('Native Linux packages use system FFmpeg and optional AI runtimes')


def stage_bundle(bundle, stage, package_format):
    if package_format not in ("deb", "rpm"):
        raise ValueError("Unsupported native package format")
    destination = stage / 'usr/lib/openstudio'
    shutil.copytree(bundle, destination, symlinks=True,
                    ignore=shutil.ignore_patterns('*.log', '__pycache__', '*.pyc'))
    marker = destination / 'OpenStudio.package'
    marker.write_text(package_format + '\n')
    marker.chmod(0o644)
    # Shared package contents are never user-writable, including executable scripts.
    for path in destination.rglob('*'):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() or os.access(path, os.X_OK) else 0o644)
    bin_dir = stage / 'usr/bin'
    bin_dir.mkdir(parents=True)
    (bin_dir / 'OpenStudio').symlink_to('../lib/openstudio/OpenStudio')
    for source, relative in (
        (ROOT / 'tools/OpenStudio.desktop', 'usr/share/applications/OpenStudio.desktop'),
        (ROOT / 'assets/icon-256x256.png', 'usr/share/icons/hicolor/256x256/apps/OpenStudio.png'),
        (ROOT / 'packaging/linux/openstudio-mime.xml', 'usr/share/mime/packages/openstudio.xml'),
        (ROOT / 'packaging/linux/in.org.openstudio.OpenStudio.metainfo.xml', 'usr/share/metainfo/in.org.openstudio.OpenStudio.metainfo.xml'),
        (ROOT / 'LICENSE', 'usr/share/doc/openstudio/copyright'),
    ):
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o644)
    stage.chmod(0o755)
    for path in stage.rglob('*'):
        if path.is_dir() and not path.is_symlink():
            path.chmod(0o755)
    return destination


def deb_dependencies(stage, work):
    # dpkg-shlibdeps must fail on missing library metadata. The only private
    # library is ONNX Runtime; exclude this package's self-dependency explicitly.
    debian = work / 'debian'
    debian.mkdir()
    (debian / 'control').write_text('Source: openstudio\n\nPackage: openstudio\nArchitecture: amd64\n')
    local = debian / 'shlibs.local'
    local.write_text('libonnxruntime 1 openstudio\n')
    runtime = stage / 'usr/lib/openstudio'
    binaries = [runtime / 'OpenStudio', runtime / 'OpenStudioUpdateInstaller']
    binaries.extend(p for p in runtime.glob('libonnxruntime.so*') if not p.is_symlink())
    output = run(['dpkg-shlibdeps', '-O', '-xopenstudio', f'-L{local}',
                  f'-l{runtime}', *[f'-e{p}' for p in binaries]], cwd=work,
                 capture_output=True).stdout
    dependencies = next((line.removeprefix('shlibs:Depends=') for line in output.splitlines()
                         if line.startswith('shlibs:Depends=')), '')
    if not dependencies:
        raise ValueError('dpkg-shlibdeps returned no runtime dependencies')
    # ALSA/JACK/X11 are partly loaded dynamically; dependency scanners cannot
    # discover every such dependency. Alternatives preserve installed providers.
    return dependencies + ', ' + ', '.join((
        'libwebkit2gtk-4.1-0 (>= 2.40)', 'libgtk-3-0t64 | libgtk-3-0',
        'libasound2t64 | libasound2', 'libjack-jackd2-0 | libjack-0.125 | libjack-0.125t64',
        'libx11-6', 'libxext6', 'libxrandr2', 'libxinerama1', 'libxcursor1',
        'libxcomposite1', 'libxrender1', 'libfreetype6', 'libfontconfig1',
        'libcurl4t64 | libcurl4', 'ffmpeg', 'libsecret-tools',
        'shared-mime-info', 'desktop-file-utils',
    ))


def build_deb(stage, work, output, version, distro, distro_version, revision=1, stage_only=False):
    dependencies = deb_dependencies(stage, work)
    control = stage / 'DEBIAN'
    control.mkdir()
    control.chmod(0o755)
    size = sum(p.stat().st_size for p in stage.rglob('*') if p.is_file()) // 1024
    (control / 'control').write_text(
        f'Package: openstudio\nVersion: {version}-{revision}\nArchitecture: amd64\n'
        'Maintainer: OpenStudio <contact@openstudio.org.in>\nSection: sound\nPriority: optional\n'
        f'Installed-Size: {size}\nDepends: {dependencies}\n'
        'Homepage: https://openstudio.org.in\n'
        'Description: OpenStudio digital audio workstation\n'
        ' Record, edit, mix and export audio and MIDI with native plugin hosting.\n')
    (control / 'control').chmod(0o644)
    refresh = ('#!/bin/sh\nset -e\n'
               'if command -v update-desktop-database >/dev/null 2>&1; then\n'
               '    update-desktop-database /usr/share/applications\nfi\n'
               'if command -v update-mime-database >/dev/null 2>&1; then\n'
               '    update-mime-database /usr/share/mime\nfi\n')
    for script in ('postinst', 'postrm'):
        (control / script).write_text(refresh)
        (control / script).chmod(0o755)
    name = f'OpenStudio-{version}-{revision}-{distro}-{distro_version}-amd64.deb'
    target = output / name
    if stage_only:
        # Dependency metadata is generated on the target OS. The archive can
        # then be assembled elsewhere without resolving against newer libraries.
        target = output / (name + '-root')
        shutil.copytree(stage, target, symlinks=True)
        return target
    temporary = work / (name + '.partial')
    run(['dpkg-deb', '--root-owner-group', '--build', stage, temporary])
    # A failed archiver must not leave a truncated installer at its final name.
    shutil.move(temporary, target)
    return target


def build_rpm(stage, work, output, version, distro_version, revision=1):
    if not shutil.which('rpmbuild'):
        raise ValueError('rpmbuild is required on the Fedora build host')
    # RPM derives ELF dependencies and bundled-library provides automatically.
    # Do not disable its dependency generator, even for private ONNX Runtime.
    spec = work / 'openstudio.spec'
    spec.write_text(f'''Name: openstudio
Version: {version}
Release: {revision}
Summary: OpenStudio digital audio workstation
License: AGPL-3.0-only
URL: https://openstudio.org.in
BuildArch: x86_64
Requires: webkit2gtk4.1 >= 2.40, gtk3, alsa-lib
Requires: libjack.so.0()(64bit), libX11, libXext, libXrandr, libXinerama, libXcursor, libXcomposite, libXrender
Requires: fontconfig, freetype, libcurl.so.4()(64bit), ffmpeg-free, /usr/bin/secret-tool, shared-mime-info, desktop-file-utils

%description
Record, edit, mix and export audio and MIDI with native plugin hosting.

%install
mkdir -p "%{{buildroot}}"
cp -a "{stage}/usr" "%{{buildroot}}/"

%files
/usr/bin/OpenStudio
/usr/lib/openstudio
/usr/share/applications/OpenStudio.desktop
/usr/share/icons/hicolor/256x256/apps/OpenStudio.png
/usr/share/mime/packages/openstudio.xml
/usr/share/metainfo/in.org.openstudio.OpenStudio.metainfo.xml
%license /usr/share/doc/openstudio/copyright
''')
    run(['rpmbuild', '-bb', '--define', f'_topdir {work / "rpm"}',
         '--define', '_build_id_links none', spec])
    packages = list((work / 'rpm/RPMS/x86_64').glob('openstudio-*.rpm'))
    if len(packages) != 1:
        raise ValueError('Expected exactly one RPM output')
    target = output / f'OpenStudio-{version}-{revision}-fedora-{distro_version}-x86_64.rpm'
    shutil.copyfile(packages[0], target)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--format', choices=('deb', 'rpm'), required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'build-release-linux')
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--revision', type=int, default=1, help='Positive native package revision for upgrades of the same app version')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'dist/linux')
    parser.add_argument('--stage-only', action='store_true', help='Export a fresh Debian package tree with target-OS dependency metadata; do not create an installer')
    args = parser.parse_args()
    if args.revision < 1:
        parser.error('--revision must be positive')
    if args.stage_only and args.format != 'deb':
        parser.error('--stage-only currently supports Debian packages')
    version = args.version.removeprefix('v')
    spec = importlib.util.spec_from_file_location('release_notes', ROOT / 'tools/validate-release-notes.py')
    notes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notes)
    notes.validate(version, args.notes_file or ROOT / f'docs/releases/{version}.md')
    distro, distro_version = host_release()
    if (args.format == 'deb' and distro not in ('ubuntu', 'debian', 'linuxmint')
            or args.format == 'rpm' and distro != 'fedora'):
        raise ValueError('Build native packages on the corresponding target distribution')
    validate_ai_release_configuration(args.build_dir)
    bundle = args.build_dir.resolve() / 'OpenStudio_artefacts/Release'
    validate_bundle(bundle, version)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='openstudio-native-') as directory:
        work = Path(directory)
        stage = work / 'package'
        stage_bundle(bundle, stage, args.format)
        run(['desktop-file-validate', stage / 'usr/share/applications/OpenStudio.desktop'])
        run(['appstreamcli', 'validate', '--no-net', stage / 'usr/share/metainfo/in.org.openstudio.OpenStudio.metainfo.xml'])
        if args.format == 'deb':
            target = build_deb(stage, work, output, version, distro, distro_version, args.revision, args.stage_only)
        else:
            target = build_rpm(stage, work, output, version, distro_version, args.revision)
    if args.stage_only:
        print(f'Staged {target}; no installer created. Assemble with dpkg-deb --root-owner-group --build.')
    else:
        print(f'Created {target}; clean-desktop installation and feature qualification still required.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
