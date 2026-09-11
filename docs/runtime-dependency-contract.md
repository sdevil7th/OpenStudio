# OpenStudio Runtime Dependency Contract

This document defines which dependencies are allowed to block launch, which files must ship with the app, and which extras must remain optional.

## Dependency Classes

### Hard Launch Prerequisites

These are required for the base app shell to start successfully.

- Windows: Microsoft Edge WebView2 Runtime
- Windows: Microsoft Visual C++ x64 Redistributable
- macOS: supported macOS version and working system WebKit backend
- Both platforms: packaged frontend entrypoint and the web assets required by the shell

If a hard prerequisite is missing or unusable:

- startup may be blocked
- the startup doctor must log the exact failure branch
- the user must get an actionable recovery path

### Startup Evidence

`--startup-self-test` verifies dependency discovery, packaged shell assets, and
whether an embedded-browser environment can be requested. It does **not** prove
that a window rendered the React application.

`boot-ready` is the stronger UI signal emitted after a browser role has loaded
its frontend. Release qualification requires both checks. The browser startup
watchdog must remain active and must turn a missing `boot-ready` signal into a
diagnosable failure instead of leaving a blank window.

## Bundled Feature Assets

These are bundled with OpenStudio and should be present in the installed/runtime bundle, but they must not block the base shell from launching.

- `webui/index.html`
- `effects/`
- `scripts/`
- `models/basic_pitch_nmp.onnx`
- `models/basic_pitch_nmp.provenance.json`
- `OpenStudio.version`, generated from the same CMake version compiled into the
  application and validated without launching a GUI process
- `LICENSE`, `THIRD_PARTY_LICENSES.md`, and the packaged dependency notices
  under `licenses/`; notices with repository-pinned digests are checksum
  validated before packaging
- Windows: the checksum-pinned FFmpeg executable, shared-library set, runtime
  manifest, source lock, provenance, and applicable license files

If a bundled feature asset is missing:

- startup must still succeed
- the affected feature surface must identify the missing asset
- release validation must fail

## Optional Feature Prerequisites

These must never block base app launch.

- Python for AI tools
- AI models and downloadable AI helper runtimes
- ONNX Runtime in custom builds and on platforms where it is not provisioned;
  official Windows/Linux releases provision the pinned runtime
- Linux `secret-tool` (normally provided by `libsecret-tools`) and an available
  Secret Service/keyring for optional TONE3000 sign-in; local NAM loading does
  not depend on it
- macOS/Linux: a system `ffmpeg` on `PATH` for MP3/OGG export, video-audio
  extraction, FFmpeg-backed time stretch/pitch shift, and conversions that need
  FFmpeg. OpenStudio does not redistribute an unpinned Unix FFmpeg binary.
- ASIO
- plugin-vendor-specific external runtimes

If an optional dependency is missing:

- the related feature surface should show guidance
- setup/download should run in the background when supported
- the main app thread must remain responsive

## Platform Rules

### Windows

- The installer owns hard launch prerequisites.
- The packaged app stages offline Windows prerequisite installers in `prereqs/windows`.
- Browser capability checks and browser construction must use the same shared
  options factory. Every WebView2 role uses the writable per-user data folder
  `%APPDATA%\OpenStudio\WebView2UserData`; no installed path may fall back to a
  user-data folder beside the executable under `Program Files`.
- A Debug browser pass is not evidence that the MSVC Release build works. The
  packaged Release executable must complete the frontend-ready lifecycle gate.
- The startup doctor must distinguish:
  - WebView2 not installed
  - WebView2 installed but unusable
  - VC++ redistributable missing
  - shell asset missing

### macOS

- The app relies on system WebKit; no separate browser runtime installer is bundled.
- The Basic Pitch model is bundled for provenance consistency, but the current
  macOS release pipeline does not provision ONNX Runtime, so Basic Pitch
  inference is unavailable in that build.
- FFmpeg-backed features require a system FFmpeg on `PATH`; FFmpeg is not
  bundled in the macOS app.
- The startup doctor must distinguish:
  - backend unavailable on the current system
  - shipped runtime asset missing
  - packaged frontend missing
- Safe mode and the startup log must remain available for recovery.

### Linux

- Release validation must read `OpenStudio.version` and fail on a missing,
  empty, or mismatched manifest; it must not launch the GUI binary for a
  best-effort version check.
