import importlib.util
import copy
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import wave


def load_tool(name):
    path = Path(__file__).resolve().parents[1] / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


desktop = load_tool("smoke-linux-appimage")
recording = load_tool("evaluate-recording-qualification")
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")
LIFECYCLE = Path(__file__).resolve().parents[1] / "tools" / "run-window-lifecycle-smoke.ps1"
SUPERVISOR = LIFECYCLE.with_name("owned-desktop-process.py")


class DesktopQualification(unittest.TestCase):
    def test_boot_alone_does_not_qualify_detached_windows(self):
        with self.assertRaises(ValueError):
            desktop.validate_report({"harnessMode": "window_lifecycle", "success": True,
                                     "checks": [{"id": "main_frontend_ready", "status": "pass"}]})

    def test_complete_lifecycle_required(self):
        report = {"harnessMode": "window_lifecycle", "success": True,
                  "checks": [{"id": key, "status": "pass"} for key in desktop.REQUIRED_CHECKS]}
        desktop.validate_report(report)
        report["checks"].append({"id": "other", "status": "fail"})
        with self.assertRaises(ValueError):
            desktop.validate_report(report)

    def test_missing_or_reset_audio_telemetry_never_becomes_zero_failures(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.wav"
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(48000)
                output.writeframes(b"\0\0" * 48000)
            known = {key: 0 for key in recording.COUNTERS} | {"sampleRate": 48000}
            self.assertEqual(recording.evaluate(known, known, path, 1)["status"], "pass")
            unsupported = known | {"audioDeviceXRunCount": -1}
            report = recording.evaluate(unsupported, unsupported, path, 1)
            self.assertEqual(report["status"], "not_asserted")
            self.assertEqual(report["audibleQuality"], "not_asserted")
            self.assertEqual(recording.evaluate(known | {"audioDeviceXRunCount": 2}, known, path, 1)["status"], "fail")
            self.assertEqual(recording.evaluate(known, known | {"audioDeviceStopCount": 1}, path, 1)["status"], "fail")
            self.assertEqual(recording.evaluate({}, {}, path, 1)["status"], "not_asserted")
            self.assertEqual(recording.evaluate(known, known, path, 60)["status"], "fail")


@unittest.skipUnless(os.name == "posix", "POSIX process sessions are required")
class PosixDesktopOwnership(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="desktop ownership ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.record = self.root / "child.json"
        self.app = self.root / "application fixture.py"
        self.app.write_text('''
import json, pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
record = pathlib.Path(sys.argv[1])
temporary = record.with_suffix(".tmp")
temporary.write_text(json.dumps({"pid": child.pid, "argv": sys.argv[3:]}))
temporary.replace(record)
print("application stdout must not become supervisor protocol", flush=True)
if sys.argv[2] == "wait": time.sleep(60)
sys.exit(7)
''', encoding="utf-8")
        self.sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(self.stop_sentinel)

    def stop_sentinel(self):
        self.sentinel.terminate()
        self.sentinel.wait(timeout=5)

    def start(self, mode="exit", application=None):
        arguments = application or [sys.executable, str(self.app), str(self.record), mode,
                                    'quoted "value" tail\\', "", "space separated argument"]
        process = subprocess.Popen([sys.executable, str(SUPERVISOR), "--", *arguments],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, bufsize=0)

        def cleanup():
            if not process.stdin.closed:
                process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

        self.addCleanup(cleanup)
        return process

    def message(self, process):
        import select
        self.assertTrue(select.select([process.stdout], [], [], 10)[0], "Supervisor protocol timed out")
        line = process.stdout.readline()
        self.assertTrue(line, "Supervisor exited before reporting its result")
        return json.loads(line)

    def child_record(self):
        deadline = time.monotonic() + 5
        while not self.record.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        return json.loads(self.record.read_text())

    @staticmethod
    def running(pid):
        result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                                text=True, check=False, timeout=5)
        # Orphans may remain as zombies until the OS's reaper collects them.
        return bool(result.stdout.strip()) and not result.stdout.lstrip().startswith("Z")

    def assert_child_stopped(self, pid):
        deadline = time.monotonic() + 5
        while self.running(pid) and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertFalse(self.running(pid), "An owned helper survived cleanup")
        self.assertIsNone(self.sentinel.poll(), "Cleanup terminated an unrelated process")

    def test_leader_exit_keeps_group_owned_until_dispose_and_preserves_argv(self):
        process = self.start()
        self.assertEqual(self.message(process)["event"], "started")
        self.assertEqual(self.message(process), {"event": "exited", "exitCode": 7})
        record = self.child_record()
        self.assertEqual(record["argv"], ['quoted "value" tail\\', "", "space separated argument"])
        self.assertIsNone(process.poll(), "Supervisor must pin the group after app exit")
        self.assertEqual(os.getpgid(record["pid"]), process.pid)
        self.assertTrue(self.running(record["pid"]))
        process.stdin.close()
        process.wait(timeout=5)
        self.assert_child_stopped(record["pid"])
        self.assertIn(b"application stdout", process.stderr.read())

    def test_timeout_or_owner_pipe_eof_stops_running_app_and_helper(self):
        process = self.start("wait")
        parent = self.message(process)["pid"]
        child = self.child_record()["pid"]
        self.assertTrue(self.running(parent))
        process.stdin.close()  # The same EOF occurs if the owning host exits.
        process.wait(timeout=5)
        self.assert_child_stopped(parent)
        self.assert_child_stopped(child)

    def test_supervisor_termination_cleans_the_owned_group(self):
        process = self.start("wait")
        self.message(process)
        child = self.child_record()["pid"]
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=5)
        self.assert_child_stopped(child)

    def test_failed_launch_reports_error_and_exits(self):
        process = self.start(application=[str(self.root / "missing executable")])
        self.assertEqual(self.message(process)["event"], "error")
        process.wait(timeout=5)
        self.assertIsNone(self.sentinel.poll())

    @unittest.skipUnless(POWERSHELL, "PowerShell is required for wrapper integration")
    def test_powershell_wrapper_waits_for_app_but_disposes_retained_session(self):
        runner = self.root / "wrapper fixture.ps1"
        runner.write_text('''
param($Module, $Python, $App, $Record, $Mode)
$ErrorActionPreference = 'Stop'
Import-Module $Module -Force
$owned = Start-OwnedDesktopProcess -FilePath $Python -ArgumentList @($App, $Record, $Mode)
try {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $Record)) {
        if ($timer.ElapsedMilliseconds -gt 10000) { throw 'Fixture did not start.' }
        Start-Sleep -Milliseconds 10
    }
    $exited = $owned.WaitForExit($(if ($Mode -eq 'exit') { 10000 } else { 50 }))
    $exitCode = if ($exited) { $owned.ExitCode } else { $null }
    $owned.Dispose()
    $owned.Dispose()
    @{ exited = $exited; exitCode = $exitCode } | ConvertTo-Json -Compress
} finally { $owned.Dispose() }
''', encoding="utf-8")
        for mode in ("exit", "wait"):
            with self.subTest(mode=mode):
                self.record.unlink(missing_ok=True)
                result = subprocess.run([POWERSHELL, "-NoProfile", "-File", str(runner),
                                         str(LIFECYCLE.with_name("OwnedDesktopProcess.psm1")),
                                         sys.executable, str(self.app), str(self.record), mode],
                                        capture_output=True, text=True, timeout=30, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"exited": mode == "exit",
                                                           "exitCode": 7 if mode == "exit" else None})
                self.assert_child_stopped(self.child_record()["pid"])


