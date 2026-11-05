"""Build-time identity and separate symbol archiving; never started by the DAW."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from openstudio_support.common import read_json, sha256, utc_now
from openstudio_support.identity import native_ids


ROOT = Path(__file__).resolve().parents[1]


def inventory(path):
    ids = native_ids(path)
    if not ids:
        raise ValueError(f'Native debug identity is missing: {path.name}')
    return {'module': path.name, 'debugIds': ids, 'sha256': sha256(path)}


def layout(app):
    if app.suffix == '.app':
        app = app / 'Contents/MacOS/OpenStudio'
    assets = app.parent.parent / 'Resources' if app.parent.name == 'MacOS' else app.parent
    return app, assets


def write_identity(app, version, configuration):
    app, assets = layout(app)
    modules = [inventory(app)]
    helper = app.with_name('OpenStudioCrashReporter.exe')
    if helper.is_file():
        modules.append(inventory(helper))
    git = lambda *args: subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
    try:
        source = {'commit': git('rev-parse', 'HEAD'), 'dirty': bool(git('status', '--porcelain', '--untracked-files=normal'))}
    except (OSError, subprocess.SubprocessError):
        source = {'commit': None, 'dirty': None}
    frontend = [{'file': str(path.relative_to(assets / 'webui')).replace('\\', '/'), 'sha256': sha256(path)}
                for path in sorted((assets / 'webui').rglob('*.js'))]
    value = {'schemaVersion': 1, 'kind': 'openstudio_build_identity', 'version': version,
             'configuration': configuration, 'createdAtUtc': utc_now(), 'source': source,
             'hashScope': 'before packaging/signing; debug IDs survive signing and stripping',
             'modules': modules, 'frontend': frontend}
    (assets / 'OpenStudio.build-identity.json').write_text(json.dumps(value, indent=2), encoding='utf-8')


def archive(app, build_dir, output, frontend_symbols):
    app, assets = layout(app)
    identity = read_json(assets / 'OpenStudio.build-identity.json')
    actual = inventory(app)
    if identity.get('kind') != 'openstudio_build_identity' or actual not in identity.get('modules', []):
        raise ValueError('Rebuild before archiving: application bytes/identity changed after the build')
    destination = output / actual['sha256']
    if destination.exists():
        raise ValueError(f'Symbol archive already exists; never overwritten: {destination}')
    output.mkdir(parents=True, exist_ok=True)
    # Build in a temporary sibling; failed validation must not leave a plausible archive.
    with tempfile.TemporaryDirectory(prefix='.symbols-', dir=output) as temporary:
        stage = Path(temporary) / 'archive'
        stage.mkdir()
        entries = []
        for module in identity['modules']:
            binary = app.with_name(module['module'])
            if inventory(binary) != module:
                raise ValueError('Native module changed after its build manifest was written')
            shutil.copy2(binary, stage / binary.name)
            if module['debugIds'][0].startswith('pdb:'):
                pdb = binary.with_suffix('.pdb')
                if not pdb.is_file():
                    pdb = build_dir / identity['configuration'] / pdb.name
                target = stage / pdb.name
                shutil.copy2(pdb, target)
            elif module['debugIds'][0].startswith('macho:'):
                dsym = Path(temporary) / (binary.name + '.dSYM')
                subprocess.run(['dsymutil', str(binary), '-o', str(dsym)], check=True)
                target = stage / (binary.name + '.dwarf')
                shutil.copy2(dsym / 'Contents/Resources/DWARF' / binary.name, target)
                shutil.copytree(dsym, stage / dsym.name)
            else:
                target = stage / (binary.name + '.debug')
                subprocess.run(['objcopy', '--only-keep-debug', str(binary), str(target)], check=True)
            symbols = inventory(target)
            if symbols['debugIds'] != module['debugIds']:
                raise ValueError(f'Mismatched symbols for {binary.name}')
            entries.append({'file': target.name, 'sha256': symbols['sha256'], 'debugIds': symbols['debugIds']})
        frontend = read_json(frontend_symbols / 'manifest.json')
        if frontend.get('kind') != 'openstudio_frontend_symbols':
            raise ValueError('Missing frontend symbol inventory')
        current = {item['file']: item['sha256'] for item in identity['frontend']}
        runtime = {path.relative_to(assets / 'webui').as_posix(): sha256(path)
                   for path in (assets / 'webui').rglob('*.js')}
        if runtime != current:
            raise ValueError('Packaged JavaScript changed after its build identity was written')
        if current != {item['file']: item['sha256'] for item in frontend['chunks']} or not current:
            raise ValueError('Frontend symbols do not match packaged JavaScript')
        for chunk in frontend['chunks']:
            for key in ('file', 'map'):
                relative = Path(chunk[key])
                if relative.is_absolute() or '..' in relative.parts or '\\' in chunk[key] or ':' in chunk[key]:
                    raise ValueError('Unsafe frontend symbol path')
                source = frontend_symbols / relative
                expected = chunk['sha256'] if key == 'file' else chunk['mapSha256']
                if sha256(source) != expected:
                    raise ValueError('Frontend symbol bytes changed')
                target = stage / 'frontend' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        shutil.copy2(frontend_symbols / 'manifest.json', stage / 'frontend/manifest.json')
        manifest = {'schemaVersion': 1, 'kind': 'openstudio_symbol_archive', 'build': identity,
                    'symbols': entries, 'createdAtUtc': utc_now()}
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        stage.rename(destination)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('identity', 'archive'))
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--version')
    parser.add_argument('--configuration', default='Release')
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'build')
    parser.add_argument('--output', type=Path, default=ROOT / 'output/symbols')
    parser.add_argument('--frontend-symbols', type=Path, default=ROOT / 'frontend/debug-symbols')
    args = parser.parse_args()
    if args.action == 'identity':
        if not args.version:
            parser.error('--version is required for identity generation')
        write_identity(args.app, args.version, args.configuration)
    else:
        print(archive(args.app, args.build_dir, args.output, args.frontend_symbols))


if __name__ == '__main__':
    main()
