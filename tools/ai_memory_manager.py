"""Shared automatic memory policy; adapters own model-specific placement hooks.

Planning never changes precision, model, duration or creative controls. Byte
estimates are admission heuristics, not measured peaks or hardware qualification.
"""
from dataclasses import dataclass
from typing import Any

GIB = 1024 ** 3


def minimax_load_backing(weights: int | None, largest: int, available_ram: int | None) -> str:
    """Avoid overlapping all CPU weights and a component's conversion peak."""
    return ("disk" if weights is not None and (available_ram is None
            or available_ram < weights + largest + 3 * GIB) else "host-memory")


def component_load_on_device(weights: int | None, available_ram: int | None,
                             free_vram: int | None) -> bool:
    """A whole component may load on-device before being archived to disk."""
    return bool(weights is not None and available_ram is not None
        and available_ram < 2 * weights + 3 * GIB
        and free_vram is not None and free_vram >= weights + 3 * GIB)


@dataclass(frozen=True)
class MiniMaxMemoryPlan:
    mode: str
    use_stream: bool = False
    low_cpu_mem_usage: bool = False
    resident_required_bytes: int | None = None
    stage_required_bytes: int | None = None
    staging_bytes: int = 0
    reason: str = "legacy conservative estimate"
    group_required_bytes: int | None = None


def plan_minimax_memory(*, free_vram: int | None, available_ram: int | None,
                       weights_bytes: int, language_model_bytes: int,
                       bf16: bool, stage_bytes: dict[str, int] | None = None,
                       kv_bytes: int = 0, largest_group_bytes: int = 0) -> MiniMaxMemoryPlan:
    """Conservative placement estimates, not a guarantee against request-time OOM.

    HF documents ~23 GB resident / ~22 GB component offload in BF16.
    Keep 3 GiB beyond those estimates for the DAW, activations and KV growth.
    FP32 needs larger budgets; unknown memory retains the previous safe path.
    """
    scale = 1 if bf16 else 2
    reserve = 3 * GIB
    if stage_bytes:
        # These are already-loaded weight footprints. available_ram is current
        # free RAM, so do not charge the CPU weights a second time when deciding
        # whether prefetch can allocate pinned transfer copies.
        resident = weights_bytes + kv_bytes + reserve
        language_stage = language_model_bytes + stage_bytes.get("rvq_depth_decoder", 0) + kv_bytes
        later_stage = max((size for name, size in stage_bytes.items()
                           if name not in {"language_model", "rvq_depth_decoder"}), default=0)
        stage = max(language_stage, later_stage) + reserve
        if free_vram is not None and free_vram >= resident:
            return MiniMaxMemoryPlan("resident", resident_required_bytes=resident,
                stage_required_bytes=stage, reason="all loaded weights, request KV and headroom fit")
        if free_vram is not None and free_vram >= stage:
            return MiniMaxMemoryPlan("model-offload", resident_required_bytes=resident,
                stage_required_bytes=stage, reason="largest simultaneous stage, request KV and headroom fit")
        staging = 2 * largest_group_bytes
        group_required = max(later_stage, largest_group_bytes + stage_bytes.get("rvq_depth_decoder", 0) + kv_bytes) + reserve
        stream = bool(largest_group_bytes and free_vram is not None and free_vram >= group_required
                      and available_ram is not None and available_ram >= staging + reserve)
        full_pin = stream and available_ram >= language_model_bytes + staging + reserve
        return MiniMaxMemoryPlan("group-offload", stream, stream and not full_pin,
            resident, stage, staging if stream else 0,
            "group placement selected from measured stage weights and bounded prefetch headroom", group_required)
    if free_vram is not None:
        if free_vram >= max(weights_bytes, 23 * scale * GIB) + reserve:
            return MiniMaxMemoryPlan("resident")
        if free_vram >= 22 * scale * GIB + reserve:
            return MiniMaxMemoryPlan("model-offload")
    # Prefetch needs both GPU headroom and host memory. Only pre-pin the full
    # LM when another LM-sized allocation plus DAW headroom fits in free RAM.
    stream = (free_vram is not None and free_vram >= 8 * scale * GIB
              and available_ram is not None and available_ram >= 3 * GIB)
    low_ram = stream and available_ram < language_model_bytes + reserve
    return MiniMaxMemoryPlan("group-offload", stream, low_ram)


def available_host_memory() -> int | None:
    from ai_system_memory import available_memory
    return available_memory()


def module_weight_bytes(modules: Any) -> int:
    """Count parameters/buffers once without making state-dict tensor copies."""
    seen: set[int] = set()
    total = 0
    for module in modules:
        if not hasattr(module, "parameters"):
            continue
        for tensors in (module.parameters(), module.buffers()):
            for tensor in tensors:
                if id(tensor) not in seen:
                    seen.add(id(tensor))
                    total += tensor.numel() * tensor.element_size()
    return total


