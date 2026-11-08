"""Exercise the post-deploy check against a small website and release fixture."""
from contextlib import ExitStack
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import Thread
import unittest


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


class Website(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


@unittest.skipUnless(POWERSHELL, "PowerShell is required for release verification")
class PublishedReleaseTests(unittest.TestCase):
    def test_supplemental_checksums_and_linux_appcast(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local, published = root / "local", root / "website"
            published.mkdir()
            with ExitStack() as stack:
                server = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), partial(Website, directory=published)))
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                stack.callback(thread.join)
                stack.callback(server.shutdown)
                origin = f"http://127.0.0.1:{server.server_port}"
                args = ["-Version", "0.1.04", "-PublishedAt", "2026-10-24T09:31:57Z",
                        "-NotesFile", str(ROOT / "docs/releases/0.1.04.md"),
                        "-OutputDir", str(local), "-ReleasePageUrl", origin + "/release"]
                for platform, filename in (("Windows", "setup.exe"), ("Mac", "app.dmg"), ("Linux", "app.AppImage")):
                    binary = published / filename
                    binary.write_bytes(filename.encode())
                    args += [f"-{platform}AssetPath", str(binary), f"-{platform}AssetUrl", f"{origin}/{filename}"]

                def run(script, options):
                    return subprocess.run([POWERSHELL, "-NoProfile", "-File", str(ROOT / "tools" / script), *options],
                                          capture_output=True, text=True, timeout=55)

                result = run("generate-release-metadata.ps1", args)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                shutil.copytree(local, published, dirs_exist_ok=True)
                supplement = published / "supplement.deb"
                supplement.write_bytes(b"additional release asset")
                with (published / "OpenStudio-checksums.txt").open("a", encoding="utf-8") as f:
                    f.write(f"{hashlib.sha256(supplement.read_bytes()).hexdigest()}  {supplement.name}\n")
                options = ["-MetadataDir", str(local), "-ReleaseSiteUrl", origin, "-SkipCacheHeaderValidation"]
                result = run("validate-published-release.ps1", options)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                (published / "appcast/linux-stable.xml").write_text(
                    (published / "appcast/macos-stable.xml").read_text(encoding="utf-8-sig"), encoding="utf-8")
                result = run("validate-published-release.ps1", options)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("linux", result.stderr.lower())
