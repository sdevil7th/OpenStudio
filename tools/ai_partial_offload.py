"""Selective block residency using public Torch and Accelerate hooks.

An immutable CPU copy is retained for each offloaded parameter. Forward hooks
upload it, then restore the CPU reference without copying unchanged GPU weights
back to RAM. The stage coordinator owns all placement; no Diffusers manager or
device-map hooks may also own these modules.
"""
from __future__ import annotations


def log_int8_cast_once():
    """Retain the known dtype notice without flooding the worker IPC pipe."""
    import logging
    logger = logging.getLogger("bitsandbytes.autograd._functions")
    if any(getattr(item, "openstudio_int8_cast_filter", False) for item in logger.filters):
        return

    class CastNotice(logging.Filter):
        openstudio_int8_cast_filter = True

        def __init__(self):
            super().__init__()
            self.seen = set()

        def filter(self, record):
            if record.msg != "MatMul8bitLt: inputs will be cast from %s to float16 during quantization":
                return True
            key = str(record.args)
            if key in self.seen:
                return False
            self.seen.add(key)
            return True

    logger.addFilter(CastNotice())


def move_int8_module(module, device):
    """Move the pinned BNB operator's non-buffer state with its parameters.

    Module.to recursively invokes _apply, bypassing Linear8bitLt.to. Move
    those children explicitly and retain the inference CB/weight alias.
    This adapter is only qualified against the isolated BNB 0.50.2 candidate.
    """
    import torch
    import bitsandbytes as bnb
    if bnb.__version__ != "0.50.2":
        raise ValueError("INT8 stage placement requires qualified bitsandbytes 0.50.2.")
    for child in module.modules():
        if isinstance(child, bnb.nn.Linear8bitLt):
            cb = child.state.CB
            aliased = cb is not None and cb.data_ptr() == child.weight.data_ptr()
            weight_cb = child.weight.CB
            weight_aliased = weight_cb is not None and weight_cb.data_ptr() == child.weight.data_ptr()
            child.to(device)
            # Torch _apply can retain the original Parameter object and only
            # replace .data. Its BNB metadata then still references the old GPU
            # allocation, particularly before the very first forward.
            if weight_aliased:
                child.weight.CB = child.weight.data
            elif child.weight.CB is not None:
                child.weight.CB = child.weight.CB.to(device)
            if child.weight.SCB is not None:
                child.weight.SCB = child.weight.SCB.to(device)
            if aliased:
                child.state.CB = child.weight.data
            for name, value in vars(child.state).items():
                if torch.is_tensor(value):
                    setattr(child.state, name, value.to(device))
    module.to(device)


