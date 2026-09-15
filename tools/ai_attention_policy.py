"""Separate Diffusers/Transformers attention adapters; never fetch Hub code.

Default SDPA dispatch uses kernels shipped in Torch. Optional implementations
can be qualified by the headless benchmark, without changing production defaults.
"""
from __future__ import annotations

from importlib import metadata
import time

BACKENDS = {
    "native": (None, "native", "sdpa"),
    "flash": ("flash-attn", "flash", "flash_attention_2"),
    "xformers": ("xformers", "xformers", None),
    "aiter": ("aiter", "aiter", None),
    "sage": ("sageattention", "sage", None),
}


def attention_candidates(family: str) -> dict:
    result = {}
    for name, (package, _, _) in BACKENDS.items():
        allowed = (name == "native" or family == "cuda" and name in {"flash", "xformers", "sage"}
                   or family == "rocm" and name in {"flash", "aiter"})
        if not allowed:
            result[name] = {"state": "unavailable", "reason": f"No qualified adapter for {family}."}
            continue
        if package is None:
            result[name] = {"state": "available", "reason": "Torch automatic SDPA; kernel depends on shape."}
            continue
        try:
            version = metadata.version(package)
            result[name] = {"state": "available-but-unqualified", "version": version,
                            "reason": "Installed package; import and model forwards require validation."}
        except metadata.PackageNotFoundError:
            result[name] = {"state": "unavailable", "reason": f"{package} is not installed in this runtime."}
    return result


def configure_attention(components: dict, family: str, requested: str = "native") -> dict:
    if requested not in BACKENDS:
        raise ValueError(f"Unknown attention backend: {requested}")
    candidates = attention_candidates(family)
    if candidates[requested]["state"] == "unavailable":
        raise ValueError(candidates[requested]["reason"])
    _, diffusers_name, transformers_name = BACKENDS[requested]
    configured, seen = {}, set()
    for name, component in components.items():
        if id(component) in seen:
            continue
        seen.add(id(component))
        # Setters belong to different libraries and cannot share backend names.
        if callable(getattr(component, "set_attn_implementation", None)):
            implementation = transformers_name or "sdpa"
            try:
                component.set_attn_implementation(implementation)
            except (ValueError, ImportError, RuntimeError) as exc:
                if requested != "native":
                    raise
                configured[name] = {"policy": "model-default", "reason": str(exc)}
            else:
                configured[name] = {"policy": implementation, "interface": "transformers"}
        elif callable(getattr(component, "set_attention_backend", None)):
            try:
                component.set_attention_backend(diffusers_name)
            except (ValueError, ImportError, RuntimeError) as exc:
                if requested != "native":
                    raise
                configured[name] = {"policy": "model-default", "reason": str(exc)}
            else:
                configured[name] = {"policy": diffusers_name, "interface": "diffusers"}
        elif callable(getattr(component, "parameters", None)):
            configured[name] = {"policy": "model-default", "reason": "No supported attention setter."}
    return {"requested": requested, "components": configured, "candidates": candidates,
            "observedKernel": "not_traced"}


