#!/usr/bin/env python3
"""Keep a POSIX process group owned until its private stdin lease closes.

The supervisor stays alive after the application exits, preventing process-group
ID reuse before cleanup. Stdout is a two-message protocol; application output
goes to inherited stderr. Descendants must remain in the inherited session/group
(deliberately daemonized processes are outside this qualification contract).
"""

import json
import os
import signal
import subprocess
import sys
import threading


def supervise(arguments):
    if os.name != "posix":
        raise RuntimeError("The desktop process supervisor requires POSIX")
    if not arguments:
        raise ValueError("An application executable is required")

    os.setsid()
    group = os.getpid()

    def cleanup(*_):
        # This live leader pins the group identity. Never search by name or use
        # a saved PID after the leader has exited. SIGKILL includes this process.
        os.killpg(group, signal.SIGKILL)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGHUP, cleanup)

    def lease():
        try:
            sys.stdin.buffer.read(1)
        finally:
            cleanup()

    watcher = threading.Thread(target=lease, name="desktop-owner-lease", daemon=True)
    try:
        child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL,
                                 stdout=sys.stderr, stderr=sys.stderr)
        watcher.start()
        print(json.dumps({"event": "started", "pid": child.pid}), flush=True)
        result = child.wait()
        print(json.dumps({"event": "exited", "exitCode": result}), flush=True)
        watcher.join()  # Retain ownership until Dispose or owner-process EOF.
    except BaseException as error:
        try:
            print(json.dumps({"event": "error", "error": str(error)}), flush=True)
        finally:
            cleanup()


if __name__ == "__main__":
    args = sys.argv[1:]
    supervise(args[1:] if args[:1] == ["--"] else args)
