"""Real Torch/Accelerate hook lifecycle tests; CPU parity plus optional CUDA."""
import types
import importlib.util
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import torch
from ai_execution_policy import ResidencyPlan
from ai_partial_offload import PartialStagePlacement, Int8StagePlacement


class Module(torch.nn.Module):
    @property
    def device(self):
        return next(self.parameters()).device

    def __init__(self):
        super().__init__()
        self.linear = torch.nn.Linear(4, 4)

    def forward(self, x):
        return self.linear(x)


class PlacementTests(unittest.TestCase):
    @unittest.skipUnless(torch.cuda.is_available() and importlib.util.find_spec("bitsandbytes"),
                         "Isolated CUDA/BNB candidate unavailable")
    def test_real_int8_stage_restores_cpu_storage_and_output(self):
        import bitsandbytes as bnb
        names = ("language_model", "rvq_depth_decoder", "condition_encoder", "transformer", "vocoder")
        pipe = types.SimpleNamespace(**{name: Module().half().eval() for name in names})
        pipe.language_model.linear = bnb.nn.Linear8bitLt(4, 4, has_fp16_weights=False).half().eval()
        pipe.language_model.to("cuda:0")
        source = torch.randn(2, 4, device="cuda:0", dtype=torch.float16)
        with torch.inference_mode():
            expected = pipe.language_model(source).clone()
        owner = Int8StagePlacement(pipe, "cuda:0")
        addresses = {name: [value.data_ptr() for value in getattr(pipe, name).parameters()] for name in names}
        baseline = None
        try:
            with torch.inference_mode():
                for _ in range(12):
                    actual = pipe.language_model(source)
                    torch.testing.assert_close(actual, expected, atol=.001, rtol=.001)
                    pipe.transformer(actual)
                    owner.release()
                    for name in names:
                        self.assertEqual([value.data_ptr() for value in getattr(pipe, name).parameters()], addresses[name])
                    state = pipe.language_model.linear.state
                    self.assertTrue(all(value.device.type == "cpu" for value in vars(state).values()
                                        if torch.is_tensor(value)))
                    # The first use of a new GEMM shape initializes CUDA library
                    # workspace. Subsequent stage cycles must not retain weights.
                    if baseline is None:
                        baseline = torch.cuda.memory_allocated()
                    self.assertLess(torch.cuda.memory_allocated() - baseline, 1024**2)
        finally:
            owner.close()

    def test_int8_stage_ownership_warm_reuse_and_failed_transition(self):
        names = ("language_model", "rvq_depth_decoder", "condition_encoder", "transformer", "vocoder")
        pipe = types.SimpleNamespace(**{name: Module() for name in names})
        # Exercise the placement lifecycle independently of optional BNB wheels.
        with patch("ai_partial_offload.move_int8_module", side_effect=lambda module, device: module.to(device)) as move:
            owner = Int8StagePlacement(pipe, "cpu")
            try:
                for _ in range(2):
                    pipe.language_model._hf_hook.pre_forward(pipe.language_model)
                    count = move.call_count
                    pipe.rvq_depth_decoder._hf_hook.pre_forward(pipe.rvq_depth_decoder)
                    self.assertEqual(move.call_count, count)
                    pipe.transformer(torch.randn(2, 4))
                    self.assertEqual(owner.stage, "transformer")
                    owner.release()
                move.side_effect = RuntimeError("allocation failed")
                with self.assertRaisesRegex(RuntimeError, "allocation failed"):
                    owner.activate("ar")
                self.assertEqual(owner.stage, "ar")
                move.side_effect = lambda module, device: module.to(device)
            finally:
                owner.close()
            self.assertIsNone(owner.stage)
            self.assertTrue(all(not hasattr(getattr(pipe, name), "_hf_hook") for name in names))

    def test_int8_stage_rejects_nested_placement_owner(self):
        names = ("language_model", "rvq_depth_decoder", "condition_encoder", "transformer", "vocoder")
        pipe = types.SimpleNamespace(**{name: Module() for name in names})
        pipe.language_model.linear._hf_hook = object()
        with patch("ai_partial_offload.move_int8_module") as move:
            with self.assertRaisesRegex(ValueError, "unhooked"):
                Int8StagePlacement(pipe, "cpu")
            move.assert_not_called()

    def run_case(self, device, stream, disk=False):
        lm = Module()
        lm.model = torch.nn.Module()
        lm.model.layers = torch.nn.ModuleList([Module() for _ in range(4)])
        lm.model.embed_tokens = torch.nn.Embedding(8, 4)
        lm.model.norm = torch.nn.LayerNorm(4)
        lm.lm_head = torch.nn.Linear(4, 8)
        pipe = types.SimpleNamespace(language_model=lm, **{name: Module() for name in
            ("rvq_depth_decoder", "condition_encoder", "transformer", "vocoder")})
        x = torch.randn(2, 4)
        with torch.no_grad():
            expected = x
            for block in lm.model.layers:
                expected = block(expected)
        temporary = tempfile.TemporaryDirectory()
        owner = PartialStagePlacement(pipe, ResidencyPlan(2, 0, 0, 0, 0, stream, "fits"), device,
                                      disk_backed=disk, cache_root=Path(temporary.name))
        cpu_addresses = [p.data_ptr() for p in lm.parameters()]
        try:
            with torch.inference_mode():
                for _ in range(3):
                    # Exercise the same direct root-hook call as MiniMax.
                    lm._hf_hook.pre_forward(lm)
                    result = x.to(device)
                    for block in lm.model.layers:
                        result = block(result)
                    torch.testing.assert_close(result.cpu(), expected)
                    self.assertEqual(next(lm.model.layers[-1].parameters()).device.type, "cpu")
                    pipe.transformer(result)
                    self.assertEqual(owner.stage, "transformer")
                    self.assertEqual(next(lm.model.layers[0].parameters()).device.type, "cpu")
                    self.assertEqual([p.data_ptr() for p in lm.parameters()], cpu_addresses)
                if stream:
                    lm._hf_hook.pre_forward(lm)
                    queued = []
                    addresses = None
                    for _ in range(64):
                        result = x.to(device)
                        for block in lm.model.layers:
                            result = block(result)
                        queued.append(result)
                        current = [buffer.data_ptr() for _, buffers in owner.staging.values()
                                   for buffer in buffers]
                        if addresses is None:
                            addresses = current
                        self.assertEqual(current, addresses)
                        self.assertEqual(len(owner.staging), 2)
                    for result in queued:
                        torch.testing.assert_close(result.cpu(), expected)
            self.assertGreater(owner.transfer_bytes, 0)
            owner.release()
            with patch.object(owner, "_move", side_effect=RuntimeError("allocation failed")):
                with self.assertRaisesRegex(RuntimeError, "allocation failed"):
                    owner.activate("ar")
            owner.release()
            self.assertEqual([p.data_ptr() for p in lm.parameters()], cpu_addresses)
        finally:
            owner.close()
            self.assertFalse(list(Path(temporary.name).iterdir()))
            temporary.cleanup()
        self.assertFalse(hasattr(lm, "_hf_hook"))
        self.assertFalse(lm.model.layers[-1]._forward_hooks)

    def test_cpu_hooks_preserve_output_across_stages_and_warm_calls(self):
        self.run_case("cpu", False)

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA unavailable")
    def test_cuda_synchronous_and_prefetched_parity(self):
        for stream in (False, True):
            with self.subTest(stream=stream):
                self.run_case("cuda", stream)

    def test_disk_backed_cpu_stage_parity_and_cleanup(self):
        self.run_case("cpu", False, disk=True)

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA unavailable")
    def test_disk_backed_cuda_stage_parity_and_cleanup(self):
        for stream in (False, True):
            with self.subTest(stream=stream):
                self.run_case("cuda", stream, disk=True)


if __name__ == "__main__":
    unittest.main()
