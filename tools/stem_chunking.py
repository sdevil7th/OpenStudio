"""Sample-accurate, bounded I/O for the pinned separator's sectioning seam."""
import os
from pathlib import Path


def install_sample_accurate_chunking():
    from audio_separator.separator import audio_chunking
    previous = audio_chunking.AudioChunker
    if getattr(previous, "_openstudio_sample_accurate", False):
        return

    class SampleAccurateChunker(previous):
        _openstudio_sample_accurate = True

        def split_audio(self, input_path, output_dir):
            import soundfile as sf
            try:
                source = sf.SoundFile(input_path)
            except (OSError, RuntimeError):
                self.logger.warning("Using the dependency decoder for this format; bounded decode is not asserted")
                return super().split_audio(input_path, output_dir)
            paths = []
            Path(output_dir).mkdir(parents=True, exist_ok=True)
            with source:
                section_frames = round(source.samplerate * self.chunk_duration_ms / 1000)
                if section_frames <= 0:
                    raise ValueError("Invalid section size")
                subtype = source.subtype if source.subtype in {"PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"} else "PCM_16"
                index = 0
                while source.tell() < len(source):
                    path = str(Path(output_dir) / f"chunk_{index:04d}.wav")
                    remaining = min(section_frames, len(source) - source.tell())
                    with sf.SoundFile(path, "w", samplerate=source.samplerate, channels=source.channels,
                                      subtype=subtype) as output:
                        while remaining:
                            block = source.read(min(65536, remaining), dtype="float32", always_2d=True)
                            if not len(block):
                                raise OSError("Input ended before its declared sample count")
                            output.write(block)
                            remaining -= len(block)
                    paths.append(path)
                    index += 1
            return paths

        def merge_chunks(self, chunk_paths, output_path):
            import soundfile as sf
            if not chunk_paths:
                raise ValueError("No processed sections to merge")
            info = sf.info(chunk_paths[0])
            temporary = str(output_path) + ".partial"
            try:
                with sf.SoundFile(temporary, "w", samplerate=info.samplerate, channels=info.channels,
                                  subtype=info.subtype, format="RF64") as output:
                    for path in chunk_paths:
                        with sf.SoundFile(path) as source:
                            if (source.samplerate, source.channels) != (info.samplerate, info.channels):
                                raise ValueError("Processed section formats do not match")
                            for block in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
                                output.write(block)
                os.replace(temporary, output_path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            return output_path

    audio_chunking.AudioChunker = SampleAccurateChunker