- FFmpeg-backed features use the system `ffmpeg` installed by the distribution;
  OpenStudio does not copy a developer-local FFmpeg into the AppImage.
- Missing FFmpeg must disable only the affected conversion operation and must
  produce an actionable diagnostic rather than blocking startup.

## Embedded and Native Window Roles

The embedded-browser lifecycle contract covers the main shell, detached Mixer,
each detached MIDI editor, and each built-in effect editor. Each role must reach
`boot-ready`, survive close/reopen cycles, and release closed secondary views.
Third-party plug-in editors use their native JUCE editor path and are qualified
separately for open/close/reopen behavior while audio is running. The graphical
Pitch Editor remains part of the main window rather than a detached browser
role.

## JUCE Dependency Policy

OpenStudio is pinned to JUCE `9.0.1`. A JUCE upgrade must be an isolated,
reviewable dependency change with Debug and Release builds plus audio-device,
plug-in-host, browser lifecycle, and packaging qualification. OpenStudio's
realtime JUCE patches must fail closed when their expected upstream source
context changes; an upgrade must never silently skip or partially apply them.

## Distribution Trust Boundary

Signing, launch reputation, and runtime health are separate gates. A valid
signature is not automatically reputation-clean on Windows, and a self-signed
binary is not a substitute for established Authenticode reputation. On macOS,
signature verification does not replace notarization/Gatekeeper assessment.
Unsigned releases may use the documented user-approved first-launch path, but
must not describe that path as warning-free.

## AI Tools Contract

- Clicking the toolbar AI button may start optional setup work.
- A lightweight popup should confirm that setup is running in the background.
- The top-right AI button is the persistent progress surface.
- Python is optional for the base app and must never block startup.

## AI generation optimization research and implementation plan

### Scope and evidence

This section is the single implementation plan for generation speed and memory
work. It covers MiniMax Music 3, Stable Audio 3 Medium, ACE-Step XL Turbo, and the
separate BS-Roformer execution path. Hugging Face's inference, memory, attention,
quantization, caching, loading, and hardware guidance was reviewed on
2026-09-11. Recommendations below are OpenStudio engineering decisions, not
claims that every documented Diffusers technique works on these audio models.

The source baseline is commit `732a314`. Stable Audio/MiniMax use Diffusers
`7643c4826609c47755e3da0e5b768e8070468f49`, Torch 2.10.0, Transformers 5.16.1,
Accelerate 1.14.0 and safetensors 0.8.0. ACE-Step has a separate managed runtime;
its package matrix must be qualified separately. Main-branch documentation can
describe APIs unavailable in these pins. Do not upgrade either runtime merely
to make an example import successfully.

Local Windows evidence: RTX 4080, 16 GiB VRAM, approximately 32 GiB RAM. A live
generation investigation observed CUDA activity up to 86% and about 7.5 GiB
VRAM used. Small attention probes in the managed runtime passed efficient SDPA
and cuDNN attention; the default probe selected efficient SDPA. Forced native
FlashAttention failed because this Torch build lacks that kernel. Neither
`flash-attn` nor xFormers is installed in this runtime. These probes establish
kernel availability, not whole-song throughput or the kernel used by every
model layer. macOS, AMD, Intel GPU and CPU-only generation are not locally
qualified by these measurements.

MiniMax combines an autoregressive Qwen3 language model with diffusion and a
vocoder. The language-model stage is the principal latency target; its token
generation is sequential. Hugging Face gives approximate BF16 memory needs of
23 GB resident, 22 GB with component offload, and 8 GB with additional language
model group offload. Duration increases cache and activation costs, so these
are reference measurements, not guaranteed capacity limits.[^ai-minimax]

### Technique decisions

