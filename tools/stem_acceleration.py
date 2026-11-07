"""Opt-in RoFormer recipe qualified on one exact Linux/ROCm runtime.

Unmatched hardware, runtime, checkpoint or config retains the existing default.
The accepted 60-80 second vocal/guitar/drum previews are a listening checkpoint,
not evidence for every instrument, song, runtime or AMD device.
"""
import hashlib
from importlib import metadata
import os
from pathlib import Path
import platform

PROFILE = "rocm-gfx1151-fp16-aotriton-v1"
TORCH_VERSION = "2.9.1+rocm7.2.0.git7e1940d4"
HIP_VERSION = "7.2.26015-fc0010cf6a"
CHECKPOINT_SHA256 = "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
CONFIG_SHA256 = "868a017096bf22865dc48c4a032c6f08ac69bc39c4a948be0d917c439efb74c8"


def qualified_fast_recipe(torch, backend, model_path, requested):
    result = {"requested": requested, "profile": "standard", "precision": "default",
              "reason": "Existing precision policy selected"}
    if requested == "standard":
        return result
    if requested != "qualified-fast":
        raise ValueError("Unknown stem performance mode")
    try:
        if platform.system() != "Linux" or backend != "rocm":
            raise ValueError("the faster recipe is qualified only for Linux ROCm")
        if str(torch.__version__) != TORCH_VERSION or str(torch.version.hip) != HIP_VERSION:
            raise ValueError("the installed Torch/ROCm runtime differs from the qualified recipe")
        properties = torch.cuda.get_device_properties(torch.cuda.current_device())
        if getattr(properties, "gcnArchName", "").split(":")[0] != "gfx1151":
            raise ValueError("this AMD architecture has not been qualified")
        if metadata.version("audio-separator") != "0.41.1":
            raise ValueError("the separator package differs from the qualified recipe")
        path = Path(model_path)
        for source, expected in [(path, CHECKPOINT_SHA256), (path.with_suffix(".yaml"), CONFIG_SHA256)]:
            with source.open("rb") as handle:
                if hashlib.file_digest(handle, "sha256").hexdigest() != expected:
                    raise ValueError("the model or configuration differs from the qualified recipe")
        # Child-local; set before the first attention operator dispatch.
        os.environ["TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL"] = "1"
        result.update(profile=PROFILE, precision="fp16", reason="Locally qualified gfx1151 FP16/AOTriton recipe",
                      audition="accepted representative previews; broader audio quality not_asserted")
    except (ValueError, OSError, AttributeError, RuntimeError, metadata.PackageNotFoundError) as exc:
        result["reason"] = f"Using standard precision: {exc}"
    return result
