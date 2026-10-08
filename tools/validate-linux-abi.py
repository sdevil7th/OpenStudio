#!/usr/bin/env python3
"""Audit trusted build outputs against the runtime on the qualification host.

Run inside each target OS, without development-library overrides. ldd -v checks
the actual loader's provider and version resolution, including transitive needs;
readelf records each object's requirements and enforces an optional glibc ceiling.
This is a loader gate, not a desktop, dlopen-plugin, or audio qualification claim.
Only use on trusted OpenStudio build artifacts (ldd is not a malware sandbox).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def run(*command):
    env = os.environ.copy()
    for name in ('LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT'):
        env.pop(name, None)
    env['LC_ALL'] = 'C'
    return subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=60)


def version_tuple(value):
    if not re.fullmatch(r'\d+\.\d+(?:\.\d+)*', value):
        raise ValueError(f'Invalid numeric version: {value}')
    return tuple(map(int, value.split('.')))


def audit(root, max_glibc=None, require_os=None):
    root = Path(root).resolve(strict=True)
    os_release = Path('/etc/os-release').read_text()
    release = dict(line.split('=', 1) for line in os_release.splitlines()
                   if '=' in line and not line.startswith('#'))
    host = ':'.join(release.get(key, '').strip('"') for key in ('ID', 'VERSION_ID'))
    result = {'host': host, 'osRelease': os_release, 'root': str(root),
              'maxGlibc': max_glibc, 'objects': [], 'errors': [],
              'scope': 'ELF loader/version requirements on this host; dlopen/UI/audio not asserted'}
    if require_os and host != require_os:
        result['errors'].append(f'Requires qualification host {require_os}; found {host}')
    ceiling = version_tuple(max_glibc) if max_glibc else None
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open('rb') as stream:
            if stream.read(4) != b'\x7fELF':
                continue
        dynamic = run('readelf', '--dynamic', '--wide', str(path))
        versions = run('readelf', '--version-info', '--wide', str(path))
        errors = []
        if dynamic.returncode or versions.returncode:
            errors.append('readelf could not inspect ELF metadata')
        # Definitions in a provider are not requirements on its consumer.
        needs = versions.stdout.partition('Version needs section')[2]
        required = sorted(set(re.findall(r'Name: (\S+)', needs)))
        if ceiling:
            for name in required:
                if re.fullmatch(r'GLIBC_\d+(?:\.\d+)+', name) and version_tuple(name[6:]) > ceiling:
                    errors.append(f'{name} exceeds declared GLIBC_{max_glibc} baseline')
        loader = ''
        if '(NEEDED)' in dynamic.stdout:
            resolved = run('ldd', '-v', str(path))
            loader = resolved.stdout
            if resolved.returncode or re.search(r'not found|version lookup error', loader):
                errors.append('Loader rejected a dependency or required symbol version')
        with path.open('rb') as stream:
            digest = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        result['objects'].append({'path': str(path.relative_to(root)),
                                  'sha256': digest.hexdigest(), 'requiredVersions': required,
                                  'loader': loader, 'errors': errors})
    if not result['objects']:
        result['errors'].append('No ELF objects found; refusing an empty audit')
    result['success'] = not result['errors'] and all(not item['errors'] for item in result['objects'])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--max-glibc')
    parser.add_argument('--require-os', help='Exact baseline, e.g. ubuntu:22.04')
    args = parser.parse_args()
    try:
        result = audit(args.root, args.max_glibc, args.require_os)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result = {'success': False, 'errors': [str(error)]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + '\n')
    print(f"Linux ABI: {'pass' if result['success'] else 'FAIL'}; report: {args.report}")
    return 0 if result['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
