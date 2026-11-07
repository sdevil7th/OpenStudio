from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

from .common import require_closed, save_report


def parser():
    command = argparse.ArgumentParser(description="Offline OpenStudio support. Close the DAW and keep it closed until finished. No uploads or live collection.")
    command.add_argument("--gui", action="store_true", help="Open the standalone support window")
    command.add_argument("--self-test", type=Path, help=argparse.SUPPRESS)
    actions = command.add_subparsers(dest="action")
    collect = actions.add_parser("collect", help="Prepare existing evidence for review")
    collect.add_argument("--log-dir", type=Path, action="append", help="Additional exact log directory; not scanned recursively")
    collect.add_argument("--route-report", type=Path, action="append", default=[])
    collect.add_argument('--app', type=Path, help='Installed app executable (or macOS .app) to identify offline')
    collect.add_argument('--symbols', type=Path, help='Optional developer symbol archive directory to verify and match')
    collect.add_argument('--crash-report', type=Path, action='append', default=[], help='Existing OS crash report text to redact; no OS configuration changes')
    collect.add_argument("--include-dumps", action="store_true", help="Include unredacted memory dumps; may contain private data")
    collect.add_argument("--description", default="", help="What happened and what you expected")
    collect.add_argument("--output", type=Path, required=True, help="New review directory (must not exist)")
    audio = actions.add_parser("audio", help="Inspect an existing audio export")
    audio.add_argument("file", type=Path)
    audio.add_argument("--route-report", type=Path)
    audio.add_argument("--project", type=Path, help="Optional saved snapshot; original export-time association is not assumed")
    audio.add_argument("--reference", action="store_true", help="Read source audio and compare a supported neutral master mix")
    audio.add_argument("--start", type=float, default=0, help="Reference export start in project seconds")
    audio.add_argument("--pan-law", choices=("linear", "constant-power"), default="linear")
    audio.add_argument("--output", type=Path, required=True)
    midi = actions.add_parser("midi", help="Inspect MIDI; optionally compare a saved project snapshot")
    midi.add_argument("file", type=Path)
    midi.add_argument("--project", type=Path)
    midi.add_argument("--clip-id", action="append", default=[], help="Selected-clip export scope; repeat for multiple clips")
    midi.add_argument("--output", type=Path, required=True)
    archive = actions.add_parser("bundle", help="ZIP only reviewed, unchanged report files")
    archive.add_argument("directory", type=Path)
    archive.add_argument("--output", type=Path, required=True)
    archive.add_argument("--reviewed", action="store_true", help="I reviewed every file, including any unredacted dumps")
    return command


def run(args):
    require_closed()
    if args.output.exists():
        raise ValueError("Output already exists. Choose a new directory or ZIP; existing files are never overwritten.")
    if args.action == "collect":
        from .collection import collect, default_directories
        result, artifacts, redactor = collect(args.log_dir or default_directories(), args.route_report,
                                             args.include_dumps, args.description, app=args.app,
                                             symbols=args.symbols, crash_reports=args.crash_report)
        save_report(args.output, result, artifacts, redactor)
    elif args.action == "audio":
        from .audio import inspect_audio
        import math
        if args.reference and (not args.project or not args.route_report):
            raise ValueError("--reference requires --project and --route-report to check scope and normalization")
        if not math.isfinite(args.start) or args.start < 0:
            raise ValueError("--start must be finite and non-negative")
        result = inspect_audio(args.file, args.route_report, args.project, args.reference, args.start, args.pan_law)
        save_report(args.output, result)
    elif args.action == "midi":
        from .midi import inspect_midi
        if args.clip_id and not args.project:
            raise ValueError("--clip-id requires --project")
        result = inspect_midi(args.file, args.project, args.clip_id)
        save_report(args.output, result)
    elif args.action == "bundle":
        from .collection import bundle
        bundle(args.directory, args.output, args.reviewed)
        return 0, "Created reviewed ZIP. Nothing was uploaded."
    else:
        raise ValueError("Choose collect, audio, midi, or bundle")
    return (2 if result["status"] == "fail" else 0), (args.output / "summary.txt").read_text(encoding="utf-8")


def main(argv=None):
    arguments = parser().parse_args(argv)
    if arguments.self_test:
        from .selftest import run_selftest
        return run_selftest(arguments.self_test)
    if arguments.gui or not arguments.action:
        from .gui import launch
        launch()
        return 0
    try:
        code, message = run(arguments)
        if sys.stdout is not None:
            print(message)
            print("Output:", arguments.output.absolute())
        return code
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        if sys.stderr is not None:
            print("Support tool could not complete:", exc, file=sys.stderr)
        return 1
