#!/usr/bin/env python3
"""Developer/release build only. Produces a self-contained, separately launched GUI."""
from pathlib import Path
import argparse
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import venv
import struct
import plistlib
import ast
from support_package import write_inventory

ROOT = Path(__file__).resolve().parents[1]


def linux_system_notices(toc, destination):
    """Retain the build distribution's notices for system libraries frozen by PyInstaller."""
    data = ast.literal_eval(toc.read_text(encoding='utf-8'))
    sources = set()
    def visit(value):
        if isinstance(value, (list, tuple)):
            if (len(value) == 3 and value[2] in ('BINARY', 'EXTENSION')
                    and isinstance(value[1], str) and value[1].startswith(('/lib/', '/usr/lib/'))):
                sources.add(value[1])
            else:
                for child in value:
                    visit(child)
    visit(data)
    owners = {}
    for source in sorted(sources):
        candidates = [source, str(Path(source).resolve())]
        candidates += [p.removeprefix('/usr') if p.startswith('/usr/lib/') else '/usr' + p for p in candidates[:]]
        for candidate in dict.fromkeys(candidates):
            result = subprocess.run(['dpkg-query', '-S', candidate], capture_output=True, text=True)
            if result.returncode == 0:
                package = result.stdout.splitlines()[0].rsplit(': ', 1)[0].split(':')[0]
                notice = Path('/usr/share/doc') / package / 'copyright'
                if not notice.is_file():
                    raise ValueError(f'Missing bundled system library notice: {package}')
                destination.mkdir(exist_ok=True)
                shutil.copyfile(notice, destination / (package + '.copyright'))
                owners[source] = package
                break
        else:
            raise ValueError(f'Cannot identify bundled system library license: {source}')
    if owners:
        shutil.copytree('/usr/share/common-licenses', destination / 'common-licenses')
        (destination / 'bundled-system-libraries.json').write_text(json.dumps(owners, indent=2))


def run(*command):
    subprocess.run([str(part) for part in command], cwd=ROOT, check=True)