@unittest.skipUnless(POWERSHELL and os.name == "nt", "Windows PowerShell is required for lifecycle wrapper fixtures")
class WindowsLifecycleQualification(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        self.app = self.bundle / "OpenStudio.exe"
        self.app.write_bytes(b"fixture only --window-lifecycle-offline; never executed")
        frontend = self.bundle / "webui"
        frontend.mkdir()
        self.frontend = frontend / "index.html"
        self.frontend.write_text("<html>native startup fixture</html>", encoding="utf-8")
        self.report = self.root / "lifecycle.json"
        self.fixture = self.root / "fixture.json"

    def report_fixture(self, mode="normal"):
        common = {
            "lifecycle_no_hardware_device_opened", "no_orphan_secondary_browser_components",
            "main_frontend_ready", "main_native_chrome", "main_move_resize", "main_bounds_stable", "main_restore_geometry",
            "mixer_frontend_ready", "mixer_native_move_resize", "mixer_bounds_stable", "mixer_reopened_frontend_ready",
            "pitch_native_move_resize", "midi_frontend_ready", "midi_native_move_resize", "midi_bounds_stable", "midi_reopened_frontend_ready",
            "plugin_frontend_ready", "plugin_editor_geometry_contract", "plugin_compact_native_resize", "plugin_compact_bounds_stable",
            "plugin_restore_preferred_geometry", "plugin_native_move_resize", "plugin_bounds_stable", "plugin_reopened_frontend_ready",
            "plugin_track_failed_removal_keeps_editor", "plugin_input_failed_removal_keeps_editor",
            "plugin_master_failed_removal_keeps_editor", "plugin_monitor_failed_removal_keeps_editor",
            "plugin_track_removal_closes_editor", "plugin_input_removal_closes_editor", "plugin_master_removal_closes_editor",
            "plugin_monitor_removal_closes_editor", "plugin_track_delete_cancels_queued_reopen", "plugin_removed_editor_stays_closed",
        }
        roles = ["main", "mixer", "mixer_reopened", "midi", "midi_reopened", "plugin", "plugin_reopened"]
        if mode == "safe":
            common.update({"pitch_safe_cycle_1_frontend_ready", "pitch_safe_cycle_2_frontend_ready"})
            roles += ["pitch_safe_cycle_1", "pitch_safe_cycle_2"]
        else:
            common.update({"pitch_analysis_hydrated", "pitch_cycle_1_interactive_ready", "pitch_cycle_2_interactive_ready",
                           "pitch_checkpoint_preserved", "pitch_native_relative_shift_committed", "pitch_native_correction_file_published",
                           "pitch_native_undo_preserved", "pitch_owner_loss_retains_checkpoint"})
            roles += ["pitch_cycle_1", "pitch_cycle_2"]
        return {"harnessMode": "window_lifecycle", "success": True, "startupMode": mode, "offlineRequested": True,
                "audioDeviceOpened": False, "audioDeviceStartCount": 0, "audioCallbackCount": 0,
                "executablePath": str(self.app), "browserExecutableFolderOverride": "", "userDataFolderOverride": "",
                "checks": [{"id": key, "status": "pass"} for key in sorted(common)],
                "frontendDocuments": [{"role": role, "documentRequests": 1, "startupState": "ready"} for role in roles],
                "startupSelfTest": {"shellReady": True, "browserBackendSupported": True, "packagedFrontendPresent": True,
                                    "packagedFrontendPath": str(self.frontend),
                                    "browserBackend": "webview2", "webView2UserDataPath": str(self.root / "userdata")}}

    def validate(self, report, mode="normal"):
        self.report.write_text(json.dumps(report), encoding="utf-8")
        return subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(LIFECYCLE),
                               "-ValidateOnly", "-ReportPath", str(self.report), "-StartupMode", mode],
                              capture_output=True, text=True, timeout=30, check=False)

    def test_normal_and_safe_require_their_own_ready_roles(self):
        for mode in ("normal", "safe"):
            with self.subTest(mode=mode):
                result = self.validate(self.report_fixture(mode), mode)
                self.assertEqual(result.returncode, 0, result.stderr)
        result = self.validate(self.report_fixture("safe"), "normal")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("startupMode", result.stderr)

    def test_absent_or_failed_detached_window_cannot_be_hidden_by_top_level_success(self):
        original = self.report_fixture()
        mutations = [lambda report: report["checks"].pop(),
                     lambda report: report["checks"].append({"id": "extra", "status": "fail"}),
                     lambda report: report["frontendDocuments"].pop(),
                     lambda report: report["frontendDocuments"][1].update({"startupState": "timedOut"}),
                     lambda report: report["frontendDocuments"][1].update({"documentRequests": 2})]
        for mutation in mutations:
            report = copy.deepcopy(original)
            mutation(report)
            with self.subTest(report=report):
                self.assertNotEqual(self.validate(report).returncode, 0)

    def test_offline_proof_requires_explicit_flag_and_known_zero_counters(self):
        for key, value in (("offlineRequested", False), ("audioDeviceOpened", True),
                           ("audioDeviceStartCount", 1), ("audioCallbackCount", 1), ("audioCallbackCount", "0")):
            report = self.report_fixture()
            report[key] = value
            with self.subTest(key=key, value=value):
                self.assertNotEqual(self.validate(report).returncode, 0)
        report = self.report_fixture()
        del report["audioCallbackCount"]
        self.assertNotEqual(self.validate(report).returncode, 0)

    def test_missing_packaged_shell_is_rejected(self):
        report = self.report_fixture()
        report["startupSelfTest"]["packagedFrontendPresent"] = False
        self.assertNotEqual(self.validate(report).returncode, 0)

    def test_user_data_paths_and_override_evidence_cannot_hide_install_directory_writes(self):
        for key in ("webView2UserDataPath", "userDataFolderOverride"):
            for user_data in (self.bundle, self.bundle / "browser-data"):
                report = self.report_fixture()
                if key == "webView2UserDataPath":
                    report["startupSelfTest"][key] = str(user_data)
                else:
                    report[key] = str(user_data)
                with self.subTest(key=key, user_data=user_data):
                    self.assertNotEqual(self.validate(report).returncode, 0)
        report = self.report_fixture()
        del report["browserExecutableFolderOverride"]
        self.assertNotEqual(self.validate(report).returncode, 0)

    def run_mock_process(self, *, mode="normal", stale=False, behavior="success", require_standard=False, report=None):
        self.fixture.write_text(json.dumps(report or self.report_fixture(mode)), encoding="utf-8")
        runner = self.root / "fixture-runner.ps1"
        record = self.root / "runner-result.json"
        runner.write_text(r'''
param([string]$Tool, [string]$App, [string]$Report, [string]$Fixture, [string]$Record,
      [string]$Mode, [string]$Behavior, [string]$Stale, [string]$RequireStandard)
$ErrorActionPreference = 'Stop'
$env:OPENSTUDIO_FORCE_PACKAGED_UI = 'parent-ui'
$env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = 'parent-runtime'
$global:fixtureRecord = @{ started = $false; stopped = @(); disposed = $false }
function Import-Module { param($Name, [switch]$Force) }
function Start-OwnedDesktopProcess {
    param($FilePath, $ArgumentList)
    $global:fixtureRecord.started = $true
    $global:fixtureRecord.arguments = $ArgumentList
    $global:fixtureRecord.childUI = $env:OPENSTUDIO_FORCE_PACKAGED_UI
    $global:fixtureRecord.childRuntime = $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
    if ($Behavior -eq 'start-failure') { throw 'fixture process launch failed' }
    if ($Behavior -eq 'invalid-json') { Set-Content -LiteralPath $Report -Value '{bad-json' }
    elseif ($Behavior -ne 'missing-report') { Copy-Item -LiteralPath $Fixture -Destination $Report -Force }
    $fake = [pscustomobject]@{ Id = 424242; HasExited = ($Behavior -ne 'timeout'); ExitCode = 0 }
    if ($Behavior -eq 'nonzero-exit') { $fake.ExitCode = 7 }
    $fake | Add-Member ScriptMethod WaitForExit { param($Milliseconds)
        $global:fixtureRecord.waitMilliseconds = $Milliseconds
        return $Behavior -ne 'timeout'
    }
    $fake | Add-Member ScriptMethod Dispose {
        $global:fixtureRecord.disposed = $true
        if ($Behavior -eq 'cleanup-failure') { throw 'fixture job cleanup failed' }
    }
    return $fake
}
try {
    & $Tool -AppPath $App -ReportPath $Report -StartupMode $Mode -TimeoutSeconds 30 `
        -StaleRuntimeOverride:($Stale -eq 'yes') -RequireStandardUser:($RequireStandard -eq 'yes')
    $global:fixtureRecord.success = $true
} catch {
    $global:fixtureRecord.success = $false
    $global:fixtureRecord.error = $_.Exception.Message
} finally {
    $global:fixtureRecord.parentUI = $env:OPENSTUDIO_FORCE_PACKAGED_UI
    $global:fixtureRecord.parentRuntime = $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
    $global:fixtureRecord | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Record -Encoding UTF8
}
''', encoding="utf-8")
        result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(runner),
                                 "-Tool", str(LIFECYCLE), "-App", str(self.app), "-Report", str(self.report),
                                 "-Fixture", str(self.fixture), "-Record", str(record), "-Mode", mode,
                                 "-Behavior", behavior, "-Stale", "yes" if stale else "no",
                                 "-RequireStandard", "yes" if require_standard else "no"],
                                capture_output=True, text=True, check=False, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(record.read_text(encoding="utf-8-sig"))

    def test_wrapper_passes_safe_offline_flags_restores_environment_and_records_binary(self):
        record = self.run_mock_process(mode="safe", stale=True)
        self.assertTrue(record["success"], record.get("error"))
        self.assertIn("--ui-safe-mode", record["arguments"])
        self.assertIn("--window-lifecycle-offline", record["arguments"])
        self.assertEqual(record["waitMilliseconds"], 30000)
        self.assertEqual(record["childUI"], "1")
        self.assertIn("missing-webview-runtime-", record["childRuntime"])
        self.assertEqual((record["parentUI"], record["parentRuntime"]), ("parent-ui", "parent-runtime"))
        self.assertEqual(record["stopped"], [])
        self.assertTrue(record["disposed"])
        evidence = json.loads(self.report.with_suffix(".qualification.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(evidence["status"], "pass")
        self.assertEqual(evidence["windows10Qualification"], "not_asserted")
        self.assertEqual(evidence["visibleInspection"], "not_asserted")
        self.assertEqual(len(evidence["executableSha256"]), 64)
        self.assertEqual(evidence["frontendIndexPath"], str(self.frontend))
        self.assertEqual(len(evidence["frontendIndexSha256"]), 64)
        self.assertTrue(evidence["frontendIndexModifiedUtc"])

    def test_old_binary_is_refused_before_any_process_launch(self):
        self.app.write_bytes(b"old executable fixture")
        record = self.run_mock_process()
        self.assertFalse(record["success"])
        self.assertFalse(record["started"])
        self.assertIn("predates", record["error"])

    def test_timeout_launch_failure_and_invalid_artifacts_restore_parent_state(self):
        for behavior in ("timeout", "start-failure", "invalid-json", "missing-report", "nonzero-exit", "cleanup-failure"):
            with self.subTest(behavior=behavior):
                record = self.run_mock_process(stale=True, behavior=behavior)
                self.assertFalse(record["success"])
                self.assertEqual((record["parentUI"], record["parentRuntime"]), ("parent-ui", "parent-runtime"))
                self.assertEqual(record["stopped"], [])
                self.assertEqual(record["disposed"], behavior != "start-failure")
                evidence = json.loads(self.report.with_suffix(".qualification.json").read_text(encoding="utf-8-sig"))
                self.assertEqual(evidence["status"], "fail")

    def test_stale_override_must_be_cleared_by_application(self):
        report = self.report_fixture()
        report["browserExecutableFolderOverride"] = "still-invalid"
        record = self.run_mock_process(stale=True, report=report)
        self.assertFalse(record["success"])
        self.assertIn("not removed", record["error"])

    def test_report_from_another_executable_cannot_qualify_this_binary(self):
        report = self.report_fixture()
        report["executablePath"] = str(self.root / "unrelated" / "OpenStudio.exe")
        record = self.run_mock_process(report=report)
        self.assertFalse(record["success"])
        self.assertIn("different executable", record["error"])

    def test_standard_user_requirement_cannot_report_elevated_success(self):
        record = self.run_mock_process(require_standard=True)
        if record["success"]:
            evidence = json.loads(self.report.with_suffix(".qualification.json").read_text(encoding="utf-8-sig"))
            self.assertIs(evidence["standardUser"], True)
        else:
            self.assertFalse(record["started"])
            self.assertIn("non-elevated Windows", record["error"])

    def test_owned_job_removes_descendants_after_parent_exit_and_preserves_unrelated_process(self):
        module = LIFECYCLE.with_name("OwnedDesktopProcess.psm1")
        fixture_dir = self.root / "fixture scripts"
        fixture_dir.mkdir()
        parent_script = fixture_dir / "parent fixture.ps1"
        parent_script.write_text(r'''
param([string]$Record, [string]$Mode, [string]$QuotedValue)
$child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -WindowStyle Hidden -PassThru
@{ parent = $PID; child = $child.Id; quotedValue = $QuotedValue } | ConvertTo-Json | Set-Content -LiteralPath $Record
if ($Mode -eq 'wait') { Start-Sleep -Seconds 60 }
''', encoding="utf-8")
        runner = fixture_dir / "job fixture.ps1"
        runner.write_text(r'''
param([string]$Module, [string]$Shell, [string]$Parent, [string]$Record, [string]$Mode, [string]$Result)
$ErrorActionPreference = 'Stop'
Import-Module $Module -Force
$owned = $null; $parentProcess = $null; $childProcess = $null
try {
    $owned = Start-OwnedDesktopProcess -FilePath $Shell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Parent, '-Record', $Record, '-Mode', $Mode, '-QuotedValue', 'quoted "value" tail\')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $Record)) {
        if ($timer.ElapsedMilliseconds -gt 10000) { throw 'Fixture parent did not start its child.' }
        Start-Sleep -Milliseconds 25
    }
    $data = Get-Content -LiteralPath $Record -Raw | ConvertFrom-Json
    $childProcess = Get-Process -Id $data.child
    $parentExited = $owned.WaitForExit($(if ($Mode -eq 'exit') { 10000 } else { 100 }))
    $childAliveBeforeCleanup = !$childProcess.HasExited
    $owned.Dispose(); $owned = $null
    @{ parentExitedBeforeCleanup = $parentExited; childAliveBeforeCleanup = $childAliveBeforeCleanup;
       childExitedAfterCleanup = $childProcess.WaitForExit(5000); quotedValue = $data.quotedValue } |
        ConvertTo-Json | Set-Content -LiteralPath $Result
} finally {
    if ($null -ne $owned) { $owned.Dispose() }
    if ($null -ne $childProcess) { $childProcess.Dispose() }
}
''', encoding="utf-8")
        sentinel = subprocess.Popen([POWERSHELL, "-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
                                    creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            for mode in ("exit", "wait"):
                with self.subTest(mode=mode):
                    child_record = self.root / f"owned-{mode}.json"
                    result_record = self.root / f"owned-{mode}-result.json"
                    result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(runner),
                                             "-Module", str(module), "-Shell", POWERSHELL, "-Parent", str(parent_script),
                                             "-Record", str(child_record), "-Mode", mode, "-Result", str(result_record)],
                                            capture_output=True, text=True, check=False, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    evidence = json.loads(result_record.read_text(encoding="utf-8-sig"))
                    self.assertEqual(evidence["parentExitedBeforeCleanup"], mode == "exit")
                    self.assertTrue(evidence["childAliveBeforeCleanup"])
                    self.assertTrue(evidence["childExitedAfterCleanup"])
                    self.assertEqual(evidence["quotedValue"], 'quoted "value" tail\\')
                    self.assertIsNone(sentinel.poll(), "Cleanup terminated an unrelated process")
        finally:
            sentinel.terminate()
            sentinel.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
