"""Qualification boundaries for the auditioned AMD startup recipe."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"tools"))
from ai_rocm_startup import SNAPSHOT, configure_rocm_startup, validate_rocm_startup, rocm_startup_reserve

FIXTURE = Path(__file__).parent/"fixtures/ace-rocm-startup"/SNAPSHOT


class RocmStartupTests(unittest.TestCase):
    def test_long_workloads_reserve_observed_activations_before_residency(self):
        from ai_memory_manager import plan_audio_memory, GIB
        # Actual ten-minute peak minus measured weights, plus 2 GiB headroom.
        self.assertGreaterEqual(rocm_startup_reserve(600),28475709952-11085397636+2*GIB)
        self.assertEqual(plan_audio_memory(30*GIB,11*GIB,10*GIB,600,
            reserve_bytes=rocm_startup_reserve(600)),"group-offload")
        self.assertEqual(plan_audio_memory(90*GIB,11*GIB,10*GIB,600,
            reserve_bytes=rocm_startup_reserve(600)),"resident")
        for duration in (0,601,float("nan")):
            with self.assertRaises(ValueError):rocm_startup_reserve(duration)

    def runtime(self, **changes):
        runtime = NS(__version__="2.9.1+rocm7.2.0.git7e1940d4", version=NS(hip="7.2.26015-fc0010cf6a"),
            backends=NS(cudnn=NS(version=lambda:3005001)),
            cuda=NS(is_bf16_supported=lambda: True,
                get_device_properties=lambda _:NS(gcnArchName="gfx1151")))
        runtime.__dict__.update(changes)
        return runtime

    def test_unsupported_hardware_and_versions_cannot_enable_fast_selection(self):
        cases = [("win32","cuda:0",self.runtime()), ("linux","cpu",self.runtime()),
            ("linux","cuda:0",self.runtime(__version__="2.10.0")),
            ("linux","cuda:0",self.runtime(version=NS(hip=None))),
            ("linux","cuda:0",self.runtime(backends=NS(cudnn=NS(version=lambda:3006000)))),
            ("linux","cuda:0",self.runtime(cuda=NS(is_bf16_supported=lambda:False))),
            ("linux","cuda:0",self.runtime(cuda=NS(is_bf16_supported=lambda:True,
                get_device_properties=lambda _:NS(gcnArchName="gfx1100"))))]
        for platform,device,runtime in cases:
            with self.subTest(platform=platform,device=device), patch("ai_rocm_startup.sys.platform",platform), patch(
                    "ai_rocm_startup.metadata.version") as version, patch.dict(os.environ,{"MIOPEN_FIND_MODE":"NORMAL"}):
                with self.assertRaisesRegex(ValueError,"qualified Linux Radeon"):
                    configure_rocm_startup(runtime,device,FIXTURE)
                version.assert_not_called()
                self.assertEqual(os.environ["MIOPEN_FIND_MODE"],"NORMAL")

    def test_preflight_is_read_only_and_activation_keeps_precision(self):
        with patch("ai_rocm_startup.sys.platform","linux"), patch("ai_rocm_startup.metadata.version",return_value="0.39.0"), patch.dict(
                os.environ,{"MIOPEN_FIND_MODE":"NORMAL"}):
            details=validate_rocm_startup(self.runtime(),"cuda:0",FIXTURE)
            self.assertEqual(os.environ["MIOPEN_FIND_MODE"],"NORMAL")
            self.assertFalse(details["precisionChange"])
            self.assertEqual(configure_rocm_startup(self.runtime(),"cuda:0",FIXTURE)["recipe"],details["recipe"])
            self.assertEqual(os.environ["MIOPEN_FIND_MODE"],"FAST")

    def test_changed_snapshot_config_or_diffusers_is_rejected(self):
        with patch("ai_rocm_startup.sys.platform","linux"), patch("ai_rocm_startup.metadata.version",return_value="0.39.0") as version:
            with self.assertRaisesRegex(ValueError,"reviewed ACE-Step snapshot"):
                validate_rocm_startup(self.runtime(),"cuda:0",Path("other-snapshot"))
            with tempfile.TemporaryDirectory() as directory:
                copy=Path(directory)/SNAPSHOT;shutil.copytree(FIXTURE,copy)
                (copy/"vae/config.json").write_text("{}")
                with self.assertRaisesRegex(ValueError,"configuration differs"):
                    validate_rocm_startup(self.runtime(),"cuda:0",copy)
            version.return_value="0.41.0"
            with self.assertRaisesRegex(ValueError,"qualified Linux Radeon"):
                validate_rocm_startup(self.runtime(),"cuda:0",FIXTURE)

    def test_worker_rejects_recipe_before_allocating_model_weights(self):
        from generate_music import DiffusersAcePipelineManager
        pipeline=NS(from_pretrained=Mock())
        torch=NS(bfloat16=object(),float32=object(),cuda=NS(is_bf16_supported=lambda:True))
        selected=NS(device="cuda:0",name="Radeon 8060S Graphics",family="rocm")
        with tempfile.TemporaryDirectory() as cache, patch.dict(sys.modules,{"torch":torch,"diffusers":NS(AceStepPipeline=pipeline)}), patch(
                "ai_execution_policy.select_device",return_value=selected), patch("ai_execution_policy.activate_device"), patch(
                "ai_rocm_startup.validate_rocm_startup",side_effect=ValueError("fixture unsupported runtime")):
            manager=DiffusersAcePipelineManager(model_id=str(FIXTURE),cache_root=Path(cache),enable_group_offload=True,rocm_fast_startup=True)
            with self.assertRaisesRegex(ValueError,"unsupported runtime"):
                manager.load()
            pipeline.from_pretrained.assert_not_called()


if __name__ == "__main__":
    unittest.main()
