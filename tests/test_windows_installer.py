"""Execute production Inno [Code] in isolated, non-admin installer fixtures.

Registry-based prerequisite detection and the prerequisite log directory are
fixture inputs. The production validation, retry, exit-code and uninstall code
is compiled and exercised rather than checked for particular source strings.
"""

import argparse
import base64
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]


def find_compiler():
    import os

    candidates = [shutil.which("ISCC.exe")]
    for base in (os.environ.get("LOCALAPPDATA"),
                 os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base:
            suffix = "Programs/Inno Setup 6/ISCC.exe" if base == os.environ.get("LOCALAPPDATA") else "Inno Setup 6/ISCC.exe"
            candidates.append(str(Path(base) / suffix))
    return next((Path(value) for value in candidates if value and Path(value).is_file()), None)


def find_csc():
    import os

    windows = Path(os.environ.get("WINDIR", "C:/Windows"))
    return next((path for path in (
        windows / "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
        windows / "Microsoft.NET/Framework/v4.0.30319/csc.exe",
    ) if path.is_file()), None)


def run_bounded(arguments, timeout=30, wait_tree=False):
    """Kill only this fixture's process tree if an unattended dialog regresses."""
    if wait_tree:
        # Inno's uninstaller stub exits before its copied child has finished.
        # Match release qualification's Start-Process -Wait process-tree wait.
        spec = {"file": str(arguments[0]),
                "arguments": subprocess.list2cmdline([str(value) for value in arguments[1:]])}
        encoded = base64.b64encode(json.dumps(spec).encode("utf-8")).decode("ascii")
        command = (
            "$ErrorActionPreference = 'Stop'; "
            "$spec = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString("
            f"[Convert]::FromBase64String('{encoded}'))); "
            "$child = Start-Process -FilePath $spec.file -ArgumentList $spec.arguments "
            "-WindowStyle Hidden -PassThru -Wait; exit $child.ExitCode"
        )
        arguments = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]
    process = subprocess.Popen([str(value) for value in arguments],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, timeout=10, check=False)
        process.communicate(timeout=10)
        raise AssertionError(f"Fixture process did not exit within {timeout}s: {arguments[0]}") from None
    return process.returncode, output.decode("utf-8", errors="replace")


def replace_routine(code, name, replacement):
    # Substitute environmental probes, never the production branches under test.
    match = re.search(r"(?m)^(?:function|procedure) " + re.escape(name) + r"\b", code)
    if not match:
        raise AssertionError(f"Fixture probe routine is missing: {name}")
    following = re.search(r"(?m)^(?:function|procedure) \w+", code[match.end():])
    end = match.end() + following.start() if following else len(code)
    return code[:match.start()] + replacement + "\n\n" + code[end:]


class WindowsInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != "win32":
            raise unittest.SkipTest("Compiled Inno regression requires Windows")
        cls.compiler, cls.csc = find_compiler(), find_csc()
        if not cls.compiler or not cls.csc:
            raise unittest.SkipTest("Compiled Inno regression requires ISCC and .NET Framework csc")
        cls.temporary = tempfile.TemporaryDirectory(prefix="openstudio-installer-regression-")
        cls.fixture_root = Path(cls.temporary.name).resolve()
        if not cls.fixture_root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise AssertionError("Installer fixtures must stay inside their temporary root")
        cls.addClassCleanup(cls.temporary.cleanup)
        fixture_source = cls.fixture_root / "Fixture.cs"
        fixture_source.write_text(r'''
using System;
using System.IO;
using System.Reflection;
class Fixture {
    static int Main(string[] args) {
        string exe = Assembly.GetExecutingAssembly().Location;
        string root = Path.GetDirectoryName(exe);
        if (Path.GetFileName(exe) == "vc_redist.x64.exe") {
            File.AppendAllText(Path.Combine(root, "prerequisite-attempts.txt"), "attempt\n");
            return 23;
        }
        string scenario = File.ReadAllText(Path.Combine(root, "fixture-case.txt")).Trim();
        int result = scenario.StartsWith("selftest-") ? 1 : 0;
        File.WriteAllText(Path.Combine(root, "self-test-ran.txt"), result.ToString());
        if (scenario != "selftest-no-report") {
            for (int i = 0; i + 1 < args.Length; ++i)
                if (args[i] == "--report")
                    File.WriteAllText(args[i + 1], result == 0 ? "fixture pass" : "fixture failure");
        }
        return result;
    }
}
''', encoding="utf-8")
        cls.fixture_exe = cls.fixture_root / "Fixture.exe"
        exit_code, output = run_bounded([cls.csc, "/nologo", "/target:exe",
                                         f"/out:{cls.fixture_exe}", fixture_source], timeout=60)
        if exit_code:
            raise AssertionError(output)
        cls.code = (ROOT / "packaging/windows/OpenStudio.iss").read_text(encoding="utf-8").split("[Code]", 1)[1]
        cls.code = replace_routine(cls.code, "VCRuntimeIsSufficient", r'''
function VCRuntimeIsSufficient(const InstallerPath: string): Boolean;
var Scenario: AnsiString;
begin
  LoadStringFromFile(ExpandConstant('{app}\fixture-case.txt'), Scenario);
  Result := Scenario <> 'prerequisite-failure';
end;'''.strip())
        cls.code = replace_routine(cls.code, "MachineWebView2Installed", r'''
function MachineWebView2Installed(): Boolean;
begin
  Result := True;
end;'''.strip())
        cls.code = cls.code.replace("{commonappdata}\\OpenStudio\\InstallerLogs", "{app}\\fixture-logs")

    def build_fixture(self, scenario):
        directory = self.fixture_root / (scenario + "-" + uuid.uuid4().hex)
        payload = directory / "payload"
        payload.mkdir(parents=True)
        (payload / "fixture-case.txt").write_text(scenario, encoding="ascii")
        app = payload / "OpenStudio.exe"
        if scenario == "selftest-unstartable":
            app.write_bytes(b"Not a Windows executable")
        else:
            shutil.copyfile(self.fixture_exe, app)
        if scenario != "payload-failure":
            (payload / "webui").mkdir()
            (payload / "webui/index.html").write_text("fixture frontend", encoding="utf-8")
        (payload / "prereqs/windows").mkdir(parents=True)
        shutil.copyfile(self.fixture_exe, payload / "prereqs/windows/vc_redist.x64.exe")
        script = directory / "Fixture.iss"
        # No production registry/file associations, icons, deletion sections,
        # privileges or AppId enter this isolated fixture.
        script.write_text('''
#define MyAppExeName "OpenStudio.exe"
#define VCRedistInstaller "vc_redist.x64.exe"
#define WebView2Bootstrapper "WebView2-fixture.exe"
[Setup]
AppId=OpenStudioInstallerRegression-%s
AppName=OpenStudio Installer Regression
AppVersion=0.0.0
DefaultDirName=%s
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=yes
CreateUninstallRegKey=no
OutputDir=%s
OutputBaseFilename=FixtureSetup
Compression=none
SetupLogging=yes
[Files]
Source: "%s\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Code]
%s
''' % (uuid.uuid4().hex, directory / "installed", directory, payload, self.code), encoding="utf-8")
        exit_code, output = run_bounded([self.compiler, "/Q", script], timeout=60)
        self.assertEqual(exit_code, 0, output)
        return directory

    def install(self, directory):
        return run_bounded([directory / "FixtureSetup.exe", "/VERYSILENT", "/SUPPRESSMSGBOXES",
                            "/NORESTART", "/SP-", f'/DIR={directory / "installed"}',
                            f'/LOG={directory / "install.log"}'])

    def uninstall(self, directory):
        uninstaller = directory / "installed/unins000.exe"
        if uninstaller.is_file():
            exit_code, output = run_bounded([uninstaller, "/VERYSILENT", "/SUPPRESSMSGBOXES",
                                            "/NORESTART", f'/LOG={directory / "uninstall.log"}'],
                                           wait_tree=True)
            self.assertEqual(exit_code, 0, output)
            self.assertFalse(uninstaller.exists(), "Silent uninstall must complete, not wait for confirmation")
            self.assertFalse((directory / "installed/OpenStudio.exe").exists())

    def verify_failure(self, scenario, self_test_ran):
        directory = self.build_fixture(scenario)
        try:
            exit_code, output = self.install(directory)
            self.assertEqual(exit_code, 10, output)
            log = (directory / "install.log").read_text(encoding="utf-8-sig")
            self.assertIn("installation failed its payload, prerequisite or startup validation", log)
            self.assertEqual((directory / "installed/self-test-ran.txt").exists(), self_test_ran)
            return directory
        finally:
            self.uninstall(directory)

    def test_successful_install_and_unattended_uninstall(self):
        directory = self.build_fixture("success")
        try:
            exit_code, output = self.install(directory)
            self.assertEqual(exit_code, 0, output)
            self.assertEqual((directory / "installed/self-test-ran.txt").read_text(), "0")
        finally:
            self.uninstall(directory)

    def test_missing_payload_returns_failure_without_dialog(self):
        self.verify_failure("payload-failure", False)

    def test_prerequisite_failure_cancels_without_retry_or_dialog(self):
        directory = self.build_fixture("prerequisite-failure")
        try:
            exit_code, output = self.install(directory)
            self.assertEqual(exit_code, 10, output)
            attempts = directory / "installed/prereqs/windows/prerequisite-attempts.txt"
            self.assertEqual(attempts.read_text().splitlines(), ["attempt"])
            self.assertFalse((directory / "installed/self-test-ran.txt").exists())
        finally:
            self.uninstall(directory)

    def test_failed_selftest_report_returns_failure_without_dialog(self):
        self.verify_failure("selftest-failure", True)

    def test_missing_selftest_report_returns_failure_without_dialog(self):
        self.verify_failure("selftest-no-report", True)

    def test_unstartable_selftest_returns_failure_without_dialog(self):
        self.verify_failure("selftest-unstartable", False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--require-tools", action="store_true")
    options, remaining = parser.parse_known_args()
    if options.require_tools and (sys.platform != "win32" or not find_compiler() or not find_csc()):
        raise SystemExit("Windows installer regression requires Windows, ISCC and .NET Framework csc")
    unittest.main(argv=[sys.argv[0], *remaining])
