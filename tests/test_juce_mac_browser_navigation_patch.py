"""Exercise the exact-pin WKWebView rewrite and refusal of uncertain source."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "cmake/ApplyJUCEMacBrowserNavigationPatch.cmake"
PIN = "project(JUCE VERSION 9.0.1 LANGUAGES C CXX)\n"
ORIGINAL = """            if (nsUrl != nullptr)
                [webView.get() loadFileURL: appendParametersToFileURL (url, nsUrl) allowingReadAccessToURL: accessPath];
        }
        else if (NSMutableURLRequest* request = getRequestForURL (url, headers, postData))
        {
            lastRequestedUrl = url;
            [webView.get() loadRequest: request];
        }"""
PATCHED = """            if (nsUrl != nullptr)
            {
                [webView.get() loadFileURL: appendParametersToFileURL (url, nsUrl) allowingReadAccessToURL: accessPath];
                // OpenStudio: this WK request has already been dispatched, even
                // while hidden. Do not replay it on the first native-peer show.
                owner.owner.lastURL.clear();
            }
        }
        else if (NSMutableURLRequest* request = getRequestForURL (url, headers, postData))
        {
            lastRequestedUrl = url;
            [webView.get() loadRequest: request];
            owner.owner.lastURL.clear();
        }"""


@unittest.skipUnless(shutil.which("cmake"), "CMake is required for dependency patch tests")
class JUCEMacBrowserNavigationPatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source_root = Path(self.directory.name)
        self.pin = self.source_root / "CMakeLists.txt"
        self.pin.write_text(PIN)
        self.source = self.source_root / "modules/juce_gui_extra/native/juce_WebBrowserComponent_mac.mm"
        self.source.parent.mkdir(parents=True)

    def apply(self):
        return subprocess.run(
            ["cmake", f"-DJUCE_SOURCE_DIR={self.source_root}", "-P", str(SCRIPT)],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )

    def rejected_without_mutation(self, message):
        before = self.source.read_bytes()
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def test_both_successful_dispatches_change_once_and_reapply_is_identical(self):
        source = "// untouched legacy WebView\n" + ORIGINAL + "\n// untouched focus/retirement\n"
        self.source.write_text(source)
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.source.read_text(), source.replace(ORIGINAL, PATCHED))
        before = self.source.read_bytes()
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def test_unknown_dispatch_context_is_rejected(self):
        self.source.write_text(ORIGINAL.replace("loadRequest: request", "unknownDispatch: request"))
        self.rejected_without_mutation("context changed")

    def test_partial_dispatch_patch_is_rejected(self):
        self.source.write_text(PATCHED.replace("            owner.owner.lastURL.clear();\n        }", "        }"))
        self.rejected_without_mutation("context changed")

    def test_duplicate_original_and_patched_contexts_are_rejected(self):
        for block in (ORIGINAL, PATCHED):
            with self.subTest(patched=block == PATCHED):
                self.source.write_text(block + "\n" + block)
                self.rejected_without_mutation("ambiguous")

    def test_mixed_original_and_patched_contexts_are_rejected(self):
        self.source.write_text(ORIGINAL + "\n" + PATCHED)
        self.rejected_without_mutation("mixes patched and unpatched")

    def test_wrong_or_ambiguous_framework_version_is_rejected(self):
        self.source.write_text(ORIGINAL)
        for version in (PIN.replace("9.0.1", "9.0.2"), PIN + PIN, "project(Other VERSION 9.0.1 LANGUAGES C CXX)\n"):
            with self.subTest(version=version):
                self.pin.write_text(version)
                self.rejected_without_mutation("exact 9.0.1 pin")

    def test_missing_pin_or_browser_source_is_rejected(self):
        self.source.write_text(ORIGINAL)
        self.pin.unlink()
        self.rejected_without_mutation("source or version was not found")
        self.pin.write_text(PIN)
        self.source.unlink()
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source or version was not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