| Technique | Evidence and OpenStudio decision |
| --- | --- |
| BF16 / FP16 / FP32 / TF32 | Retain BF16 on supported CUDA hardware. Keep Stable Audio FP32 on MPS and CPU: its model-specific guidance warns about FP16 noise on MPS. Evaluate older NVIDIA FP16 and MiniMax MPS BF16 separately. TF32 only affects eligible FP32 operations; measure numerical and speed effects before changing it.[^ai-speed][^ai-stable] |
| Native SDPA | Retain automatic kernel selection. Report it as a policy, not a promise of FlashAttention. Test masks, head sizes, causal and noncausal attention, and both prompt and single-token shapes.[^ai-attention] |
| FlashAttention, xFormers, cuDNN, ROCm AITER | Candidate kernels, not universal dependencies. Check the compiled wheel, GPU architecture, dtype and actual forward operation. Transformers Qwen attention and Diffusers transformer attention need separate configuration. Keep working SDPA fallback when an optional kernel fails.[^ai-attention] |
| SageAttention / quantized attention | Evaluate after weight placement and quantization. It changes numerical behavior; require lyric intelligibility and music-quality audition. Do not assume an image benchmark transfers to audio.[^ai-attention] |
| Resident, model, group, sequential offload | Prefer residency, then component/group offload as capacity requires. Sequential offload is a slow last resort. One owner must manage hook lifecycle.[^ai-memory] |
| Streams and pinned RAM | Budget from available RAM. Evaluate on-demand pinning; leave `record_stream` disabled pending measurement. Unknown capacity uses synchronous transfers.[^ai-memory] |
| Block versus leaf groups | Benchmark larger groups against MiniMax's leaf path. Streamed block offload requires one block per group.[^ai-memory] |
| Disk offload | Last-resort capacity option. OpenStudio requires bounded storage, free-space checks and cancellation cleanup away from recording disks.[^ai-memory] |
| INT8 / NF4 INT4 weights | Highest-priority low-VRAM experiment: quantize MiniMax's large Qwen language model first, preserving the vocoder and small audio components. Load with Transformers' quantization config for Qwen and Diffusers' config for Diffusers components. Test load-time peak RAM/VRAM as well as inference.[^ai-bnb][^ai-quant] |
| TorchAO and FP8 | Compare weight-only INT8/INT4 and supported FP8 configurations with bitsandbytes. Kernel availability and speed depend on architecture and package pin. CPU quantization can avoid a GPU loading spike. Do not quantize normalization/output components indiscriminately.[^ai-torchao] |
| Layerwise casting | Compress storage while retaining higher compute precision. Validate sensitive-layer exclusions and hook compatibility per component.[^ai-memory] |
| GGUF, Quanto and other quantizers | GGUF needs a supported component loader and compatible checkpoint mapping; it is not a generic pipeline replacement. Current Quanto docs deprecate that backend, so do not add a new dependency on it. ModelOpt, AutoRound, SDNQ and Nunchaku require a separate model/export/kernel compatibility review before adoption.[^ai-gguf][^ai-quanto][^ai-quant] |
| Regional / full compilation | Prefer repeated-block experiments over compiling the entire pipeline first. Measure first-run cost, warm latency, cache disk use and recompilation across durations. The worker currently disables Dynamo; removing that setting requires explicit compatibility testing. Persistent workers can amortize compilation, but OOM/cancellation must discard invalid compiled state.[^ai-speed][^ai-combinations] |
| KV cache | MiniMax's pinned encoder already passes `use_cache=True`. Static, offloaded and quantized caches are different tradeoffs. Its custom loop calls the Qwen model directly; adding `cache_implementation` to a top-level pipeline call is not sufficient. Any change must integrate with that loop and the pinned upstream API.[^ai-kv] |
| Intermediate diffusion caches | PAB, FasterCache, First Block Cache and Taylor-style approximations trade extra state and approximate computation for speed. Require model-specific block recognition and auditory evaluation. Distilled eight-step generation has little redundant work to skip safely.[^ai-cache] |
| VAE tiling / slicing | Retain ACE tiling; test other audio VAEs separately. Single-output batch slicing may not help. Require audio seam/context checks.[^ai-memory][^ai-ace] |
| Sharded / low-memory loading | Preserve local-only inference and setup-managed Hub downloads. Load directly at the intended dtype, retain checkpoint sharding, avoid state-dict copies, and bound parallel shard loading on low-RAM hosts. Parallel loading is a cold-start optimization, not a sampling-speed improvement.[^ai-loading] |
| Persistent session / conditioning cache | Reuse a loaded model when practical, but bound idle residency and release on model switch. Prompt embedding caching requires a byte-bounded key including model revision, dtype, prompt, lyrics, source-conditioning state and device policy. Never reuse a previous clip's source state.[^ai-loading] |
| Scheduler / steps / duration / batch | Preserve model-specific training contracts. Stable Audio distilled Medium and ACE Turbo use their supported distilled behavior. Lower steps or duration are user-visible quality/scope choices, not transparent performance fixes. Keep single-request batch size one for low-memory generation.[^ai-stable][^ai-ace] |
| Token merging / DeepCache / T-GATE / ParaAttention | The reviewed examples target specific image/video architectures. No production audio enablement until the exact model and upstream integration are demonstrated. Do not monkey-patch image attention into the audio models.[^ai-community] |
| Pruna / CacheDiT / xDiT / FreeU | Framework wrappers still need exact audio-model compatibility. Pruning/distillation require new model validation; QKV fusion needs supported projections and state restoration. FreeU changes U-Net feature weighting rather than solving audio-model memory pressure. Keep these outside the initial implementation.[^ai-frameworks] |
| Multi-GPU / distributed execution | Distinguish distributing independent songs from accelerating one song. Component/layer placement may expand capacity but PCIe transfers can worsen latency. Sequence/context parallelism requires model support and communication testing; it is not the initial desktop implementation.[^ai-distributed] |
| Core ML / OpenVINO / ONNX / TensorRT | Separate export/runtime projects. The reviewed image-oriented integrations do not establish support for these audio pipelines or source-edit workflows. Prioritize native PyTorch MPS/ROCm/XPU qualification first.[^ai-export] |

