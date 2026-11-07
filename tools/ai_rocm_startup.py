"""Auditioned ACE-Step convolution-selection recipe; no precision changes."""
import hashlib
from importlib import metadata
import os
import math
from pathlib import Path
import sys

SNAPSHOT = "200ba991ae448051e14b0183157e35c2d27c9fb0"
CONFIG_SHA256 = {
    "model_index.json": "26f44f97c4908851f19dbff6c25c6dfcbe17b9c74c152cc0535c47b82b80a250",
    "transformer/config.json": "6b6753b2833681bb0ad3363be71cafaa2b0a751146bbeb4e8ae485a407fa5775",
    "vae/config.json": "164a21874900efa4813175f812a7816408551b8c5ac38f2deb65347acb2fc3eb",
}


def rocm_startup_reserve(duration):
    if not math.isfinite(duration) or not 0 < duration <= 600:
        raise ValueError("Faster AMD startup is qualified for requests up to 600 seconds")
    # Envelope above the observed 30/60/600-second activation peaks, including
    # headroom. A ten-minute forward needs more than the generic duration rule.
    return int((5 + 16*max(0, duration-60)/540)*1024**3)


def validate_rocm_startup(torch, device, snapshot):
    if (not sys.platform.startswith("linux") or not str(device).startswith("cuda")
            or str(torch.__version__) != "2.9.1+rocm7.2.0.git7e1940d4"
            or torch.version.hip != "7.2.26015-fc0010cf6a"
            or not torch.cuda.is_bf16_supported()
            or torch.cuda.get_device_properties(device).gcnArchName.split(":")[0] != "gfx1151"
            or torch.backends.cudnn.version() != 3005001
            or metadata.version("diffusers") != "0.39.0"):
        raise ValueError("Faster AMD startup requires the qualified Linux Radeon 8060S ROCm runtime; choose Automatic")
    snapshot = Path(snapshot).resolve()
    if snapshot.name != SNAPSHOT:
        raise ValueError("Faster AMD startup requires the reviewed ACE-Step snapshot; choose Automatic")
    for name, expected in CONFIG_SHA256.items():
        path = snapshot/name
        if (not path.is_file() or path.stat().st_size > 64*1024
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected):
            raise ValueError("Faster AMD startup model configuration differs from the reviewed snapshot; choose Automatic")
    return {"recipe":"ace-gfx1151-miopen-fast-v1", "state":"qualified_opt_in",
        "convolutionSelection":"MIOPEN_FIND_MODE=FAST", "miopenVersion":3005001, "snapshot":SNAPSHOT,
        "precisionChange":False, "recipeAudition":"accepted paired November previews",
        "audioQuality":"not_asserted for this output"}


def configure_rocm_startup(torch, device, snapshot):
    details = validate_rocm_startup(torch, device, snapshot)
    # Child-local and before any model forward. Changing this setting requires
    # a fresh worker, which the native optimization identity already enforces.
    os.environ["MIOPEN_FIND_MODE"] = "FAST"
    return details
