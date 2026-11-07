import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"tools"))


@unittest.skipUnless(importlib.util.find_spec("torch"),"needs Torch")
class WeightBankTests(unittest.TestCase):
    def test_gpu_loaded_component_is_archived_exactly_and_returns_to_cpu(self):
        import torch
        if not torch.cuda.is_available():self.skipTest("requires CUDA or ROCm")
        from ai_disk_store import DiskWeightBank
        model=torch.nn.Linear(8,8).to("cuda").eval()
        model.register_buffer("curve",torch.arange(6,device="cuda"))
        expected={name:value.detach().cpu().clone() for name,value in model.state_dict().items()}
        with tempfile.TemporaryDirectory() as directory:
            bank=DiskWeightBank(root=Path(directory))
            try:
                bank.add(model,allow_device=True)
                self.assertTrue(all(value.device.type=="cpu" for value in model.parameters()))
                self.assertTrue(all(value.device.type=="cpu" for value in model.buffers()))
                for name,value in model.state_dict().items():torch.testing.assert_close(value,expected[name],atol=0,rtol=0)
                bank.move_module(model,"cuda")
                for name,value in model.state_dict().items():torch.testing.assert_close(value.cpu(),expected[name],atol=0,rtol=0)
            finally:bank.close()
            self.assertEqual(list(Path(directory).glob('worker-*')),[])

    def test_separate_equal_shaped_components_retain_exact_weights_and_cleanup(self):
        import torch
        from ai_disk_store import DiskWeightBank
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            foreign=root/"unrelated-model.bin"
            foreign.write_bytes(b"keep original")
            models=[torch.nn.Linear(8,8).eval(),torch.nn.Linear(8,8).eval()]
            originals=[{k:v.detach().clone() for k,v in m.state_dict().items()} for m in models]
            bank=DiskWeightBank(root=root)
            try:
                for m in models: bank.add(m)
                self.assertEqual(len(bank.stores),2)
                self.assertEqual(len(list(root.glob("worker-*"))),2)
                for model,weights in zip(models,originals):
                    for key,value in model.state_dict().items(): torch.testing.assert_close(value,weights[key],atol=0,rtol=0)
                    for value in model.parameters():
                        destination=torch.empty_like(value)
                        bank.read_into(value,destination)
                        torch.testing.assert_close(destination,value,atol=0,rtol=0)
                with self.assertRaisesRegex(ValueError,"tied parameters"): bank.add(models[0])
            finally: bank.close()
            self.assertEqual(list(root.glob("worker-*")),[])
            self.assertEqual(foreign.read_bytes(),b"keep original")

    def test_real_cuda_moves_use_the_right_component_and_retire_after_forward(self):
        import torch
        if not torch.cuda.is_available(): self.skipTest("requires CUDA or ROCm")
        from ai_disk_store import DiskWeightBank
        models=[torch.nn.Linear(8,8).eval(),torch.nn.Linear(8,8).eval()]
        value=torch.ones(2,8,device="cuda")
        reference=[]
        for model in models:
            twin=torch.nn.Linear(8,8).eval();twin.load_state_dict(model.state_dict());twin.to("cuda")
            reference.append(twin(value).detach().clone())
        with tempfile.TemporaryDirectory() as directory:
            bank=DiskWeightBank(root=Path(directory))
            try:
                for model in models: bank.add(model)
                for _ in range(2):
                    for model,expected in zip(models,reference):
                        bank.move_module(model,"cuda")
                        torch.testing.assert_close(model(value),expected,atol=0,rtol=0)
                        bank.move_module(model,"cpu")
                        self.assertTrue(all(p.device.type=="cpu" for p in model.parameters()))
            finally: bank.close()
            self.assertEqual(list(Path(directory).glob("worker-*")),[])


if __name__=="__main__": unittest.main()
