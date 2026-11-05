"""Build the companion AppImage. It never wraps or intercepts the DAW launcher."""
import argparse
import hashlib
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import urllib.request
from support_package import validate

ROOT = Path(__file__).resolve().parents[1]
DEPLOY_VERSION = '1-alpha-20251107-1'
DEPLOY_HASH = 'c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d'


def package(bundle, output, version):
    validate(bundle, version, 'linux')
    output.mkdir(parents=True, exist_ok=True)
    target = output / f'OpenStudioSupport-{version}-linux-x86_64.AppImage'
    if target.exists():
        raise ValueError('Support AppImage output already exists')
    with tempfile.TemporaryDirectory(prefix='support-appimage-') as directory:
        work = Path(directory)
        deploy = work / 'linuxdeploy.AppImage'
        urllib.request.urlretrieve(f'https://github.com/linuxdeploy/linuxdeploy/releases/download/{DEPLOY_VERSION}/linuxdeploy-x86_64.AppImage', deploy)
        if hashlib.sha256(deploy.read_bytes()).hexdigest() != DEPLOY_HASH:
            raise ValueError('linuxdeploy checksum mismatch')
        deploy.chmod(0o755)
        app = work / 'OpenStudioSupport.AppDir'
        binary_dir = app / 'usr/bin'
        binary_dir.mkdir(parents=True)
        shutil.copy2(bundle / 'OpenStudioSupport', binary_dir)
        shutil.copytree(bundle / 'support-runtime', binary_dir / 'support-runtime', symlinks=True)
        desktop = app / 'OpenStudioSupport.desktop'
        desktop.write_text((ROOT / 'packaging/linux/OpenStudioSupport.desktop').read_text(), newline='\n')
        shutil.copyfile(ROOT / 'assets/icon-256x256.png', app / 'OpenStudio.png')
        env = dict(os.environ, APPIMAGE_EXTRACT_AND_RUN='1', OUTPUT='support.AppImage')
        subprocess.run([str(deploy), '--appdir', str(app), '--executable', str(binary_dir / 'OpenStudioSupport'),
                        '--desktop-file', str(desktop), '--icon-file', str(app / 'OpenStudio.png'),
                        '--exclude-library', '*', '--output', 'appimage'], cwd=work, env=env, check=True)
        shutil.copy2(work / 'support.AppImage', target)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    print(package(args.bundle.resolve(), args.output.resolve(), args.version))
