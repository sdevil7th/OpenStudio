#!/usr/bin/env python3
"""Qualify the packaged X11/XWayland path with a real window manager.

Does not assert native Wayland, hardware audio or visible desktop coverage.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile

REQUIRED_CHECKS = {
    "no_orphan_secondary_browser_components",
    "main_frontend_ready", "main_native_chrome", "main_bounds_stable",
    "mixer_frontend_ready", "mixer_bounds_stable", "mixer_reopened_frontend_ready",
    "midi_frontend_ready", "midi_bounds_stable", "midi_reopened_frontend_ready",
    "plugin_frontend_ready", "plugin_bounds_stable", "plugin_reopened_frontend_ready",
    "pitch_analysis_hydrated", "pitch_cycle_1_interactive_ready",
    "pitch_cycle_2_interactive_ready", "pitch_bounds_stable", "pitch_checkpoint_preserved",
    "pitch_native_relative_shift_committed", "pitch_native_correction_file_published",
    "pitch_native_undo_preserved", "pitch_owner_loss_retains_checkpoint",
}
MAX_DIAGNOSTIC_REPORT_BYTES = 256 * 1024
MAX_DIAGNOSTIC_ROWS = 12


def failure_diagnostics(report: Path) -> dict:
    """Summarize known lifecycle fields without dumping the report or environment."""
    summary = {"reportPath": str(report), "logPath": str(report.with_suffix(".log")),
               "startupLogPath": str(report.with_suffix(".startup.log"))}
    try:
        with report.open("rb") as source:
            content = source.read(MAX_DIAGNOSTIC_REPORT_BYTES + 1)
        if len(content) > MAX_DIAGNOSTIC_REPORT_BYTES:
            summary["reportError"] = "report exceeds diagnostic size limit"
            return summary
        document = json.loads(content)
        if not isinstance(document, dict):
            raise ValueError("Expected an object")
    except FileNotFoundError:
        summary["reportError"] = "report was not written"
        return summary
    except (OSError, ValueError, UnicodeError, RecursionError):
        summary["reportError"] = "report is unreadable or malformed"
        return summary

    def fields(row: dict, keys: tuple) -> dict:
        return {key: row[key][:512 if key == "detail" else 96]
                for key in keys if isinstance(row.get(key), str)}

    summary.update(fields(document, ("harnessMode",)))
    if isinstance(document.get("success"), bool):
        summary["success"] = document["success"]
    checks = document.get("checks", [])
    failed = [row for row in checks if isinstance(row, dict) and row.get("status") == "fail"] \
        if isinstance(checks, list) else []
    summary["failedCheckCount"] = len(failed)
    summary["failedChecks"] = [fields(row, ("id", "status", "detail"))
                               for row in failed[:MAX_DIAGNOSTIC_ROWS]]
    documents = document.get("frontendDocuments", [])
    if isinstance(documents, list):
        summary["frontendDocuments"] = [fields(row, ("role", "startupState"))
                                        for row in documents[:MAX_DIAGNOSTIC_ROWS] if isinstance(row, dict)]
    startup = document.get("startupSelfTest", {})
    if isinstance(startup, dict):
        summary["startupSelfTest"] = {
            key: startup[key] for key in ("shellReady", "browserBackendSupported", "packagedFrontendPresent")
            if isinstance(startup.get(key), bool)}
    return summary


def validate_report(report: dict) -> None:
    if report.get("harnessMode") != "window_lifecycle" or report.get("success") is not True:
        raise ValueError("Native lifecycle harness did not report success")
    checks = report.get("checks", [])
    if any(check.get("status") == "fail" for check in checks):
        raise ValueError("Native lifecycle report contains failed checks")
    passed = {check.get("id") for check in checks if check.get("status") == "pass"}
    missing = REQUIRED_CHECKS - passed
    if missing:
        raise ValueError(f"Missing successful lifecycle checks: {', '.join(sorted(missing))}")


def stop_process_group(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appimage", type=Path)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--report", type=Path,
                        default=Path("output/linux-appimage/window-manager-lifecycle.json"))
    parser.add_argument("--inside-display", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    appimage = args.appimage.resolve()
    report = args.report.resolve()
    if not appimage.is_file():
        parser.error(f"AppImage does not exist: {appimage}")
    report.parent.mkdir(parents=True, exist_ok=True)
    if not args.inside_display:
        for tool in ("xvfb-run", "openbox"):
            if not shutil.which(tool):
                parser.error(f"Required desktop test dependency is missing: {tool}")
        return subprocess.call(["xvfb-run", "-a", "-s", "-screen 0 1600x1000x24",
                                sys.executable, str(Path(__file__).resolve()), str(appimage),
                                "--inside-display", "--timeout", str(args.timeout), "--report", str(report)])

    with tempfile.TemporaryDirectory(prefix="openstudio-appimage-smoke-") as temporary:
        home = Path(temporary) / "home"
        config, data = home / ".config", home / ".local/share"
        config.mkdir(parents=True)
        data.mkdir(parents=True)
        env = {**os.environ, "HOME": str(home), "XDG_CONFIG_HOME": str(config),
               "XDG_DATA_HOME": str(data), "APPIMAGE_EXTRACT_AND_RUN": "1", "GDK_BACKEND": "x11"}
        report.unlink(missing_ok=True)
        with report.with_suffix(".log").open("wb") as output:
            manager = subprocess.Popen(["openbox", "--sm-disable"], env=env, stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            process = None
            try:
                process = subprocess.Popen([str(appimage), "--window-lifecycle-harness", "--report", str(report)],
                                           env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                code = process.wait(timeout=args.timeout)
                if manager.poll() is not None:
                    raise RuntimeError("The window manager exited during qualification")
                if code != 0:
                    raise RuntimeError(f"Packaged application exited with {code}")
                validate_report(json.loads(report.read_text(encoding="utf-8")))
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                print(str(error), file=sys.stderr)
                print("AppImage lifecycle diagnostics: " + json.dumps(failure_diagnostics(report)), file=sys.stderr)
                return 1
            finally:
                if process is not None:
                    stop_process_group(process)
                stop_process_group(manager)
                startup = config / "OpenStudio/logs/OpenStudio_Startup.log"
                if startup.exists():
                    shutil.copy2(startup, report.with_suffix(".startup.log"))
    print(f"Packaged AppImage main and detached lifecycle passed: {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
