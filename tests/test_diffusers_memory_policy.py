"""Placement boundaries run in ordinary CI without Torch or model downloads."""
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from diffusers_audio_pipeline import DiffusersAudioSession, MINIMAX_MODEL, GIB, module_weight_bytes, plan_minimax_memory, plan_audio_memory


class MiniMaxMemoryTests(unittest.TestCase):
    def test_stage_reuse_rejects_growing_duration_or_prompt_before_forward(self):
        for stage in ("_partial", "_int8_stage"):
            session = DiffusersAudioSession.__new__(DiffusersAudioSession)
            setattr(session, stage, object())
            session.request_duration = 5
            session.request_prompt_tokens = 20
            session.root = Path("unused")
            session.pipe = types.SimpleNamespace(tokenizer=object())
            session._replan_stable = Mock()
            with patch.dict(sys.modules, {"torch": types.SimpleNamespace()}), patch(
                    "ai_execution_policy.minimax_prompt_tokens", return_value=21):
                for duration, prompt in ((6, "short"), (5, "long " * 100)):
                    with self.assertRaisesRegex(ValueError, "budget"):
                        session.generate(duration=duration, prompt=prompt, lyrics="verse")

    def test_structured_song_budgets_expanded_input_before_loading(self):
        import json
        import stable_audio3_generate as worker_module
        params = {"prompt": "A song", "verse": "Long verse " * 100,
                  "chorus": "A chorus", "bridge": "A bridge", "arrangement": "Guitars",
                  "vocals": "Solo voice", "duration": 12}
        with tempfile.TemporaryDirectory() as directory, patch.object(
                worker_module, "MODEL_ID", MINIMAX_MODEL), patch.object(worker_module, "emit_payload"):
            worker = worker_module.StableAudioWorker(Path(directory))
            expected = worker_module.build_generation_request("structured-song", params)[0]
            observed = {}
            def inspect_budget(*_):
                observed.update(duration=worker._request_duration, tokens=worker._request_prompt_tokens)
                raise RuntimeError("stop before model load")
            with patch.object(worker, "_load_model", side_effect=inspect_budget), patch.object(worker, "unload"), patch(
                    "ai_execution_policy.minimax_prompt_tokens", return_value=321) as tokenize:
                self.assertFalse(worker.generate("structured-song", json.dumps(params),
                    Path(directory) / "output.wav", "budget-test"))
            self.assertEqual(observed["duration"], 12)
            self.assertEqual(observed["tokens"], 321)
            tokenize.assert_called_once_with(Path(directory), expected["prompt"], expected["lyrics"], tokenizer=None)

    def test_inapplicable_local_int8_stops_before_unquantized_load(self):
        import stable_audio3_generate as worker_module
        worker = worker_module.StableAudioWorker(Path("unused"))
        with patch.object(worker_module, "MODEL_ID", MINIMAX_MODEL), patch.dict(
                sys.modules, {"torch": types.SimpleNamespace()}), patch(
                "ai_execution_policy.qualified_minimax_options", return_value=({}, "Qualified INT8 is unavailable: prompt too long.")), patch(
                "diffusers_audio_pipeline.DiffusersAudioSession") as loader:
            with self.assertRaisesRegex(RuntimeError, "stopped before loading unquantized"):
                worker._load_local_model("lyrics-style", "fixture")
            loader.assert_not_called()

    def test_selected_precision_is_emitted_before_weights_load(self):
        import stable_audio3_generate as worker_module
        worker = worker_module.StableAudioWorker(Path("unused"))
        worker._progress_context = {"requestId": "fixture"}
        events = []
        def load(*_, **options):
            self.assertEqual(options["quantization"], "int8")
            self.assertIn("INT8 language model", events[-1]["statusNote"])
            self.assertEqual(events[-1]["phase"], "loading_model")
            return types.SimpleNamespace(execution_details={})
        with patch.object(worker_module, "MODEL_ID", MINIMAX_MODEL), patch.dict(
                sys.modules, {"torch": types.SimpleNamespace()}), patch(
                "ai_execution_policy.qualified_minimax_options", return_value=({"quantization": "int8"}, "Qualified locally.")), patch(
                "diffusers_audio_pipeline.DiffusersAudioSession", side_effect=load), patch.object(
                worker_module, "emit_payload", side_effect=events.append):
            worker._load_local_model("lyrics-style", "fixture")

    def test_int8_oom_never_retries_unquantized_or_publishes_audio(self):
        import json
        import stable_audio3_generate as worker_module
        class OutOfMemoryError(RuntimeError):
            pass
        model = types.SimpleNamespace(quantization="int8", sample_rate=44100, io_channels=2,
            execution_details={"quantization": "int8"}, generate=Mock(side_effect=OutOfMemoryError("fixture")))
        events = []
        with tempfile.TemporaryDirectory() as directory:
            worker = worker_module.StableAudioWorker(Path(directory))
            output = Path(directory) / "output.wav"
            with patch.object(worker_module, "MODEL_ID", MINIMAX_MODEL), patch.dict(
                    sys.modules, {"torch": types.SimpleNamespace(OutOfMemoryError=OutOfMemoryError)}), patch(
                    "ai_execution_policy.minimax_prompt_tokens", return_value=20), patch.object(
                    worker, "_load_model", return_value=model) as load, patch.object(worker, "unload"), patch.object(
                    worker_module, "emit_payload", side_effect=events.append):
                self.assertFalse(worker.generate("lyrics-style", json.dumps({"prompt": "A song",
                    "lyrics": "[verse]\nA verse", "duration": 5, "seed": 123}), output, "oom-test"))
                load.assert_called_once()
                model.generate.assert_called_once()
                self.assertFalse(output.exists())
                self.assertIn("will not retry with unquantized", events[-1]["error"])

    def test_audio_policy_reserves_memory_for_long_requests(self):
        self.assertEqual(plan_audio_memory(10 * GIB, 6 * GIB, 4 * GIB, 30), "resident")
        self.assertEqual(plan_audio_memory(10 * GIB, 6 * GIB, 4 * GIB, 150), "model-offload")
        self.assertEqual(plan_audio_memory(6 * GIB, 6 * GIB, 4 * GIB), "group-offload")
        self.assertEqual(plan_audio_memory(None, 6 * GIB, 4 * GIB), "model-offload")
        self.assertEqual(plan_audio_memory(32 * GIB, 6 * GIB, 4 * GIB, conservative=True), "group-offload")
        self.assertEqual(plan_audio_memory(4 * GIB, 6 * GIB, 4 * GIB, allow_group=False), "model-offload")

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
    def test_int8_load_keeps_lm_on_gpu_until_cpu_conversion_temporaries_are_released(self):
        from contextlib import ExitStack
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            (root / "modular_model_index.json").write_text("{}")
            order = []
            pipe = types.SimpleNamespace(sampling_rate=44100,
                load_components=lambda **kwargs: order.append(tuple(kwargs["names"])))
            names = ("language_model", "condition_encoder", "rvq_depth_decoder", "transformer", "vocoder", "tokenizer", "scheduler")
            for name in names:
                setattr(pipe, name, types.SimpleNamespace())
            pipe.language_model.config = types.SimpleNamespace(num_hidden_layers=36, num_key_value_heads=8, head_dim=128)
            torch = types.SimpleNamespace(set_num_threads=Mock(), bfloat16="torch.bfloat16", float32="torch.float32",
                version=types.SimpleNamespace(hip=None), cuda=types.SimpleNamespace(is_available=lambda: True,
                    is_bf16_supported=lambda: True, mem_get_info=lambda: (16*GIB, 16*GIB), empty_cache=lambda: order.append("release-cache")))
            stack.enter_context(patch.dict(sys.modules, {"torch": torch, "diffusers": types.SimpleNamespace(
                ComponentsManager=Mock(), ModularPipeline=types.SimpleNamespace(from_pretrained=lambda *args, **kwargs: pipe))}))
            stack.enter_context(patch("ai_execution_policy.quantization_kwargs", return_value={}))
            stack.enter_context(patch("ai_execution_policy.device_budget", return_value=16*GIB))
            stack.enter_context(patch("ai_partial_offload.Int8StagePlacement"))
            stack.enter_context(patch("ai_partial_offload.move_int8_module", side_effect=lambda model, device: order.append((model, device))))
            session = DiffusersAudioSession(root, MINIMAX_MODEL, request_duration=5,
                                           quantization="int8", placement="model-offload")
            self.assertEqual(order, [("language_model",), "release-cache", names[1:], (pipe.language_model, "cpu"), "release-cache"])
            self.assertEqual(session.execution_details["quantization"], "int8")

    def load(self, free_gib, duration=None):
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
            session = DiffusersAudioSession(root, MINIMAX_MODEL, request_duration=duration)
        return pipeline, manager, group, session

    def test_resident_does_not_install_offload_hooks(self):
        pipeline, manager, group, session = self.load(32)
        pipeline.to.assert_called_once_with("cuda")
        manager.enable_auto_cpu_offload.assert_not_called()
        group.assert_not_called()
        self.assertIn("model stays on device", session.execution_summary())

    def test_unqualified_partial_residency_is_never_selected_automatically(self):
        _, _, group, session = self.load(13, duration=30)
        group.assert_called_once()
        self.assertIsNone(session._partial)
        self.assertIn("qualification incomplete", session.execution_details["partialResidencyQualification"])

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
