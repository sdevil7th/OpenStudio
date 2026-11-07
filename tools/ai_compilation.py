"""Process-owned compilation storage and explicit generation options.

Compilation remains opt-in. Each worker starts with a private cache, so a model,
driver, runtime or request policy cannot accidentally reuse another session's
qualification. Warm requests reuse that worker's compiled regions.
"""
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
from contextlib import contextmanager

from ai_memory_manager import GIB

OPTIONS = ("standard", "compile", "torchao-int8", "disk-offload", "fp8-storage", "rocm-fast-startup")


def validate_optimization(value, model, variant="original"):
    if value not in OPTIONS:
        raise ValueError("Unknown generation optimization")
    if value != "standard" and variant == "int8":
        raise ValueError("Additional optimizations require Original; saved INT8 keeps its existing placement")
    if value != "standard" and model == "minimax-music-3":
        raise ValueError("These additional MiniMax optimizations are not yet qualified")
    if value == "torchao-int8":
        raise ValueError("TorchAO INT8 is excluded: the Stable Audio preview failed user audition; other models are not qualified")
    if value == "disk-offload" and model != "ace-step-v15-xl-turbo":
        raise ValueError("Disk group offload is currently supported only for ACE-Step")
    if value == "fp8-storage" and model != "stable-audio-3-medium":
        raise ValueError("FP8 storage has no qualified recipe for this model")
    if value == "rocm-fast-startup" and model != "ace-step-v15-xl-turbo":
        raise ValueError("Faster AMD startup is currently qualified only for ACE-Step Original")
    return value


def _remove(directory, root):
    if directory.is_symlink() or directory.resolve().parent != root.resolve():
        raise ValueError("Compile cleanup escaped its owned root")
    paths = list(directory.rglob("*"))
    if any(path.is_symlink() or not path.resolve().is_relative_to(directory.resolve()) for path in paths):
        raise ValueError("Compile cache contains a symlink")
    for path in sorted(paths, key=lambda p:len(p.parts), reverse=True):
        if path == directory/".owner.json":
            continue
        path.rmdir() if path.is_dir() else path.unlink()
    (directory/".owner.json").unlink()
    directory.rmdir()


class CompilationWorkspace:
    def __init__(self, root=None, *, quota_bytes=8*GIB, reservation_bytes=2*GIB):
        import psutil
        from filelock import FileLock
        from ai_disk_store import cache_root
        self.root = Path(root or cache_root()/"compilation").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.directory = None
        self.deferred = False
        self.reservation = reservation_bytes
        with FileLock(str(self.root/"quota.lock")):
            occupied = 0
            for directory in self.root.glob("compile-*"):
                if directory.is_symlink() or not re.fullmatch("compile-[a-f0-9]{32}", directory.name):
                    continue
                try:
                    owner = json.loads((directory/".owner.json").read_text())
                    if owner.get("kind") != "openstudio-compile-v1":
                        continue
                    try:
                        live = abs(psutil.Process(owner["pid"]).create_time()-owner["birth"]) < .01
                    except psutil.NoSuchProcess:
                        live = False
                    if not live:
                        _remove(directory, self.root)
                    else:
                        occupied += max(int(owner["reservation"]), sum(p.stat().st_size for p in directory.rglob("*") if p.is_file()))
                except (OSError, ValueError, KeyError, TypeError, psutil.AccessDenied):
                    # Unknown entries neither authorize deletion nor permit a
                    # new cache to overbook an unmeasurable reservation.
                    occupied += quota_bytes
            if (reservation_bytes <= 0 or occupied+reservation_bytes > quota_bytes
                    or shutil.disk_usage(self.root).free < reservation_bytes+3*GIB):
                raise RuntimeError("Insufficient compilation cache quota or disk headroom")
            self.directory = self.root/("compile-"+uuid.uuid4().hex)
            self.directory.mkdir()
            (self.directory/".owner.json").write_text(json.dumps({"kind":"openstudio-compile-v1",
                "pid":os.getpid(),"birth":psutil.Process().create_time(),"reservation":reservation_bytes}))
        os.environ["TORCHINDUCTOR_CACHE_DIR"] = str(self.directory/"inductor")
        os.environ["TRITON_CACHE_DIR"] = str(self.directory/"triton")
        os.environ["OPENSTUDIO_COMPILE_WORKSPACE"] = str(self.directory)

    def check(self):
        size = sum(p.stat().st_size for p in self.directory.rglob("*") if p.is_file())
        if size > self.reservation:
            raise RuntimeError("Compilation cache exceeded its worker reservation; unload this worker")
        return size

    def close(self):
        if self.deferred:
            return False
        if self.directory is not None:
            try:
                _remove(self.directory, self.root)
            except PermissionError:
                # Windows keeps imported compiler extension DLLs mapped until
                # process exit. Keep the marker; the next worker reclaims only
                # after this PID/birth pair has retired.
                self.deferred = True
                return False
            self.directory = None
        return True


def prepare_worker_optimization(value, model=None):
    if value == "compile":
        # Run before importing Torch/Diffusers. Changing a warm worker's
        # compilation environment is unsupported; the host starts a new worker.
        os.environ["TORCHDYNAMO_DISABLE"] = "0"
        # PyTorch's subprocess compiler pool uses pass_fds, unsupported by
        # Windows. Keep its single-worker path; Linux may use a bounded pool.
        os.environ["TORCHINDUCTOR_COMPILE_THREADS"] = "1" if sys.platform == "win32" else "2"
        from ai_execution_policy import optimization_candidates
        if optimization_candidates()["compile"]["state"] == "unavailable":
            raise ValueError("Compilation requires a compatible Triton runtime; use Standard with this runtime")
        import torch
        if not torch.cuda.is_available() or torch.version.hip:
            raise ValueError("Additional generation compilation is currently qualified only for NVIDIA CUDA")
        if model == "stable-audio-3-medium":
            from ai_compiler_profile import validate_compiler_device
            validate_compiler_device(torch, "cuda:0")
        return CompilationWorkspace()
    return None


@contextmanager
def compilation_proof(details):
    """Observe the first real forward; a compile wrapper alone is not success."""
    if not details:
        yield
        return
    import torch
    directory = os.environ.get("OPENSTUDIO_COMPILE_WORKSPACE")
    def check():
        if not directory:
            return 0
        path = Path(directory)
        owner = json.loads((path/".owner.json").read_text())
        if owner.get("kind") != "openstudio-compile-v1" or owner.get("pid") != os.getpid():
            raise RuntimeError("Compilation cache ownership changed")
        size = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
        if size > owner["reservation"]:
            raise RuntimeError("Compilation cache exceeded its worker reservation")
        return size
    check()
    if details.get("state") == "pass":
        yield
    else:
        with torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU]) as trace:
            yield
        regions = [event.key for event in trace.key_averages() if "Torch-Compiled Region" in event.key]
        if not regions:
            raise RuntimeError("Generation executed no observed Torch-Compiled Region")
        details.update(state="pass", observedRegions=regions, qualification="local_model_forward")
    details["cacheBytes"] = check()
