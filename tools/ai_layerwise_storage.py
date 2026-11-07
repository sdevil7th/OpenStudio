"""Explicit Stable Audio storage-precision experiment, never an automatic policy."""
from ai_memory_manager import module_storage_bytes
from importlib import metadata
import json
import sys


def validate_fp8_device(torch, device):
    if (sys.platform != "win32" or not str(device).startswith("cuda") or torch.version.hip
            or torch.cuda.get_device_name(device) != "NVIDIA GeForce RTX 4080"
            or not torch.cuda.is_bf16_supported()
            or str(torch.__version__) not in {"2.10.0+cu128", "2.11.0+cu128"}):
        raise ValueError("FP8 storage currently requires the qualified Windows RTX 4080 CUDA runtime; choose Automatic in AI Tools Setup")
    origin = json.loads(metadata.distribution("diffusers").read_text("direct_url.json") or "{}")
    revision = "7643c4826609c47755e3da0e5b768e8070468f49"
    if (origin.get("vcs_info",{}).get("commit_id") != revision
            and not origin.get("url", "").endswith("/"+revision+".zip")):
        raise ValueError("FP8 storage needs the reviewed Diffusers runtime; choose Automatic or repair Audio Generation setup")


def configure_fp8_storage(torch, model, device):
    validate_fp8_device(torch, device)
    if model.dtype != torch.bfloat16:
        raise ValueError("FP8 storage qualification requires BF16 computation")
    if (type(model).__name__ != "StableAudio3DiTModel"
            or type(model).__module__ != "diffusers.models.transformers.transformer_stable_audio3"):
        raise ValueError("FP8 storage has no audited adapter for this model")
    if getattr(model, "_openstudio_fp8_storage", None):
        raise ValueError("FP8 storage needs a fresh model; do not stack precision owners")
    for child in model.modules():
        hooks = getattr(getattr(child,"_diffusers_hook",None),"hooks",{})
        if hasattr(child,"_hf_hook") or hooks:
            raise ValueError("FP8 storage requires fresh components without placement hooks")
    from diffusers.hooks.layerwise_casting import DEFAULT_SKIP_MODULES_PATTERN
    # Keep condition/timestep, normalization and audio boundary projections at
    # their loaded precision; evaluate the repeated attention/FF weights only.
    skipped = tuple(DEFAULT_SKIP_MODULES_PATTERN) + ("norm", "proj_in", "proj_out", "to_local_embed",
        "to_timestep_embed", "to_cond_embed", "to_global_embed", "global_cond_embedder",
        "preprocess_conv", "postprocess_conv")
    before = module_storage_bytes([model])["storageBytes"]
    model.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn,
        compute_dtype=torch.bfloat16, skip_modules_pattern=skipped, non_blocking=False)
    after = module_storage_bytes([model])["storageBytes"]
    census = {}
    for parameter in model.parameters():
        key = str(parameter.dtype)
        census[key] = census.get(key,0)+parameter.numel()*parameter.element_size()
    if "torch.float8_e4m3fn" not in census or after >= before or model.dtype != torch.bfloat16:
        raise ValueError("FP8 storage did not reduce observed storage while retaining BF16 pipeline inputs")
    result = {"state":"qualified_opt_in", "recipe":"stable-audio-fp8-storage-v1",
        "computeDtype":"bfloat16", "storageDtype":"float8_e4m3fn", "skipPatterns":list(skipped),
        "storageBeforeBytes":before,"storageAfterBytes":after,"parameterBytesByDtype":census,
        "recipeAudition":"accepted reference preview; see November qualification",
        "audioQuality":"not_asserted for this output","checkpointMutation":False}
    model._openstudio_fp8_storage = result
    return result


def verify_fp8_storage(model, details):
    """Check that source-pipeline swaps and forwards retained the storage owner."""
    census = {}
    for parameter in model.parameters():
        key = str(parameter.dtype)
        census[key] = census.get(key, 0) + parameter.numel()*parameter.element_size()
    expected = details["parameterBytesByDtype"].get("torch.float8_e4m3fn", 0)
    if not expected or census.get("torch.float8_e4m3fn", 0) != expected:
        raise RuntimeError("FP8 storage was not restored after inference; unload before retrying")
    details["afterForwardParameterBytesByDtype"] = census
