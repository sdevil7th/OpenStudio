"""Real native Diffusers disk-hook ownership; no mocked tensor transfers."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
READY = all(importlib.util.find_spec(name) for name in ("torch", "diffusers", "psutil", "filelock"))


@unittest.skipUnless(READY, "requires the isolated generation runtime")
class GroupOffloadTests(unittest.TestCase):
    def setUp(self):
        import torch
        self.torch = torch
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def model(self, seed):
        torch = self.torch
        class Network(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.layers = torch.nn.ModuleList([torch.nn.Linear(8, 8) for _ in range(3)])
                self.register_buffer("bias", torch.ones(8))

            def forward(self, value):
                for layer in self.layers:
                    value = layer(value).relu()
                return value + self.bias
        with torch.random.fork_rng():
            torch.manual_seed(seed)
            return Network().eval()

    def test_equal_shapes_and_components_keep_their_own_weights(self):
        from ai_group_offload import GroupPlacement
        models = {"first": self.model(7), "second": self.model(8)}
        value = self.torch.ones(2, 8)
        expected = {name: model(value).detach().clone() for name, model in models.items()}
        with self.torch.inference_mode():
            owner = GroupPlacement(models, "cpu", disk=True, identity="a"*64, root=self.root, disk_backend="native")
            other_model = self.model(9)
            other_expected = other_model(value).detach().clone()
            other = GroupPlacement({"first": other_model}, "cpu", disk=True, identity="a"*64, root=self.root, disk_backend="native")
            try:
                for _ in range(2):
                    with owner.lease(), other.lease():
                        for name, model in models.items():
                            self.torch.testing.assert_close(model(value), expected[name], atol=0, rtol=0)
                        self.torch.testing.assert_close(other_model(value), other_expected, atol=0, rtol=0)
                self.assertNotEqual(owner.directory, other.directory)
                self.assertTrue(list((owner.directory/"first").glob("*.safetensors")))
                with owner.lease(), self.assertRaisesRegex(RuntimeError, "active request"):
                    owner.close()
            finally:
                owner.close()
                other.close()
        self.assertEqual(list(self.root.glob("load-*")), [])
        owner.close()
        with self.assertRaisesRegex(RuntimeError, "retired"), owner.lease():
            pass

    def test_rejects_hook_conflicts_shared_storage_and_retired_models(self):
        from ai_group_offload import GroupPlacement
        first, second = self.model(1), self.model(2)
        second.layers[0].weight = first.layers[0].weight
        with self.assertRaisesRegex(ValueError, "tied parameters"):
            GroupPlacement({"a": first, "b": second}, "cpu")
        model = self.model(3)
        owner = GroupPlacement({"a": model}, "cpu")
        with self.assertRaisesRegex(ValueError, "another hook owner"):
            GroupPlacement({"a": model}, "cpu")
        owner.close()
        with self.assertRaisesRegex(ValueError, "another hook owner"):
            GroupPlacement({"a": model}, "cpu")

    def test_quota_failure_precedes_model_mutation(self):
        from ai_group_offload import GroupPlacement
        model = self.model(1)
        before = model(self.torch.ones(1, 8)).detach().clone()
        with self.assertRaisesRegex(RuntimeError, "quota"):
            GroupPlacement({"a": model}, "cpu", disk=True, identity="b"*64,
                           root=self.root, quota_bytes=1)
        self.torch.testing.assert_close(model(self.torch.ones(1, 8)), before, atol=0, rtol=0)
        self.assertFalse(hasattr(model, "_openstudio_group_owner"))

    def test_stale_cleanup_keeps_live_and_foreign_entries(self):
        from ai_group_offload import cleanup_stale
        import psutil
        entries = [("a", "openstudio-group-store-v1", 0),
                   ("b", "openstudio-group-store-v1", psutil.Process().create_time()),
                   ("c", "foreign", 0)]
        for char, kind, birth in entries:
            directory = self.root/("load-"+char*32)
            directory.mkdir()
            (directory/".owner.json").write_text(json.dumps({"kind":kind,"pid":os.getpid(),"processBirth":birth}))
            (directory/"weights").write_bytes(b"owned")
        cleanup_stale(self.root)
        self.assertFalse((self.root/("load-"+"a"*32)).exists())
        self.assertTrue((self.root/("load-"+"b"*32)).exists())
        self.assertTrue((self.root/("load-"+"c"*32)).exists())

    def test_cuda_disk_groups_return_parameters_to_disk_between_forwards(self):
        if not self.torch.cuda.is_available():
            self.skipTest("requires CUDA or ROCm hardware")
        from ai_group_offload import GroupPlacement
        model = self.model(15)
        reference = self.model(15).to("cuda")
        value = self.torch.ones(4, 8, device="cuda")
        owner = GroupPlacement({"transformer":model}, "cuda", disk=True, identity="c"*64, root=self.root, disk_backend="native")
        try:
            with self.torch.inference_mode(), owner.lease():
                for _ in range(2):
                    self.torch.testing.assert_close(model(value), reference(value), atol=0, rtol=0)
                    self.assertTrue(all(parameter.device.type == "cpu" for parameter in model.parameters()))
        finally:
            owner.close()

    def test_mapped_disk_groups_preserve_real_cuda_output_and_error_retirement(self):
        if not self.torch.cuda.is_available():
            self.skipTest("requires CUDA or ROCm hardware")
        from ai_group_offload import GroupPlacement
        model, reference = self.model(4), self.model(4).to("cuda")
        value = self.torch.ones(2, 8, device="cuda")
        owner = GroupPlacement({"transformer":model}, "cuda", disk=True, identity="d"*64,
                               root=self.root, disk_backend="mapped")
        try:
            with self.torch.inference_mode(), owner.lease():
                for _ in range(2):
                    self.torch.testing.assert_close(model(value), reference(value), atol=0, rtol=0)
                    self.assertTrue(all(p.device.type == "cpu" for p in model.parameters()))
                with self.assertRaises(RuntimeError):
                    model(self.torch.ones(2, 9, device="cuda"))
                self.assertTrue(all(p.device.type == "cpu" for p in model.parameters()))
        finally:
            owner.close()
        self.assertEqual(list(self.root.glob("load-*")), [])


if __name__ == "__main__":
    unittest.main()
