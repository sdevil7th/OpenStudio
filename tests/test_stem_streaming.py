"""Rolling-buffer parity/transaction tests; subjective audio is not asserted."""
from pathlib import Path
import importlib.util
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
import shutil
import subprocess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ai_telemetry import WorkerTelemetry
from stem_streaming import separate_streaming


@unittest.skipIf(importlib.util.find_spec("torch") is None, "real tensor tests need Torch")
class StreamingTests(unittest.TestCase):
    @unittest.skipIf(importlib.util.find_spec("soxr") is None, "needs the runtime streaming resampler")
    def test_decoder_format_matrix_matches_independent_whole_decode(self):
        import numpy as np
        import soundfile as sf
        import soxr
        from stem_streaming import prepare_source
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            samples = (np.sin(np.arange(48007)*.071)*.17).astype("float32")
            sources = []
            for name, subtype in [("pcm16.wav", "PCM_16"), ("pcm24.wav", "PCM_24"),
                                  ("float.wav", "FLOAT"), ("lossless.flac", "PCM_24")]:
                path = root/name
                sf.write(path, samples, 48000, subtype=subtype)
                sources.append(path)
            if shutil.which("ffmpeg"):
                for name, options in [("vbr.mp3", ["-codec:a", "libmp3lame", "-q:a", "3"]),
                                      ("aac.m4a", ["-codec:a", "aac", "-b:a", "192k"])]:
                    path = root/name
                    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(sources[0]),
                                    *options, str(path)], check=True, capture_output=True)
                    sources.append(path)
            for index, path in enumerate(sources):
                with self.subTest(format=path.name):
                    scratch = root/str(index)
                    scratch.mkdir()
                    try:
                        decoded, rate = sf.read(path, dtype="float32", always_2d=True)
                    except (RuntimeError, OSError):
                        reference = root/(str(index)+"-reference.wav")
                        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(path),
                            "-map", "0:a:0", "-vn", "-acodec", "pcm_s16le", str(reference)], check=True, capture_output=True)
                        decoded, rate = sf.read(reference, dtype="float32", always_2d=True)
                    expected = soxr.resample(decoded, rate, 44100, quality="HQ")
                    read = sf.SoundFile.read
                    def bounded(handle, frames=-1, *args, **kwargs):
                        self.assertGreaterEqual(frames, 0)
                        self.assertLessEqual(frames, 65536)
                        return read(handle, frames, *args, **kwargs)
                    with patch.object(sf.SoundFile, "read", bounded):
                        actual_path, _ = prepare_source(path, scratch, 44100, WorkerTelemetry())
                    actual, actual_rate = sf.read(actual_path, dtype="float32", always_2d=True)
                    self.assertEqual(actual_rate, 44100)
                    self.assertEqual(actual.shape[1], 1)
                    self.assertLessEqual(abs(len(actual)-len(expected)), 1)
                    np.testing.assert_array_equal(actual[:len(expected)], expected)

    def test_nonfinite_source_is_rejected_without_publishing_stems(self):
        import numpy as np
        import soundfile as sf
        separator, calls = self.engine()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sf.write(root/"invalid.wav", np.array([.1, float("nan"), .2]), 100, subtype="FLOAT")
            with self.assertRaisesRegex(ValueError, "nonfinite"):
                separate_streaming(separator, str(root/"invalid.wav"), str(root/"out"),
                    ["Vocals"], WorkerTelemetry(), lambda *a, **k: None)
            self.assertEqual(calls, [])
            self.assertEqual(list((root/"out").iterdir()), [])

    def test_mono_digital_silence_publishes_six_stereo_files_without_model_forward(self):
        import numpy as np
        import soundfile as sf
        separator, calls = self.engine()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sf.write(root/"mono.wav", np.zeros(17), 100)
            files, _ = separate_streaming(separator, str(root/"mono.wav"), str(root/"out"),
                ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"], WorkerTelemetry(), lambda *a, **k: None)
            self.assertEqual(calls, [])
            self.assertEqual(len(files), 6)
            for path in files:
                samples, rate = sf.read(path, always_2d=True)
                self.assertEqual((samples.shape, rate), ((17, 2), 100))
                self.assertFalse(samples.any())

    @unittest.skipIf(importlib.util.find_spec("soxr") is None, "streaming resampler qualification needs soxr")
    def test_resampling_preserves_fractional_tail_and_mono_channel_count(self):
        import math
        import numpy as np
        import soundfile as sf
        import soxr
        from stem_streaming import prepare_source
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/"source.wav"
            sf.write(source, np.sin(np.arange(48007) * .07) * .1, 48000, subtype="PCM_24")
            decoded = sf.read(source, dtype="float32", always_2d=True)[0]
            expected = soxr.resample(decoded, 48000, 44100, quality="HQ")
            converted, subtype = prepare_source(source, root, 44100, WorkerTelemetry())
            actual, rate = sf.read(converted, dtype="float32", always_2d=True)
            self.assertEqual(rate, 44100)
            self.assertEqual(actual.shape, (math.ceil(48007 * 44100/48000), 1))
            self.assertEqual(subtype, "PCM_24")
            np.testing.assert_array_equal(actual[:len(expected)], expected)

    def engine(self, fail=False):
        import torch
        calls = []
        def model(value):
            calls.append(value.shape[-1])
            if fail and len(calls) == 2:
                raise RuntimeError("injected forward failure")
            output = value + value.mean() * .25
            return torch.stack([output * (i + 1) / 3 for i in range(6)], dim=1)
        engine = NS(is_roformer=True, pitch_shift=0, sample_rate=100,
            normalization_threshold=.9, amplification_threshold=0,
            override_model_segment_size=False, segment_size=6, overlap=.2,
            torch_device=torch.device("cpu"), model_run=model,
            model_data_cfgdict=NS(model=NS(stft_hop_length=10), inference=NS(dim_t=6),
                audio=NS(hop_length=10, sample_rate=100),
                training=NS(target_instrument=None, instruments=["vocals", "drums", "bass", "guitar", "piano", "other"])))
        return NS(model_instance=engine, use_autocast=False), calls

    def test_tail_windows_match_full_reconstruction_and_reads_are_bounded(self):
        import numpy as np
        import soundfile as sf
        import torch
        from scipy.signal.windows import hamming
        # Independent normalization reference, without requiring the model
        # package in the lightweight unit-test environment.
        def normalize(value, maximum, minimum):
            peak = np.abs(value).max()
            if peak > maximum:
                value *= maximum / peak
            elif 0 < peak < minimum:
                value *= minimum / peak
            return value
        separator, calls = self.engine()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.wav"
            original = np.stack([np.sin(np.arange(145)*.19), np.cos(np.arange(145)*.23)], axis=1).astype("float32") * .2
            sf.write(source, original, 100)
            audio = sf.read(source, dtype="float32", always_2d=True)[0].T
            mix = torch.tensor(audio)
            result = torch.zeros((6, 2, 145))
            counter = torch.zeros_like(result)
            weights = torch.tensor(hamming(50), dtype=torch.float32)
            for i in range(0, 145, 20):
                start = i if i + 50 <= 145 else 95
                prediction = separator.model_instance.model_run(mix[:, start:start+50].unsqueeze(0))[0]
                result[..., start:start+50] += prediction * weights
                counter[..., start:start+50] += weights
            reference = (result / counter.clamp(min=1e-10)).numpy()
            calls.clear()
            read = sf.SoundFile.read
            def bounded(handle, frames=-1, *args, **kwargs):
                self.assertGreaterEqual(frames, 0)
                self.assertLessEqual(frames, 65536)
                return read(handle, frames, *args, **kwargs)
            with patch.object(sf.SoundFile, "read", bounded):
                files, destination = separate_streaming(separator, str(source), str(root/"out"),
                    ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"], WorkerTelemetry(), lambda *a, **k: None)
            self.assertEqual(len(files), 6)
            self.assertEqual(calls, [50] * 8)
            for index, filename in enumerate(files):
                expected = normalize(reference[index].copy(), .9, 0).T
                expected = normalize(expected, .9, 0)
                expected = (expected * 32767).astype(np.int16)
                actual, rate = sf.read(filename, dtype="int16", always_2d=True)
                self.assertEqual(rate, 100)
                self.assertLessEqual(np.max(np.abs(actual.astype("int32") - expected)), 1)
            self.assertTrue(Path(destination).is_dir())
            self.assertFalse(any(path.name.startswith(".openstudio-stem-") for path in (root/"out").iterdir()))

    def test_forward_failure_does_not_publish_partial_stems_or_remove_prior_outputs(self):
        import numpy as np
        import soundfile as sf
        separator, _ = self.engine(fail=True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sf.write(root/"source.wav", np.ones((145, 2))*.1, 100)
            output = root/"out"
            output.mkdir()
            prior = output/"prior.wav"
            prior.write_bytes(b"existing output")
            with self.assertRaisesRegex(RuntimeError, "injected"):
                separate_streaming(separator, str(root/"source.wav"), str(output), ["Vocals"], WorkerTelemetry(), lambda *a, **k: None)
            self.assertEqual(list(output.iterdir()), [prior])
            self.assertEqual(prior.read_bytes(), b"existing output")