### Platform policy

NVIDIA CUDA is the first execution target. Select precision and memory behavior
from the installed runtime and current free memory, with a reserve for live DAW
use. Low VRAM and low host RAM are independent constraints; moving tensors to
CPU does not solve host-memory exhaustion. Never claim that every 4/6/8 GiB
machine can run every model.

AMD Linux requires a qualified ROCm wheel set and supported hardware. Torch's
ROCm backend uses the `cuda` API namespace, so log the HIP runtime and physical
device rather than labeling all `torch.cuda` execution NVIDIA. The current
Stable/MiniMax installer incorrectly forces the CUDA wheel index on Linux;
correcting runtime selection is a separate first-priority implementation item.
AMD Windows DirectML support for separation does not imply that these generation
pipelines support DirectML. Check native ROCm availability against the actual
release matrix before adding a Windows generation route.

Apple Silicon must use native arm64 Python and a compatible MPS runtime. Unified
memory means host and GPU allocations compete for the same budget. General MPS
docs contain older image-specific attention-slicing advice; the audio model's
precision and attention contracts take precedence. Intel Macs retain an honest
CPU capability result. Intel XPU is a separate future probe/installer path.
Do not infer any of these capabilities from an OS name alone.[^ai-mps]

Optional quantization libraries must be pinned and installed for the selected
OS/GPU combination only. Their hardware support is independent of Diffusers'
general device support. Failed acceleration setup must leave the previously
working runtime usable and present an actionable result.[^ai-bnb-install]

BS-Roformer is hosted by `audio-separator`, not these Diffusers pipelines. Its
backend probe covers CUDA, DirectML, ROCm and MPS routes, subject to installed
packages and model support. Audit the effective backend after constructing the
separator, not only the requested backend. Its installed attention wrapper has
its own SDPA kernel restrictions, so the model YAML's `flash_attn: true` does not
prove the FlashAttention kernel runs. Tune supported chunk/batch settings and
autocast separately, with overlap reconstruction tests and vocal/stem audition;
Diffusers offload and VAE APIs must not be passed to this engine.

### Implementation sequence and acceptance gates

1. **MiniMax placement and reporting — first implementation slice.** Add a pure,
   CI-tested memory planner and apply it after loading CPU components. Select
   resident, component offload or language-model group offload. Pass an explicit
   reserve to ComponentsManager. For group offload, use its supported custom
   strategy to preserve the concurrently used language model and RVQ decoder;
   whole-model footprint estimates are misleading for streamed layers. Report device family, precision, placement and
   transfer overlap in the existing generation-details text, including repeated
   progress events. Acceptance: policy boundary tests, actual pinned hooks on a
   CUDA forward, local-weight cold/warm generation, finite stereo output, and
   no extra dependencies or downloads during inference.
