"""Exercise the real pinned MiniMax text step on CPU without model weights."""
from pathlib import Path
import importlib.util
import unittest

import torch
from ai_execution_policy import minimax_prompt_tokens, prompt_token_bound


class TokenBudgetTests(unittest.TestCase):
    def test_budget_uses_tokenizer_output_including_structural_tokens(self):
        texts = []
        def tokenizer(text, **kwargs):
            texts.append(text)
            self.assertEqual(kwargs, {"return_tensors": "pt"})
            return {"input_ids": torch.arange(405).unsqueeze(0)}
        prompt, lyrics = "A long musical description " * 40, "[verse] words\n[chorus]\n更多歌詞"
        self.assertGreater(prompt_token_bound(prompt, lyrics), 980)
        self.assertEqual(minimax_prompt_tokens(Path("unused"), prompt, lyrics, tokenizer=tokenizer), 405)
        self.assertEqual(len(texts), 1)
        self.assertIn("words", texts[0])  # Same-line tags retain words via our normalizer.
        self.assertIn("更多歌詞", texts[0])

    def test_upstream_rejects_actual_token_overflow(self):
        tokenizer = lambda *_args, **_kwargs: {"input_ids": torch.zeros((1, 5001), dtype=torch.long)}
        with self.assertRaisesRegex(ValueError, "5001 tokens"):
            minimax_prompt_tokens(Path("unused"), "A song", "A verse", tokenizer=tokenizer)

    def test_empty_text_fails_before_tokenizer_or_weights(self):
        def tokenizer(*_args, **_kwargs):
            self.fail("Invalid input should not reach the tokenizer")
        for prompt, lyrics in (("", "A verse"), ("A song", "")):
            with self.subTest(prompt=prompt), self.assertRaises(ValueError):
                    minimax_prompt_tokens(Path("unused"), prompt, lyrics, tokenizer=tokenizer)


class CapacityHarnessTests(unittest.TestCase):
    def test_eos_mask_is_test_local_and_restored_even_on_failure(self):
        from diffusers.modular_pipelines.minimax_music3 import encoders
        spec = importlib.util.spec_from_file_location("benchmark", Path(__file__).with_name("run-ai-benchmark.py"))
        benchmark = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(benchmark)
        original = encoders._sample_top_k
        logits = torch.full((1, encoders._AUDIO_CODE_OFFSET + 1), -float("inf"))
        logits[0, encoders._AUDIO_END_TOKEN_ID] = 100
        logits[0, encoders._AUDIO_CODE_OFFSET] = 5
        generator = torch.Generator("cpu").manual_seed(123)
        self.assertEqual(original(logits, generator).item(), encoders._AUDIO_END_TOKEN_ID)
        with self.assertRaisesRegex(RuntimeError, "test failure"):
            with benchmark.capacity_sampling(True) as evidence:
                self.assertEqual(encoders._sample_top_k(logits, generator).item(), encoders._AUDIO_CODE_OFFSET)
                depth_logits = torch.tensor([[-100., 100., -100.]])
                self.assertEqual(encoders._sample_top_k(depth_logits, generator).item(), 1)
                self.assertEqual(evidence["semanticCalls"], 1)
                self.assertEqual(logits[0, encoders._AUDIO_END_TOKEN_ID].item(), 100)
                raise RuntimeError("test failure")
        self.assertIs(encoders._sample_top_k, original)
        with benchmark.capacity_sampling(False) as evidence:
            self.assertIsNone(evidence)
            self.assertIs(encoders._sample_top_k, original)


if __name__ == "__main__":
    unittest.main()
