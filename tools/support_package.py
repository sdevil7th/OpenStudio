"""Build-time layout and inventory for the independently launched support app."""
import json
from pathlib import Path, PurePosixPath
import sys


def layout(bundle, platform=None):
    root = Path(bundle).resolve(strict=True)
    if root.name == 'OpenStudio.app':
        root = root / 'Contents/Helpers/OpenStudioSupport.app'
    if root.suffix == '.app':
        return root, root / 'Contents/MacOS/OpenStudioSupport', root / 'Contents/Resources'
    exe = 'OpenStudioSupport.exe' if (platform or sys.platform) == 'win32' else 'OpenStudioSupport'
    return root, root / exe, root / 'support-runtime'


def write_inventory(bundle, version, platform=None):
    root, _exe, resources = layout(bundle, platform)
    files = sorted(path.relative_to(root).as_posix() for path in root.rglob('*')
                   if path.is_file() and '_CodeSignature' not in path.parts
                   and path.name != 'support-package.json')
    (resources / 'support-package.json').write_text(json.dumps({'version': version, 'files': files}, indent=2), encoding='utf-8')


def validate(bundle, version, platform=None):
    root, exe, resources = layout(bundle, platform)
    manifest = json.loads((resources / 'support-package.json').read_text(encoding='utf-8'))
    build = json.loads((resources / 'support-build.json').read_text(encoding='utf-8'))
    if build != {'version': version, 'launch': 'manual_only'} or manifest['version'] != version:
        raise ValueError('Support version or launch policy does not match this app package')
    required = {exe.relative_to(root).as_posix()}
    required.update((resources / name).relative_to(root).as_posix() for name in
                    ('support-midi.js', 'support-midi-sources.json', 'support-build.json', 'support-licenses/README.txt'))
    files = manifest.get('files', [])
    if not required.issubset(files) or len(files) < 20:
        raise ValueError('Incomplete support runtime inventory')
    for name in files:
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or '\\' in name or ':' in name:
            raise ValueError('Unsafe support inventory path')
        path = root / name
        if not path.resolve().is_relative_to(root) or not path.is_file():
            raise ValueError('Missing support runtime file: ' + name)
    return len(files)