class Int8StagePlacement:
    """Experimental whole-stage residency with quantization-aware CPU moves."""
    def __init__(self, pipe, device, *, disk_store=None):
        import torch
        from accelerate.hooks import ModelHook, add_hook_to_module
        log_int8_cast_once()
        self.device = torch.device(device)
        self.stage = None
        self.disk_store = disk_store
        self.models = {name: getattr(pipe, name) for name in
                       ("language_model", "rvq_depth_decoder", "condition_encoder", "transformer", "vocoder")}
        for model in self.models.values():
            # A single-device loader map has no hooks in the pinned BNB stack.
            # Reject every existing hook, including nested ones, before taking ownership.
            if any(hasattr(child, "_hf_hook") for child in model.modules()):
                raise ValueError("INT8 stage placement requires unhooked components.")
            mapping = getattr(model, "hf_device_map", {})
            if mapping and (len(mapping) != 1 or "" not in mapping or
                            str(mapping[""]) != str(self.device)):
                raise ValueError("INT8 stage placement cannot share a dispatched model.")
        # Loading quantizes the LM on the selected GPU. Retire it before other
        # stages are activated; do not retain an extra full CPU weight snapshot.
        for model in self.models.values():
            move_int8_module(model, "cpu")
        self.cpu_weights = {name: [(value, value.detach()) for value in model.parameters()]
                            for name, model in self.models.items()}
        # Quantized weights are immutable during inference. Keep their original
        # scales with the CPU snapshot, including the pre-first-forward layout.
        self.cpu_scales = {}
        for model in self.models.values():
            for child in model.modules():
                state = getattr(child, "state", None)
                weight = getattr(child, "weight", None)
                if state is not None and hasattr(weight, "SCB"):
                    scale = weight.SCB if weight.SCB is not None else state.SCB
                    if scale is None:
                        raise ValueError("INT8 stage requires already quantized weights and scales.")
                    self.cpu_scales[id(child)] = scale
        owner = self

        class StageHook(ModelHook):
            def __init__(self, stage):
                self.execution_device = owner.device
                self.stage = stage

            def pre_forward(self, module, *args, **kwargs):
                owner.activate(self.stage)
                return args, kwargs

        for name, model in self.models.items():
            add_hook_to_module(model, StageHook("ar" if name in
                               {"language_model", "rvq_depth_decoder"} else name))

    def release(self):
        names = ("language_model", "rvq_depth_decoder") if self.stage == "ar" else (
            (self.stage,) if self.stage is not None else ())
        for name in names:
            model = self.models[name]
            for value, source in self.cpu_weights[name]:
                value.data = source
            for child in model.modules():
                if id(child) in self.cpu_scales:
                    child.weight.CB = None
                    child.weight.SCB = None
                    child.state.CB = child.weight.data
                    child.state.SCB = self.cpu_scales[id(child)]
            # Only small dynamic buffers/state remain to move.
            move_int8_module(model, "cpu")
        self.stage = None

    def activate(self, stage):
        if self.stage == stage:
            return
        self.release()
        self.stage = stage  # Record ownership before allocations, including failed moves.
        names = ("language_model", "rvq_depth_decoder") if stage == "ar" else (stage,)
        for name in names:
            if self.disk_store is not None:
                self.disk_store.move_module(self.models[name], self.device)
            move_int8_module(self.models[name], self.device)

    def close(self):
        from accelerate.hooks import remove_hook_from_module
        self.release()
        for model in self.models.values():
            remove_hook_from_module(model)
        self.cpu_weights.clear()
        self.cpu_scales.clear()
        if self.disk_store is not None:
            self.disk_store.close()
            self.disk_store = None