def module_storage_bytes(modules: Any) -> dict[str, int]:
    """Observed storage, including known packed-weight metadata and aliases.

    Kept separate from logical load estimates: moving distinct views can create
    independent destination allocations. This census is not an activation peak.
    """
    seen = set()
    visited = set()
    total = 0
    fallback = 0

    def visit(value):
        nonlocal total, fallback
        if value is None or id(value) in visited:
            return
        visited.add(id(value))
        if hasattr(value, "numel") and hasattr(value, "element_size"):
            try:
                storage = value.untyped_storage()
                size = storage.nbytes()
                pointer = storage.data_ptr()
                if pointer == 0 and size:
                    raise ValueError("virtual/meta storage")
                key = (str(value.device), pointer, size)
            except (AttributeError, RuntimeError, TypeError, ValueError):
                size = value.numel() * value.element_size()
                key = ("logical", id(value))
                fallback += size
            if key not in seen:
                seen.add(key)
                total += size
        # bitsandbytes packed weights keep scales/codebooks outside registered
        # buffers. Follow only documented state fields, never arbitrary graphs.
        for name in ("quant_state", "SCB", "CB", "absmax", "code", "offset", "state2"):
            visit(getattr(value, name, None))

    for module in modules:
        if not hasattr(module, "parameters"):
            continue
        for tensors in (module.parameters(), module.buffers()):
            for tensor in tensors:
                visit(tensor)
        state = getattr(module, "state", None)
        for name in ("SCB", "CB"):
            visit(getattr(state, name, None))
    return {"storageBytes": total, "logicalFallbackBytes": fallback}


def plan_audio_memory(free_vram: int | None, weights: int, largest: int,
                      duration: float = 30, conservative: bool = False,
                      allow_group: bool = True, reserve_bytes: int | None = None) -> str:
    """Reserve grows with duration; measured OOM retries choose layer offload."""
    if conservative:
        return "group-offload" if allow_group else "model-offload"
    reserve = int((3 + max(0, duration - 30) / 60) * GIB) if reserve_bytes is None else reserve_bytes
    if free_vram is not None and free_vram >= weights + reserve:
        return "resident"
    if free_vram is None or free_vram >= largest + reserve:
        return "model-offload"
    return "group-offload" if allow_group else "model-offload"


@dataclass(frozen=True)
class StemMemoryPlan:
    backend: str
    chunk_duration: int
    reason: str
    estimated_host_bytes: int | None
    estimated_gpu_bytes: int | None
    memory_mode: str = "whole"


def plan_stem_memory(*, backend: str, duration: float | None, sample_rate: int,
                     channels: int, model_bytes: int, available_ram: int | None,
                     free_vram: int | None, requested_sections: int = 0,
                     precision: str = "default", allow_streaming: bool = False,
                     qualified_rocm_fast: bool = False) -> StemMemoryPlan:
    # RoFormer keeps its six output accumulators on the CPU. Sections bound
    # those arrays, not GPU weights; the dependency still decodes the source.
    # Include float64 mix/output temporaries, checkpoint loading overlap and
    # a reserve for the DAW. Keep estimates explicit in diagnostics.
    audio_bytes = int(max(0, duration or 0) * sample_rate * max(2, channels) * 8)
    estimate = 12 * audio_bytes + 2 * model_bytes + 2 * GIB if duration is not None else None
    sections = requested_sections
    memory_mode = "sections" if sections else "whole"
    reasons = []
    # The current ROCm adapter uses FP32 and its measured SDPA path needs a
    # larger activation budget than NVIDIA autocast. Weight size alone cannot
    # predict this peak. Keep a separate reserve until that adapter changes.
    gpu_reserve = (7 if backend == "rocm" and not qualified_rocm_fast or precision == "fp32" else 2) * GIB
    gpu_estimate = model_bytes + gpu_reserve if backend in {"cuda", "rocm"} else None
    if not sections and (duration is None or (duration > 30 and (available_ram is None or estimate > available_ram))):
        if allow_streaming:
            memory_mode = "streaming"
            reasons.append("rolling output buffers and temporary disk selected for the host-memory budget")
        else:
            sections = 30
            memory_mode = "sections"
            reasons.append("30-second CPU output sections selected for the host-memory budget")
    if gpu_estimate is not None and free_vram is not None and free_vram < gpu_estimate:
        backend = "cpu"
        reasons.append("GPU free-memory budget cannot hold resident RoFormer weights and activation reserve; using CPU")
    if not reasons:
        reasons.append("resident model fits the observed budget" if free_vram is not None else "resident model; GPU memory budget unavailable")
    return StemMemoryPlan(backend, sections, "; ".join(reasons), estimate, gpu_estimate, memory_mode)


def model_execution_receipt(torch, model, device) -> dict[str, Any]:
    """Observe actual tensors and allocator activity, never infer from a label."""
    devices = {}
    if model is not None and hasattr(model, "parameters"):
        for tensor in model.parameters():
            key = str(tensor.device)
            devices[key] = devices.get(key, 0) + tensor.numel() * tensor.element_size()
    receipt = {"parameterBytesByDevice": devices}
    if str(device).split(":")[0] == "cuda":
        torch.cuda.synchronize(device)
        receipt.update(cudaAllocatedBytes=int(torch.cuda.memory_allocated(device)),
                       cudaPeakAllocatedBytes=int(torch.cuda.max_memory_allocated(device)),
                       cudaDeviceName=torch.cuda.get_device_name(device),
                       torchCudaVersion=torch.version.cuda, torchHipVersion=torch.version.hip)
    return receipt
