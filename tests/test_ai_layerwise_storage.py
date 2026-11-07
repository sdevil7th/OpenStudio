"""FP8 qualification gates and restoration, independent of model downloads."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"tools"))
from ai_layerwise_storage import validate_fp8_device, verify_fp8_storage


class LayerwiseStorageTests(unittest.TestCase):
    def runtime(self, name="NVIDIA GeForce RTX 4080", version="2.10.0+cu128", hip=None):
        return NS(__version__=version, version=NS(hip=hip), cuda=NS(
            get_device_name=lambda _: name, is_bf16_supported=lambda: True))

    def test_unsupported_devices_and_runtime_stop_before_loading(self):
        for platform, device, runtime in [
            ("linux", "cuda:0", self.runtime()),
            ("win32", "cpu", self.runtime()),
            ("win32", "cuda:0", self.runtime(name="NVIDIA GeForce RTX 3060")),
            ("win32", "cuda:0", self.runtime(version="2.12.0+cu128")),
            ("win32", "cuda:0", self.runtime(hip="7.2")),
        ]:
            with self.subTest(platform=platform, device=device, runtime=runtime), patch(
                    "ai_layerwise_storage.sys.platform", platform), patch(
                    "ai_layerwise_storage.metadata.distribution") as distribution:
                with self.assertRaisesRegex(ValueError, "qualified Windows RTX 4080"):
                    validate_fp8_device(runtime, device)
                distribution.assert_not_called()

    def test_diffusers_revision_must_match_reviewed_recipe(self):
        revision = "7643c4826609c47755e3da0e5b768e8070468f49"
        with patch("ai_layerwise_storage.sys.platform", "win32"), patch(
                "ai_layerwise_storage.metadata.distribution") as distribution:
            for origin in ({}, {"vcs_info":{"commit_id":"wrong"}}):
                distribution.return_value.read_text.return_value = json.dumps(origin)
                with self.assertRaisesRegex(ValueError, "reviewed Diffusers"):
                    validate_fp8_device(self.runtime(), "cuda:0")
            for origin in ({"vcs_info":{"commit_id":revision}}, {"url":"https://github.com/huggingface/diffusers/archive/"+revision+".zip"}):
                distribution.return_value.read_text.return_value = json.dumps(origin)
                validate_fp8_device(self.runtime(), "cuda:0")

    def test_forward_must_restore_fp8_before_publishing_output(self):
        parameter = NS(dtype="torch.float8_e4m3fn", numel=lambda: 16, element_size=lambda: 1)
        model = NS(parameters=lambda: iter([parameter]))
        details = {"parameterBytesByDtype":{"torch.float8_e4m3fn":16}}
        verify_fp8_storage(model, details)
        self.assertEqual(details["afterForwardParameterBytesByDtype"], {"torch.float8_e4m3fn":16})
        parameter.dtype = "torch.bfloat16"
        with self.assertRaisesRegex(RuntimeError, "not restored"):
            verify_fp8_storage(model, details)


if __name__ == "__main__":
    unittest.main()
