import importlib.util
from pathlib import Path
import tempfile
import unittest
import os
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_notes", ROOT / "tools/validate-release-notes.py")
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)


class ReleaseNotesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "0.1.01.md"
        self.valid = (ROOT / "docs/releases/0.1.01.md").read_text(encoding="utf-8")

    def check_text(self, text):
        self.path.write_text(text, encoding="utf-8")
        return notes.validate("0.1.01", self.path)

    def test_real_notes_pass(self):
        self.assertEqual(self.check_text(self.valid).strip(), self.valid.strip())

    def test_published_template_is_rejected(self):
        with self.assertRaises(ValueError):
            self.check_text(self.valid + "\nSummarize the biggest user-facing improvements here.")

    def test_wrong_version_is_rejected(self):
        with self.assertRaises(ValueError):
            self.check_text(self.valid.replace("# OpenStudio 0.1.01", "# OpenStudio 0.1.02", 1))

    def test_missing_or_empty_sections_are_rejected(self):
        for section in notes.SECTIONS:
            with self.subTest(section=section), self.assertRaises(ValueError):
                self.check_text(self.valid.replace(f"## {section}", f"## Missing {section}", 1))

    def test_unexpanded_template_token_is_rejected(self):
        with self.assertRaises(ValueError):
            self.check_text(self.valid + "\n{{version}}")

    def test_template_filename_is_rejected(self):
        with self.assertRaises(ValueError):
            notes.validate("0.1.01", ROOT / "packaging/release-notes-template.md")


class DirectPackagingNotesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "tools").mkdir()
        for name in ("validate-release-notes.py", "windows-signing.ps1", "package-windows-release.ps1",
                     "package-windows-store.ps1", "package-macos-release.sh", "package-linux-release.sh", "run-windows-rc.ps1"):
            shutil.copy2(ROOT / "tools" / name, self.root / "tools" / name)
        shutil.copy2(ROOT / "build.py", self.root / "build.py")
        self.path = self.root / "docs/releases/0.1.01.md"
        self.path.parent.mkdir(parents=True)
        self.valid = (ROOT / "docs/releases/0.1.01.md").read_text(encoding="utf-8")
        self.source = self.root / "input"
        for name in ("OpenStudio.exe", "OpenStudioCrashReporter.exe", "ffmpeg.exe", "onnxruntime.dll",
                     "OpenStudio.version", "webui/index.html", "LICENSE", "THIRD_PARTY_LICENSES.md"):
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("test fixture", encoding="utf-8")
        (self.source / "OpenStudio.version").write_text("0.1.01", encoding="utf-8")
        self.output = self.root / "package-output"

    def invoke(self, kind, custom_notes=None):
        if kind == "prod":
            command = [os.sys.executable, str(self.root / "build.py"), "prod", "--version", "0.1.01"]
        elif kind == "rc":
            shell = shutil.which("pwsh") or shutil.which("powershell")
            if not shell:
                self.skipTest("PowerShell is unavailable")
            command = [shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                       str(self.root / "tools/run-windows-rc.ps1"), "-Version", "0.1.01"]
        elif kind in ("macos", "linux"):
            if os.name == "nt":
                self.skipTest("Shell entry test runs on POSIX CI")
            command = (["bash", str(self.root / "tools/package-macos-release.sh"), str(self.root / "missing.app"),
                        "0.1.01", str(self.output)] if kind == "macos" else
                       ["bash", str(self.root / "tools/package-linux-release.sh"), "0.1.01", "missing-build"])
            if custom_notes:
                command.append(str(custom_notes))
        else:
            shell = shutil.which("pwsh") or shutil.which("powershell")
            if not shell:
                self.skipTest("PowerShell is unavailable")
            command = [shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                       str(self.root / "tools" / f"package-windows-{kind}.ps1"), "-Version",
                       "0.1.1.0" if kind == "store" else "0.1.01", "-SourceDir", str(self.source),
                       "-OutputDir", str(self.output)]
            if custom_notes:
                command.extend(["-NotesFile", str(custom_notes)])
        return subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=30)

    def rejects_invalid_notes(self, kind):
        for content in (None, self.valid.replace("# OpenStudio 0.1.01", "# OpenStudio 0.1.02", 1), self.valid + "\nTODO"):
            with self.subTest(kind=kind, content="missing" if content is None else "invalid"):
                if content is None:
                    self.path.unlink(missing_ok=True)
                else:
                    self.path.write_text(content, encoding="utf-8")
                result = self.invoke(kind)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("validate-release-notes.py", result.stdout + result.stderr)
                self.assertFalse(self.output.exists(), "Packaging created output before validating notes")

    def test_direct_windows_installer_rejects_invalid_notes(self):
        self.rejects_invalid_notes("release")

    def test_production_build_rejects_invalid_notes_before_building(self):
        self.rejects_invalid_notes("prod")

    def test_windows_rc_rejects_invalid_notes_before_building(self):
        self.rejects_invalid_notes("rc")

    @unittest.skipIf(os.name == "nt", "Linux shell entry test runs on POSIX CI")
    def test_direct_linux_packager_rejects_invalid_notes(self):
        self.rejects_invalid_notes("linux")

    def test_direct_store_packager_rejects_invalid_notes(self):
        self.rejects_invalid_notes("store")

    @unittest.skipIf(os.name == "nt", "macOS shell entry test runs on POSIX CI")
    def test_direct_macos_packager_rejects_invalid_notes(self):
        self.rejects_invalid_notes("macos")

    def test_store_preserves_exact_application_version_and_custom_notes(self):
        self.path.write_text(self.valid, encoding="utf-8")
        result = self.invoke("store")
        # Dummy PE inputs deliberately stop this fixture after the notes gate.
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Release notes validated: docs/releases/0.1.01.md", result.stdout)
        self.assertFalse(self.output.exists())
        custom = self.root / "docs/reviewed release.md"
        self.path.rename(custom)
        result = self.invoke("store", custom)
        self.assertIn("Release notes validated: docs/reviewed release.md", result.stdout)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
