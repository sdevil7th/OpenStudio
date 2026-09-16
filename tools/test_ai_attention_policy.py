"""Real pinned Roformer adapter parity, without checkpoints or audio playback."""
import unittest
import torch
from ai_attention_policy import configure_roformer_attention
from audio_separator.separator.uvr_lib_v5.roformer.attend import Attend


class RoformerAttentionTests(unittest.TestCase):
    def test_automatic_sdpa_preserves_output_and_state(self):
        devices = ["cpu"] + (["cuda"] if torch.cuda.is_available() else [])
        for device in devices:
            original = Attend(flash=True).eval()
            model = torch.nn.Sequential(original)
            before = model.state_dict()
            tensors = [torch.randn(2, 4, 32, 64, device=device) for _ in range(3)]
            with torch.inference_mode():
                expected = original(*tensors)
                details = configure_roformer_attention(model)
                result = model[0](*tensors)
            self.assertEqual(details["adaptedModules"], 1)
            self.assertEqual(model.state_dict(), before)
            torch.testing.assert_close(result, expected, atol=1e-5, rtol=1e-4)
            self.assertFalse(model[0].training)

    def test_explicit_unfused_configuration_stays_owned_by_model(self):
        original = Attend(flash=False)
        model = torch.nn.Sequential(original)
        self.assertEqual(configure_roformer_attention(model)["adaptedModules"], 0)
        self.assertIs(model[0], original)


if __name__ == "__main__":
    unittest.main()
