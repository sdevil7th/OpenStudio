import sys
import types
import unittest
from unittest.mock import patch, Mock

import torch

from diffusers_audio_pipeline import DiffusersAudioSession, STABLE_MODEL, MINIMAX_MODEL, model_workflows, normalize_song_lyrics


class FakePipeline:
    def __init__(self):
        self.calls = []
        self.bad_output = None
        self.components = {"vae": object(), "transformer": object()}

    def to(self, device):
        return self

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        output = torch.full((1, 2, round(kwargs["duration"] * 1000)), 0.2)
        if self.bad_output == "short":
            output = output[..., :50]
        elif self.bad_output == "nan":
            output[..., 0] = float("nan")
        return types.SimpleNamespace(audios=output)


class DiffusersContractTests(unittest.TestCase):
    def setUp(self):
        self.pipe = FakePipeline()
        self.session = DiffusersAudioSession.__new__(DiffusersAudioSession)
        self.session.model_id = STABLE_MODEL
        self.session.device = "cpu"
        self.session.dtype = torch.float32
        self.session.sample_rate = 1000
        self.session.pipe = self.pipe
        self.session.pipelines = {}
        self.session._active_pipe = None
        self.session._placement = None
        self.from_pipe = Mock(side_effect=lambda **kwargs: self.pipe)
        adapter = self.from_pipe
        module = types.SimpleNamespace(StableAudio3InpaintPipeline=adapter, StableAudio3AudioToAudioPipeline=adapter)
        self.import_patch = patch.dict(sys.modules, {"diffusers": module})
        self.import_patch.start()
        self.addCleanup(self.import_patch.stop)
        self.source = torch.linspace(-0.6, 0.6, 1000).repeat(2, 1)

    def test_text_contract_does_not_pass_ineffective_controls(self):
        self.session.generate(workflow="text-to-audio", prompt="bass", duration=1, seed=123, cfg_scale=9, negative_prompt="noise")
        args = self.pipe.calls[0]
        self.assertEqual(args["guidance_scale"], 1)
        self.assertEqual(args["silence_padding_duration"], 0)
        self.assertNotIn("negative_prompt", args)
        self.assertEqual(args["generator"].initial_seed(), 123)

    def test_inpaint_preserves_untouched_pcm_exactly(self):
        output = self.session.generate(workflow="inpaint-selection", prompt="bass", duration=1,
            inpaint_audio=(1000, self.source), inpaint_mask_start_seconds=.2, inpaint_mask_end_seconds=.7)
        self.assertTrue(torch.equal(output[..., :200], self.source[..., :200]))
        self.assertTrue(torch.equal(output[..., 700:], self.source[..., 700:]))
        self.assertEqual(self.pipe.calls[0]["mask_start_seconds"], .2)
        self.assertNotIn("guidance_scale", self.pipe.calls[0])
        self.from_pipe.assert_called_once_with(**self.pipe.components)
        self.assertTrue(torch.allclose(output[..., 300:600], torch.full((2, 300), .2)))

    def test_zero_variation_is_exact_noop_without_inference(self):
        output = self.session.generate(workflow="variation", prompt="bass", duration=1,
            init_audio=(1000, self.source), init_noise_level=0)
        self.assertTrue(torch.equal(output, self.source))
        self.assertEqual(self.pipe.calls, [])

    def test_continuation_pads_reference_and_preserves_prefix(self):
        output = self.session.generate(workflow="continue-clip", prompt="bass", duration=2,
            inpaint_audio=(1000, self.source), inpaint_mask_start_seconds=.9, inpaint_mask_end_seconds=2)
        self.assertEqual(output.shape, (2, 2000))
        self.assertTrue(torch.equal(output[..., :900], self.source[..., :900]))
        self.assertEqual(self.pipe.calls[0]["audio"].shape, (1, 2, 2000))

    def test_invalid_inputs_fail_without_inference(self):
        cases = [dict(workflow="variation"), dict(workflow="continue-clip"),
            dict(workflow="variation", init_audio=(48000, self.source)),
            dict(workflow="inpaint-selection", inpaint_audio=(1000, self.source), inpaint_mask_start_seconds=.7, inpaint_mask_end_seconds=.2)]
        for case in cases:
            with self.subTest(case=case["workflow"]), self.assertRaises(ValueError):
                self.session.generate(prompt="bass", duration=1, **case)
        self.assertEqual(self.pipe.calls, [])

    def test_bad_outputs_are_not_published_or_silently_retried(self):
        for fault in ("short", "nan"):
            self.pipe.bad_output = fault
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):
                self.session.generate(workflow="text-to-audio", prompt="bass", duration=1)
        self.assertEqual(len(self.pipe.calls), 2)

    def test_minimax_capabilities_and_tags(self):
        self.assertEqual(model_workflows(MINIMAX_MODEL), {"lyrics-style", "structured-song"})
        self.assertEqual(normalize_song_lyrics("[verse] words\n[chorus]\nmore words"), "[verse]\nwords\n[chorus]\nmore words")


if __name__ == "__main__":
    unittest.main()
