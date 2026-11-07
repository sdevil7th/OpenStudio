"""Memory admission boundaries; real placement is checked by the hardware runner."""
import sys
from pathlib import Path
import unittest
import importlib.util

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ai_memory_manager import GIB, plan_stem_memory, plan_minimax_memory
from ai_memory_manager import module_storage_bytes, minimax_load_backing, component_load_on_device


class StemMemoryTests(unittest.TestCase):
    def test_minimax_loading_includes_conversion_headroom_and_unknown_ram(self):
        self.assertEqual(minimax_load_backing(23*GIB,17*GIB,32*GIB),"disk")
        self.assertEqual(minimax_load_backing(23*GIB,17*GIB,43*GIB),"host-memory")
        self.assertEqual(minimax_load_backing(23*GIB,17*GIB,None),"disk")
        self.assertEqual(minimax_load_backing(None,0,8*GIB),"host-memory")

    def test_component_load_uses_gpu_only_when_both_headrooms_allow_it(self):
        self.assertTrue(component_load_on_device(5*GIB,8*GIB,9*GIB))
        self.assertFalse(component_load_on_device(17*GIB,8*GIB,12*GIB))
        self.assertFalse(component_load_on_device(5*GIB,16*GIB,12*GIB))
        self.assertFalse(component_load_on_device(None,8*GIB,12*GIB))
    def test_minimax_uses_simultaneous_stage_weights_and_request_cache(self):
        values = dict(available_ram=8*GIB, weights_bytes=20*GIB, language_model_bytes=12*GIB,
            bf16=True, stage_bytes={"language_model":12*GIB, "rvq_depth_decoder":GIB,
                "condition_encoder":GIB, "transformer":5*GIB, "vocoder":GIB},
            kv_bytes=GIB, largest_group_bytes=GIB//2)
        self.assertEqual(plan_minimax_memory(free_vram=24*GIB, **values).mode, "resident")
        plan = plan_minimax_memory(free_vram=17*GIB, **values)
        self.assertEqual(plan.mode, "model-offload")
        self.assertEqual(plan.stage_required_bytes, 17*GIB)
        values["kv_bytes"] = 2*GIB
        self.assertEqual(plan_minimax_memory(free_vram=17*GIB, **values).mode, "group-offload")

    def test_minimax_prefetch_charges_staging_once_against_current_free_ram(self):
        values = dict(free_vram=10*GIB, weights_bytes=20*GIB, language_model_bytes=12*GIB,
            bf16=True, stage_bytes={"language_model":12*GIB, "rvq_depth_decoder":GIB,
                "transformer":5*GIB}, kv_bytes=GIB, largest_group_bytes=GIB)
        plan = plan_minimax_memory(available_ram=5*GIB, **values)
        self.assertTrue(plan.use_stream)
        self.assertTrue(plan.low_cpu_mem_usage)
        self.assertEqual(plan.staging_bytes, 2*GIB)
        self.assertFalse(plan_minimax_memory(available_ram=5*GIB-1, **values).use_stream)
        self.assertFalse(plan_minimax_memory(available_ram=None, **values).use_stream)

    @unittest.skipIf(importlib.util.find_spec("torch") is None, "real tensor storage test needs Torch")
    def test_storage_census_counts_views_once_and_retains_quantization_scales(self):
        import torch
        first, second = torch.nn.Module(), torch.nn.Module()
        source = torch.arange(24, dtype=torch.float32)
        first.weight = torch.nn.Parameter(source[:16])
        second.weight = torch.nn.Parameter(source[8:])
        first.register_buffer("alias", source[:4])
        first.weight.SCB = torch.ones(4)
        census = module_storage_bytes([first, second, first])
        self.assertEqual(census, {"storageBytes": 112, "logicalFallbackBytes": 0})

    @unittest.skipIf(importlib.util.find_spec("torch") is None, "real module hooks need Torch")
    def test_experimental_roformer_keeps_complex_boundary_float32_without_stacked_hooks(self):
        import torch
        from ai_execution_policy import configure_roformer_precision
        model = torch.nn.Module()
        model.mask_estimators = torch.nn.ModuleList([torch.nn.Linear(2, 2).to(torch.bfloat16)])
        configure_roformer_precision(model, "bf16")
        configure_roformer_precision(model, "bf16")
        output = model.mask_estimators[0](torch.ones(2, dtype=torch.bfloat16))
        self.assertEqual(output.dtype, torch.float32)
        self.assertEqual(len(model._openstudio_precision_handles), 1)
        with self.assertRaisesRegex(ValueError, "Rebuild"):
            configure_roformer_precision(model, "fp16")
    def plan(self, **overrides):
        values = dict(backend="cuda", duration=224, sample_rate=44100, channels=2,
                      model_bytes=700 * 1024 ** 2, available_ram=16 * GIB,
                      free_vram=10 * GIB)
        values.update(overrides)
        return plan_stem_memory(**values)

    def test_reporter_capacity_uses_cuda_residency(self):
        plan = self.plan()
        self.assertEqual((plan.backend, plan.chunk_duration), ("cuda", 0))

    def test_host_pressure_sections_does_not_move_gpu_weights_to_cpu(self):
        plan = self.plan(available_ram=4 * GIB)
        self.assertEqual((plan.backend, plan.chunk_duration), ("cuda", 30))

    def test_qualified_rolling_memory_preserves_gpu_and_explicit_sections(self):
        plan = self.plan(available_ram=4*GIB, allow_streaming=True)
        self.assertEqual((plan.backend, plan.chunk_duration, plan.memory_mode), ("cuda", 0, "streaming"))
        plan = self.plan(available_ram=4*GIB, allow_streaming=True, requested_sections=30)
        self.assertEqual((plan.chunk_duration, plan.memory_mode), (30, "sections"))

    def test_gpu_pressure_uses_cpu_with_reason(self):
        plan = self.plan(free_vram=GIB)
        self.assertEqual(plan.backend, "cpu")
        self.assertIn("GPU free-memory", plan.reason)

    def test_rocm_fp32_activations_do_not_borrow_nvidia_autocast_budget(self):
        self.assertEqual(self.plan(backend="rocm", free_vram=4 * GIB).backend, "cpu")
        plan = self.plan(backend="rocm", free_vram=10 * GIB)
        self.assertEqual(plan.backend, "rocm")
        self.assertGreater(plan.estimated_gpu_bytes, 7 * GIB)

    def test_explicit_fp32_does_not_borrow_the_cuda_autocast_reserve(self):
        self.assertEqual(self.plan(precision="default", free_vram=4 * GIB).backend, "cuda")
        self.assertEqual(self.plan(precision="fp32", free_vram=4 * GIB).backend, "cpu")

    def test_cpu_only_and_explicit_sections_are_preserved(self):
        plan = self.plan(backend="cpu", requested_sections=30)
        self.assertEqual((plan.backend, plan.chunk_duration), ("cpu", 30))

    def test_unknown_memory_or_metadata_uses_bounded_sections(self):
        self.assertEqual(self.plan(available_ram=None).chunk_duration, 30)
        plan = self.plan(duration=None)
        self.assertEqual(plan.chunk_duration, 30)
        self.assertIsNone(plan.estimated_host_bytes)

    def test_short_clip_does_not_need_section_splitting(self):
        self.assertEqual(self.plan(duration=3, available_ram=GIB).chunk_duration, 0)


if __name__ == "__main__":
    unittest.main()
