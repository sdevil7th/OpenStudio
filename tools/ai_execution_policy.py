"""Hardware capabilities and allocation policy shared by AI workers.

No Torch import at module scope: policy tests and setup can run without models.
All memory quantities are bytes. Availability is not hardware qualification.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import os
import platform
import subprocess
import csv
from pathlib import Path
from typing import Any
from importlib import metadata
import json
import sys

GIB = 1024 ** 3
POLICY_VERSION = 1
WORKER_MODULES = ("diffusers_audio_pipeline.py", "ai_execution_policy.py",
                  "ai_attention_policy.py", "ai_partial_offload.py", "ai_disk_store.py", "ai_model_variants.py")

MINIMAX_ALLOCATOR = "backend:native,per_process_memory_fraction:0.9,garbage_collection_threshold:0.8,roundup_power2_divisions:4"
MINIMAX_PROMPT_MEASUREMENT = "upstream-tokenize-step-v1"


def allocator_environment() -> str:
    return os.environ.get("PYTORCH_ALLOC_CONF", os.environ.get("PYTORCH_CUDA_ALLOC_CONF", ""))


def configure_allocator_environment(model: str) -> None:
    """Called before Torch import; preserve both forms of user override.

    Windows Torch 2.10 does not support expandable_segments. Rounded native
    allocations let the growing MiniMax KV cache reuse a bounded set of sizes.
    The pinned allocator activates reclamation only with an explicit fraction
    below 1.0; leave 10% outside this worker's allocator for the device context
    and desktop. Physical free memory and request reserves are checked separately.
    """
    if (model == "minimax-music-3" and platform.system() == "Windows"
            and "PYTORCH_ALLOC_CONF" not in os.environ
            and "PYTORCH_CUDA_ALLOC_CONF" not in os.environ):
        os.environ["PYTORCH_ALLOC_CONF"] = MINIMAX_ALLOCATOR


def worker_version(script: Path) -> str:
    return hashlib.md5(script.read_bytes() + b"".join(
        script.with_name(name).read_bytes() for name in WORKER_MODULES)).hexdigest()[:16]


def cuda_uuid(value) -> str:
    # Torch _CUuuid omits NVIDIA SMI's GPU- prefix.
    return str(value).removeprefix("GPU-").lower()


def model_storage_identity(root: Path) -> str:
    """Invalidate calibration after snapshot/config changes without hashing GBs.

    This is a local cache identity, not a cryptographic attestation of weights.
    """
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix in {".json", ".safetensors", ".bin", ".model", ".txt"}:
            info = path.stat()
            digest.update(json.dumps([path.relative_to(root).as_posix(), info.st_size, info.st_mtime_ns]).encode())
            if path.name in {"config.json", "model_index.json", "modular_model_index.json"}:
                digest.update(path.read_bytes())
    return digest.hexdigest()


def checkpoint_storage_bytes(root: Path, float_bytes: int) -> int | None:
    """Read safetensors headers only, before a CPU/FP32 load can exhaust RAM."""
    import math
    widths = {"BOOL": 1, "I8": 1, "U8": 1, "I16": 2, "U16": 2, "I32": 4, "U32": 4, "I64": 8, "U64": 8}
    files = list(root.rglob("*.safetensors")) if root.is_dir() else []
    if not files:
        return None
    total = 0
    for path in files:
        with path.open("rb") as handle:
            prefix = handle.read(8)
            length = int.from_bytes(prefix, "little")
            if len(prefix) != 8 or not 2 <= length <= 16*1024**2:
                raise ValueError(f"Invalid safetensors header: {path.name}")
            header = json.loads(handle.read(length))
        for name, tensor in header.items():
            if name == "__metadata__":
                continue
            dtype, shape = tensor["dtype"], tensor["shape"]
            if any(not isinstance(size, int) or size < 0 for size in shape):
                raise ValueError(f"Invalid tensor shape in {path.name}")
            width = float_bytes if dtype.startswith(("F", "BF")) else widths.get(dtype)
            if width is None:
                return None  # Let the owning loader diagnose an unfamiliar format.
            total += math.prod(shape) * width
    return total


def check_host_capacity(root: Path, *, float_bytes: int = 4) -> None:
    available = host_available()
    weights = checkpoint_storage_bytes(root, float_bytes)
    if available is not None and weights is not None and weights + 3*GIB > available:
        raise ValueError(f"This precision needs approximately {(weights + 3*GIB)/GIB:.1f} GiB of available RAM "
                         f"including working headroom; only {available/GIB:.1f} GiB is available. "
                         "Choose a smaller model or a machine with more RAM.")


def qualified_minimax_options(torch, root: Path, duration: float, prompt_tokens: int,
                              *, profile_path: Path | None = None) -> tuple[dict, str]:
    """Reuse only a locally auditioned, matching calibration; fail to defaults.

    Profile publication is a separate qualification action, never triggered by
    detecting a wheel or by a successful finite-output check alone.
    """
    import math
    try:
        if platform.system() != "Windows" or not torch.cuda.is_available() or torch.version.hip:
            return {}, ""
        candidate_root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "OpenStudio/ai-candidates"
        path = profile_path or candidate_root / "minimax-int8-qualified.json"
        if not path.is_file():
            return {}, ""
        if path.stat().st_size > 65536:
            raise ValueError("profile is oversized")
        profile = json.loads(path.read_text(encoding="utf-8"))
        if (profile.get("schemaVersion") != 1 or profile.get("state") != "qualified-local"
                or profile.get("modelId") != "minimax-music-3"
                or profile.get("policy") != "minimax-int8-stage-v1"
                or profile.get("audition", {}).get("status") != "accepted"):
            raise ValueError("profile has no matching local qualification")
        if Path(sys.executable).resolve().parent.parent.name != profile["environment"]:
            raise ValueError("worker is not using the staged runtime")
        if profile["scriptVersion"] != worker_version(Path(__file__).with_name("stable_audio3_generate.py")):
            raise ValueError("worker implementation changed")
        if profile.get("allocatorConfig") != allocator_environment():
            raise ValueError("allocator configuration changed")
        expected = profile["packages"]
        required = {"torch", "diffusers", "transformers", "accelerate", "bitsandbytes"}
        if set(expected) != required or expected["bitsandbytes"] != "0.50.2":
            raise ValueError("profile has an incomplete package contract")
        if any(metadata.version(name) != version for name, version in expected.items()):
            raise ValueError("runtime packages changed")
        if model_storage_identity(root) != profile["modelStorageIdentity"]:
            raise ValueError("model snapshot changed")
        if profile.get("promptMeasurement") != MINIMAX_PROMPT_MEASUREMENT:
            raise ValueError("profile must be requalified with actual tokenizer counts")
        if not math.isfinite(duration) or not 0 < duration <= profile["maxDuration"]:
            raise ValueError(f"requested duration exceeds the locally tested {profile['maxDuration']}-second limit")
        if not 0 <= prompt_tokens <= profile["maxPromptTokens"]:
            raise ValueError(f"request has {prompt_tokens} input tokens; the locally tested limit is {profile['maxPromptTokens']}")
        selected = select_device(torch)
        if selected.family != "cuda":
            raise ValueError("selected device is not NVIDIA CUDA")
        uuid = cuda_uuid(torch.cuda.get_device_properties(selected.device).uuid)
        device = next((item for item in nvidia_link_snapshot().get("devices", []) if cuda_uuid(item["uuid"]) == uuid), {})
        if uuid != cuda_uuid(profile["hardware"]["uuid"]) or device.get("driver_version") != profile["hardware"]["driver"]:
            raise ValueError("physical GPU or driver changed")
        from types import SimpleNamespace
        kv = minimax_kv_bytes(SimpleNamespace(**profile["kvConfig"]), duration=duration,
                              prompt_tokens=prompt_tokens, element_size=2)
        reserve = profile.get("deviceReserveBytes", 3 * GIB)
        if reserve not in {3 * GIB // 2, 2 * GIB, 3 * GIB}:
            raise ValueError("device reserve has no qualified policy")
        required_bytes = profile["stageWeightBytes"] + kv + reserve
        budget = device_budget(torch, selected.device)
        ram = host_available()
        if budget is None:
            raise ValueError("available GPU memory could not be measured")
        if budget < required_bytes:
            raise ValueError(f"this request needs {required_bytes/GIB:.2f} GiB of available GPU memory "
                             f"including reserve; {budget/GIB:.2f} GiB is available. Close unused GPU applications")
        if ram is None or ram < profile["minimumFreeHostBytes"]:
            raise ValueError(f"this request needs {profile['minimumFreeHostBytes']/GIB:.2f} GiB of available system RAM")
        return {"quantization": "int8", "placement": "model-offload", "int8_reserve_bytes": reserve}, "Locally qualified INT8 stage placement."
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError, metadata.PackageNotFoundError) as exc:
        return {}, f"Qualified INT8 is unavailable: {exc}."


def host_available() -> int | None:
    try:
        import psutil
        return int(psutil.virtual_memory().available)
    except (ImportError, OSError, AttributeError):
        return None


def release_idle_weights(idle_seconds: float, available_ram: int | None) -> bool:
    """Only evaluated while a worker is waiting for its next request."""
    return idle_seconds >= 120 or available_ram is None or available_ram < 3 * GIB


def worker_threads(cores: int | None = None, *, cpu: bool = False) -> int:
    # Leave scheduling room for audio, plugins and the main UI, even on CPUs
    # with many logical cores. GPU transfer workers rarely benefit from more.
    cores = max(1, cores or os.cpu_count() or 1)
    return max(1, min(8 if cpu else 4, cores // 2))


def accelerator_api(torch, device: str):
    return getattr(torch, device.split(":")[0], None)


def physical_cuda_free(torch, device) -> int | None:
    """WDDM's CUDA heap budget can exceed physically free VRAM.

    Match UUID when available (CUDA_VISIBLE_DEVICES can reorder indices), or a
    unique device name. Never attribute another GPU's capacity to this device.
    This runs only at request/setup boundaries, not during inference callbacks.
    """
    if platform.system() != "Windows" or getattr(getattr(torch, "version", None), "hip", None):
        return None
    try:
        props = torch.cuda.get_device_properties(device)
        result = subprocess.run(["nvidia-smi", "--query-gpu=uuid,name,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        rows = [[cell.strip() for cell in row] for row in csv.reader(result.stdout.splitlines())]
        uuid = cuda_uuid(getattr(props, "uuid", ""))
        matches = [row for row in rows if len(row) == 3 and cuda_uuid(row[0]) == uuid] if uuid else []
        if not matches:
            matches = [row for row in rows if len(row) == 3 and row[1] == props.name]
        if len(matches) == 1:
            return int(matches[0][2]) * 1024**2
    except (AttributeError, ValueError, OSError, subprocess.SubprocessError):
        pass
    return None


def device_budget(torch, device: str, *, include_allocated: bool = False) -> int | None:
    """Free + reusable cache; live allocations are not generally reusable.

    A full session rebuild can reclaim its own allocated tensors, which callers
    must explicitly request. Shared-memory devices use the host budget once.
    """
    kind = device.split(":")[0]
    api = accelerator_api(torch, device)
    if kind in {"cpu", "mps"}:
        return host_available()
    try:
        free, total = map(int, api.mem_get_info(device))
        properties = getattr(api, "get_device_properties", None)
        if callable(properties):
            total = min(total, int(getattr(properties(device), "total_memory", total)))
        if kind == "cuda":
            physical = physical_cuda_free(torch, device)
            if physical is not None:
                free = min(free, physical)
        allocated = int(api.memory_allocated(device))
        cached = int(api.memory_reserved(device))
        if not include_allocated:
            cached -= allocated
        limit = total
        fraction = getattr(api, "get_per_process_memory_fraction", None)
        if callable(fraction):
            limit = max(0, int(total * fraction(device)) - (0 if include_allocated else allocated))
        # Windows can back CUDA reservations with shared host memory. That
        # virtual reservation must never increase the physical device budget.
        return min(limit, free + max(0, cached))
    except (AttributeError, RuntimeError, TypeError, OSError):
        return None


@dataclass(frozen=True)
class Device:
    device: str
    family: str
    name: str
    free_bytes: int | None = None
    total_bytes: int | None = None
    unified_memory: bool = False


def enumerate_devices(torch) -> list[Device]:
    devices = []
    for kind in ("cuda", "xpu"):
        api = getattr(torch, kind, None)
        if api is None or not api.is_available():
            continue
        family = "rocm" if kind == "cuda" and getattr(torch.version, "hip", None) else kind
        for index in range(api.device_count()):
            name, free, total = f"{kind}:{index}", None, None
            try:
                free, total = map(int, api.mem_get_info(index))
                name = api.get_device_name(index)
                if kind == "cuda":
                    physical = physical_cuda_free(torch, index)
                    if physical is not None:
                        free = min(free, physical)
            except (AttributeError, RuntimeError, OSError):
                pass
            devices.append(Device(f"{kind}:{index}", family, name, free, total))
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    if mps is not None and mps.is_available():
        devices.append(Device("mps", "mps", "Apple Metal", host_available(), unified_memory=True))
    devices.append(Device("cpu", "cpu", platform.processor() or platform.machine(), host_available()))
    return devices


def select_device(torch, requested: str | None = None) -> Device:
    devices = enumerate_devices(torch)
    if requested is not None:
        for candidate in devices:
            if candidate.device == requested:
                return candidate
        raise ValueError(f"Requested device {requested} is unavailable in this runtime.")
    accelerated = [item for item in devices if item.family != "cpu"]
    # Capacity-based first selection, not a claim that the biggest device is
    # fastest. The benchmark accepts an explicit device for calibration.
    return max(accelerated, key=lambda item: item.free_bytes or 0) if accelerated else devices[-1]


def activate_device(torch, selected: Device) -> None:
    kind = selected.device.split(":")[0]
    if kind in {"cuda", "xpu"}:
        accelerator_api(torch, selected.device).set_device(selected.device)
    torch.set_num_threads(worker_threads(cpu=kind == "cpu"))


def runtime_capabilities(torch) -> dict[str, Any]:
    packages = {}
    for package in ("diffusers", "transformers", "accelerate", "audio-separator"):
        try:
            packages[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            packages[package] = None
    return {"policyVersion": POLICY_VERSION, "os": platform.system(),
            "architecture": platform.machine(), "torch": str(torch.__version__),
            "cuda": getattr(torch.version, "cuda", None), "hip": getattr(torch.version, "hip", None),
            "availableRamBytes": host_available(), "devices": [asdict(x) for x in enumerate_devices(torch)],
            "packages": packages, "cpuThreads": worker_threads(cpu=True),
            "gpuWorkerThreads": worker_threads(),
            "qualification": "availability_only"}


def model_execution_capabilities(model: str, family: str) -> dict:
    """Adapter coverage is distinct from measured hardware qualification."""
    modes = ["resident"]
    excluded = {"disk-offload": "No qualified disk storage/cleanup adapter for this model.",
                "multi-gpu-sharding": "Single-adapter selection is implemented; distributed execution is unqualified."}
    if model == "minimax-music-3":
        if family in {"cuda", "rocm"}:
            modes += ["model-offload", "group-offload", "partial-resident", "partial-resident-disk"]
            excluded["disk-offload"] = "Bounded disk-backed partial placement is experimental; full-model RAM qualification is incomplete."
        excluded["sequential-offload"] = "Direct embedding/head calls require the model-specific placement owner."
    elif model in {"stable-audio-3-medium", "ace-step-v15-xl-turbo"}:
        if family in {"cuda", "rocm", "xpu"}:
            modes += ["model-offload"]
            if model == "ace-step-v15-xl-turbo":
                modes += ["group-offload"]
        excluded["sequential-offload"] = "Prior warm-output/meta-tensor qualification failed."
        if model == "stable-audio-3-medium":
            excluded["group-offload"] = "Only resident/component placement has valid workflow qualification."
    elif model == "bs-roformer":
        modes = ["resident-model-with-cpu-chunk-storage"]
        excluded["diffusers-offload"] = "audio-separator is a separate engine; Diffusers hooks are inapplicable."
        excluded["batch-size-tuning"] = "The pinned Roformer loop ignores batch_size."
    else:
        raise ValueError(f"Unknown execution adapter: {model}")
    return {"model": model, "family": family, "implementedPlacementModes": modes,
            "excluded": excluded, "qualification": "adapter_coverage_only",
            "experimentalPlacementModes": ["partial-resident", "partial-resident-disk"]
                if model == "minimax-music-3" and family in {"cuda", "rocm"} else []}


def nvidia_link_snapshot() -> dict:
    """Diagnostic link readings, never interpreted as a measured bandwidth."""
    fields = ["uuid", "name", "driver_version", "pcie.link.gen.gpucurrent", "pcie.link.gen.gpumax",
              "pcie.link.gen.hostmax", "pcie.link.width.current", "memory.used", "utilization.gpu"]
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=" + ",".join(fields),
            "--format=csv,noheader,nounits"], capture_output=True, text=True, check=True, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return {"state": "diagnostic_only", "devices": [dict(zip(fields, map(str.strip, row)))
                for row in csv.reader(result.stdout.splitlines()) if len(row) == len(fields)]}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"state": "unavailable", "reason": str(exc)}


def probe_transfer_bandwidth(torch, device: str) -> dict:
    """Bounded pinned-memory probe: 128 MiB, three samples per direction."""
    if not device.startswith("cuda"):
        return {"state": "unavailable", "reason": "This diagnostic uses CUDA/HIP events and pinned memory."}
    import statistics
    size = 128 * 1024**2
    host = torch.empty(size, dtype=torch.uint8, pin_memory=True)
    target = torch.empty(size, dtype=torch.uint8, device=device)
    host.zero_()
    target.copy_(host, non_blocking=True)
    torch.cuda.synchronize(device)
    result = {"state": "diagnostic_only", "bytesPerCopy": size}
    for name, destination, source in (("hostToDevice", target, host), ("deviceToHost", host, target)):
        samples = []
        for _ in range(3):
            start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            start.record()
            destination.copy_(source, non_blocking=True)
            end.record()
            end.synchronize()
            samples.append(size / (start.elapsed_time(end) / 1000) / 1e9)
        result[name] = {"GBps": samples, "medianGBps": statistics.median(samples)}
    result["linkUnderLoad"] = nvidia_link_snapshot()
    return result


def generator_device(device: str) -> str:
    return "cpu" if device.split(":")[0] in {"mps", "cpu"} else device


@dataclass(frozen=True)
class ResidencyPlan:
    resident_blocks: int
    resident_bytes: int
    transient_bytes: int
    reserve_bytes: int
    kv_bytes: int
    use_stream: bool
    reason: str


def plan_residency(*, budget: int | None, block_bytes: list[int], fixed_bytes: int,
                   peer_bytes: int, kv_bytes: int, available_ram: int | None) -> ResidencyPlan:
    """Retain a prefix of blocks; two staging blocks leave room for prefetch.

    The host reserve includes the DAW. All stages retain one authoritative CPU
    weight copy, preserving checkpoint-backed storage without repeated D2H.
    """
    reserve = 3 * GIB
    transient = 2 * max(block_bytes, default=0)
    remaining = (budget or 0) - reserve - kv_bytes - fixed_bytes - peer_bytes - transient
    count, resident = 0, 0
    for size in block_bytes:
        if size > remaining:
            break
        remaining -= size
        resident += size
        count += 1
    offloaded = sum(block_bytes[count:])
    # Prefetch owns two reusable pinned blocks; never pre-pin a full LM copy.
    stream = bool(offloaded and available_ram is not None and available_ram > transient + reserve)
    return ResidencyPlan(count, resident + fixed_bytes, transient, reserve, kv_bytes, stream,
                         "fits" if remaining >= 0 else "insufficient_stage_budget")


def minimax_kv_bytes(config, *, duration: float, prompt_tokens: int, element_size: int) -> int:
    # Conditional/unconditional batch=2; K and V; prefill plus audio feedback.
    frames = min(9000, max(1, int(duration * 25)))
    return (2 * 2 * int(config.num_hidden_layers) * int(config.num_key_value_heads)
            * int(config.head_dim) * (prompt_tokens + frames + 2) * element_size)


def prompt_token_bound(prompt: str, lyrics: str) -> int:
    # Qwen's byte-level BPE cannot have more ordinary tokens than UTF-8 bytes.
    # Include structural token overhead; the upstream encoder caps at 5000.
    return min(5000, len(prompt.encode("utf-8")) + len(lyrics.encode("utf-8")) + 128)


def minimax_prompt_tokens(root: Path, prompt: str, lyrics: str, *, tokenizer=None) -> int:
    """Run the pinned model's real text-only step on CPU before loading weights.

    Reuse its formatting, special tokens and maximum-length validation instead
    of equating UTF-8 bytes with tokens. The same normalized lyrics are passed
    to generation; this does not shorten or otherwise change the model input.
    """
    from types import SimpleNamespace
    from transformers import Qwen2Tokenizer
    from diffusers.modular_pipelines.modular_pipeline import PipelineState
    from diffusers.modular_pipelines.minimax_music3.encoders import MiniMaxMusic3TokenizeStep
    from diffusers_audio_pipeline import normalize_song_lyrics
    if tokenizer is None:
        tokenizer = Qwen2Tokenizer.from_pretrained(str(root / "tokenizer"), local_files_only=True)
    state = PipelineState(values={"prompt": prompt, "lyrics": normalize_song_lyrics(lyrics)})
    MiniMaxMusic3TokenizeStep()(SimpleNamespace(tokenizer=tokenizer, _execution_device="cpu"), state)
    return int(state.get("text_ids").shape[1])


def optimization_candidates() -> dict:
    result = {"nf4": {"state": "excluded", "reason": "Prior MiniMax artifact failed user audition."}}
    for name, package in (("int8", "bitsandbytes"), ("torchao-int8", "torchao"), ("compile", "triton")):
        try:
            version = metadata.version(package)
            result[name] = {"state": "available-but-unqualified", "version": version,
                            "reason": "Requires component, hardware and audio qualification."}
        except metadata.PackageNotFoundError:
            result[name] = {"state": "unavailable", "reason": f"{package} is not installed in this runtime."}
            if name == "compile" and platform.system() == "Windows":
                try:
                    result[name] = {"state": "available-but-unqualified", "version": metadata.version("triton-windows"),
                                    "reason": "Windows Triton distribution; actual compilation still requires validation."}
                except metadata.PackageNotFoundError:
                    pass
    return result


def quantization_kwargs(mode: str, *, modular: bool) -> dict:
    """Explicit candidate configs; automatic use requires local qualification."""
    if mode == "none":
        return {}
    candidates = optimization_candidates()
    if mode not in {"int8", "torchao-int8"} or candidates[mode]["state"] != "available-but-unqualified":
        raise ValueError(candidates.get(mode, {"reason": "Unknown quantization mode."})["reason"])
    component = "language_model" if modular else "transformer"
    if mode == "int8":
        if modular:
            from transformers import BitsAndBytesConfig
        else:
            from diffusers import BitsAndBytesConfig
        config = BitsAndBytesConfig(load_in_8bit=True)
    else:
        if modular:
            from transformers import TorchAoConfig
        else:
            from diffusers import TorchAoConfig
        from torchao.quantization import Int8WeightOnlyConfig
        config = TorchAoConfig(Int8WeightOnlyConfig())
    if modular:
        return {"quantization_config": {component: config}}
    from diffusers import PipelineQuantizationConfig
    return {"quantization_config": PipelineQuantizationConfig(quant_mapping={component: config})}


def probe_int8(torch, device: str) -> dict:
    """Validate the actual optional operator and device moves, not package metadata."""
    import bitsandbytes as bnb
    torch.manual_seed(123)
    reference = torch.nn.Linear(128, 64, bias=False).half().eval()
    layer = bnb.nn.Linear8bitLt(128, 64, bias=False, has_fp16_weights=False).eval()
    layer.weight = bnb.nn.Int8Params(reference.weight.detach().clone(), requires_grad=False,
                                    has_fp16_weights=False)
    from ai_partial_offload import move_int8_module
    nested = torch.nn.Sequential(layer)
    move_int8_module(nested, device)
    # Offload before the first forward, as the real quantizing loader does.
    # BNB stores its scale/weight state on the Parameter until first inference.
    move_int8_module(nested, "cpu")
    if layer.weight.CB.device.type != "cpu" or layer.weight.SCB.device.type != "cpu":
        raise ValueError("INT8 pre-forward offload retained GPU metadata.")
    if layer.weight.CB.data_ptr() != layer.weight.data_ptr():
        raise ValueError("INT8 pre-forward offload duplicated weights.")
    move_int8_module(nested, device)
    cases = []
    with torch.inference_mode():
        for length in (1, 32):
            source = torch.randn(length, 128, device=device, dtype=torch.float16)
            expected = torch.nn.functional.linear(source, reference.weight.to(device))
            actual = layer(source)
            relative_error = float((actual.float()-expected.float()).norm() / expected.float().norm())
            if not bool(torch.isfinite(actual).all()) or relative_error > .03:
                raise ValueError(f"INT8 operator numerical check failed: relative error {relative_error}.")
            for _ in range(3):
                move_int8_module(nested, "cpu")
                for child in nested.modules():
                    if isinstance(child, bnb.nn.Linear8bitLt):
                        if child.state.CB.device.type != "cpu" or child.state.SCB.device.type != "cpu":
                            raise ValueError("INT8 offload retained GPU state.")
                        if child.state.CB.data_ptr() != child.weight.data_ptr():
                            raise ValueError("INT8 offload duplicated the weight storage.")
                move_int8_module(nested, device)
            moved = layer(source)
            torch.testing.assert_close(moved, actual, atol=.001, rtol=.001)
            cases.append({"rows": length, "relativeL2Error": relative_error, "deviceMoveParity": "pass"})
    return {"state": "pass", "qualification": "operator_only", "cases": cases,
            "audioQuality": "not_asserted", "package": bnb.__version__}


def compile_components(components: dict, device: str) -> dict:
    """Explicit harness qualification; never a blanket Dynamo switch."""
    if device.startswith("cuda") and optimization_candidates()["compile"]["state"] == "unavailable":
        raise ValueError("CUDA compilation requires a working, qualified Triton runtime.")
    compiled = []
    for name, model in components.items():
        if callable(getattr(model, "compile_repeated_blocks", None)) and getattr(model, "_repeated_blocks", None):
            model.compile_repeated_blocks(fullgraph=True)
            compiled.append(name)
    if not compiled:
        raise ValueError("This pipeline exposes no supported repeated-block compilation targets.")
    return {"targets": compiled, "state": "pending_first_forward", "audioQuality": "not_asserted"}


def probe_compile(torch, device: str) -> dict:
    """Require an actual compiled region, not merely a successful wrapper call."""
    import time
    def operation(left, right):
        return torch.nn.functional.silu(left @ right)
    compiled = torch.compile(operation, fullgraph=True)
    api = accelerator_api(torch, device)
    def synchronize():
        if device.split(":")[0] in {"cuda", "xpu"}:
            api.synchronize()
    cases = []
    with torch.inference_mode():
        for rows in (1, 32):
            left = torch.randn(rows, 128, device=device)
            right = torch.randn(128, 64, device=device)
            synchronize()
            started = time.perf_counter()
            actual = compiled(left, right)
            synchronize()
            cold = time.perf_counter() - started
            torch.testing.assert_close(actual, operation(left, right), atol=1e-4, rtol=1e-4)
            with torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU]) as trace:
                compiled(left, right)
                synchronize()
            regions = [event.key for event in trace.key_averages() if "Torch-Compiled Region" in event.key]
            if not regions:
                raise ValueError("No Torch-Compiled Region was observed; compilation may be disabled.")
            cases.append({"rows": rows, "coldSeconds": cold, "observedRegions": regions, "parity": "pass"})
    return {"state": "pass", "qualification": "operator_only", "cases": cases, "audioQuality": "not_asserted"}