2. **Capacity and stage telemetry.** Measure component weights, available RAM,
   free VRAM, peak allocated/reserved VRAM, worker RSS and phase timings. Replace
   elapsed-time-derived generation percentages with actual model callbacks where
   available; otherwise show indeterminate work with elapsed time. Add explicit
   physical device and fallback reason. A tiny kernel probe must not be labeled
   a whole-model kernel trace. Test status continuity through reopen/cancel.
3. **Platform runtime repair and common policy.** Correct platform wheel
   selection, distinguish CUDA from HIP and qualify MPS/CPU/XPU independently.
   Extend placement to Stable Audio and ACE only after auditing their component
   lifetimes, source workflow sharing and VAE hooks. Re-evaluate free memory at
   request boundaries and rebuild placement safely if capacity changed. Add
   staged, bounded OOM recovery without changing seed, requested duration or
   inference parameters. Do not retry a partially published clip.
4. **MiniMax language-model quantization.** In an isolated evaluation runtime,
   compare BF16 baseline, INT8 and NF4 INT4, then TorchAO where supported. Start
   with language-model weights only. Establish whether quantization removes the
   need to stream layers on 8/12/16 GiB GPUs. Keep original snapshots intact;
   derived caches must record model revision, quantizer and kernel versions.
   Promote a mode only after complete inference, cancellation and audition pass.
5. **Compilation, attention and cache experiments.** Compare default SDPA,
   qualified optional kernels and regional compile on unchanged model weights.
   Next evaluate KV cache strategies. Approximate attention and diffusion caching
   come last because they alter numerical behavior and may offer little value
   on distilled pipelines. Record incompatible combinations in this document;
   do not accumulate silent fallback chains or production feature flags.
6. **Low-memory completion and release qualification.** Add disk offload only
   if measurements justify it. Qualify idle unloading, model switching, setup
   recovery, long-duration peaks, packaging and the visible native app on the
   supported platform matrix. Update existing user and website documentation
   with verified capabilities, not generic upstream claims.

The first MiniMax planner uses conservative reference thresholds: full residency
requires the larger of actual weight bytes and 23 GiB, plus 3 GiB reserve;
component offload requires 22 GiB plus reserve. FP32 doubles the reference
weight budgets. Below that, keep language-model group offload. Stream only with
at least 8 GiB free VRAM (16 GiB for FP32) and 3 GiB available host RAM; use
on-demand pinning unless another language-model-sized allocation plus reserve
fits in available host RAM. Unknown memory keeps synchronous offload. These
thresholds are initial engineering estimates to calibrate with duration-aware
benchmarks; they are not upstream guarantees or an OOM-proof scheduler.

### Benchmark and release protocol

Use identical prompts, lyrics, seeds, sample rates, durations and inference
steps when comparing execution policies. Separate cold loading, conversion,
compilation and warm generation. Measure complete wall time and per-stage time,
not average GPU utilization alone. Record hardware, OS, driver, library pins,
attention policy, actual traced kernels when measured, peak RAM/VRAM, free-memory
conditions, generated duration and output validity. Use bounded monitoring so
profiling does not dominate generation.

Cover short smoke requests and realistic 30/60-second requests, then the model's
maximum supported duration where resources permit. Test 8/12/16/24/32+ GiB
NVIDIA, low versus ample host RAM, a supported AMD Linux device, Apple Silicon
with constrained unified memory, and CPU fallback. Simulated capacities prove
policy selection only; real hardware is required to claim support or speed.

Functional gates: finite, nonempty stereo audio; correct sample rate; required
workflow duration behavior; untouched PCM preservation for source edits;
successive warm requests without state leakage; cancellation; model-switch
cleanup; and actionable OOM/error reporting. Approximate modes require human
audition for lyrics, rhythm, transients, pitch and seams. Numerical metrics are
diagnostic only for subjective audio quality. No benchmark here establishes
that any generated music is natural or artifact-free.

