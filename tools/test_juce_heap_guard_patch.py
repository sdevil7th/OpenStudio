"""Execute the pinned dependency patch against stock, patched and unsafe inputs."""
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATCH = ROOT / 'cmake/ApplyJUCEHeapBlockPatch.cmake'


class HeapGuardPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.header = self.root / 'modules/juce_core/memory/juce_HeapBlock.h'
        self.header.parent.mkdir(parents=True)
        self.stock = '''    ~HeapBlock()
    {
        std::free (data);
    }
    void free() noexcept
    {
        std::free (data);
        data = nullptr;
    }
'''

    def run_patch(self):
        return subprocess.run(['cmake', f'-DJUCE_SOURCE_DIR={self.root}', '-P', str(PATCH)],
                              capture_output=True, text=True)

    def test_stock_and_repeat_are_idempotent(self):
        self.header.write_text(self.stock)
        self.assertEqual(self.run_patch().returncode, 0)
        first = self.header.read_bytes()
        self.assertEqual(self.run_patch().returncode, 0)
        self.assertEqual(self.header.read_bytes(), first)

    def test_partial_guard_fails_without_rewriting(self):
        self.header.write_text(self.stock)
        self.assertEqual(self.run_patch().returncode, 0)
        patched = self.header.read_text()
        patched = patched[:patched.index('    void free() noexcept')] + self.stock[self.stock.index('    void free() noexcept'):]
        self.header.write_text(patched)
        before = self.header.read_bytes()
        self.assertNotEqual(self.run_patch().returncode, 0)
        self.assertEqual(self.header.read_bytes(), before)

    def test_unknown_vendor_context_fails_without_rewriting(self):
        self.header.write_text(self.stock.replace('std::free (data)', 'changed_vendor_free (data)'))
        before = self.header.read_bytes()
        self.assertNotEqual(self.run_patch().returncode, 0)
        self.assertEqual(self.header.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