def configure_same_bounded_windows(vae, core_segments: int = 64) -> dict:
    """Bound SAME's dense band mask while preserving each layer's receptive field.

    Invoke the upstream resampling block on overlapping, stride-aligned windows.
    The halo covers every transformer layer; only the unaffected core is kept.
    No cross-fade, new weights, attention replacement, or global monkey-patching.
    RoPE retains absolute positions, including the pin's low-precision rounding.
    """
    import types
    from contextvars import ContextVar
    import torch
    if type(vae).__module__ != "diffusers.models.autoencoders.autoencoder_same":
        return {"state": "not_applicable"}
    if core_segments < 1:
        raise ValueError("SAME window core must be positive")
    count = 0
    for block in vae.modules():
        if type(block).__name__ != "SAMETransformerResamplingBlock":
            continue
        if getattr(block, "_openstudio_windowed", False):
            count += 1
            continue
        if block.mode not in {"encode", "decode", "encoder", "decoder"} or block.sliding_window < 1:
            raise ValueError("Unrecognized SAME resampling contract")
        encoding = block.mode == "encoder"
        stride = block.stride
        halo_segments = len(block.transformers) * block.sliding_window
        input_scale = stride if encoding else 1
        output_scale = 1 if encoding else stride
        original = block.forward
        position = ContextVar(f"same_window_position_{id(block)}", default=0)
        for layer in block.transformers:
            rope = layer.attn.rope
            original_rope = rope.forward

            def absolute_rope(self, seq_len, device, *, _original=original_rope, _position=position):
                offset = _position.get()
                return _original(seq_len + offset, device)[offset:]

            rope.forward = types.MethodType(absolute_rope, rope)

        def bounded(self, x, *, _original=original, _input=input_scale,
                    _output=output_scale, _halo=halo_segments, _position=position, _sub=stride + 1):
            core, halo = core_segments * _input, _halo * _input
            length = x.shape[-1]
            if length <= core + 2 * halo:
                return _original(x)
            chunks = []
            for start in range(0, length, core):
                end = min(start + core, length)
                left, right = max(0, start - halo), min(length, end + halo)
                token = _position.set(left // _input * _sub)
                try:
                    result = _original(x[..., left:right])
                finally:
                    _position.reset(token)
                first = (start - left) // _input * _output
                size = ((end - start + _input - 1) // _input) * _output
                # Clone only the core so the full halo result is not retained.
                chunks.append(result[..., first:first + size].clone())
            return torch.cat(chunks, dim=-1)

        block.forward = types.MethodType(bounded, block)
        block._openstudio_windowed = True
        count += 1
    return {"state": "enabled", "blocks": count, "coreSegments": core_segments,
            "halo": "transformer depth times local window", "subjectiveAudioQuality": "not_asserted"}


def configure_roformer_attention(model) -> dict:
    """Remove the pinned separator's A100-only SDPA kernel restriction.

    Only replace its parameter-free Attend nodes already configured for SDPA.
    Keep explicit non-SDPA model configurations and all chunk/overlap code.
    Torch dispatch retains its math fallback for unsupported shapes/devices.
    """
    import torch

    class AutomaticSDPA(torch.nn.Module):
        def __init__(self, original):
            super().__init__()
            self.dropout = original.dropout
            self.train(original.training)

        def forward(self, q, k, v):
            return torch.nn.functional.scaled_dot_product_attention(
                q, k, v, dropout_p=self.dropout if self.training else 0.0)

    count = 0
    if model is not None:
        for parent in list(model.modules()):
            for name, child in list(parent.named_children()):
                if (type(child).__module__ == "audio_separator.separator.uvr_lib_v5.roformer.attend"
                        and type(child).__name__ == "Attend" and getattr(child, "flash", False)):
                    if list(child.parameters()) or list(child.buffers()):
                        raise ValueError("Roformer attention layout changed; review the adapter before replacing it.")
                    setattr(parent, name, AutomaticSDPA(child))
                    count += 1
    return {"policy": "PyTorch automatic SDPA" if count else "audio-separator model default",
            "adaptedModules": count, "observedKernel": "not_traced",
            "batching": "The pinned Roformer engine processes one chunk at a time; batch_size is ignored."}


def probe_native_attention(torch, device: str) -> dict:
    """Bounded operator checks, explicitly not complete model qualification."""
    from torch.nn.attention import SDPBackend, sdpa_kernel
    from ai_execution_policy import accelerator_api
    family = device.split(":")[0]
    dtype = torch.bfloat16 if family == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
    api = accelerator_api(torch, device)
    results = {}
    # Keep tensors small; cover prefill, single-token decode, and additive masks.
    for name in ("MATH", "FLASH_ATTENTION", "EFFICIENT_ATTENTION", "CUDNN_ATTENTION"):
        cases = []
        for query_length, causal, masked in ((64, True, False), (1, False, False), (64, False, True)):
            try:
                query = torch.randn(2, 4, query_length, 128, device=device, dtype=dtype)
                key = torch.randn(2, 4, 64, 128, device=device, dtype=dtype)
                value = torch.randn_like(key)
                mask = torch.zeros(2, 1, query_length, 64, device=device, dtype=dtype) if masked else None
                if mask is not None:
                    mask[..., -8:] = float("-inf")
                kwargs = {"attn_mask": mask, "is_causal": causal}
                with torch.inference_mode(), sdpa_kernel(SDPBackend.MATH):
                    reference = torch.nn.functional.scaled_dot_product_attention(query, key, value, **kwargs)
                with torch.inference_mode(), sdpa_kernel(getattr(SDPBackend, name)):
                    if family in {"cuda", "xpu"}:
                        api.synchronize()
                    start = time.perf_counter()
                    output = torch.nn.functional.scaled_dot_product_attention(query, key, value, **kwargs)
                    if family in {"cuda", "xpu"}:
                        api.synchronize()
                torch.testing.assert_close(output, reference, atol=.04 if dtype == torch.bfloat16 else .0001,
                                           rtol=.04 if dtype == torch.bfloat16 else .0001)
                cases.append({"queryLength": query_length, "causal": causal, "masked": masked,
                              "state": "pass", "seconds": time.perf_counter()-start})
            except (RuntimeError, ValueError, AssertionError, AttributeError) as exc:
                cases.append({"queryLength": query_length, "causal": causal, "masked": masked,
                              "state": "unavailable", "reason": str(exc)})
        results[name] = cases
    return {"qualification": "operator_only", "dtype": str(dtype), "backends": results}
