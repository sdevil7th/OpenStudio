"""Relocate Ubuntu WebKit's compiled helper prefix inside the classic Snap.

Release WebKit ignores WEBKIT_EXEC_PATH (it is a developer-build option).
Replace only complete, NUL-terminated strings, retaining their byte footprint.
The resulting dependency is qualified inside the installed Snap before upload.
"""
from pathlib import Path
import sys

OLD = b'/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1'
NEW = b'/snap/openstudio/current/wk'


def patch(data):
    result = bytearray(data)
    count, start = 0, 0
    while (offset := data.find(OLD, start)) >= 0:
        end = data.find(b'\0', offset)
        if end < 0 or end - offset > 4096:
            raise ValueError('Unexpected WebKit helper prefix representation')
        # Only a path beginning at a string boundary is an intended constant.
        if offset == 0 or data[offset - 1] == 0:
            value = NEW + data[offset + len(OLD):end]
            result[offset:end] = value.ljust(end - offset, b'\0')
            count += 1
        start = end + 1
    return bytes(result), count


if __name__ == '__main__':
    root = Path(sys.argv[1])
    libraries = list((root / 'usr/lib/x86_64-linux-gnu').glob('libwebkit2gtk-4.1.so.*'))
    count = 0
    for library in libraries:
        if library.is_symlink():
            continue
        data, changed = patch(library.read_bytes())
        if changed:
            library.write_bytes(data)
            count += changed
    if not count:
        raise SystemExit('WebKit helper prefix was not found; refusing an unqualified layout')
    print(f'Relocated {count} WebKit helper prefix constants; file sizes retained')
