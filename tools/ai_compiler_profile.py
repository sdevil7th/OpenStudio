"""Reviewed optional Stable Audio compilation runtime; standard stays separate."""
import hashlib
from importlib import metadata
import json
from pathlib import Path
import sys

PROFILE = "stable-audio-cuda-compile-v1"
REQUIREMENTS_NAME = "ai-compiler-runtime-requirements-windows.txt"
REQUIREMENTS_SHA256 = "cfc91cff0477fdf68d3763c7f60643972f1436a4ee80babc8ccc3d5839cb4293"
BOOTSTRAP = {
    "url":"https://github.com/sdevil7th/OpenStudio/releases/download/ai-runtime-v0.0.16/OpenStudio-AI-Runtime-windows-base-x64.zip",
    "filename":"OpenStudio-AI-Runtime-windows-base-x64.zip",
    "sha256":"7cac2d40a25bf620664502e8db578a2f6274b84f234ce09296d524f40d84ecc1",
    "size":45325998,
}
TORCH_PACKAGES = ("torch==2.10.0+cu128", "torchaudio==2.10.0+cu128", "torchvision==0.25.0+cu128")


def requirements_path():
    path = Path(__file__).with_name(REQUIREMENTS_NAME)
    if hashlib.sha256(path.read_text(encoding="utf-8-sig").encode("utf-8")).hexdigest() != REQUIREMENTS_SHA256:
        raise ValueError("Compiler requirements differ from the reviewed recipe")
    return path


def pinned_packages():
    packages = {}
    for line in requirements_path().read_text(encoding="utf-8-sig").splitlines():
        if line and not line.startswith(("#", "https://")):
            name, version = line.split("==")
            packages[name] = version
    return packages


def validate_compiler_device(torch, device):
    if (sys.platform != "win32" or sys.version_info[:2] != (3,11)
            or not str(device).startswith("cuda") or torch.version.hip
            or str(torch.__version__) not in {"2.10.0+cu128","2.11.0+cu128"}
            or torch.cuda.get_device_name(device) != "NVIDIA GeForce RTX 4080"
            or not torch.cuda.is_bf16_supported()):
        raise ValueError("This compilation recipe requires the qualified Windows RTX 4080 CUDA/Python runtime; choose Automatic")
    for name, expected in pinned_packages().items():
        if metadata.version(name) != expected:
            raise ValueError("Compiler runtime package differs from the qualified recipe: "+name)
    audio, vision = (("2.10.0+cu128","0.25.0+cu128") if str(torch.__version__)=="2.10.0+cu128"
                     else ("2.11.0+cu128","0.26.0+cu128"))
    if metadata.version("torchaudio") != audio or metadata.version("torchvision") != vision:
        raise ValueError("Compiler audio/vision packages must match PyTorch; repair optional compiler setup")
    origin = json.loads(metadata.distribution("diffusers").read_text("direct_url.json") or "{}")
    revision = "7643c4826609c47755e3da0e5b768e8070468f49"
    if (origin.get("vcs_info",{}).get("commit_id") != revision
            and not origin.get("url","").endswith("/"+revision+".zip")):
        raise ValueError("Compilation needs the reviewed Diffusers revision; prepare the optional compiler runtime")
    return {"recipe":PROFILE,"state":"qualified_opt_in","precisionChange":False,
        "requirementsSha256":REQUIREMENTS_SHA256,"recipeAudition":"accepted paired November previews",
        "audioQuality":"not_asserted for this output"}
