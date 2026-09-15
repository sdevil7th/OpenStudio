"""Selection and memory safety invariants without requiring model downloads."""
from pathlib import Path
import sys
import json
import os
import tempfile
from contextlib import ExitStack
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ai_execution_policy import GIB, plan_residency, device_budget, minimax_kv_bytes, select_device, worker_threads, physical_cuda_free
from ai_attention_policy import configure_attention
from ai_execution_policy import release_idle_weights, qualified_minimax_options, model_storage_identity, checkpoint_storage_bytes, check_host_capacity, configure_allocator_environment, allocator_environment, MINIMAX_ALLOCATOR


class PolicyTests(unittest.TestCase):
    def test_minimax_allocator_is_scoped_and_preserves_user_overrides(self):
        with patch.dict(os.environ, {}, clear=True), patch("ai_execution_policy.platform.system", return_value="Windows"):
            configure_allocator_environment("stable-audio-3-medium")
            self.assertEqual(allocator_environment(), "")
            configure_allocator_environment("minimax-music-3")
            self.assertEqual(allocator_environment(), MINIMAX_ALLOCATOR)
        for variable in ("PYTORCH_ALLOC_CONF", "PYTORCH_CUDA_ALLOC_CONF"):
            with patch.dict(os.environ, {variable: "backend:cudaMallocAsync"}, clear=True):
                configure_allocator_environment("minimax-music-3")
                self.assertEqual(allocator_environment(), "backend:cudaMallocAsync")
                self.assertEqual(len(os.environ), 1)
        with patch.dict(os.environ, {}, clear=True), patch("ai_execution_policy.platform.system", return_value="Darwin"):
            configure_allocator_environment("minimax-music-3")
            self.assertEqual(allocator_environment(), "")

    def test_cpu_capacity_checks_headers_before_allocating_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            header = json.dumps({"weight": {"dtype": "BF16", "shape": [2*GIB], "data_offsets": [0, 4*GIB]},
                                 "indices": {"dtype": "I64", "shape": [2], "data_offsets": [4*GIB, 4*GIB+16]}}).encode()
            (root / "model.safetensors").write_bytes(len(header).to_bytes(8, "little") + header)
            self.assertEqual(checkpoint_storage_bytes(root, 4), 8*GIB + 16)
            with patch("ai_execution_policy.host_available", return_value=10*GIB):
                with self.assertRaisesRegex(ValueError, "available RAM"):
                    check_host_capacity(root)
            with patch("ai_execution_policy.host_available", return_value=12*GIB):
                check_host_capacity(root)
            (root / "model.safetensors").write_bytes((17*1024**2).to_bytes(8, "little"))
            with self.assertRaisesRegex(ValueError, "header"):
                checkpoint_storage_bytes(root, 4)

    def test_int8_cast_notice_is_once_per_dtype_and_other_warnings_remain(self):
        import logging
        from ai_partial_offload import log_int8_cast_once
        logger = logging.getLogger("bitsandbytes.autograd._functions")
        previous = list(logger.filters)
        try:
            logger.filters = []
            log_int8_cast_once()
            log_int8_cast_once()
            self.assertEqual(len(logger.filters), 1)
            def record(message, args=()):
                return logging.LogRecord(logger.name, logging.WARNING, __file__, 1, message, args, None)
            template = "MatMul8bitLt: inputs will be cast from %s to float16 during quantization"
            self.assertTrue(logger.filter(record(template, ("bfloat16",))))
            self.assertFalse(logger.filter(record(template, ("bfloat16",))))
            self.assertTrue(logger.filter(record(template, ("float32",))))
            for _ in range(2):
                self.assertTrue(logger.filter(record("An unrelated warning")))
        finally:
            logger.filters = previous

    def test_local_calibration_invalidates_changed_inputs_and_never_promotes_import_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config.json").write_text('{"model":"fixture"}')
            original_identity = model_storage_identity(root)
            profile_path = root / "profile.fixture"
            profile = {"schemaVersion": 1, "state": "qualified-local", "modelId": "minimax-music-3",
                "policy": "minimax-int8-stage-v1", "audition": {"status": "accepted"},
                "environment": "int8-fixture", "scriptVersion": "fixture-version",
                "allocatorConfig": MINIMAX_ALLOCATOR,
                "promptMeasurement": "upstream-tokenize-step-v1",
                "packages": {"torch": "pinned", "diffusers": "pinned", "transformers": "pinned",
                             "accelerate": "pinned", "bitsandbytes": "0.50.2"},
                "modelStorageIdentity": original_identity, "maxDuration": 15, "maxPromptTokens": 400,
                "hardware": {"uuid": "gpu", "driver": "driver"}, "kvConfig": {
                    "num_hidden_layers": 36, "num_key_value_heads": 8, "head_dim": 128},
                "stageWeightBytes": 10*GIB, "minimumFreeHostBytes": 18*GIB}
            torch = NS(cuda=NS(is_available=lambda: True,
                               get_device_properties=lambda _: NS(uuid="gpu")), version=NS(hip=None))
            with ExitStack() as stack:
                stack.enter_context(patch("ai_execution_policy.platform.system", return_value="Windows"))
                stack.enter_context(patch("ai_execution_policy.sys.executable", str(root / "int8-fixture/Scripts/python.exe")))
                version = stack.enter_context(patch("ai_execution_policy.worker_version", return_value="fixture-version"))
                allocator = stack.enter_context(patch("ai_execution_policy.allocator_environment", return_value=MINIMAX_ALLOCATOR))
                package = stack.enter_context(patch("ai_execution_policy.metadata.version", side_effect=profile["packages"].__getitem__))
                stack.enter_context(patch("ai_execution_policy.select_device", return_value=NS(family="cuda", device="cuda:0")))
                link = stack.enter_context(patch("ai_execution_policy.nvidia_link_snapshot",
                    return_value={"devices": [{"uuid": "gpu", "driver_version": "driver"}]}))
                budget = stack.enter_context(patch("ai_execution_policy.device_budget", return_value=16*GIB))
                ram = stack.enter_context(patch("ai_execution_policy.host_available", return_value=22*GIB))
                def options(duration=5, tokens=300):
                    profile_path.write_text(json.dumps(profile))
                    return qualified_minimax_options(torch, root, duration, tokens, profile_path=profile_path)[0]
                self.assertEqual(options(), {"quantization": "int8", "placement": "model-offload", "int8_reserve_bytes": 3*GIB})
                allocator.return_value = "backend:cudaMallocAsync"
                self.assertEqual(options(), {})
                allocator.return_value = MINIMAX_ALLOCATOR
                self.assertEqual(options(duration=30), {})
                self.assertEqual(options(tokens=401), {})
                profile["promptMeasurement"] = "byte-bound"
                self.assertEqual(options(), {})
                profile["promptMeasurement"] = "upstream-tokenize-step-v1"
                profile["state"] = "import_only"
                self.assertEqual(options(), {})
                profile["state"] = "qualified-local"
                profile["audition"]["status"] = "not_asserted"
                self.assertEqual(options(), {})
                profile["audition"]["status"] = "accepted"
                version.return_value = "changed"
                self.assertEqual(options(), {})
                version.return_value = "fixture-version"
                package.side_effect = lambda _: "changed"
                self.assertEqual(options(), {})
                package.side_effect = profile["packages"].__getitem__
                link.return_value = {"devices": [{"uuid": "gpu", "driver_version": "new-driver"}]}
                self.assertEqual(options(), {})
                link.return_value = {"devices": [{"uuid": "gpu", "driver_version": "driver"}]}
                budget.return_value = 12*GIB
                self.assertEqual(options(), {})
                budget.return_value = 16*GIB
                ram.return_value = 2*GIB
                self.assertEqual(options(), {})
                ram.return_value = 22*GIB
                (root / "config.json").write_text('{"model":"changed"}')
                self.assertNotEqual(model_storage_identity(root), original_identity)
                self.assertEqual(options(), {})

    def test_warm_worker_budget_expires_or_releases_under_pressure(self):
        self.assertFalse(release_idle_weights(119, 8*GIB))
        self.assertTrue(release_idle_weights(120, 8*GIB))
        self.assertTrue(release_idle_weights(1, 2*GIB))
        self.assertTrue(release_idle_weights(1, None))

    def test_partial_plan_keeps_kv_and_two_transfer_blocks_out_of_residency(self):
        result = plan_residency(budget=16*GIB, block_bytes=[GIB]*10,
            fixed_bytes=2*GIB, peer_bytes=GIB, kv_bytes=2*GIB, available_ram=2*GIB)
        self.assertEqual(result.resident_blocks, 6)
        self.assertEqual(result.resident_bytes + result.reserve_bytes + result.kv_bytes
                         + result.transient_bytes + GIB, 16*GIB)
        self.assertFalse(result.use_stream)

    def test_unknown_or_insufficient_memory_never_claims_fit(self):
        for budget in (None, GIB):
            plan = plan_residency(budget=budget, block_bytes=[GIB], fixed_bytes=GIB,
                peer_bytes=GIB, kv_bytes=GIB, available_ram=None)
            self.assertEqual(plan.reason, "insufficient_stage_budget")
            self.assertEqual(plan.resident_blocks, 0)

    def test_stream_requires_space_for_the_pinned_host_copy(self):
        kwargs = dict(budget=8*GIB, block_bytes=[GIB]*8, fixed_bytes=GIB, peer_bytes=GIB, kv_bytes=0)
        self.assertFalse(plan_residency(**kwargs, available_ram=4*GIB).use_stream)
        self.assertTrue(plan_residency(**kwargs, available_ram=16*GIB).use_stream)

    def test_allocator_live_bytes_are_not_free(self):
        api = NS(mem_get_info=lambda _: (2*GIB, 16*GIB), memory_reserved=lambda _: 8*GIB,
                 memory_allocated=lambda _: 7*GIB)
        self.assertEqual(device_budget(NS(cuda=api), "cuda:1"), 3*GIB)
        self.assertEqual(device_budget(NS(cuda=api), "cuda:1", include_allocated=True), 10*GIB)

    def test_shared_memory_reservations_cannot_exceed_physical_capacity(self):
        api = NS(mem_get_info=lambda _: (0, 32*GIB), memory_reserved=lambda _: 20*GIB,
                 memory_allocated=lambda _: 11*GIB,
                 get_device_properties=lambda _: NS(total_memory=16*GIB))
        with patch("ai_execution_policy.physical_cuda_free", return_value=0):
            self.assertEqual(device_budget(NS(cuda=api), "cuda:0", include_allocated=True), 16*GIB)
            self.assertEqual(device_budget(NS(cuda=api), "cuda:0"), 9*GIB)

    def test_device_budget_respects_explicit_allocator_limit(self):
        api = NS(mem_get_info=lambda _: (10*GIB, 16*GIB), memory_reserved=lambda _: 6*GIB,
                 memory_allocated=lambda _: 4*GIB, get_per_process_memory_fraction=lambda _: .5)
        with patch("ai_execution_policy.physical_cuda_free", return_value=10*GIB):
            self.assertEqual(device_budget(NS(cuda=api), "cuda:0"), 4*GIB)
            self.assertEqual(device_budget(NS(cuda=api), "cuda:0", include_allocated=True), 8*GIB)

    def test_wddm_budget_uses_physical_free_and_only_reusable_cache(self):
        api = NS(mem_get_info=lambda _: (14*GIB, 16*GIB), memory_reserved=lambda _: 8*GIB,
                 memory_allocated=lambda _: 7*GIB)
        with patch("ai_execution_policy.physical_cuda_free", return_value=2*GIB):
            self.assertEqual(device_budget(NS(cuda=api), "cuda:1"), 3*GIB)

    def test_physical_budget_matches_uuid_under_reordered_devices(self):
        api = NS(get_device_properties=lambda _: NS(name="GPU", uuid="second"))
        with patch("ai_execution_policy.platform.system", return_value="Windows"), patch(
                "ai_execution_policy.subprocess.run", return_value=NS(stdout="GPU-first,GPU,4096\nGPU-second,GPU,2048\n")):
            self.assertEqual(physical_cuda_free(NS(cuda=api), "cuda:0"), 2*GIB)
            api.get_device_properties = lambda _: NS(name="GPU")
            self.assertIsNone(physical_cuda_free(NS(cuda=api), "cuda:0"))

    def test_kv_counts_both_cfg_branches_and_duration_growth(self):
        config = NS(num_hidden_layers=36, num_key_value_heads=8, head_dim=128)
        small = minimax_kv_bytes(config, duration=10, prompt_tokens=20, element_size=2)
        large = minimax_kv_bytes(config, duration=20, prompt_tokens=20, element_size=2)
        self.assertEqual(large-small, 2*2*36*8*128*250*2)

    def test_multigpu_selection_and_explicit_request(self):
        api = NS(is_available=lambda: True, device_count=lambda: 2,
                 mem_get_info=lambda i: ((i+1)*GIB, 4*GIB), get_device_name=lambda i: f"GPU{i}")
        torch = NS(cuda=api, version=NS(hip="7"), backends=NS())
        self.assertEqual(select_device(torch).device, "cuda:1")
        self.assertEqual(select_device(torch, "cuda:0").family, "rocm")
        with self.assertRaises(ValueError):
            select_device(torch, "xpu:0")

    def test_thread_budget_leaves_room_for_audio(self):
        self.assertEqual(worker_threads(2), 1)
        self.assertEqual(worker_threads(64), 4)
        self.assertEqual(worker_threads(64, cpu=True), 8)

    def test_attention_adapters_have_separate_names_and_shared_components_once(self):
        lm = NS(set_attn_implementation=Mock())
        dit = NS(set_attention_backend=Mock())
        details = configure_attention({"lm": lm, "dit": dit, "shared": dit}, "cpu")
        lm.set_attn_implementation.assert_called_once_with("sdpa")
        dit.set_attention_backend.assert_called_once_with("native")
        self.assertEqual(details["observedKernel"], "not_traced")
        with self.assertRaises(ValueError):
            configure_attention({"lm": lm}, "cpu", "flash")


if __name__ == "__main__":
    unittest.main()
