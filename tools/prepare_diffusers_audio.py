"""Download supported Hub models or convert an existing local SA3 snapshot.

Setup only; inference stays offline. The host publishes staging only after validation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import gc
from functools import partial
import runpy
import shutil
import sys
import time
import urllib.request

from diffusers_audio_pipeline import DIFFUSERS_REVISION, DiffusersAudioSession, STABLE_MODEL, MINIMAX_MODEL

CONVERTER_SHA256 = "ee782fa2dfacc637251d00add7cee93f6c3aafcbed6abf111ff209947d98267f"
HUB_MODELS = {
    STABLE_MODEL: ("stabilityai/stable-audio-3-medium", "27b5a21b791b1b033d193a9e1e3ce78493f102f9",
                   ["model.safetensors", "model_config.json", "t5gemma-b-b-ul2/*", "LICENSE*", "NOTICE"]),
    MINIMAX_MODEL: ("MiniMaxAI/MiniMax-Music3", "fbdf52fbaaca799592917417eb05f1899f1255ec",
                    ["modular_model_index.json", "condition_encoder/*", "language_model/*",
                     "rvq_depth_decoder/*", "scheduler/*", "tokenizer/*", "transformer/*", "vocoder/*", "LICENSE"]),
}


def report_progress(stage: str, completed: int = 0, total: int = 0, cached: int = 0):
    print("OPENSTUDIO_SETUP_PROGRESS " + json.dumps({
        "stage": stage, "bytesDownloaded": completed, "bytesTotal": total, "bytesCached": cached,
    }), flush=True)


def hub_progress_class(total_bytes: int = 0, cached_bytes: int = 0):
    from huggingface_hub.utils import tqdm
    from tqdm.auto import tqdm as base_tqdm

    class SetupProgress(tqdm):
        def __init__(self, *args, **kwargs):
            self.setup_name = kwargs.pop("name", "")
            self.last_report = 0.0
            # This is app telemetry, not terminal output. Pipe/TTY detection and
            # HF_HUB_DISABLE_PROGRESS_BARS must not silence setup progress.
            kwargs["disable"] = False
            base_tqdm.__init__(self, *args, **kwargs)

        def display(self, *args, **kwargs):
            # Hub aggregates newly reconstructed files, including partial
            # resumes. Add complete cached files to the fixed preflight total.
            now = time.monotonic()
            if self.setup_name == "huggingface_hub.snapshot_download" and now - self.last_report >= 0.5:
                self.last_report = now
                total = total_bytes or int(self.total or 0)
                completed = min(total, cached_bytes + int(self.n)) if total else 0
                report_progress("Downloading model files", completed, total, cached_bytes)

    return SetupProgress


def download(model_id: str, destination: Path, cache: Path, *, check_access: bool = False):
    from huggingface_hub import hf_hub_download, snapshot_download

    repo, revision, patterns = HUB_MODELS[model_id]
    if destination.exists():
        raise ValueError("Download requires a new staging directory.")
    # Probe a small required file before transferring multi-gigabyte weights.
    # Hub uses the one-run HF_TOKEN or an existing Hugging Face login.
    probe = "model_config.json" if model_id == STABLE_MODEL else "modular_model_index.json"
    report_progress("Checking Hugging Face access")
    hf_hub_download(repo, probe, revision=revision, cache_dir=str(cache / "hub"))
    if check_access:
        print("Hugging Face model access verified.", flush=True)
        return
    report_progress("Checking download size and cached files")
    plan = snapshot_download(repo, revision=revision, allow_patterns=patterns,
                             cache_dir=str(cache / "hub"), dry_run=True)
    if not plan:
        raise RuntimeError("Hugging Face returned no files for the selected model.")
    total_bytes = sum(item.file_size for item in plan)
    cached_bytes = sum(item.file_size for item in plan if not item.will_download)
    print(f"Downloading {repo} from Hugging Face. Completed files are reused on retry.", flush=True)
    report_progress("Downloading model files", cached_bytes, total_bytes, cached_bytes)
    source = Path(snapshot_download(repo, revision=revision, allow_patterns=patterns,
                                   cache_dir=str(cache / "hub"), tqdm_class=hub_progress_class(total_bytes, cached_bytes)))
    # Never give the converter the access token; no credentials are saved by this helper.
    os.environ.pop("HF_TOKEN", None)
    if model_id == STABLE_MODEL:
        prepare(source, destination, cache)
    else:
        report_progress("Preparing downloaded model files")
        destination.mkdir(parents=True)
        # A Hub snapshot may also contain files cached by a previous version.
        # Copy only our selected components, never legacy duplicate weights.
        for pattern in patterns:
            name = pattern.removesuffix("/*")
            item = source / name
            if item.is_dir():
                shutil.copytree(item, destination / name)
            elif item.is_file():
                shutil.copy2(item, destination / name)
        report_progress("Checking model can load")
        DiffusersAudioSession(destination, MINIMAX_MODEL)
        print("Downloaded Diffusers snapshot loaded successfully.", flush=True)


def prepare(source: Path, destination: Path, cache: Path):
    report_progress("Converting Stable Audio model")
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
    if sys.platform == "win32":
        # Large copy-on-write mappings can crash torch_cpu.dll on Windows
        # before Python can raise an error. Use safetensors' supported reader
        # for this converter only; keep the verified upstream script intact.
        globals_ = namespace["convert"].__globals__
        globals_["load_file"] = partial(globals_["load_file"], backend="pread")
    namespace["convert"](argparse.Namespace(checkpoint_path=str(source / "model.safetensors"),
        model_config_path=str(source / "model_config.json"), text_encoder_repo=str(source / "t5gemma-b-b-ul2"),
        output_dir=str(destination), dtype="bfloat16", skip_sanity_check=True))
    del namespace
    gc.collect()
    # The upstream sanity check only warns on failure and keeps all conversion
    # tensors alive. Check after conversion locals have been released. Running
    # in one worker process also makes cancellation leave no orphan converter.
    report_progress("Checking model can load")
    DiffusersAudioSession(destination, STABLE_MODEL)
    for notice in ("LICENSE.md", "LICENSE_GEMMA.md", "NOTICE"):
        if (source / notice).is_file():
            (destination / notice).write_bytes((source / notice).read_bytes())
    print("Converted Diffusers snapshot loaded successfully; source unchanged.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--source", type=Path)
    mode.add_argument("--download-model", choices=HUB_MODELS)
    parser.add_argument("--check-access", action="store_true")
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.download_model:
            download(args.download_model, args.destination, args.cache, check_access=args.check_access)
        else:
            prepare(args.source, args.destination, args.cache)
    except Exception as exc:
        # Do not echo HTTP headers, request URLs or credentials in installer logs.
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (401, 403):
            message = ("Hugging Face access was denied. Open the model page, accept its terms and wait for access approval, "
                       "then retry with a read token from that account that permits access to this model.")
        else:
            message = str(exc)
            token = os.environ.get("HF_TOKEN")
            if token:
                message = message.replace(token, "[redacted]")
        print(f"Setup failed: {message}", file=sys.stderr, flush=True)
        sys.exit(1)
