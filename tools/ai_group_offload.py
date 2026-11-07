"""One owner per model for native Diffusers block offload and disk backing.

Disk paths are private to a load and component, even for equal-shaped models.
Closing retires the supplied models; callers reload before changing placement.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import threading
import uuid

from ai_memory_manager import GIB, module_weight_bytes


def _remove_owned(directory, root):
    if directory.is_symlink() or directory.resolve().parent != root.resolve():
        raise ValueError("Offload cache escaped its owned root")
    paths = list(directory.rglob("*"))
    if any(p.is_symlink() or not p.resolve().is_relative_to(directory.resolve()) for p in paths):
        raise ValueError("Refusing symlinks in an offload workspace")
    for path in sorted(paths, key=lambda p: len(p.parts), reverse=True):
        if path.name == ".owner.json" and path.parent == directory:
            continue
        path.rmdir() if path.is_dir() else path.unlink()
    (directory/".owner.json").unlink()
    directory.rmdir()


def cleanup_stale(root):
    import psutil
    if not root.is_dir():
        return
    for directory in root.glob("load-*"):
        if directory.is_symlink() or not re.fullmatch(r"load-[a-f0-9]{32}", directory.name):
            continue
        try:
            owner = json.loads((directory/".owner.json").read_text())
            if owner.get("kind") != "openstudio-group-store-v1":
                continue
            try:
                live = abs(psutil.Process(owner["pid"]).create_time() - owner["processBirth"]) < .01
            except psutil.NoSuchProcess:
                live = False
            if not live:
                _remove_owned(directory, root)
        except (OSError, ValueError, KeyError, psutil.AccessDenied):
            continue


class GroupPlacement:
    def __init__(self, components, device, *, disk=False, identity="", root=None,
                 quota_bytes=64*GIB, use_stream=False, group_size=1, disk_backend="mapped"):
        import torch
        from diffusers.hooks.group_offloading import apply_group_offloading
        if group_size < 1 or group_size > 8:
            raise ValueError("Group size must be between one and eight blocks")
        if use_stream and group_size != 1:
            raise ValueError("Stream prefetch requires exactly one block per group")
        if disk and use_stream:
            raise ValueError("Disk prefetch is not yet qualified; use synchronous disk groups")
        if disk_backend not in {"native", "mapped"}:
            raise ValueError("Unknown disk group implementation")
        self.components = dict(components)
        self.token = uuid.uuid4().hex
        self.directory = None
        self.active = 0
        self.lock = threading.RLock()
        self.closed = False
        self.owner_models = []
        self.mapped_groups = []
        seen = set()
        for name, model in self.components.items():
            if not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
                raise ValueError("Invalid offload component identity")
            for child in model.modules():
                registry = getattr(child, "_diffusers_hook", None)
                if (hasattr(child, "_hf_hook") or getattr(registry, "hooks", {})
                        or hasattr(child, "_openstudio_group_owner") or getattr(child, "_openstudio_group_retired", False)):
                    raise ValueError("Group placement needs components without another hook owner")
            aliases = set()
            tensors = list(model.named_parameters(remove_duplicate=False)) + list(model.named_buffers(remove_duplicate=False))
            for _, value in tensors:
                storage = value.untyped_storage()
                key = (str(value.device), storage.data_ptr(), storage.nbytes()) if value.numel() else ("empty", id(value))
                if key in aliases or key in seen:
                    raise ValueError("Cross-group tied parameters need a model-specific adapter")
                aliases.add(key)
            seen.update(aliases)
        if disk:
            if not re.fullmatch(r"[a-f0-9]{64}", identity):
                raise ValueError("Disk placement requires a checkpoint identity")
            from ai_disk_store import cache_root
            from filelock import FileLock
            import psutil
            self.root = Path(root or cache_root()/"groups").resolve()
            self.root.mkdir(parents=True, exist_ok=True)
            reservation = module_weight_bytes(self.components.values()) + sum(
                8192 for model in self.components.values() for _ in model.modules()) + 1024**2
            with FileLock(str(self.root/"quota.lock")):
                cleanup_stale(self.root)
                occupied = 0
                for marker in self.root.glob("load-*/.owner.json"):
                    if marker.parent.is_symlink():
                        continue
                    try:
                        record = json.loads(marker.read_text())
                        occupied += max(0, int(record.get("reservedBytes", quota_bytes)))
                    except (OSError, ValueError, TypeError):
                        raise RuntimeError("An unreadable offload reservation prevents safe quota admission") from None
                if occupied + reservation > quota_bytes or shutil.disk_usage(self.root).free < reservation + 3*GIB:
                    raise RuntimeError("Insufficient offload quota or disk headroom")
                self.directory = self.root/("load-"+self.token)
                self.directory.mkdir()
                (self.directory/".owner.json").write_text(json.dumps({"kind":"openstudio-group-store-v1",
                    "pid":os.getpid(),"processBirth":psutil.Process().create_time(),
                    "modelIdentity":identity,"reservedBytes":reservation}), encoding="utf-8")
        try:
            for name, model in self.components.items():
                model._openstudio_group_owner = self.token
                self.owner_models.append(model)
                directory = self.directory/name if self.directory else None
                if disk and disk_backend == "mapped":
                    self.mapped_groups.append(MappedGroups(model, device, directory, group_size))
                else:
                    apply_group_offloading(model, onload_device=torch.device(device), offload_device=torch.device("cpu"),
                        offload_type="block_level", num_blocks_per_group=group_size, use_stream=use_stream,
                        low_cpu_mem_usage=use_stream, offload_to_disk_path=str(directory) if directory else None)
        except BaseException:
            self.close()
            raise

    @contextmanager
    def lease(self):
        with self.lock:
            if self.closed:
                raise RuntimeError("Offload owner has been retired")
            self.active += 1
        try:
            yield
        finally:
            with self.lock:
                self.active -= 1

    def close(self):
        with self.lock:
            if self.closed:
                return
            if self.active:
                raise RuntimeError("Cannot retire offload storage during an active request")
            for groups in self.mapped_groups:
                groups.close()
            self.mapped_groups.clear()
            for model in self.owner_models:
                for child in model.modules():
                    registry = getattr(child, "_diffusers_hook", None)
                    if registry:
                        for key in ("lazy_prefetch_group_offloading", "group_offloading"):
                            registry.remove_hook(key, recurse=False)
                if getattr(model, "_openstudio_group_owner", None) == self.token:
                    del model._openstudio_group_owner
                model._openstudio_group_retired = True
            if self.directory is not None:
                _remove_owned(self.directory, self.root)
                self.directory = None
            self.closed = True


class MappedGroups:
    """Bounded synchronous transfers from immutable app-owned weight backing.

    The disk file contains authoritative weights. At most the current block and
    root residual parameters are staged; post-forward restores file references
    without a GPU-to-CPU weight copy. No direct VAE encode/decode adapter exists.
    """
    def __init__(self, model, device, directory, group_size):
        import torch
        from ai_disk_store import DiskWeightStore
        # Archive this component only, in its already-reserved private folder.
        self.handles, self.groups = [], []
        self.store = None
        lists = [child for child in model.children() if isinstance(child, (torch.nn.ModuleList, torch.nn.Sequential))]
        if not lists:
            raise ValueError("Mapped block placement requires an explicit block list")
        self.store = DiskWeightStore([model], root=directory)
        self.device = torch.device(device)
        try:
            seen = set()
            for blocks in lists:
                for start in range(0, len(blocks), group_size):
                    members = list(blocks[start:start+group_size])
                    parameters = [value for member in members for value in member.parameters()]
                    buffers = [value for member in members for value in member.buffers()]
                    seen.update(id(value) for value in parameters + buffers)
                    self._attach(members[0], members[-1], parameters, buffers)
            self._attach(model, model, [value for value in model.parameters() if id(value) not in seen],
                         [value for value in model.buffers() if id(value) not in seen])
        except BaseException:
            self.close()
            raise

    def _attach(self, first, last, parameters, buffers):
        import torch
        weights = [(value, value.detach()) for value in parameters]
        other = [(value, value.detach()) for value in buffers]
        group = (weights, other)
        self.groups.append(group)

        def before(_module, _args):
            for value, source in weights:
                staging = torch.empty_like(source, device="cpu")
                self.store.read_into(value, staging)
                value.data = staging.to(self.device)
            for value, source in other:
                value.data = source.to(self.device)

        def after(_module, _args, _output):
            for value, source in weights + other:
                value.data = source

        self.handles.append(first.register_forward_pre_hook(before))
        self.handles.append(last.register_forward_hook(after, always_call=True))

    def close(self):
        for handle in self.handles:
            handle.remove()
        self.handles.clear()
        for weights, buffers in self.groups:
            for value, source in weights + buffers:
                value.data = source
        self.groups.clear()
        if self.store is not None:
            self.store.close()
            self.store = None


def owned_group_request(method):
    from functools import wraps
    @wraps(method)
    def run(self, *args, **kwargs):
        owner = getattr(self, "_group_owner", None)
        if owner is None:
            return method(self, *args, **kwargs)
        with owner.lease():
            return method(self, *args, **kwargs)
    return run
