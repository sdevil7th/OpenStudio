"""RoFormer rolling reconstruction candidate, using the pinned model forward.

Preserves window positions (including repeated tail windows) and whole-source
normalization. RAM depends on the model window, not recording duration. Float
stems are staged on disk until their global peaks are known; a directory rename
publishes the complete set. This is not Diffusers model offloading.
"""
from contextlib import ExitStack, nullcontext
import math
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid


def normalization_gain(peak, maximum, minimum):
    import numpy as np
    peak = np.float32(peak)
    if peak > maximum:
        return maximum / peak
    if minimum is not None and peak > 0 and peak < minimum:
        return minimum / peak
    return np.float32(1)


def window_positions(frames, window, step):
    padded = max(frames, window)
    return (min(start, padded - window) for start in range(0, padded, step))


def prepare_source(source_path, scratch, sample_rate, telemetry):
    measure = telemetry.measure if telemetry else nullcontext
    import numpy as np
    import soundfile as sf
    source_path = Path(source_path)
    try:
        source = sf.SoundFile(str(source_path))
    except (RuntimeError, OSError):
        decoded = scratch / "decoded.wav"
        with (scratch / "decoder.log").open("wb") as log:
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(source_path),
                            "-map", "0:a:0", "-vn", "-acodec", "pcm_s16le", "-rf64", "auto", str(decoded)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, check=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        source_path = decoded
        source = sf.SoundFile(str(source_path))
    with source:
        if source.channels not in {1, 2} or len(source) == 0:
            raise ValueError("Streaming RoFormer requires nonempty mono or stereo audio")
        subtype = source.subtype
        if source.samplerate != sample_rate:
            import soxr
            converted = scratch / "resampled.wav"
            expected = math.ceil(len(source) * sample_rate / source.samplerate)
            converter = soxr.ResampleStream(source.samplerate, sample_rate, source.channels, dtype="float32", quality="HQ")
            with measure("resample"), sf.SoundFile(str(converted), "w", samplerate=sample_rate,
                    channels=source.channels, format="RF64", subtype="FLOAT") as target:
                position = 0
                while position < len(source):
                    block = source.read(65536, dtype="float32", always_2d=True)
                    position += len(block)
                    result = converter.resample_chunk(block, last=position == len(source))
                    target.write(result[:max(0, expected - target.tell())])
                if target.tell() < expected:
                    target.write(np.zeros((expected - target.tell(), source.channels), dtype="float32"))
            source_path = converted
    return source_path, subtype


