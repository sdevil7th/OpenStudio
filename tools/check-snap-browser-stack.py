"""Explicit CI-only proof that the Snap loads its own coherent GTK/WebKit stack."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


EXPECTED = ('libwebkit2gtk-4.1.so', 'libjavascriptcoregtk-4.1.so', 'libgtk-3.so', 'libsoup-3.0.so', 'libglib-2.0.so')


def coherent_stack(loaded, root, base):
    if set(loaded) != set(EXPECTED):
        return False
    for name, filename in loaded.items():
        path = Path(filename).resolve()
        if path.is_relative_to(root.resolve()):
            continue
        # Snapcraft omits base-identical GLib. GTK/WebKit/Soup must still come
        # from this Snap; a host-distribution GLib is never an accepted fallback.
        if name != 'libglib-2.0.so' or not path.is_relative_to(base.resolve()):
            return False
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    expected = EXPECTED
    loaded = {}
    with (args.output / 'native.log').open('w') as log:
        process = subprocess.Popen(['snap', 'run', 'openstudio', '--window-lifecycle-harness', '--report',
                                    str((args.output / 'windows.json').absolute())],
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = time.monotonic() + 60
            while process.poll() is None and time.monotonic() < deadline:
                maps = Path(f'/proc/{process.pid}/maps')
                try:
                    lines = maps.read_text().splitlines()
                except (FileNotFoundError, ProcessLookupError):
                    lines = []
                if lines:
                    for line in lines:
                        fields = line.split(None, 5)
                        if len(fields) != 6 or not fields[5].startswith('/'):
                            continue
                        path = Path(fields[5])
                        for name in expected:
                            if path.name.startswith(name):
                                loaded[name] = str(path)
                if set(loaded) == set(expected):
                    break
                time.sleep(0.1)
            code = process.wait(timeout=180)
        finally:
            # Dispose only the diagnostic process group created above.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    base = Path('/snap/core22/current')
    okay = code == 0 and coherent_stack(loaded, args.root, base)
    result = {'status': 'pass' if okay else 'fail', 'loadedLibraries': loaded,
              'expectedRoot': str(args.root.resolve()), 'expectedBaseRoot': str(base.resolve()),
              'scope': 'explicit CI reproduction only; GTK/WebKit/Soup from Snap, GLib from Snap or core22'}
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if okay else 1)
