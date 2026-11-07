import os
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch, mock_open

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"tools"))
import stem_acceleration as policy


class RecipeTests(unittest.TestCase):
    def runtime(self, arch="gfx1151", version=policy.TORCH_VERSION):
        return NS(__version__=version, version=NS(hip=policy.HIP_VERSION),
                  cuda=NS(current_device=lambda:0, get_device_properties=lambda _:NS(gcnArchName=arch)))

    def test_standard_does_not_probe_or_set_experimental_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            result = policy.qualified_fast_recipe(None, "cpu", "/missing", "standard")
            self.assertEqual(result["precision"], "default")
            self.assertNotIn("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", os.environ)

    def test_unmatched_device_or_runtime_keeps_default_precision(self):
        for backend, runtime in [("cuda",self.runtime()), ("cpu",self.runtime()),
                                  ("rocm",self.runtime("gfx1100")), ("rocm",self.runtime(version="different"))]:
            with self.subTest(backend=backend, runtime=runtime), patch("platform.system", return_value="Linux"), patch.dict(os.environ, {}, clear=True):
                result = policy.qualified_fast_recipe(runtime, backend, "/missing", "qualified-fast")
                self.assertEqual(result["profile"], "standard")
                self.assertNotIn("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", os.environ)

    def test_matching_runtime_still_requires_both_checkpoint_hashes(self):
        with patch("platform.system", return_value="Linux"), patch("importlib.metadata.version", return_value="0.41.1"), patch.object(Path, "open", mock_open()), patch("hashlib.file_digest") as digest, patch.dict(os.environ, {}, clear=True):
            digest.return_value.hexdigest.side_effect = [policy.CHECKPOINT_SHA256, "wrong-config"]
            result = policy.qualified_fast_recipe(self.runtime(), "rocm", "/model.ckpt", "qualified-fast")
            self.assertEqual(result["profile"], "standard")
            self.assertNotIn("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", os.environ)

    def test_exact_recipe_sets_only_child_precision_and_aotriton_flag(self):
        with patch("platform.system", return_value="Linux"), patch("importlib.metadata.version", return_value="0.41.1"), patch.object(Path, "open", mock_open()), patch("hashlib.file_digest") as digest, patch.dict(os.environ, {}, clear=True):
            digest.return_value.hexdigest.side_effect = [policy.CHECKPOINT_SHA256, policy.CONFIG_SHA256]
            result = policy.qualified_fast_recipe(self.runtime(), "rocm", "/model.ckpt", "qualified-fast")
            self.assertEqual((result["profile"],result["precision"]), (policy.PROFILE,"fp16"))
            self.assertEqual(os.environ["TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL"], "1")


if __name__ == "__main__":
    unittest.main()
