"""Explicit CI-only proof that the Snap loads its own coherent GTK/WebKit stack."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    expected = ('libwebkit2gtk-4.1.so', 'libjavascriptcoregtk-4.1.so', 'libgtk-3.so', 'libsoup-3.0.so', 'libglib-2.0.so')
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
    okay = (code == 0 and set(loaded) == set(expected)
            and all(Path(path).is_relative_to(args.root.resolve()) for path in loaded.values()))
    result = {'status': 'pass' if okay else 'fail', 'loadedLibraries': loaded,
              'expectedRoot': str(args.root.resolve()), 'scope': 'explicit CI reproduction only'}
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if okay else 1)