Current status: research complete and first MiniMax placement/reporting slice
implemented. Nine planner/API integration tests pass, as do the existing audio
workflow tests and a new repeated-progress-message test. A local-weight two-frame
MiniMax check completed twice with finite stereo output. First/warm generation
times were 53.61/65.03 seconds on the previous implementation and 38.36/26.52
seconds on the candidate. This very small diagnostic uses a 0.08-second request,
eight diffusion steps and seed 123; it is not representative song throughput,
an audio-quality test, or a controlled cold-load comparison. An earlier two-second
streamed run was stopped after approximately six minutes without completion;
that run establishes neither success nor a regression against a matching baseline.
Longer-request qualification remains open. Stable Audio/ACE adaptive placement,
quantization, runtime-platform repair, request-time replanning and cross-platform
performance qualification also remain open. This is not an announcement that
all optimization modes are supported.

### Research sources

The links below were reviewed on 2026-09-11; Hugging Face publishes these as
living documentation. Resolve implementation details against the pinned source.

[^ai-minimax]: Hugging Face, [MiniMax Music 3](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_music3).
[^ai-stable]: Hugging Face, [Stable Audio 3](https://huggingface.co/docs/diffusers/main/en/api/pipelines/stable_audio_3).
[^ai-ace]: Hugging Face, [ACE-Step 1.5 documentation source](https://github.com/huggingface/diffusers/blob/main/docs/source/en/api/pipelines/ace_step.md).
[^ai-memory]: Hugging Face, [Reduce memory usage](https://huggingface.co/docs/diffusers/main/en/optimization/memory), including streams, disk offload and layerwise casting.
[^ai-speed]: Hugging Face, [Accelerate inference](https://huggingface.co/docs/diffusers/main/en/optimization/fp16).
[^ai-attention]: Hugging Face, [Attention backends](https://huggingface.co/docs/diffusers/main/en/optimization/attention_backends).
[^ai-quant]: Hugging Face, [Quantization overview](https://huggingface.co/docs/diffusers/main/en/quantization/overview).
[^ai-bnb]: Hugging Face, [Diffusers bitsandbytes](https://huggingface.co/docs/diffusers/main/en/quantization/bitsandbytes).
[^ai-torchao]: Hugging Face, [TorchAO](https://huggingface.co/docs/diffusers/main/en/quantization/torchao).
[^ai-gguf]: Hugging Face, [GGUF](https://huggingface.co/docs/diffusers/main/en/quantization/gguf).
[^ai-quanto]: Hugging Face, [Quanto](https://huggingface.co/docs/diffusers/main/en/quantization/quanto).
[^ai-combinations]: Hugging Face, [Compiling and offloading quantized models](https://huggingface.co/docs/diffusers/main/en/optimization/speed-memory-optims).
[^ai-kv]: Hugging Face, [Transformers cache strategies](https://huggingface.co/docs/transformers/main/en/kv_cache).
[^ai-cache]: Hugging Face, [Diffusers caching](https://huggingface.co/docs/diffusers/main/en/optimization/cache).
[^ai-loading]: Hugging Face, [Loading pipelines](https://huggingface.co/docs/diffusers/main/en/using-diffusers/loading).
[^ai-mps]: Hugging Face, [Metal Performance Shaders](https://huggingface.co/docs/diffusers/main/en/optimization/mps).
[^ai-bnb-install]: Hugging Face, [bitsandbytes installation and hardware matrix](https://huggingface.co/docs/bitsandbytes/main/en/installation).
[^ai-community]: Hugging Face, [Token merging](https://huggingface.co/docs/diffusers/main/en/optimization/tome), [DeepCache](https://huggingface.co/docs/diffusers/main/en/optimization/deepcache), [T-GATE](https://huggingface.co/docs/diffusers/main/en/optimization/tgate), [ParaAttention](https://huggingface.co/docs/diffusers/main/en/optimization/para_attn).
[^ai-distributed]: Hugging Face, [Distributed inference](https://huggingface.co/docs/diffusers/main/en/training/distributed_inference).
[^ai-export]: Hugging Face, [Core ML](https://huggingface.co/docs/diffusers/main/en/optimization/coreml), [OpenVINO](https://huggingface.co/docs/diffusers/main/en/optimization/open_vino).
[^ai-frameworks]: Hugging Face, [Pruna](https://huggingface.co/docs/diffusers/main/en/optimization/pruna), [CacheDiT](https://huggingface.co/docs/diffusers/main/en/optimization/cache_dit), [xDiT](https://huggingface.co/docs/diffusers/main/en/optimization/xdit), [FreeU](https://huggingface.co/docs/diffusers/main/en/using-diffusers/image_quality).