def notices(destination):
    destination.mkdir()
    shutil.copytree(ROOT / 'packaging/support/licenses', destination / 'upstream')
    packages = ['pyinstaller', 'numpy', 'soundfile', 'cffi', 'pycparser', 'quickjs-ng']
    versions = {}
    for name in packages:
        dist = importlib.metadata.distribution(name)
        versions[name] = dist.version
        for item in dist.files or []:
            if any(word in item.name.lower() for word in ('license', 'copying', 'notice')):
                source = Path(dist.locate_file(item))
                if source.is_file() and source.suffix != '.py':
                    target = destination / name / str(item).replace('..', '_')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
    import tkinter
    tcl = tkinter.Tcl()
    library = Path(tcl.eval('info library'))
    # Python distributions place the combined Python/Tcl notices in different slots.
    for index, path in enumerate((Path(sys.base_prefix) / 'LICENSE.txt', Path(sys.base_prefix) / 'LICENSE',
                                  library / 'license.terms', library.parent / 'tk8.6/license.terms')):
        if path.is_file():
            shutil.copyfile(path, destination / f'runtime-{index}-{path.name}')
    (destination / 'runtime-versions.json').write_text(json.dumps({'python': sys.version, **versions}, indent=2))
    shutil.copyfile(ROOT / 'LICENSE', destination / 'OpenStudio-LICENSE')
    (destination / 'README.txt').write_text(
        'This separate offline support executable bundles Python, Tcl/Tk, NumPy, SoundFile, libsndfile, '
        'CFFI, QuickJS-NG and the PyInstaller bootloader. See the accompanying license files.\n'
        'SoundFile distributes unmodified libsndfile as a replaceable shared library under LGPL-2.1.\n'
        'Corresponding source: https://github.com/bastibe/python-soundfile/releases/tag/0.13.1 '
        'and https://github.com/libsndfile/libsndfile/releases/tag/1.2.2\n'
        'Build recipe and OpenStudio support source: https://github.com/sdevil7th/OpenStudio/tree/main/tools\n'
        'No service, startup task, updater, upload endpoint or DAW dependency is installed.\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/support-package')
    parser.add_argument('--stage', type=Path, help='Existing app runtime directory; on macOS pass OpenStudio.app')
    parser.add_argument('--prepared-environment', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+', args.version) or any(int(n) > 65535 for n in args.version.split('.')):
        parser.error('Version must be three numeric components, each at most 65535')
    if not args.prepared_environment:
        environment = ROOT / '.venv-support'
        python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        if not python.exists():
            venv.EnvBuilder(with_pip=True).create(environment)
        run(python, '-m', 'pip', 'install', '-r', ROOT / 'tools/support-build-requirements.txt')
        run(python, __file__, *sys.argv[1:], '--prepared-environment')
        return
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Work and PyInstaller's replaceable output are isolated from application files.
    with tempfile.TemporaryDirectory(prefix='support-build-') as directory:
        work = Path(directory)
        run('node', ROOT / 'tools/build-support-midi.mjs', work)
        notices(work / 'support-licenses')
        (work / 'support-build.json').write_text(json.dumps({'version': args.version, 'launch': 'manual_only'}))
        options = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--windowed',
                   '--name', 'OpenStudioSupport', '--contents-directory', 'support-runtime',
                   '--distpath', work / 'dist', '--workpath', work / 'build', '--specpath', work,
                   '--paths', ROOT / 'tools', '--hidden-import', 'quickjs',
                   '--exclude-module', 'pytest', '--exclude-module', 'IPython']
        for name in ('support-midi.js', 'support-midi-sources.json', 'support-build.json'):
            options += ['--add-data', f'{work / name}{os.pathsep}.']
        options += ['--add-data', f'{work / "support-licenses"}{os.pathsep}support-licenses',
                    '--add-data', f'{ROOT / "tools/check-project-render-reference.py"}{os.pathsep}.']
        if sys.platform == 'win32':
            icon = work / 'support.ico'
            png = (ROOT / 'assets/icon-256x256.png').read_bytes()
            icon.write_bytes(struct.pack('<HHHBBBBHHII', 0, 1, 1, 0, 0, 0, 0, 1, 32, len(png), 22) + png)
            options += ['--icon', icon, '--manifest', ROOT / 'packaging/support/windows.manifest']
            numbers = tuple(map(int, args.version.split('.'))) + (0,)
            version_file = work / 'version.txt'
            version_file.write_text(f'''VSVersionInfo(ffi=FixedFileInfo(filevers={numbers!r}, prodvers={numbers!r},
mask=0x3f, flags=0, OS=0x40004, fileType=1, subtype=0, date=(0,0)), kids=[StringFileInfo([
StringTable('040904B0', [StringStruct('ProductName','OpenStudio'), StringStruct('ProductVersion',{args.version!r}),
StringStruct('FileVersion',{args.version!r}), StringStruct('FileDescription','OpenStudio Offline Support'),
StringStruct('OriginalFilename','OpenStudioSupport.exe')])]), VarFileInfo([VarStruct('Translation',[1033,1200])])])''')
            options += ['--version-file', version_file]
        elif sys.platform == 'darwin':
            options += ['--osx-bundle-identifier', 'in.org.openstudio.support']
        options += [ROOT / 'tools/openstudio-support.py']
        run(*options)
        name = 'OpenStudioSupport.app' if sys.platform == 'darwin' else 'OpenStudioSupport'
        generated = work / 'dist' / name
        target = output / name
        if target.exists():
            raise ValueError(f'Support output already exists; choose a fresh --output directory: {target}')
        shutil.copytree(generated, target, symlinks=True)
        if sys.platform == 'linux':
            linux_system_notices(work / 'build/OpenStudioSupport/COLLECT-00.toc',
                                 target / 'support-runtime/support-licenses/system')
        if sys.platform == 'darwin':
            plist = target / 'Contents/Info.plist'
            info = plistlib.loads(plist.read_bytes())
            info.update(CFBundleShortVersionString=args.version, CFBundleVersion=args.version,
                        CFBundleDisplayName='OpenStudio Support')
            plist.write_bytes(plistlib.dumps(info))
        write_inventory(target, args.version)
        if sys.platform == 'darwin':
            run('codesign', '--force', '--sign', '-', target)
    if args.stage:
        stage = args.stage.resolve(strict=True)
        if sys.platform == 'darwin':
            stage = stage / 'Contents/Helpers'
            stage.mkdir(exist_ok=True)
            items = [target]
        else:
            items = list(target.iterdir())
        for source in items:
            destination = stage / source.name
            if destination.is_symlink() or destination.resolve().parent != stage.resolve():
                raise ValueError('Unsafe support staging destination')
            if destination.is_dir():
                shutil.rmtree(destination)  # Exact owned helper path, checked within stage above.
            elif destination.exists():
                destination.unlink()
            if source.is_dir():
                shutil.copytree(source, destination, symlinks=True)
            else:
                shutil.copy2(source, destination)
    print('Standalone support package:', target)


if __name__ == '__main__':
    main()
