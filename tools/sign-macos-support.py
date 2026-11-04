"""Sign nested support code explicitly from the inside out, never with --deep."""
import argparse
from pathlib import Path
import subprocess

MACHO = {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe',
         b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf'}


def sign(bundle, identity, timestamp):
    files = []
    for path in bundle.rglob('*'):
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                if stream.read(4) in MACHO:
                    files.append(path)
    bundles = [p for p in bundle.rglob('*') if p.suffix in ('.app', '.framework') and p.is_dir() and not p.is_symlink()]
    for path in files + sorted(bundles, key=lambda p: len(p.parts), reverse=True) + [bundle]:
        subprocess.run(['codesign', '--force', '--timestamp' if timestamp else '--timestamp=none',
                        '--options', 'runtime', '--sign', identity, str(path)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--no-timestamp', action='store_true')
    args = parser.parse_args()
    sign(args.bundle.resolve(), args.identity, not args.no_timestamp)
