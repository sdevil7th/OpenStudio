"""Exercise the pinned dependency rewrite, including refusal of unknown source."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "cmake/ApplyJUCELV2IdentifierPatch.cmake"
ORIGINAL = """        std::vector<const LilvPlugin*> plugins { findPluginByUri (identifier) };
        findPluginsByFile (identifier, plugins);"""
PATCHED = """        std::vector<const LilvPlugin*> plugins { findPluginByUri (identifier) };
        // OpenStudio: an LV2 URI must not be implicitly converted to a File.
        if (File::isAbsolutePath (identifier))
            findPluginsByFile (identifier, plugins);"""


@unittest.skipUnless(shutil.which("cmake"), "CMake is required for dependency patch tests")
class JUCEIdentifierPatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source_root = Path(self.directory.name)
        self.source = self.source_root / "modules/juce_audio_processors_headless/format_types/juce_LV2PluginFormatImpl.h"
        self.source.parent.mkdir(parents=True)

    def apply(self):
        return subprocess.run(
            ["cmake", f"-DJUCE_SOURCE_DIR={self.source_root}", "-P", str(SCRIPT)],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )

    def test_original_context_changes_once_and_repeated_apply_is_identical(self):
        source = "// preserved header\n" + ORIGINAL + "\n// preserved footer\n"
        self.source.write_text(source)
        first = self.apply()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(self.source.read_text(), source.replace(ORIGINAL, PATCHED))
        before = self.source.read_bytes()
        second = self.apply()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def test_changed_dependency_context_is_rejected_without_mutation(self):
        self.source.write_text(ORIGINAL.replace("findPluginsByFile", "renamedLookup"))
        before = self.source.read_bytes()
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("context changed", result.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def test_ambiguous_original_or_patched_context_is_rejected(self):
        for block in (ORIGINAL, PATCHED):
            with self.subTest(block=block):
                self.source.write_text(block + "\n" + block)
                before = self.source.read_bytes()
                result = self.apply()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ambiguous", result.stderr)
                self.assertEqual(self.source.read_bytes(), before)

    def test_mixed_patch_state_is_rejected_without_mutation(self):
        self.source.write_text(ORIGINAL + "\n" + PATCHED)
        before = self.source.read_bytes()
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mixes patched and unpatched", result.stderr)
        self.assertEqual(self.source.read_bytes(), before)

    def test_missing_source_is_rejected(self):
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source was not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