def separate_streaming(separator, input_path, output_dir, requested_stems, telemetry, emit, job_id=None):
    measure = telemetry.measure if telemetry else nullcontext
    import numpy as np
    import soundfile as sf
    import torch
    from scipy import signal
    engine = separator.model_instance
    if not getattr(engine, "is_roformer", False) or engine.pitch_shift != 0:
        raise ValueError("Streaming requires the RoFormer adapter without a pitch-shift transform")
    instruments = list(engine.model_data_cfgdict.training.instruments)
    if engine.model_data_cfgdict.training.target_instrument or len(instruments) != 6:
        raise ValueError("Streaming adapter is qualified only for the six-stem RoFormer model")
    requested = {name.lower() for name in requested_stems}
    root = Path(output_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    job_id = job_id or uuid.uuid4().hex
    if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
        raise ValueError("Invalid streaming job identity")
    final = root / ("stems-" + job_id)
    if final.exists():
        raise FileExistsError("Streaming output identity already exists")
    with tempfile.TemporaryDirectory(prefix=".openstudio-stem-" + job_id + "-", dir=root) as temporary:
        scratch = Path(temporary)
        ownership = {"kind": "openstudio-stem-workspace-v1", "job": job_id, "pid": os.getpid()}
        (scratch / ".openstudio-owner.json").write_text(json.dumps(ownership), encoding="utf-8")
        emit("analyzing", 0.2, phase="stream_decode", stagingDirectory=str(scratch))
        with measure("decode"):
            source_path, input_subtype = prepare_source(input_path, scratch, engine.sample_rate, telemetry)
        with sf.SoundFile(str(source_path)) as source:
            frames = len(source)
            # Float intermediates + final PCM outputs + an explicit disk floor.
            required_disk = frames * 2 * len(instruments) * 8 + 1024 ** 3
            if shutil.disk_usage(root).free < required_disk:
                raise OSError("Not enough free disk space for bounded-memory stem reconstruction")
            peak = np.float32(0)
            with measure("scanNormalization"):
                for block in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
                    if not np.isfinite(block).all():
                        raise ValueError("Source contains nonfinite samples")
                    peak = max(peak, np.max(np.abs(block)))
            gain = normalization_gain(peak, engine.normalization_threshold, engine.amplification_threshold)
            if peak == 0:
                emit("writing", 0.2, phase="silent_input", inference="skipped_digital_silence")
            if frames / engine.sample_rate < 10 and not engine.override_model_segment_size:
                engine.override_model_segment_size = True
            cfg = engine.model_data_cfgdict
            segment = engine.segment_size if engine.override_model_segment_size else cfg.inference.dim_t
            hop = getattr(cfg.model, "stft_hop_length", None) or cfg.audio.hop_length
            window_size = int(hop) * (int(segment) - 1)
            desired = int(engine.overlap * cfg.audio.sample_rate)
            step = window_size if desired <= 0 else min(desired, window_size)
            window = np.asarray(signal.windows.hamming(window_size), dtype=np.float32)
            result = np.zeros((len(instruments), 2, window_size), dtype=np.float32)
            counter = np.zeros(window_size, dtype=np.float32)
            peaks = np.zeros(len(instruments), dtype=np.float32)
            staging = scratch / "complete"
            staging.mkdir()
            (staging / ".openstudio-owner.json").write_text(json.dumps(ownership), encoding="utf-8")
            raw_paths = [scratch / f"stem-{index}.wav" for index in range(len(instruments))]
            with ExitStack() as stack:
                writers = [stack.enter_context(sf.SoundFile(str(path), "w", samplerate=engine.sample_rate,
                    channels=2, format="RF64", subtype="FLOAT")) for path in raw_paths]
                base = 0

                def flush(count):
                    valid = min(count, max(0, frames - base))
                    if valid:
                        with measure("reconstruct"):
                            samples = result[..., :valid] / np.maximum(counter[:valid], np.float32(1e-10))
                            if not np.isfinite(samples).all():
                                raise ValueError("Model produced nonfinite stem samples")
                            for index, writer in enumerate(writers):
                                peaks[index] = max(peaks[index], np.max(np.abs(samples[index])))
                                writer.write(samples[index].T)
                    if count < window_size:
                        result[..., :window_size-count] = result[..., count:]
                        counter[:window_size-count] = counter[count:]
                    result[..., window_size-count:] = 0
                    counter[window_size-count:] = 0

                positions = window_positions(frames, window_size, step)
                total = math.ceil(max(frames, window_size) / step)
                autocast = torch.autocast(engine.torch_device.type) if separator.use_autocast else nullcontext()
                with torch.no_grad(), autocast:
                    for index, start in enumerate(positions):
                        if start > base:
                            flush(start - base)
                            base = start
                        source.seek(start)
                        part = source.read(window_size, dtype="float32", always_2d=True)
                        if part.shape[1] == 1:
                            part = np.repeat(part, 2, axis=1)
                        part = part * gain
                        if len(part) < window_size:
                            part = np.pad(part, [(0, window_size-len(part)), (0, 0)])
                        if peak == 0:
                            prediction = np.zeros_like(result)
                        else:
                            tensor = torch.tensor(np.ascontiguousarray(part.T), dtype=torch.float32).to(engine.torch_device)
                            with measure("modelForward"):
                                prediction = engine.model_run(tensor.unsqueeze(0))[0].detach().float().cpu().numpy()
                        length = min(window_size, prediction.shape[-1])
                        result[..., :length] += prediction[..., :length] * window[:length]
                        counter[:length] += window[:length]
                        emit("analyzing", 0.2 + 0.65 * (index + 1) / total, phase="stream_inference")
                flush(window_size)
            subtype = {"PCM_24": "PCM_24", "PCM_32": "PCM_32", "FLOAT": "PCM_32", "DOUBLE": "PCM_32"}.get(input_subtype, "PCM_16")
            paths = []
            for index, name in enumerate(instruments):
                if name.lower() not in requested:
                    continue
                target = staging / (name.capitalize() + ".wav")
                output_gain = normalization_gain(peaks[index], engine.normalization_threshold, engine.amplification_threshold)
                # Upstream normalizes once in the separator and again in its
                # writer; preserve the second scalar correction as well.
                after = np.float32(peaks[index] * output_gain)
                second_gain = normalization_gain(after, engine.normalization_threshold, engine.amplification_threshold)
                near_silent = after < 1e-6
                with measure("writeOutput"), sf.SoundFile(str(raw_paths[index])) as raw, sf.SoundFile(str(target), "w",
                        samplerate=engine.sample_rate, channels=2, subtype="PCM_16" if near_silent else subtype,
                        format="WAV" if frames * 2 * 4 < 2**32 - 4096 else "RF64") as output:
                    for block in raw.blocks(blocksize=65536, dtype="float32", always_2d=True):
                        block *= output_gain
                        if not near_silent:
                            block *= second_gain
                            block = (block * 32767).astype(np.int16)
                        output.write(block)
                paths.append(str(final / target.name))
            emit("writing", 0.95, phase="stream_publish")
            os.replace(staging, final)
            return paths, str(final)
