"""Placement boundaries run in ordinary CI without Torch or model downloads."""
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from diffusers_audio_pipeline import DiffusersAudioSession, MINIMAX_MODEL, GIB, module_weight_bytes, plan_minimax_memory


class MiniMaxMemoryTests(unittest.TestCase):
    def plan(self, vram, ram=32, bf16=True, weights=24):
        return plan_minimax_memory(free_vram=None if vram is None else int(vram * GIB),
            available_ram=None if ram is None else int(ram * GIB),
            weights_bytes=weights * GIB, language_model_bytes=16 * GIB, bf16=bf16)

    def test_large_gpu_avoids_transfer_hooks(self):
        self.assertEqual(self.plan(32).mode, "resident")
        self.assertEqual(self.plan(26).mode, "model-offload")
        self.assertEqual(self.plan(24).mode, "group-offload")

    def test_actual_weight_size_can_prevent_resident_placement(self):
        self.assertEqual(self.plan(32, weights=30).mode, "model-offload")

    def test_16gb_gpu_prefetches_without_full_host_copy_when_ram_is_tight(self):
        plan = self.plan(13, ram=5)
        self.assertEqual(plan.mode, "group-offload")
        self.assertTrue(plan.use_stream)
        self.assertTrue(plan.low_cpu_mem_usage)
        self.assertFalse(self.plan(13, ram=32).low_cpu_mem_usage)

    def test_pressure_or_unknown_memory_keeps_synchronous_fallback(self):
        for vram, ram in [(6, 32), (13, 2), (None, 32), (13, None)]:
            with self.subTest(vram=vram, ram=ram):
                self.assertFalse(self.plan(vram, ram).use_stream)

    def test_fp32_does_not_reuse_bf16_capacity_estimate(self):
        self.assertEqual(self.plan(32, bf16=False).mode, "group-offload")
        self.assertEqual(self.plan(48, bf16=False).mode, "model-offload")

    def test_shared_parameter_is_only_counted_once_and_buffers_count(self):
        weight = Mock(numel=lambda: 100, element_size=lambda: 2)
        buffer = Mock(numel=lambda: 10, element_size=lambda: 4)
        module = Mock(parameters=lambda: iter([weight]), buffers=lambda: iter([buffer]))
        self.assertEqual(module_weight_bytes([module, module, object()]), 240)


class MiniMaxPlacementIntegrationTests(unittest.TestCase):
    def load(self, free_gib):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "modular_model_index.json").write_text("{}")
        pipeline = types.SimpleNamespace(sampling_rate=44100, load_components=Mock(), to=Mock())
        for name in ("language_model", "condition_encoder", "rvq_depth_decoder", "transformer", "vocoder", "tokenizer", "scheduler"):
            setattr(pipeline, name, object())
        manager, group = Mock(), Mock()
        torch = types.SimpleNamespace(set_num_threads=Mock(), bfloat16="torch.bfloat16", float32="torch.float32",
            version=types.SimpleNamespace(hip=None), device=lambda value: value,
            cuda=types.SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True,
                                      mem_get_info=lambda: (free_gib * GIB, 32 * GIB)))
        modules = {"torch": torch, "diffusers": types.SimpleNamespace(
            ComponentsManager=lambda: manager,
            ModularPipeline=types.SimpleNamespace(from_pretrained=Mock(return_value=pipeline))),
            "diffusers.hooks.group_offloading": types.SimpleNamespace(apply_group_offloading=group)}
        with patch.dict(sys.modules, modules), patch("diffusers_audio_pipeline.available_host_memory", return_value=5 * GIB):
            session = DiffusersAudioSession(root, MINIMAX_MODEL)
        return pipeline, manager, group, session

    def test_resident_does_not_install_offload_hooks(self):
        pipeline, manager, group, session = self.load(32)
        pipeline.to.assert_called_once_with("cuda")
        manager.enable_auto_cpu_offload.assert_not_called()
        group.assert_not_called()
        self.assertIn("model stays on device", session.execution_summary())

    def test_intermediate_capacity_uses_only_component_manager(self):
        pipeline, manager, group, session = self.load(25)
        pipeline.to.assert_not_called()
        manager.enable_auto_cpu_offload.assert_called_once_with(device="cuda", memory_reserve_margin="3GiB")
        group.assert_not_called()
        self.assertEqual(session.execution_details["offload"], "model-offload")

    def test_low_capacity_applies_real_api_arguments_and_reports_policy(self):
        pipeline, manager, group, session = self.load(13)
        pipeline.to.assert_not_called()
        self.assertTrue(group.call_args.kwargs["use_stream"])
        self.assertEqual(group.call_args.kwargs["offload_type"], "leaf_level")
        self.assertIn("CPU layer offload with transfer overlap", session.execution_summary())
        strategy = manager.enable_auto_cpu_offload.call_args.kwargs["offload_strategy"]
        lm = types.SimpleNamespace(model=pipeline.language_model)
        depth = types.SimpleNamespace(model=pipeline.rvq_depth_decoder)
        transformer = types.SimpleNamespace(model=pipeline.transformer)
        self.assertEqual(strategy(hooks=[depth, transformer], model_id="lm", model=pipeline.language_model, execution_device="cuda"), [transformer])
        self.assertEqual(strategy(hooks=[lm, transformer], model_id="depth", model=pipeline.rvq_depth_decoder, execution_device="cuda"), [transformer])
        self.assertEqual(strategy(hooks=[lm, depth], model_id="transformer", model=pipeline.transformer, execution_device="cuda"), [lm, depth])


if __name__ == "__main__":
    unittest.main()
