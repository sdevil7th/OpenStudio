"""App-owned, quota-bounded immutable weight backing for inference offload.

Checkpoint files are never modified. Stores belong to one worker process and
are removed on close, or reclaimed after a terminated worker has exited.
"""
from __future__ import annotations

import gc
import json
import os
from pathlib import Path
import shutil
import tempfile

GIB = 1024**3


def cache_root() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return (base / "OpenStudio" / "ai-offload").resolve()


def _remove_owned_directory(directory: Path, root: Path):
    # Deliberately no recursive delete: only these two owned files may exist.
    if directory.is_symlink() or directory.resolve().parent != root.resolve():
        raise ValueError("Offload cleanup escaped its owned cache directory.")
    for name in ("weights.bin", "owner.json"):
        (directory / name).unlink(missing_ok=True)
    directory.rmdir()


def cleanup_stale_stores(root: Path | None = None):
    import psutil
    root = (root or cache_root()).resolve()
    if not root.is_dir():
        return
    for directory in root.glob("worker-*"):
        if directory.is_symlink() or not directory.is_dir():
            continue
        try:
            owner = json.loads((directory / "owner.json").read_text(encoding="utf-8"))
            if owner.get("kind") == "openstudio-weight-store" and not psutil.pid_exists(int(owner["pid"])):
                _remove_owned_directory(directory, root)
        except (OSError, ValueError, KeyError):
            # An incomplete/foreign directory is not authorization to delete it.
            continue


class DiskWeightStore:
    """Replace CPU parameter storage with read-only-in-use file mappings.

    Closing invalidates the supplied model weights, just like unloading a
    session. No quantization or dtype conversion is performed.
    """
    def __init__(self, modules, *, root: Path | None = None, quota_bytes: int = 64*GIB):
        import torch
        self.root = (root or cache_root()).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        cleanup_stale_stores(self.root)
        self.bindings = []
        self.mapping = None
        self.reader = None
        self.offsets = {}
        self.directory = None
        seen = set()
        size = 0
        for module in modules:
            for value in module.parameters():
                if id(value) in seen:
                    continue
                seen.add(id(value))
                if value.device.type != "cpu" or value.is_quantized or not value.is_contiguous():
                    raise ValueError("Disk backing requires contiguous, unquantized CPU parameters.")
                size = (size + 63) // 64 * 64
                self.bindings.append((value, size, value.shape, value.dtype, value.numel()))
                size += value.numel() * value.element_size()
        self.bytes = size
        occupied = sum(path.stat().st_size for path in self.root.glob("worker-*/weights.bin") if not path.is_symlink())
        if size + occupied > quota_bytes or shutil.disk_usage(self.root).free < size + 3*GIB:
            raise RuntimeError("Not enough app-cache quota or free disk space for immutable weight offload.")
        self.directory = Path(tempfile.mkdtemp(prefix=f"worker-{os.getpid()}-", dir=self.root)).resolve()
        (self.directory / "owner.json").write_text(json.dumps({"kind": "openstudio-weight-store",
            "pid": os.getpid(), "bytes": size}), encoding="utf-8")
        try:
            with (self.directory / "weights.bin").open("w+b", buffering=0) as output:
                output.truncate(size)
                # This app-owned file is immutable during inference. A shared
                # mapping avoids reserving a model-sized Windows pagefile
                # commitment for private copy-on-write pages we never modify.
                self.mapping = torch.from_file(str(self.directory / "weights.bin"), shared=True,
                                               size=size, dtype=torch.uint8)
                for value, offset, shape, dtype, count in self.bindings:
                    self.offsets[id(value)] = (offset, count * value.element_size())
                    output.seek(offset)
                    value.detach().view(-1).view(torch.uint8).numpy().tofile(output)
                    value.data = self.mapping.narrow(0, offset, count * value.element_size()).view(dtype).view(shape)
            self.reader = (self.directory / "weights.bin").open("rb", buffering=0)
        except BaseException:
            self.close()
            raise

    def read_into(self, parameter, destination):
        """Read into a bounded staging tensor without faulting the full mapping.

        Mapping all streamed layers into the working set competes with WDDM's
        host allocations. Direct file reads keep only the caller's staging
        buffers resident. The OS can reclaim its ordinary file cache.
        """
        import torch
        offset, size = self.offsets[id(parameter)]
        if destination.device.type != "cpu" or not destination.is_contiguous():
            raise ValueError("Disk reads require a contiguous CPU staging tensor.")
        if destination.numel() * destination.element_size() != size or destination.dtype != parameter.dtype:
            raise ValueError("Disk staging tensor does not match the stored parameter.")
        target = memoryview(destination.detach().view(-1).view(torch.uint8).numpy())
        self.reader.seek(offset)
        read = 0
        while read < size:
            count = self.reader.readinto(target[read:])
            if not count:
                raise OSError("Immutable weight store was truncated during inference.")
            read += count

    def move_module(self, module, device):
        import torch
        for value in module.parameters():
            # One parameter-sized temporary; never materialize a second model.
            source = torch.empty_like(value, device="cpu")
            self.read_into(value, source)
            value.data = source.to(device)
        for child in module.modules():
            for name, value in child._buffers.items():
                if value is not None:
                    child._buffers[name] = value.to(device)

    def close(self):
        import torch
        if self.reader is not None:
            self.reader.close()
            self.reader = None
        for value, _, _, dtype, _ in self.bindings:
            value.data = torch.empty(0, dtype=dtype)
        self.bindings.clear()
        self.offsets.clear()
        self.mapping = None
        gc.collect()
        if self.directory is not None:
            _remove_owned_directory(self.directory, self.root)
            self.directory = None
