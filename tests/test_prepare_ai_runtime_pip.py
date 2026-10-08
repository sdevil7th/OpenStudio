"""Exercise actual PowerShell pip argument selection without preparing a runtime."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SHELL = shutil.which("pwsh") or shutil.which("powershell")


@unittest.skipUnless(SHELL, "PowerShell is required for runtime preparation behavior")
class PrepareAiRuntimePipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        cls.requirements = directory / "requirements with spaces $() and ;.txt"
        cls.requirements.write_text("# Argument fixture only; no packages are installed.\n", encoding="utf-8")
        script = directory / "pip-arguments.ps1"
        script.write_text(r"""
param([string]$PrepareScript, [string]$RequirementsPath)
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$syntax = [System.Management.Automation.Language.Parser]::ParseFile($PrepareScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Runtime preparation script has a PowerShell syntax error." }
$definitions = @($syntax.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Get-PipInstallArguments"
}, $true))
if ($definitions.Count -ne 1) { throw "Expected one runtime pip argument function." }
# Evaluate only the owned function; never execute the preparation entry point.
. ([scriptblock]::Create($definitions[0].Extent.Text))
$selected = @{}
foreach ($platform in @("windows", "macos", "linux")) {
    $selected[$platform] = @(Get-PipInstallArguments -TargetPlatform $platform -RequirementsPath $RequirementsPath)
}
ConvertTo-Json -InputObject $selected -Depth 4 -Compress
""", encoding="utf-8")
        result = subprocess.run([
            SHELL, "-NoProfile", "-File", str(script),
            "-PrepareScript", str(ROOT / "tools/prepare-ai-runtime.ps1"),
            "-RequirementsPath", str(cls.requirements),
        ], text=True, capture_output=True, timeout=30)
        if result.returncode != 0:
            raise AssertionError(f"PowerShell argument fixture failed: {result.stderr}")
        cls.arguments = json.loads(result.stdout.lstrip("\ufeff"))

    def test_macos_prefers_wheels_without_rejecting_diffq_source(self):
        arguments = self.arguments["macos"]
        self.assertEqual(arguments[:3], ["-m", "pip", "install"])
        self.assertIn("--prefer-binary", arguments)
        self.assertNotIn("--only-binary", arguments)
        self.assertNotIn("--no-build-isolation", arguments)
        self.assertNotIn("--no-deps", arguments)

    def test_windows_preserves_fixed_diffq_wheel_only_policy(self):
        arguments = self.arguments["windows"]
        index = arguments.index("--only-binary")
        self.assertEqual(arguments[index + 1], "diffq-fixed")
        self.assertIn("--prefer-binary", arguments)

    def test_linux_keeps_its_existing_source_fallback(self):
        self.assertEqual(self.arguments["linux"], self.arguments["macos"])
        self.assertIn("--prefer-binary", self.arguments["linux"])
        self.assertNotIn("--only-binary", self.arguments["linux"])

    def test_requirements_path_remains_one_literal_argument(self):
        for platform, arguments in self.arguments.items():
            with self.subTest(platform=platform):
                self.assertEqual(arguments[-2:], ["-r", str(self.requirements)])
                self.assertEqual(arguments.count(str(self.requirements)), 1)


if __name__ == "__main__":
    unittest.main()
