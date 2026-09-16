"""Real pinned SAME blocks: compare bounded windows with full-sequence attention."""
import unittest
import torch
from diffusers.models.autoencoders.autoencoder_same import AutoencoderSAME
from ai_attention_policy import configure_same_bounded_windows


class SAMEWindowsTests(unittest.TestCase):
    def test_window_boundaries_encoder_padding_and_absolute_positions(self):
        torch.set_num_threads(2)
        torch.manual_seed(71)
        vae = AutoencoderSAME(patch_size=4, encoder_channels=16, encoder_c_mults=(2,),
            encoder_strides=(4,), encoder_transformer_depths=(3,), latent_dim=8,
            dim_heads=8, decoder_sinusoidal_blocks=(1,)).eval()
        # Default branches initialize to zero; randomize so the test exercises
        # attention and cross-window propagation rather than a no-op network.
        with torch.no_grad():
            for name, parameter in vae.named_parameters():
                if name.endswith(('to_out.weight', 'proj_out.weight')):
                    parameter.normal_(std=.03)
        samples = torch.randn(1, 2, 713)
        latents = torch.randn(1, 8, 73)
        with torch.inference_mode():
            expected_encode = vae.encode(samples).latents
            expected_decode = vae.decode(latents).sample
            details = configure_same_bounded_windows(vae, core_segments=8)
            self.assertEqual(details['blocks'], 2)
            torch.testing.assert_close(vae.encode(samples).latents, expected_encode, atol=2e-5, rtol=2e-5)
            torch.testing.assert_close(vae.decode(latents).sample, expected_decode, atol=2e-5, rtol=2e-5)
            # Idempotence and shorter requests after a windowed request.
            configure_same_bounded_windows(vae, core_segments=8)
            self.assertTrue(torch.isfinite(vae.decode(latents[..., :2]).sample).all())


if __name__ == '__main__':
    import sys
    if '--model-root' not in sys.argv:
        unittest.main()
    else:
        import argparse
        import json
        import time
        from pathlib import Path
        parser = argparse.ArgumentParser()
        parser.add_argument('--model-root', type=Path, required=True)
        parser.add_argument('--output', type=Path, required=True)
        parser.add_argument('--dtype', choices=['bfloat16', 'float32'], default='bfloat16')
        parser.add_argument('--full-accumulation', action='store_true')
        args = parser.parse_args()
        torch.set_num_threads(4)
        torch.manual_seed(71)
        if args.full_accumulation:
            torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
        dtype = getattr(torch, args.dtype)
        vae = AutoencoderSAME.from_pretrained(str(args.model_root), subfolder='vae',
            torch_dtype=dtype, local_files_only=True).to('cuda').eval()
        # Beyond the window threshold and BF16's exact-integer position range.
        latent = torch.randn(1, 256, 137, device='cuda', dtype=dtype)
        with torch.inference_mode():
            torch.cuda.synchronize()
            start = time.perf_counter()
            reference = vae.decode(latent).sample.float()
            torch.cuda.synchronize()
            reference_seconds = time.perf_counter() - start
            # A batch-shape control distinguishes windowing from the normal
            # numerical variation of the unchanged low-precision checkpoint.
            control = vae.decode(latent.repeat(2, 1, 1)).sample[:1].float()
            control_relative_rmse = ((control - reference).square().mean().sqrt()
                                     / reference.square().mean().sqrt()).item()
            details = configure_same_bounded_windows(vae)
            start = time.perf_counter()
            actual = vae.decode(latent).sample.float()
            torch.cuda.synchronize()
            difference = actual - reference
            relative_rmse = (difference.square().mean().sqrt() / reference.square().mean().sqrt()).item()
            report = {'dtype': args.dtype, 'fullAccumulation': args.full_accumulation,
                'referenceSeconds': reference_seconds, 'windowedSeconds': time.perf_counter() - start,
                'maxAbsDifference': difference.abs().max().item(), 'relativeRmse': relative_rmse,
                'unmodifiedBatchShapeRelativeRmse': control_relative_rmse,
                'shape': list(actual.shape), 'windows': details,
                'status': 'diagnostic_only',
                'finiteOutputAndShape': bool(actual.shape == reference.shape and torch.isfinite(actual).all()),
                'fp32NumericalParity': ('pass' if relative_rmse < .0001 else 'fail') if dtype == torch.float32 else 'not_asserted',
                'comparison': 'uncalibrated audio difference; not an audio-quality gate', 'subjectiveAudioQuality': 'not_asserted'}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(report))
            if not report['finiteOutputAndShape'] or report['fp32NumericalParity'] == 'fail':
                raise SystemExit(1)
