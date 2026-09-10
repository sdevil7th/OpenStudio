"""Convert an existing local SA3 snapshot with the pinned OFFICIAL converter.

Setup only; inference uses Diffusers exclusively. Never downloads model weights,
changes the source folder, or publishes a partial destination.
"""
import argparse
import hashlib
import os
from pathlib import Path
import gc
import runpy
import urllib.request

from diffusers_audio_pipeline import DIFFUSERS_REVISION, DiffusersAudioSession, STABLE_MODEL

CONVERTER_SHA256 = "ee782fa2dfacc637251d00add7cee93f6c3aafcbed6abf111ff209947d98267f"


def prepare(source: Path, destination: Path, cache: Path):
    source, destination = source.resolve(), destination.resolve()
    if source == destination or source in destination.parents or destination.exists():
        raise ValueError("Conversion requires a new staging directory outside the original snapshot.")
    required = ["model.safetensors", "model_config.json", "t5gemma-b-b-ul2/config.json",
                "t5gemma-b-b-ul2/model.safetensors", "t5gemma-b-b-ul2/tokenizer.model"]
    missing = [name for name in required if not (source / name).is_file()]
    if missing:
        raise ValueError("Original snapshot is incomplete: " + ", ".join(missing))
    url = f"https://raw.githubusercontent.com/huggingface/diffusers/{DIFFUSERS_REVISION}/scripts/convert_stable_audio_3_to_diffusers.py"
    cache.mkdir(parents=True, exist_ok=True)
    converter = cache / f"convert_stable_audio_3_{DIFFUSERS_REVISION}.py"
    data = converter.read_bytes() if converter.is_file() else urllib.request.urlopen(url, timeout=60).read()
    if hashlib.sha256(data).hexdigest() != CONVERTER_SHA256:
        raise RuntimeError("Official converter checksum mismatch; setup stopped.")
    if not converter.is_file():
        converter.write_bytes(data)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    namespace = runpy.run_path(str(converter))
    namespace["convert"](argparse.Namespace(checkpoint_path=str(source / "model.safetensors"),
        model_config_path=str(source / "model_config.json"), text_encoder_repo=str(source / "t5gemma-b-b-ul2"),
        output_dir=str(destination), dtype="bfloat16", skip_sanity_check=True))
    del namespace
    gc.collect()
    # The upstream sanity check only warns on failure and keeps all conversion
    # tensors alive. Check after conversion locals have been released. Running
    # in one worker process also makes cancellation leave no orphan converter.
    DiffusersAudioSession(destination, STABLE_MODEL)
    for notice in ("LICENSE.md", "LICENSE_GEMMA.md", "NOTICE"):
        if (source / notice).is_file():
            (destination / notice).write_bytes((source / notice).read_bytes())
    print("Converted Diffusers snapshot loaded successfully; source unchanged.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source, args.destination, args.cache)
