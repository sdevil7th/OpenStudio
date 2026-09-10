"""Model-specific Diffusers contracts; no vendored model inference or fallback.

Kept independent of IPC so request routing and preserved samples can be tested
without loading multi-gigabyte weights. Generation never downloads checkpoints.
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any

STABLE_MODEL = "stable-audio-3-medium"
MINIMAX_MODEL = "minimax-music-3"
DIFFUSERS_REVISION = "7643c4826609c47755e3da0e5b768e8070468f49"


def normalize_song_lyrics(lyrics: str) -> str:
    import re
    # MiniMax drops words on the same line as a leading structure tag.
    return re.sub(r"(?m)^(\s*\[[^\]\r\n]+\])[ \t]*(\S)", r"\1\n\2", lyrics).strip()


def model_workflows(model_id: str) -> set[str]:
    if model_id == STABLE_MODEL:
        return {"text-to-audio", "variation", "inpaint-selection", "continue-clip"}
    if model_id == MINIMAX_MODEL:
        return {"lyrics-style", "structured-song"}
    raise ValueError(f"Unsupported audio model: {model_id}")


class DiffusersAudioSession:
    def __init__(self, root: Path, model_id: str = STABLE_MODEL) -> None:
        import torch
        # This separate worker must not create a full-machine CPU thread pool
        # beside live monitoring. GPU offload still consumes RAM/bandwidth.
        torch.set_num_threads(4)
        self.model_id = model_id
        model_workflows(model_id)
        self.device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        self.sample_rate = 44100
        self.io_channels = 2
        dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        if self.device == "cuda" and not torch.cuda.is_bf16_supported():
            dtype = torch.float32  # Avoid silently using unsupported BF16 kernels.
        self.pipelines: dict[str, Any] = {}
        if model_id == STABLE_MODEL:
            from diffusers import StableAudio3Pipeline
            if not (root / "model_index.json").is_file():
                raise RuntimeError("Import a converted Stable Audio 3 Diffusers folder (model_index.json), not the original checkpoint. See AI Tools setup instructions.")
            self.pipe = StableAudio3Pipeline.from_pretrained(str(root), torch_dtype=dtype, local_files_only=True)
            if not self.pipe.scheduler.config.stochastic_sampling:
                raise RuntimeError("This slot requires distilled Stable Audio 3 Medium, not Medium Base.")
            self.sample_rate = int(self.pipe.vae.config.sampling_rate)
        else:
            from diffusers import ComponentsManager, ModularPipeline
            if not (root / "modular_model_index.json").is_file():
                raise RuntimeError("Import the MiniMax Music 3 Modular Diffusers snapshot (modular_model_index.json).")
            manager = ComponentsManager()
            if self.device == "cuda":
                manager.enable_auto_cpu_offload(device="cuda")
            self.pipe = ModularPipeline.from_pretrained(str(root), components_manager=manager, local_files_only=True)
            # Snapshot indexes may still name the public repository. Resolve
            # every component against the imported local root, never the cache.
            self.pipe.load_components(dtype=dtype, local_files_only=True,
                                      pretrained_model_name_or_path=str(root))
            required = ("language_model", "condition_encoder", "rvq_depth_decoder", "transformer", "vocoder", "tokenizer", "scheduler")
            missing = [name for name in required if getattr(self.pipe, name, None) is None]
            if missing:  # Modular load_components logs errors instead of raising.
                raise RuntimeError("MiniMax components could not be loaded locally: " + ", ".join(missing))
            self.sample_rate = int(self.pipe.sampling_rate)
            if self.device == "cuda":
                from diffusers.hooks.group_offloading import apply_group_offloading
                # Follow the documented low-memory path; never compete for all
                # VRAM while the DAW is monitoring. CPU RAM is still required.
                apply_group_offloading(self.pipe.language_model, onload_device=torch.device("cuda"), offload_type="leaf_level", use_stream=False)
            else:
                self.pipe.to(self.device)

    def generate(self, *, workflow: str, prompt: str, duration: float,
                 steps: int = 8, seed: int = -1, lyrics: str = "",
                 init_audio: Any = None, init_noise_level: float = 0.5,
                 inpaint_audio: Any = None, inpaint_mask_start_seconds: float = 0,
                 inpaint_mask_end_seconds: float = 0, cfg_scale: float = 1,
                 negative_prompt: str = "") -> Any:
        import torch
        if workflow not in model_workflows(self.model_id):
            raise ValueError(f"{self.model_id} does not support {workflow}.")
        if workflow == "variation" and init_audio is None:
            raise ValueError("Variation requires source audio.")
        if workflow in {"inpaint-selection", "continue-clip"} and inpaint_audio is None:
            raise ValueError("This workflow requires source audio and an edit range.")
        if workflow == "text-to-audio" and (init_audio is not None or inpaint_audio is not None):
            raise ValueError("Text generation must not reuse a previous source clip.")
        if not math.isfinite(duration) or not 0 < duration <= (300 if self.model_id == MINIMAX_MODEL else 360):
            raise ValueError("Requested duration exceeds this model's supported workflow window.")
        generator_device = "cuda" if self.device == "cuda" else "cpu"
        generator = torch.Generator(generator_device)
        generator.manual_seed(seed) if seed >= 0 else generator.seed()
        if self.model_id == MINIMAX_MODEL:
            with torch.inference_mode():
                return self.pipe(prompt=prompt, lyrics=normalize_song_lyrics(lyrics),
                                 audio_duration=duration, num_inference_steps=steps,
                                 generator=generator, output="audios")[0]

        from diffusers import StableAudio3AudioToAudioPipeline, StableAudio3InpaintPipeline
        kind = "inpaint" if inpaint_audio is not None else "variation" if init_audio is not None else "text"
        pipe = self.pipelines.get(kind)
        if pipe is None:
            pipe = self.pipe if kind == "text" else (
                StableAudio3InpaintPipeline if kind == "inpaint" else StableAudio3AudioToAudioPipeline
            ).from_pipe(self.pipe)
            self.pipelines[kind] = pipe
        if self.device == "cuda":
            pipe.enable_model_cpu_offload()
        else:
            pipe.to(self.device)
        # Distilled CFG is baked into the weights; negative prompts have no
        # effect at guidance 1. Do not retry while silently dropping arguments.
        kwargs = dict(prompt=prompt, duration=duration, num_inference_steps=steps,
                      silence_padding_duration=0.0,
                      generator=generator, output_type="pt")
        if kind == "text":
            kwargs["guidance_scale"] = 1.0
        # The source pipelines do not expose CFG at all in this pinned API.
        source = inpaint_audio if kind == "inpaint" else init_audio
        original = None
        if source is not None:
            rate, waveform = source
            if rate != self.sample_rate:
                raise ValueError("Source must be resampled to the pipeline's sample rate before inference.")
            original = waveform.unsqueeze(0) if waveform.ndim == 2 else waveform
            if original.ndim != 3 or original.shape[1] != 2:
                raise ValueError("Expected stereo source shaped (batch, channels, samples).")
            if not torch.isfinite(original).all():
                raise ValueError("Source contains non-finite samples.")
            length = round(duration * self.sample_rate)
            prepared = torch.nn.functional.pad(original[..., :length], (0, max(0, length - original.shape[-1])))
            kwargs["audio"] = prepared
            if kind == "inpaint":
                start, end = inpaint_mask_start_seconds, inpaint_mask_end_seconds
                if not 0 <= start < end <= duration:
                    raise ValueError("Inpaint range must be a nonempty range inside the prepared source.")
                kwargs.update(mask_start_seconds=start, mask_end_seconds=end)
            else:
                if init_noise_level == 0:
                    return original[0]
                if not 0 < init_noise_level <= 1:
                    raise ValueError("Variation amount must be between 0 and 1.")
                kwargs["init_noise_level"] = init_noise_level
        with torch.inference_mode():
            audio = pipe(**kwargs).audios
        required_samples = round(duration * self.sample_rate)
        if audio.ndim != 3 or audio.shape[0] != 1 or audio.shape[1] != 2 or audio.shape[-1] < required_samples:
            raise RuntimeError("Diffusers returned an incomplete or invalid stereo waveform.")
        if not torch.isfinite(audio).all():
            raise RuntimeError("Diffusers returned non-finite audio; output was not published.")
        audio = audio[..., :required_samples].clone()
        if kind == "inpaint" and original is not None:
            # Latent masking cannot guarantee sample-exact unchanged context.
            # Preserve the untouched PCM; crossfade only inside the edit.
            start = round(inpaint_mask_start_seconds * self.sample_rate)
            end = round(inpaint_mask_end_seconds * self.sample_rate)
            original = original.to(device=audio.device, dtype=audio.dtype)
            available = min(original.shape[-1], audio.shape[-1])
            audio[..., :min(start, available)] = original[..., :min(start, available)]
            if end < available:
                audio[..., end:available] = original[..., end:available]
            fade = min(round(0.01 * self.sample_rate), (end - start) // 2)
            if fade > 0 and start + fade <= available:
                ramp = torch.linspace(0, 1, fade, device=audio.device, dtype=audio.dtype)
                audio[..., start:start + fade] = original[..., start:start + fade] * (1 - ramp) + audio[..., start:start + fade] * ramp
            if fade > 0 and end <= available:
                ramp = torch.linspace(0, 1, fade, device=audio.device, dtype=audio.dtype)
                audio[..., end - fade:end] = audio[..., end - fade:end] * (1 - ramp) + original[..., end - fade:end] * ramp
        return audio[0]
