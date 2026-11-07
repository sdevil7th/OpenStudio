from pathlib import Path
import sys
import tempfile
import importlib.util
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))


@unittest.skipIf(importlib.util.find_spec("audio_separator") is None, "pinned runtime adapter test")
class ChunkingTests(unittest.TestCase):
    def test_fractional_millisecond_tail_and_merge_preserve_every_sample(self):
        import numpy as np
        import soundfile as sf
        from stem_chunking import install_sample_accurate_chunking
        from audio_separator.separator import audio_chunking
        install_sample_accurate_chunking()
        # The upstream millisecond slicing loses this 6-sample tail.
        original = (np.arange(48006*2, dtype="int32").reshape(-1, 2) % 30000).astype("int16")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sf.write(root/"source.wav", original, 48000, subtype="PCM_16")
            chunker = audio_chunking.AudioChunker(.25)
            parts = chunker.split_audio(str(root/"source.wav"), str(root/"parts"))
            self.assertEqual(sum(sf.info(path).frames for path in parts), len(original))
            chunker.merge_chunks(parts, str(root/"merged.wav"))
            actual, rate = sf.read(root/"merged.wav", dtype="int16", always_2d=True)
            self.assertEqual(rate, 48000)
            np.testing.assert_array_equal(actual, original)
