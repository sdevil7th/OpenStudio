"""Exercise the Windows qualification wrapper without launching native audio or browsers."""

import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")
WRAPPER = Path(__file__).resolve().parents[1] / "tools" / "run-free-suite-ui-regression.ps1"


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows PowerShell is required")
class FreeSuiteUIWrapper(unittest.TestCase):
    def run_fixture(self, *, browser_exit=0, omit_schema=False, use_short_root=False):
        with tempfile.TemporaryDirectory(prefix="free suite wrapper ") as directory:
            root = Path(directory)
            if use_short_root:
                # Windows may expose TEMP through an 8.3 alias (RUNNER~1 in CI).
                # Volumes with short names disabled return the original path.
                buffer = ctypes.create_unicode_buffer(32768)
                length = ctypes.windll.kernel32.GetShortPathNameW(directory, buffer, len(buffer))
                self.assertGreater(length, 0)
                self.assertLess(length, len(buffer))
                root = Path(buffer.value)
            tools = root / "tools"
            tools.mkdir()
            (root / "frontend").mkdir()
            shutil.copyfile(WRAPPER, tools / WRAPPER.name)
            (tools / "run-free-plugin-headless-regression.ps1").write_text("""
param([string]$AppPath, [string]$ReportPath, [string]$CaseName)
if ($CaseName -ne 'editor-schemas') { throw 'Wrong native export group' }
if ($env:FIXTURE_OMIT_SCHEMA -ne '1') {
    '{"overallPass":true}' | Set-Content -LiteralPath $ReportPath
}
""", encoding="utf-8")
            candidates = [root / "setup node", root / "system node"]
            for candidate in candidates:
                candidate.mkdir()
                (candidate / "npm.cmd").write_text(
                    f'@echo off\n"{sys.executable}" "%~dp0npm-stub.py" %*\nexit /b %ERRORLEVEL%\n',
                    encoding="utf-8",
                )
                (candidate / "npm-stub.py").write_text("""
import json, os, pathlib, sys
pathlib.Path(os.environ['FIXTURE_INVOCATION']).write_text(json.dumps({
    'candidate': str(pathlib.Path(__file__).parent), 'arguments': sys.argv[1:],
    'cwd': os.getcwd(), 'schema': os.environ.get('OPENSTUDIO_FREE_SUITE_SCHEMAS'),
    'port': os.environ.get('OPENSTUDIO_E2E_PORT'),
}))
print('fixture native stderr remains visible', file=sys.stderr)
sys.exit(int(os.environ['FIXTURE_BROWSER_EXIT']))
""", encoding="utf-8")
            runner = root / "fixture.ps1"
            runner.write_text("""
$ErrorActionPreference = 'Stop'
$start = (Get-Location).Path
$candidateCount = @(Get-Command npm.cmd -CommandType Application).Count
$failure = $null
try { & (Join-Path $PSScriptRoot 'tools/run-free-suite-ui-regression.ps1') -AppPath 'fixture.exe' -Port 5196 }
catch { $failure = $_.Exception.Message }
@{
    candidateCount = $candidateCount; failure = $failure; cwdRestored = ((Get-Location).Path -eq $start)
    schema = $env:OPENSTUDIO_FREE_SUITE_SCHEMAS; port = $env:OPENSTUDIO_E2E_PORT
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json')
""", encoding="utf-8")
            invocation_path = root / "invocation.json"
            environment = os.environ | {
                "PATH": os.pathsep.join(map(str, candidates)) + os.pathsep + os.environ["PATH"],
                "FIXTURE_INVOCATION": str(invocation_path),
                "FIXTURE_BROWSER_EXIT": str(browser_exit),
                "FIXTURE_OMIT_SCHEMA": "1" if omit_schema else "0",
                "OPENSTUDIO_FREE_SUITE_SCHEMAS": "original-schema",
                "OPENSTUDIO_E2E_PORT": "original-port",
            }
            process = subprocess.run(
                [POWERSHELL, "-NoProfile", "-File", str(runner)], cwd=root, env=environment,
                capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            result = json.loads((root / "result.json").read_text(encoding="utf-8-sig"))
            self.assertGreaterEqual(result["candidateCount"], 2)
            self.assertTrue(result["cwdRestored"])
            self.assertEqual(result["schema"], "original-schema")
            self.assertEqual(result["port"], "original-port")
            invocation = json.loads(invocation_path.read_text()) if invocation_path.exists() else None
            if invocation:
                self.assertTrue(Path(invocation["candidate"]).samefile(candidates[0]))
                self.assertTrue(Path(invocation["cwd"]).samefile(root / "frontend"))
                self.assertTrue(Path(invocation["schema"]).samefile(root / "output/review/free-suite-ui/editor-schemas.json"))
                self.assertEqual(invocation["port"], "5196")
                self.assertEqual(invocation["arguments"], [
                    "exec", "--", "playwright", "test", "e2e/free-suite-design03.spec.ts",
                    "e2e/free-suite-effects.spec.ts", "e2e/free-suite-precision.spec.ts",
                    "e2e/release-review-ui.spec.ts", "--project=chromium",
                ])
            return result, invocation

    def test_first_npm_application_on_path_runs_all_four_editor_suites(self):
        result, invocation = self.run_fixture()
        self.assertIsNone(result["failure"])
        self.assertIsNotNone(invocation)

    def test_browser_failure_is_not_hidden_and_context_is_restored(self):
        result, invocation = self.run_fixture(browser_exit=17)
        self.assertIn("Free-suite browser regression failed (exit 17)", result["failure"])
        self.assertIsNotNone(invocation)

    def test_short_directory_alias_preserves_filesystem_identity(self):
        result, invocation = self.run_fixture(use_short_root=True)
        self.assertIsNone(result["failure"])
        self.assertIsNotNone(invocation)

    def test_missing_native_schema_prevents_browser_launch(self):
        result, invocation = self.run_fixture(omit_schema=True)
        self.assertIn("Native editor schema export was not produced", result["failure"])
        self.assertIsNone(invocation)


if __name__ == "__main__":
    unittest.main()
