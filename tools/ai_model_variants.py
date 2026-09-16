"""Explicit, offline INT8 variants. Setup downloads originals and converts once.

Only the large language model (MiniMax) or diffusion transformer (ACE/SA3)
is quantized. Audio codecs and conditioning retain their original precision.
"""
from __future__ import annotations

import gc
import json
import os
from pathlib import Path
import shutil
import sys

MODELS = {"ace-step-v15-xl-turbo", "stable-audio-3-medium", "minimax-music-3"}
COMPONENTS = {
    "ace-step-v15-xl-turbo": ("transformer", "condition_encoder", "text_encoder", "vae"),
    "stable-audio-3-medium": ("transformer", "text_encoder", "duration_embedder", "vae"),
    "minimax-music-3": ("language_model", "condition_encoder", "rvq_depth_decoder", "transformer", "vocoder"),
}
MARKER = "openstudio-variant.json"
BITSANDBYTES_VERSION = "0.50.2"


def requested_variant(params):
    value = params.get("modelVariant", "original")
    if value not in {"original", "int8"}:
        raise ValueError("Unknown model version. Choose Original or INT8 in the model selector.")
    return value


def variant_root(model):
    if model not in MODELS:
        raise ValueError("Unsupported quantized model.")
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    return base / "OpenStudio/models" / (model + "-int8")


def validate_variant(root, model):
    root = Path(root)
    marker = root / MARKER
    if not marker.is_file() or marker.stat().st_size > 65536:
        raise ValueError("INT8 is not installed for this model. Download and prepare it in AI Runtime Setup.")
    record = json.loads(marker.read_text(encoding="utf-8"))
    component = "language_model" if model == "minimax-music-3" else "transformer"
    if (record.get("schemaVersion") != 1 or record.get("modelId") != model
            or record.get("variant") != "int8" or record.get("component") != component):
        raise ValueError("INT8 snapshot does not match the selected model. Repair it in AI Runtime Setup.")
    config = json.loads((root / component / "config.json").read_text(encoding="utf-8"))
    quant = config.get("quantization_config", {})
    if quant.get("quant_method") != "bitsandbytes" or not quant.get("load_in_8bit"):
        raise ValueError("The installed INT8 component is not a serialized 8-bit checkpoint.")
    if not any((root / component).glob("*.safetensors")):
        raise ValueError("The installed INT8 weights are missing.")
    validate_snapshot(root, model)
    return record


def validate_snapshot(root, model):
    index = "modular_model_index.json" if model == "minimax-music-3" else "model_index.json"
    for relative in (index, "tokenizer/tokenizer_config.json", "scheduler/scheduler_config.json"):
        if not (root / relative).is_file():
            raise ValueError(f"Incomplete model snapshot: missing {relative}.")
    for component in COMPONENTS[model]:
        folder = root / component
        if not (folder / "config.json").is_file() or not any(folder.glob("*.safetensors")):
            raise ValueError(f"Incomplete model snapshot: missing {component} weights or configuration.")
        for shard_index in folder.glob("*.index.json"):
            shards = json.loads(shard_index.read_text(encoding="utf-8"))["weight_map"]
            for filename in set(shards.values()):
                path = (folder / filename).resolve()
                if not path.is_relative_to(folder.resolve()) or not path.is_file():
                    raise ValueError(f"Incomplete model snapshot: missing {component} shard.")


def require_int8_device(torch):
    from importlib.metadata import version
    if not torch.cuda.is_available() or torch.version.hip:
        raise ValueError("This INT8 version currently requires an NVIDIA CUDA GPU. Choose Original on this device.")
    if version("bitsandbytes") != BITSANDBYTES_VERSION:
        raise ValueError("Install the INT8 runtime from AI Runtime Setup before using this version.")


def prepare_int8(source: Path, destination: Path, model: str):
    """Save and reload an actual quantized checkpoint; never modify the source."""
    import torch
    require_int8_device(torch)
    torch.set_num_threads(4)
    source, destination = source.resolve(), destination.resolve()
    if model not in MODELS or destination.exists() or source == destination or source in destination.parents:
        raise ValueError("INT8 preparation requires a new staging folder outside the original snapshot.")
    from prepare_diffusers_audio import report_progress
    if (source / MARKER).is_file():
        validate_variant(source, model)
        report_progress("Importing saved INT8 version")
        shutil.copytree(source, destination)
        validate_variant(destination, model)
        return
    validate_snapshot(source, model)
    component = "language_model" if model == "minimax-music-3" else "transformer"
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    if model == "minimax-music-3":
        from transformers import AutoModelForCausalLM, BitsAndBytesConfig
        cls = AutoModelForCausalLM
    else:
        from diffusers import AceStepTransformer1DModel, StableAudio3DiTModel, BitsAndBytesConfig
        cls = AceStepTransformer1DModel if model == "ace-step-v15-xl-turbo" else StableAudio3DiTModel
    report_progress("Preparing INT8 weights (one-time conversion)")
    config = BitsAndBytesConfig(load_in_8bit=True,
        **({"llm_int8_skip_modules": []} if model == "minimax-music-3" else {}))
    quantized = cls.from_pretrained(str(source / component), torch_dtype=dtype,
        quantization_config=config, device_map={"": "cuda:0"}, local_files_only=True)
    destination.mkdir(parents=True)
    quantized.save_pretrained(str(destination / component), safe_serialization=True, max_shard_size="2GB")
    del quantized
    gc.collect()
    torch.cuda.empty_cache()
    report_progress("Verifying saved INT8 weights")
    restored = cls.from_pretrained(str(destination / component), torch_dtype=dtype,
                                  device_map={"": "cuda:0"}, local_files_only=True)
    import bitsandbytes as bnb
    count = sum(isinstance(module, bnb.nn.Linear8bitLt) for module in restored.modules())
    if count == 0:
        raise RuntimeError("Reloaded checkpoint has no INT8 layers; setup stopped.")
    del restored
    gc.collect()
    torch.cuda.empty_cache()
    report_progress("Preparing shared model components")
    for item in source.iterdir():
        if item.name == component or item.name.startswith(".") or item.name == MARKER:
            continue
        target = destination / item.name
        # Copy, not symlink: the installed variant survives removal of a source
        # download cache or an imported folder on removable storage.
        if item.is_dir():
            shutil.copytree(item, target)
        elif item.is_file():
            shutil.copy2(item, target)
    record = {"schemaVersion": 1, "modelId": model, "variant": "int8", "component": component,
              "bitsandbytes": BITSANDBYTES_VERSION, "quantizedLayers": count,
              "source": "official weights; quantized locally", "subjectiveAudioQuality": "not_asserted"}
    (destination / MARKER).write_text(json.dumps(record, indent=2), encoding="utf-8")
    validate_variant(destination, model)
    report_progress("INT8 version ready")