class PartialStagePlacement:
    def __init__(self, pipe, plan, device, *, disk_backed=False, cache_root=None):
        import torch
        from accelerate.hooks import ModelHook, add_hook_to_module
        self.pipe, self.plan = pipe, plan
        self.device = torch.device(device)
        self.blocks = list(pipe.language_model.model.layers)
        self.stage = None
        self.handles = []
        self.cpu_weights = {}
        self.loaded = set()
        self.transfer_bytes = 0
        self.stream = torch.cuda.Stream(device=self.device) if plan.use_stream else None
        self.events = {}
        self.staging = {}
        self.host_staging = {}
        self.host_reuse_events = {}
        self.reuse_events = {}
        self.models = {name: getattr(pipe, name) for name in
                       ("language_model", "rvq_depth_decoder", "condition_encoder", "transformer", "vocoder")}
        self.disk_store = None
        for model in self.models.values():
            if hasattr(model, "_hf_hook") or getattr(model, "hf_device_map", None):
                raise ValueError("Partial placement requires a fresh, unhooked model.")
        if disk_backed:
            from ai_disk_store import DiskWeightStore
            self.disk_store = DiskWeightStore(self.models.values(), root=cache_root)
        for index, block in enumerate(self.blocks):
            if index < plan.resident_blocks:
                continue
            values = list(block.parameters()) + list(block.buffers())
            self.cpu_weights[index] = []
            for value in values:
                source = value.detach().cpu()
                self.cpu_weights[index].append((value, source))
                value.data = source
            self.handles.append(block.register_forward_pre_hook(self._before(index)))
            self.handles.append(block.register_forward_hook(self._after(index), always_call=True))

        # Retain the original immutable CPU storage for resident components too.
        # Returning these stages with model.to('cpu') alone allocates a fresh
        # multi-GB host copy on every warm request. Restore references first.
        self.stage_cpu_weights = {name: [(value, value.detach()) for value in model.parameters()]
                                  for name, model in self.models.items()}

        owner = self

        class StageHook(ModelHook):
            def __init__(self, stage):
                self.execution_device = owner.device
                self.stage = stage

            def pre_forward(self, module, *args, **kwargs):
                owner.activate(self.stage)
                return args, kwargs

        # Upstream explicitly invokes the LM/RVQ root hooks before directly
        # reading their embeddings and heads. All model roots expose the same
        # execution device to ModularPipeline.
        for name, model in self.models.items():
            stage = "ar" if name in {"language_model", "rvq_depth_decoder"} else name
            add_hook_to_module(model, StageHook(stage))

    def _upload(self, index):
        import torch
        if index in self.loaded or index not in self.cpu_weights:
            return
        values = self.cpu_weights[index]
        if self.stream is None:
            for value, source in values:
                if self.disk_store is not None and id(value) in self.disk_store.offsets:
                    staging = torch.empty_like(source, device="cpu")
                    self.disk_store.read_into(value, staging)
                    value.data = staging.to(self.device)
                else:
                    value.data = source.to(self.device)
        else:
            with torch.cuda.stream(self.stream):
                slot = index % 2
                # The CPU must not overwrite a pinned source while a queued
                # DMA still reads it. Only two blocks are pinned, not the LM.
                if slot in self.host_reuse_events:
                    self.host_reuse_events.pop(slot).synchronize()
                if slot in self.reuse_events:
                    self.stream.wait_event(self.reuse_events.pop(slot))
                signature = [(source.shape, source.dtype) for _, source in values]
                if slot not in self.staging:
                    self.staging[slot] = (signature, [torch.empty_like(source, device=self.device)
                                                     for _, source in values])
                    self.host_staging[slot] = [torch.empty_like(source, device="cpu", pin_memory=True)
                                               for _, source in values]
                layout, buffers = self.staging[slot]
                if layout != signature:
                    raise ValueError("Prefetched blocks must have matching parameter layouts.")
                for (value, source), host, buffer in zip(values, self.host_staging[slot], buffers):
                    if self.disk_store is not None and id(value) in self.disk_store.offsets:
                        self.disk_store.read_into(value, host)
                    else:
                        host.copy_(source)
                    buffer.copy_(host, non_blocking=True)
                    value.data = buffer
                event = torch.cuda.Event()
                event.record(self.stream)
                self.events[index] = event
                self.host_reuse_events[slot] = event
        self.transfer_bytes += sum(source.numel() * source.element_size() for _, source in values)
        self.loaded.add(index)

    def _before(self, index):
        def hook(_module, _args):
            import torch
            self._upload(index)
            if self.stream is not None:
                current = torch.cuda.current_stream(self.device)
                current.wait_event(self.events.pop(index))
                self._upload(index + 1)
        return hook

    def _after(self, index):
        def hook(_module, _args, _output):
            if self.stream is not None:
                import torch
                completed = torch.cuda.Event()
                completed.record(torch.cuda.current_stream(self.device))
                self.reuse_events[index % 2] = completed
            for value, source in self.cpu_weights[index]:
                value.data = source
            self.loaded.discard(index)
        return hook

    def activate(self, stage):
        if self.stage == stage:
            return
        self.release()
        # Record ownership before the first allocation so OOM during a stage
        # transition still has a complete teardown path.
        self.stage = stage
        if stage == "ar":
            # Move only non-block components and the selected resident prefix.
            lm = self.pipe.language_model
            for name, child in lm.model.named_children():
                if name != "layers":
                    self._move(child)
            self._move(lm.lm_head)
            for block in self.blocks[:self.plan.resident_blocks]:
                self._move(block)
            self._move(self.pipe.rvq_depth_decoder)
        else:
            self._move(self.models[stage])

    def _move(self, module):
        if self.disk_store is not None:
            self.disk_store.move_module(module, self.device)
        else:
            module.to(self.device)

    def release(self):
        if self.stream is not None:
            for event in self.reuse_events.values():
                self.stream.wait_event(event)
            self.stream.synchronize()
        for values in self.cpu_weights.values():
            for value, source in values:
                value.data = source
        self.loaded.clear()
        self.events.clear()
        self.reuse_events.clear()
        self.staging.clear()
        self.host_staging.clear()
        self.host_reuse_events.clear()
        if self.stage == "ar":
            names = ("language_model", "rvq_depth_decoder")
        elif self.stage is not None:
            names = (self.stage,)
        else:
            names = ()
        for name in names:
            for value, source in self.stage_cpu_weights[name]:
                value.data = source
            # Parameters are already on CPU; this moves any small buffers.
            self.models[name].to("cpu")
        self.stage = None

    def close(self):
        from accelerate.hooks import remove_hook_from_module
        self.release()
        for handle in self.handles:
            handle.remove()
        self.handles.clear()
        for model in self.models.values():
            remove_hook_from_module(model)
        self.cpu_weights.clear()
        self.stage_cpu_weights.clear()
        if self.disk_store is not None:
            self.disk_store.close()
            self.disk_store = None
