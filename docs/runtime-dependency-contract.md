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
device rather than labeling all `torch.cuda` execution NVIDIA. Stable/MiniMax setup now chooses the pinned ROCm, CUDA or CPU wheel index for
new Linux runtimes; real AMD hardware qualification remains required.
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

### Original implementation sequence and acceptance gates

This sequence records the first implementation slices. Their results and
exclusions are recorded below; the September 12 remaining-work plan supersedes
this sequence for new work.

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

### Implementation status and qualification decisions

The implementation now includes these production changes:

- Stable Audio and ACE select resident or component offload using actual weight
  sizes, free device memory and a duration-dependent reserve. ACE uses transformer
  group offload at lower capacity, with RAM-aware transfer overlap. Stable Audio sequential offload is
  **excluded**: repeated warm-session tests returned non-finite output, although
  a fresh sequential session completed. Its fallback remains component offload;
  this does not claim that every small GPU can fit the model.
- Source variants share Stable Audio components through their public constructors.
  The pinned `from_pipe()` defaults to FP32, doubling the BF16 weights; forcing
  BF16 there also casts buffers which the loader deliberately keeps in FP32.
  Constructor sharing preserves each original parameter and buffer dtype.
- Placement changes rebuild the session from local weights before the request.
  The worker permits one OOM retry using a more conservative policy, preserves
  the resolved seed and all generation parameters, and publishes no partial clip.
  MiniMax falls back to synchronous group offload on memory pressure. CPU/MPS
  precision and existing hardware eligibility are unchanged.
- Stable/MiniMax use actual diffusion callbacks and observational module hooks.
  MiniMax reports completed autoregressive forwards as frames against an upper
  bound (EOS may finish early). Unmeasured phases are indeterminate; percentages
  mean **current stage**, never an elapsed-time estimate of whole-song completion.
  The clip dialog, track dialog and track header share the same accessible bar.
- Execution diagnostics include the physical GPU, precision, placement, current
  allocation, free memory, peak allocated/reserved bytes, worker RSS and phase
  wall times. These are host-side phase timings, not synchronized GPU profiles.
  Diagnostic details are retained in worker JSON output; live device/placement
  and memory information appears in generation details.
- Both persistent generation workers release model references and GPU cache after
  two idle minutes. New requests can reuse the worker process but reload weights.
  ACE inference is explicitly local-only and no longer enables parallel shard
  loading regardless of available RAM.
- New Stable/MiniMax runtime setup selects the pinned PyTorch CPU wheel on
  non-NVIDIA Windows/Linux, CUDA on NVIDIA, and ROCm 7.1 on detected AMD Linux.
  macOS retains its native PyTorch wheel. These are upstream wheel selections,
  not new hardware qualification claims. Existing ready runtimes are not silently
  replaced. BS-Roformer reports HIP-backed Torch execution as ROCm.

| Plan phase | Decision |
| --- | --- |
| 1. MiniMax memory placement | Implemented; existing local-weight CUDA checks passed. |
| 2. Capacity and stage telemetry | Implemented; callbacks, phase reset and repeated heartbeat tests cover status continuity. |
| 3. Shared policy / platform repair | Shared placement and setup selection implemented. Stable sequential offload excluded after failed validation. ACE sequential offload is also excluded because its condition tensor is read outside forward and becomes an unusable meta tensor. MPS/CPU/XPU/AMD end-to-end qualification remains unavailable on this Windows machine; existing eligibility is retained. |
| 4. Quantization | Not promoted. The user reported audible problems in the exact NF4 audition artifact. INT8 evaluation did not complete a 30-second request within an eight-minute bound and was stopped; other GPU work was present, so this is not a controlled speed comparison. |
| 5. Compile / attention / caches | Native SDPA retained. An actual CUDA Inductor compile probe failed because this managed Windows runtime has no working Triton. The Stable/MiniMax runtime has no Triton, TorchAO, flash-attn or xFormers. ACE has an optional flash-attn package whose import fails with a DLL error; its existing native-attention fallback remains in use. Approximate caches/attention remain excluded without model-specific auditory qualification. The pinned MiniMax loop already uses KV caching; alternate cache implementations need upstream loop integration. |
| 6. Low-memory / release qualification | Idle unloading and bounded recovery implemented. Disk offload has no measured justification yet. Real 8/12 GiB, AMD, Apple Silicon and maximum-duration qualification remain open. Website release claims must wait for a qualified published application release. |

Prior local MiniMax evidence remains diagnostic: a 0.08-second BF16 request
completed first/warm at 38.36/26.52 seconds versus 53.61/65.03 seconds previously.
A later two-second request completed in 377.58 seconds with finite stereo output
and approximately 4.85 GiB peak reserved VRAM. These are not song-quality results.
An isolated NF4 30-second experiment completed in 59.13 seconds with 14.51 GiB
peak reserved VRAM; component offload completed in 86.61 seconds with 8.41 GiB.
Those two saved WAVs matched, but the user's audition failed. NF4 and the private
bitsandbytes experiment remain outside the application and Git.

The first Stable Audio GPU integration check found the source-pipeline upcast:
weight storage grew from 5,174,153,442 to 10,348,305,092 bytes. Constructor sharing
preserves the original mixed dtypes. The failing sequential transition is not a
supported production mode; finite-output checks correctly prevented publication.
A fresh sequential diagnostic used about 0.38 GiB peak reserved memory, but that
single success does not override the failed warm-session gate or establish audio
quality. Cross-platform CI establishes build/test portability, not generation
performance or audio quality on hardware that was not tested.

Final production-policy CUDA checks passed for Stable Audio text, variation,
then a rebuilt component-offloaded text request: all produced finite stereo
output. Weights stayed at 5,174,153,442 bytes; peak reserved memory was about
5.07/5.08/2.84 GiB respectively. ACE's ten-second minimum request completed in
resident and synchronous transformer-group modes, with about 11.66/3.86 GiB
peak reserved memory. The MiniMax observational-progress check completed two
0.08-second requests with finite stereo output (57.73/34.84 seconds). These are
functional checks on the RTX 4080, not clean-machine comparative benchmarks or
proof of audio quality on smaller cards. NF4 remains `fail` by user audition;
production output quality remains `not_asserted` pending listening.

PyTorch wheel selection follows the pinned [PyTorch 2.10.0 installation matrix](https://pytorch.org/get-started/previous-versions/#v2100).

### Remaining implementation plan: September 12, 2026

Status: **implementation in progress; the complete plan is not qualified**.
The source baseline is `808ccbe`. The working tree now includes shared device
enumeration, indexed CUDA/XPU operations, WDDM physical-memory budgeting,
bounded worker thread pools, model-specific placement capability records,
separate Diffusers/Transformers attention adapters, and a headless benchmark
runner. Generation details now reach the native bridge, and worker hashes
include the policy dependencies. Debug builds refresh the worker assets even
when no C++ source changed. Earlier qualification failures remain valid.

#### September 12 implementation checkpoint

September 13 continuation: native completion polling now preserves successful
workers for warm reuse. Failed/cancelled workers still retire immediately.
Both Python servers check available host RAM while idle every second and release
weights below 3 GiB or after two minutes; unknown RAM availability also releases
weights. Generation and separation cannot run concurrently through the host,
and starting separation retires an idle generation worker without clearing its
completed result. These changes are on the control path, not the audio callback.
The Debug native regression passed **191 checks**, including warm retention,
refusal to retire an active generation, and idle resource handoff.

MiniMax now also has an explicit `partial-resident-disk` harness candidate. It
writes unchanged parameter bytes into a quota-bounded app-owned store (64 GiB
quota, 3 GiB disk reserve), uses direct file reads into two pinned staging blocks,
and releases its store on unload or after a terminated benchmark. Shared file
mapping avoids a model-sized Windows copy-on-write commitment. Mapped reads
alone failed the RAM floor; direct staging subsequently passed two 0.08-second
and two 1-second requests. CPU/CUDA toy parity, synchronous/streamed placement,
warm stage restoration, quota rejection, truncated reads and cleanup tests pass.
**This remains experimental**: it has not met realistic song-duration, controlled
speed comparison, and complete model-switch/cancellation qualification gates.

- Stable Audio and ACE use their existing resident/component placement policies
  with the shared device budget; ACE retains its transformer group adapter.
  A forced ACE group-offload test exposed full-model pre-pinning exhausting
  host RAM. Streamed ACE group offload now uses on-demand pinning; all three
  source workflows subsequently passed both first and warm runs. The original
  failed report is retained as `ace-group-variation`.
  MiniMax also uses physical WDDM capacity at load and warm-reuse boundaries.
  CPU/MPS/XPU routing code is not evidence of model qualification on those devices.
- MiniMax partial residency has a separate placement owner, immutable CPU weight
  references, two reusable GPU staging buffers and two reusable pinned CPU
  buffers. Toy CPU/CUDA parity, repeated-buffer reuse, and failed-transition
  teardown pass. **It remains excluded from automatic selection**: full-model
  qualification on this 32-GB Windows host repeatedly violated the RAM reserve.
  The harness can request `--placement partial-resident` explicitly.
  The later disk-backed candidate avoids the observed short-run RAM failure;
  this does not qualify the original in-memory partial placement.
- BS-Roformer replaces the pinned engine's A100-only SDPA kernel restriction on
  its 24 eligible, parameter-free attention nodes with Torch automatic SDPA.
  Explicit non-SDPA model configurations stay unchanged. The pinned Roformer
  loop ignores `batch_size`; changing that setting is not an optimization.
  Chunk size and overlap reconstruction remain owned by audio-separator.
- Optional FlashAttention, xFormers, AITER and Sage adapters report availability
  separately from qualification. Native SDPA is the automatic default. The ACE
  runtime's installed FlashAttention distribution is not treated as validated
  merely because its package metadata exists. The later INT8 experiment uses an
  isolated, hash-checked bitsandbytes environment; the base runtimes are unchanged.
- INT8/TorchAO loader configurations and regional compilation have explicit
  qualification entry points. MiniMax now has a separate INT8 stage owner;
  other quantization/offload combinations remain excluded. Compilation requires
  unquantized residency. NF4 remains excluded following the prior failed audition.
- `tools/run-ai-benchmark.py` covers the three generators and the real one-shot
  separator worker. It records actual output length, cold/warm timings, policy,
  phase progress, memory, package versions and optional attention/transfer probes.
  Timeout/cancellation kills the complete Windows venv process tree. A sustained
  2-GiB available-RAM floor also stops the benchmark. A native exit cannot silently
  become a passing report. Separation runs are explicitly one-shot, not warm.

Local evidence under `build/ai-qualification/` (ignored build artifacts):

| Case | Result and scope |
| --- | --- |
| `stable-current` | **pass**: three finite stereo 5-second outputs, resident BF16, 5.154 / 0.567 / 1.177 seconds excluding model load. Diffusers audio runtime, Torch 2.10.0+cu128. |
| `ace-production-runtime` | **pass**: three finite stereo 10-second outputs, resident BF16, 7.327 / 0.871 / 0.789 seconds excluding load. Actual app `stem-runtime`, Torch 2.11.0+cu128. The request's 5-second value was normalized to ACE's 10-second minimum; this is not a 5-second result. |
| `separator-current` | **pass**: the actual worker returned six finite stereo 8-second stems from a synthetic fixture, with all 24 SDPA nodes adapted. Total one-shot latency 11.075 seconds; separation quality on music is **not_asserted**. |
| `stable-variation`, `stable-inpaint-selection`, `stable-continue-clip` | **pass**: two real-model runs of each source workflow, using production source normalization, output validation and continuation cropping. |
| `ace-variation`, `ace-inpaint-selection`, `ace-continue-clip` | **pass**: two real-model runs of each source workflow in the actual ACE runtime and app checkpoint snapshot. |
| `stable-production-workflows` | **pass**: the real worker completed text, variation, inpainting and continuation in one reused session. Unedited source PCM was bit-exact before/after the inpaint interval; continuation produced the requested two-second tail. |
| `stable-component-*` | **pass**: forced component offload, two runs each of variation, inpainting and continuation; all returned the requested five-second output. Generation latency 4.43-5.06 seconds. |
| `ace-group-bounded-*` | **pass**: forced streamed group offload with on-demand pinning, two runs each of variation, inpainting and continuation. Outputs were 10 / 10 / 5 seconds respectively; sampled host RAM remained above 10 GiB. This is a capacity fallback, not faster than residency on this card. |
| `minimax-disk-1s` | **pass for short forwards only**: two finite 0.99846-second outputs, 78.635 / 76.924 seconds excluding a 61.677-second load/store preparation. Sampled free RAM stayed around 13-14 GiB during inference; worker private commitment was about 16 GiB, versus about 38 GiB in the private-mapping microbenchmark. The first run uploaded 220.731 GB of streamed block weights. Long-song speed and quality remain **not_asserted**. |
| MiniMax experimental variants | **diagnostic_only**: earlier variants produced finite subsecond audio, but subsequent warm runs exhausted safe host headroom. A separate run exited with Windows access violation `0xc0000005` in `python312.dll`; its cause was not conclusively isolated. `minimax-bounded-host` stopped at the RAM floor before a result. No variant is promoted and no production speed-up is established. |
| `link-probe` | **diagnostic_only**: median pinned transfers 3.386 GB/s host-to-device and 3.354 GB/s device-to-host. NVIDIA reported GPU maximum Gen 4, host maximum/current Gen 1, width x16. This needs system-level investigation, not more GPU allocation. |

The GPU is an RTX 4080 on an MSI PRO X670-P WIFI / Ryzen 9 7900X system.
NVIDIA defines its maximum link generation as the limit of the GPU and current
system configuration, not just the GPU's capability ([NVIDIA SMI reference](https://docs.nvidia.com/deploy/nvidia-smi/)).
The user confirmed the GPU is connected directly to the motherboard's top long
slot, without a riser. The installed MSI BIOS reports version 1.10, dated
August 16, 2022. No BIOS, driver, clock, power-plan or registry settings were changed.
Windows PnP independently reported current link speed `1`, maximum `4`, width
`16`, and a direct parent PCI Express Root Port at bus 0/device 1/function 1.
The installed Windows SDK `pciprop.h` defines current-speed value `1` as 2.5 Gb/s.
This idle PnP reading supplements the earlier under-load NVIDIA/transfer samples;
it does not identify whether BIOS configuration, firmware or link training caused
the limit. The active Balanced plan's PCIe power settings were read only; they
do not establish the cause of the under-load Gen 1 limit.

These are functional/diagnostic samples, not controlled before/after speed
comparisons. Some independent build work ran during checks; contention is
recorded as unmeasured. Subjective generated-audio quality outside the exact
accepted INT8 artifact below is **not_asserted**.
Python policy/routing and runtime pins (65 checks), the real Torch disk/hook/attention/source
tests (20 checks), frontend TypeScript and production assets, and the CMake
Debug build passed locally. The CI matrix now
runs pure policy tests on Windows, Linux and macOS; those remote jobs have not
been executed by this local session.
Both Python tooling and policy jobs select Python 3.12 and install their
lightweight NumPy and SoundFile test dependencies explicitly. The policy set passed in a fresh local
Python 3.12 venv without Torch, rather than relying on development-machine packages.
The general tooling suite also passed locally: 68 executed checks and two
platform-specific skips out of 70 discovered checks.

#### September 13 INT8 continuation

The user accepted the exact `minimax-int8-reused-5s/run-0.wav` artifact, SHA-256
`588a5578c6363c844c2731e1f7a0b97746d26880e862d6cc56d34690feaf8e0d`.
This is **pass by user audition for that artifact**, not an assertion about all
prompts, durations, hardware, or future quantizers. NF4 remains excluded.

The MiniMax candidate quantizes only the language model using bitsandbytes
0.50.2 and retains the other components' original precision. Its stage owner
keeps the language model and RVQ decoder together throughout token generation,
then hands device memory to the condition encoder, diffusion model and vocoder.
There is one owner for weights and quantizer state. Explicit placement restores
bnb's parameter and scale metadata both before and after the first forward;
warm offload restores original CPU storage instead of allocating another full
CPU copy. The loader quantizes the LM first and keeps it on the GPU while
converting the other CPU checkpoints, then offloads it after releasing conversion
temporaries. Twelve toy stage cycles validate storage reuse,
device placement and forward parity. These are deterministic checks, not audio
quality metrics.

`tools/stage-ai-candidate.py --candidate int8` creates an isolated versioned venv,
verifies the official Windows wheel against PyPI's SHA-256, and checks that
Torch/Diffusers/Transformers/Accelerate pins did not change. It atomically
publishes an **import-only** candidate manifest. Base runtimes and checkpoints
remain unchanged. A failed stage keeps the previous candidate manifest.
`tools/qualify-ai-candidate.py` separately requires matching first/warm real
forwards and explicit audition acceptance before publishing a local profile.
The native host resolves that profile's app-local interpreter; the Python
worker revalidates source hash, package versions, local model identity, GPU
UUID/driver, allocator configuration, tested request bounds and current memory.
Changing any of these invalidates automatic INT8 selection. The model identity
uses local file metadata and configuration contents; it is not a cryptographic
attestation of every checkpoint byte. Profiles are machine-local calibration,
not portable project settings or universal hardware qualification.

Long requests exposed an allocator issue missed by short forwards: by frame
1830 of 4875, the default allocator reserved 15.279 GB with only 12.282 GB live.
That run was stopped before output and is retained as
`minimax-int8-long-195s` (**cancelled**, no passing song). The revised Windows
MiniMax worker configures a 90% per-process allocator limit, cache reclamation
at 80% of that limit and four rounded size divisions before importing Torch,
preserving either user allocator environment override. Device budgeting also
honors that limit. Physical free-memory checks and request headroom still apply.
An intermediate attempt (`minimax-int8-allocator-195s`) improved allocation reuse
but was stopped after source review showed that reclamation requires an explicit
fraction below 1.0 in the pinned allocator; that report is **cancelled** too.
The relevant guard and initialization are in
[PyTorch 2.10 CUDACachingAllocator](https://github.com/pytorch/pytorch/blob/v2.10.0/c10/cuda/CUDACachingAllocator.cpp#L1340).
This targets growing KV allocation sizes without clearing the cache per token.
PyTorch 2.10's expandable segments are unavailable in the
installed Windows build; an actual allocation probe confirmed that limitation.
The supported controls and their native-allocator restrictions are documented in
[PyTorch 2.10 CUDA memory management](https://docs.pytorch.org/docs/2.10/notes/cuda.html#optimizing-memory-usage-with-pytorch-cuda-alloc-conf).
The allocator candidate's full-duration qualification is recorded separately
from the earlier cancelled run.

The reduced-reserve candidate is local-only: a 1.5-GiB allowance beyond stage
weights and estimated KV storage can be evaluated explicitly, while ordinary
unqualified loading retains its 3-GiB reserve. Qualification does not assert
that WDDM never uses shared memory: the first complete 195-second run briefly
reported zero free VRAM, despite completing without an OOM or RAM-floor stop.
Allocator memory statistics are diagnostics; successful output alone is not a
measurement of physical residency throughout every kernel.

Additional evidence, retained with failed attempts rather than overwritten:

| Case | Result and scope |
| --- | --- |
| `minimax-int8-reused-5s` | **pass**: two 4.992-second outputs, 29.368 / 32.069 seconds generation, 36.122 seconds load. User accepted only run 0. The earlier unquantized disk-backed 5-second fixture took 306.369 seconds; this is an observational comparison of different placements/precision, with contention unmeasured. |
| `minimax-int8-reused-30s` | **pass for output, insufficient for a 30-second capacity claim**: EOS ended both outputs around 15.047 seconds. |
| `minimax-int8-final-30s` | **pass**: both outputs reached 30.023 seconds, 142.731 / 143.202 seconds generation. |
| `minimax-int8-release-candidate-30s` | **resource_limit**: reduced available host memory exposed a cold-load RAM peak. This led to the LM-first loading change. |
| `minimax-int8-load-order-30s` | **pass**: two 30.023-second outputs after the load-order fix, 163.933 / 165.680 seconds generation, about 5 GB available host RAM during inference. Different machine load prevents a speed-regression conclusion from these timings alone. |
| `minimax-int8-bounded-allocator-195s` | **resource_limit during load**: converting the diffusion checkpoint while the quantized LM was already in RAM still exceeded the host reserve. The next candidate retains the LM on GPU during CPU checkpoint conversion. |
| `minimax-int8-gpu-load-195s` | **budget rejection before inference**: revised loading kept at least 4.895 GiB available RAM in the sampled load tail, but the 195-second request plus a 2-GiB device reserve exceeded current available VRAM. This is a capacity rejection, not an OOM or a completed generation. |
| `minimax-int8-local-195s` | **pass**: first and warm runs produced 195.245 seconds of finite stereo 44.1-kHz audio in 1086.657 / 1083.745 seconds, excluding 39.141 seconds cold load. Current worker hash `b563a5f0f6ce029e`, native SDPA, INT8 LM, model offload, 1.5-GiB device reserve and the bounded native allocator. Neither run hit an OOM or the sustained 2-GiB host-memory stop. Long-song subjective quality is **not_asserted**. |
| `minimax-production-int8-workflows` | **pass**: actual IPC worker automatically selected the qualified INT8 profile for lyrics/style and two structured-song requests in PID 10432. All outputs were finite stereo, 4.992 seconds; total request latency was 70.335 / 29.665 / 28.686 seconds (first includes load). Both structured outputs have PCM bit-exact to the user-accepted short artifact; WAV container hashes differ. Wrong-model requests were rejected. Cancellation after 10 positive token frames stopped the owned worker process tree, with no cancelled or wrong-model output published. This harness exercises Python IPC; native ownership is covered separately by the Debug regression. |
| `ace-compile-operator` | **pass for operator only**: Windows Triton compiled two matrix shapes, profiler-observed compiled regions and output parity. Full ACE model compilation and audio are **not_asserted**. |

The repeated bnb BF16-to-FP16 cast notice is emitted once per dtype; unrelated
warnings are preserved. Memory reports distinguish allocated, reserved, cached
and inactive split bytes. CPU/FP32 capacity checks read safetensors headers
before loading weights: MiniMax alone requires approximately 43.74 GiB for
FP32 weights, so this 32-GB host receives a capacity explanation before an
unbounded CPU load. That rejection is not a successful CPU generation test.

The latest native Debug regression passed **195 checks**, including candidate
manifest validation and resource ownership. No Linux AMD, Apple Silicon, Intel
GPU or additional NVIDIA machine is currently available (user confirmed).
Actual model-forward qualification on those devices remains **not_asserted**;
mocked capability tests and the CI OS matrix cannot replace it.

The successful full-duration report was used to publish
`%LOCALAPPDATA%/OpenStudio/ai-candidates/minimax-int8-qualified.json`.
Automatic selection is now active on this exact machine/runtime/checkpoint for
requests up to 195 seconds and a conservative prompt bound of 980 tokens
(UTF-8 byte count plus special-token allowance, not a measured tokenizer count).
Larger prompts, changed identities or insufficient current memory use standard
placement with an explanation in generation details. This is a local capacity
qualification, not completion of the hardware matrix or every optional backend.

The full-song token phase took 960.250 / 956.765 seconds; diffusion took
115.968 / 115.844 seconds. Peak live allocations were 13.839 / 13.952 GiB and
peak allocator reservations 14.340 / 14.336 GiB. The separate memory sampler
observed at least 2.481 / 2.397 GiB available host RAM during its sampled
inference interval; it started after early token generation and does not measure
the cold-load minimum. Both runs briefly reported zero free VRAM, so physical
residency and shared-memory spill remain **diagnostic_only**, not a zero-spill
claim. Contention was not measured. The short 5-second comparison above suggests
roughly 90% less generation time for that fixture, but it is not a controlled
universal speed-up or a percentage claim for these full-length songs.

Final local checks: **65** policy/routing/runtime-pin tests, **20** Torch-enabled
adapter checks (7 placement including real bnb stage cycles, 4 disk storage,
7 pipeline-contract checks and 2 attention checks), and the **195** native
Debug checks above passed. The pipeline-contract checks use fake pipelines;
the separately named benchmark and worker reports establish real-model output.
The general tooling suite passed 68 checks with two platform skips. Frontend
TypeScript/Vite build and CMake Debug build passed; all 141 frontend files and
nine copied worker/helper files matched their source/build inputs. The native
build log contained no C++ warnings or errors. Existing Vite bundle/import
notices and third-party Python deprecation notices are not zero-warning claims.

Headless Playwright checked the real generation modal with mock qualified and
fallback metadata at 390 x 844 and 1280 x 900: note wrapping, horizontal bounds,
Show details keyboard focus and screenshots passed. Malformed/duplicate bridge
metadata checks passed. This is browser UI evidence, not a native WebView or
Release qualification. Screenshots are retained under
`output/playwright/ai-execution-qa/`. The temporary fixture, browser and owned
Vite server were removed/stopped, and port 5183 was free at handoff. The app can
be started with `python build.py dev --run`; no pre-running server is needed.

Remaining work is explicit: actual alternative-hardware model qualification;
native XPU/Windows ROCm setup routes where supported; optional attention wheels
and full-model qualification; regional compilation beyond the operator probe;
broader quantization, conditioning caches and multi-GPU placement; disk/offload
combinations excluded in the adapter capability records; and controlled speed
comparisons plus playback/recording contention measurements. These are not
implicitly passed by local INT8 promotion. The directly installed RTX 4080's
observed Gen 1 host link also remains unresolved; no firmware or system setting
was changed as part of this implementation.

Local qualification commands (run after reviewing the reports; the audition
argument records an actual user decision, not an automated quality score):

```powershell
$candidateRoot = "$env:LOCALAPPDATA/OpenStudio/ai-candidates"
$modelRoot = "$env:LOCALAPPDATA/OpenStudio/models/minimax-music-3"
python tools/stage-ai-candidate.py --candidate int8 `
  --runtime-python "$env:LOCALAPPDATA/OpenStudio/diffusers-audio-runtime/Scripts/python.exe" `
  --output-dir $candidateRoot
$candidatePython = (Get-Content "$candidateRoot/int8.json" -Raw | ConvertFrom-Json).python
& $candidatePython tools/run-ai-benchmark.py --model minimax-music-3 `
  --model-root $modelRoot --output-dir build/ai-qualification/minimax-int8-local-195s `
  --request build/ai-qualification/workflow-requests/minimax-lyrics-195s.json `
  --placement model-offload --quantization int8 --int8-reserve-gib 1.5 --repeats 2 --timeout 2700
& $candidatePython tools/qualify-ai-candidate.py `
  --candidate-manifest "$candidateRoot/int8.json" --model-root $modelRoot `
  --report build/ai-qualification/minimax-int8-local-195s/report.json `
  --audition-artifact build/ai-qualification/minimax-int8-reused-5s/run-0.wav --audition-accepted
```

The JSON requests and audition audio above are local qualification artifacts,
not downloaded or generated by those commands. Reproducing this on another
machine requires its own requests, reports and user-accepted audio. Use a fresh
benchmark output directory for each attempt. Normal generation never runs the
staging or qualification commands automatically.

Remaining work includes controlled full-duration
workflow comparisons, staged optional attention packages beyond the INT8 wheel, native XPU
and Windows ROCm installers, actual non-NVIDIA device qualification, disk
offload qualification beyond the new MiniMax experiment, multi-GPU sharding,
persistent calibration beyond the local MiniMax profile, full-model compilation
and broader quantization qualification, conditioning
caches, and playback/recording contention tests. Warm worker reuse is now
implemented and native-tested; it is not a conditioning or approximate diffusion
cache. The following
sections retain the full delivery plan; they are requirements, not completion
claims.

The objective is the lowest measured generation latency on the available
hardware while preserving the requested audio behavior and responsive DAW
playback/recording. GPU activity and memory occupancy are diagnostics, not
optimization targets. Keep measured activation/cache and DAW headroom; never
reserve all VRAM just to display 100% usage. Hardware coverage means a tested
capability decision for every model/device combination, with a useful fallback
or precise unsupported result where necessary. It cannot guarantee every model
fits or every kernel works on every machine.

The September 12 live MiniMax investigation observed approximately 5.4 GB
dedicated GPU use, 79-100% NVIDIA kernel activity, 66 W power, 3.8-4.8 GB/s PCIe
receive traffic, 19 GB worker working set, and 1.5 GB available host RAM. A short
paging sample did not show heavy disk thrashing. These observations support
weight-transfer overhead as a major suspect, but are not an isolated profiler
breakdown. The active streaming setting was not recovered. Capture it in the
baseline instead of inferring it from utilization. The conversational 2-4x
speed estimate is an unverified hypothesis conditional on successful residency
and quantization; the prior NF4 audition failure prevents using it as a delivery
target or expected quality-preserving improvement.

#### September 13 exact-song selection regression

The user's 195-second, 30-step lyrics/style request exposed a production gap:
its old UTF-8 prompt bound was 1763, exceeding the locally qualified 980 bound.
The worker therefore loaded the unquantized model even though the host selected
the INT8-capable interpreter. The cancelled app request reached 2170 of 4875
frames after approximately 253 minutes. The earlier 18-minute INT8 benchmark
was not representative of that selected execution path.

The revised worker runs the pinned `MiniMaxMusic3TokenizeStep` on CPU with the
local Qwen tokenizer before loading model weights. It uses the same lyric
normalization and upstream special-token formatting as generation. This exact
song has **405 actual input tokens**. Worker, benchmark, warm-stage validation,
and qualification now use that count consistently. A `promptMeasurement`
identity prevents old byte-bound profiles from being mistaken for actual-token
profiles. Tokenizer metadata changes also invalidate model calibration.

An existing local INT8 profile that fails identity, request or memory validation
now stops generation before loading unquantized weights. INT8 OOMs likewise
stop instead of silently retrying unquantized. Memory errors state required and
available GPU capacity. Selected precision is emitted before weight loading,
and both track and clip dialogs show execution status outside collapsed details.
Other machines without a local INT8 profile retain their standard model policy.

Current evidence (full-length requalification is still pending):

- **pass**: 69 policy/routing/runtime-pin checks, including expanded structured
  lyrics, byte-profile invalidation, pre-load precision reporting, rejection
  before unquantized loading, and no unquantized retry/publication on INT8 OOM.
- **pass**: three CPU tests of the actual pinned tokenizer step, including real
  maximum-token rejection and lyric normalization with Unicode; seven pipeline
  contract checks and seven placement checks including real bnb stage cycles.
  A fourth CPU test verifies that the capacity harness suppresses EOS only in
  its own process, leaves depth sampling/input tensors unchanged, and restores
  the upstream sampler even when the test raises an exception.
- `minimax-user-song-preflight-rejection`: **pass**. The real IPC worker rejected
  the stale profile in 3.682 seconds before inference/output; worker cleanup and
  wrong-model rejection passed. This does not qualify a successful long song.
- `minimax-user-song-int8-smoke`: **pass**. Exact user text, original seed
  470655306 and 30 steps, but explicitly shortened to five seconds for a smoke
  test: two 4.992-second outputs in 29.218 / 33.155 seconds, plus 37.319 seconds
  initial load. Worker `0d8b120bf2b69068`, 405 measured prompt tokens. These are
  not 195-second results; subjective quality is **not_asserted**.
- `minimax-user-song-int8-195s`: **budget rejection before inference**, not a
  passing output. A subsequent read-only budget probe measured 13.640 GiB
  available versus 13.675 GiB required, approximately 36 MiB short before any
  additional loading overhead. The user was asked to close unused GPU apps;
  no unrelated processes were stopped and the reserve was not reduced.
- `minimax-user-song-int8-full`: **pass after the user closed unused GPU apps**.
  Both requests used the exact supplied text, seed 470655306, a 195-second
  maximum and 30 diffusion steps. Generation took 817.379 / 1040.758 seconds,
  excluding 39.103 seconds initial load. Both outputs ended naturally at
  129.242 seconds and their decoded PCM was bit-exact across first/warm runs.
  Token generation took 655.531 / 877.813 seconds; synthesis took
  153.328 / 153.594 seconds. The logged synthesis loops reached 960 iterations
  (30 per audio chunk). Peak live allocations were 12.958 / 13.072 GiB;
  reservations peaked at 13.344 / 13.453 GiB. Whole-process RAM sampling stayed
  above 5.879 GiB. The first run reached the screenshot's 2170-frame checkpoint
  at 434.204 seconds excluding load. This is not a completed-baseline speed-up
  measurement, and the slower warm result is retained rather than hidden.
  Subjective song quality is **not_asserted**. The directory name denotes the
  full requested workload, not a 195-second output: separate maximum-length
  capacity qualification is required because this song ended early.
- `minimax-token-capacity-195s`: **incomplete capacity qualification**. The normal
  412-token fixture produced 184.517 seconds in 1213.837 seconds on its first
  run, then the redundant warm repeat was cancelled. This early EOS cannot
  qualify a 195-second output. `minimax-forced-capacity-195s` explicitly masks
  EOS inside the headless benchmark only; production sampling is unchanged.
  Qualification from this stress test requires both first/warm full-duration
  outputs plus matching separate normal first/warm generation evidence.
- `minimax-forced-capacity-195s`: **harness duration-check failure**, retained
  as failed evidence. The model completed 4876 semantic sampling calls (one
  initial advance plus 4875 emitted frames) and all 1440 synthesis iterations,
  producing finite stereo audio lasting 195.245 seconds in 1297.177 seconds.
  The test incorrectly required duration equality within 0.05 seconds despite
  upstream window-stitching padding. Capacity validation now requires at least
  the requested duration, and qualification never expands the duration bound
  beyond the request. Production code is unchanged.
- `minimax-forced-capacity-195s-validated`: **fail**. Cold output passed at
  195.245 seconds in 1289.409 seconds. Warm generation reached approximately
  4700 frames before a 192 MiB CUDA allocation failed. The initial hypothesis
  that a retained waveform occupied VRAM was **disproved**: the pinned MiniMax
  decoder defaults to a CPU NumPy output. GPU allocation instrumentation and
  inspection of `decoders.py` established that placement. The failed pair
  remains unqualified; it is not attributed to GPU waveform retention.
  `minimax-output-lifetime-smoke` passed two exact-text five-second requests
  after releasing the host waveform (30.698 / 33.648 seconds).
  `minimax-capacity-output-release-195s` produced a passing cold output in
  1299.485 seconds, then its warm repeat was cancelled when instrumentation
  disproved the GPU-waveform hypothesis. It does not qualify warm capacity.
- Worker `26da0b07c5653b3a` adds garbage collection and unused CUDA allocator
  cache reclamation once at the INT8 request boundary, after prior stages have
  been offloaded. It does not flush inside token or diffusion loops or change
  sampling. Two dedicated checks passed, including a real CUDA allocation test
  that preserves live tensor values while releasing unused cache. The 69
  policy checks and seven pipeline contract checks passed; CMake Debug was
  rebuilt. Earlier `0d8b120bf2b69068` results remain historical evidence and
  cannot publish this new worker's profile. Real-generation requalification
  is in progress.
- `minimax-request-cache-smoke`: **pass** on `26da0b07c5653b3a`. Exact user text,
  seed and 30 steps, explicitly limited to five seconds: cold/warm outputs took
  34.674 / 33.695 seconds. Warm request-boundary cleanup released 12,201,230,336
  bytes of unused CUDA cache. Both decoded outputs are bit-exact to the same
  five-second fixture before the cleanup change. This is deterministic parity,
  not subjective audio-quality approval or full-duration qualification.
- `minimax-request-cache-capacity-195s`: **resource_limit**, not pass. The new
  worker reached about 2660 frames before whole-system available RAM fell to
  1,710,899,200 bytes, below the 2 GiB floor. The watchdog stopped its worker
  tree. After exit, available RAM was 16.149 GiB, below the local model's
  approximately 18.4 GiB startup requirement and the earlier approximately
  23 GiB test starting condition. Other applications were left running. Full
  capacity requalification and the exact full-song normal-worker check remain
  pending restoration of sufficient system RAM. The old profile is not promoted.
- **pass**: TypeScript/Vite and CMake Debug builds; all 141 frontend assets and
  nine worker/helper copies matched. Browser checks exercised visible precision
  in both dialogs with details collapsed, narrow/wide wrapping, keyboard focus,
  and the explicit rejection message. Temporary browser/server/fixture resources
  were cleaned up. No C++ warnings/errors were reported by the Debug build.

The old local profile is deliberately not relabelled with the new worker hash.
The exact full-length request must pass first/warm qualification before the new
profile is published, followed by a normal-worker automatic-selection check.

September 13 follow-up: [full-song qualification and hardware warnings](ai-generation-qualification-2026-09-13.md)
records worker `77d8f16feb593810`, successful 195-second ACE-Step/Stable Audio
tests, the bounded SAME decoder and its numerical/audition limitations. MiniMax
full-duration requalification remains pending; the older profile is not promoted.

#### 1. Shared capability contract and reproducible baseline

Extend `tools/ai_runtime_probe.py` and introduce a small shared
`tools/ai_execution_policy.py`, consumed by both generation workers. Keep model
adapters in `diffusers_audio_pipeline.py` and `generate_music.py`; separation
retains its own `stem_separator.py` adapter. Avoid a rewrite of inference loops.

The contract records OS/architecture, physical adapter and device index,
CUDA/HIP/MPS/XPU/CPU family, driver/runtime/package pins, dtype support, available
device and host memory, unified-memory topology, CPU cores, supported streams,
and optional kernel import/forward results. A model capability record adds
workflow, component lifetime, attention mask/head shapes, placement modes,
quantizers, and compilation compatibility. Each candidate has one explicit
state: qualified, available-but-unqualified, unavailable, or excluded with reason.
An import success or an OS match must never imply model support.

Extend the headless smoke tooling with a benchmark runner that writes a
structured report and artifacts. Establish cold-load, prompt/prefill, token
decode, diffusion and waveform-decode baselines separately. Include time to
first progress, frames/second, complete latency, peak working set/commit and
VRAM, generated duration, transfers where measurable, and worker reuse. Record
the actual policy and optionally a bounded profiler trace of representative
forwards; do not synchronize every production operation for telemetry.

Acceptance: pure policy tests on all CI OS targets, installed-runtime operator
probes with timeouts, and an uncontended RTX 4080 baseline. Do not stop unrelated
user workloads automatically. If contention remains, label measurements as
contended and exclude them from comparative claims.

#### 2. Placement that uses available memory efficiently

Replace MiniMax's fixed 8/22/23 GiB decisions with a component/layer budget using
actual storage bytes, prompt length, requested duration, concurrent components,
KV cache growth and measured activation peaks. Keep the conservative policy as
the fallback when capacity measurements are missing. Count reusable allocator
memory once; never double-count shared parameters or unified host/device memory.

Implement candidates for full residency, stage/component offload, partial
residency with offloaded remaining blocks, block group offload, leaf group
offload, and a bounded disk-capacity fallback. Qualify each candidate separately
for every model adapter. Sequential offload remains excluded for Stable Audio
and ACE until the already-recorded warm-output/meta-tensor failures are resolved.
Disk offload is a capacity feature, evaluated after faster options; give it a
bounded app-owned cache, free-space checks and cancellation cleanup.

For MiniMax, keep RVQ and a budgeted subset of frequently reused Qwen layers
resident during autoregression. Include embedding/head direct calls in the
lifetime analysis. Load later diffusion/vocoder components only when needed if
the pinned ModularPipeline stage interfaces permit it, then release the LM and
KV cache before that stage. Measure the cold/warm cost of delayed loading.
Modular Diffusers supports component loading and stage composition, but the
exact MiniMax stage-state boundary must be tested against our pin.[^ai-modular]

Partial residency is an OpenStudio implementation task, not a switch that
ComponentsManager automatically supplies. First prototype supported selective
group hooks on disjoint modules; only proceed if outer manager hooks do not
move the full LM or evict its RVQ partner. Retain one placement owner per tensor
and one teardown path. If the pinned hooks cannot express this safely, isolate
a minimal upstream-compatible adapter or reviewed upstream change before
production adoption. Never stack device-map, Accelerate and group hooks on the
same parameters. Reset maps/remove hooks or rebuild between policies.

Benchmark synchronous versus streamed transfers, block versus leaf groups,
pre-pinned versus on-demand pinned memory, and `record_stream`. Streamed block
groups require size one in the documented implementation. Budget pinned host
memory and prefetch buffers; avoid a full extra LM copy on a constrained host.
Do not assume that larger groups retain more weights between token steps.
These choices affect transfer overhead differently.[^ai-memory]

Acceptance: fewer measured weight-transfer bytes or shorter stage latency,
bounded peak RAM/VRAM, no regression on already-resident configurations, and
cold/warm/model-switch/OOM/cancel tests. Preserve one bounded retry, resolved
seed, duration, steps, source audio and atomic clip publication. Replan at safe
request boundaries rather than migrating live tensors during a forward.

#### 3. Attention dispatch and optional runtime packages

Add `tools/ai_attention_policy.py` with component-specific adapters. For
Diffusers models use their supported attention dispatcher; for Qwen and other
Transformers encoders use their attention implementation interface. MiniMax's
RVQ decoder and BS-Roformer require their own audited paths. A top-level flag
must not claim to configure all of these implementations.[^ai-transformers-attn]

Qualify native automatic SDPA, native fused/efficient/cuDNN variants,
FlashAttention versions supported by the exact wheel/device, xFormers and AMD
AITER. Treat SageAttention and FP8/INT8 attention as numerical-change candidates
with a separate audio gate. Test actual causal/noncausal masks, padding, head
dimensions, dtype, long prompts and one-token decode. Benchmark prefill and
decode independently: a prefill win need not improve autoregressive decoding.
Do not combine attention slicing with an already-efficient backend without
evidence, or assume every custom attention layer uses the dispatcher.[^ai-attention]

Extend setup manifests and `tools/install_ai_tools.py` plus
`Source/StemSeparator.cpp` where setup is owned there. Stage exact optional
wheel/dependency sets in app-local runtimes, validate imports and real forwards,
then publish atomically. Keep the working environment on failure. Do not build
flash-attn at ordinary app startup or download executable Hub kernels during
generation. Windows FlashAttention needs separate wheel/ABI qualification;
upstream still calls out Windows build limitations.[^ai-flash-install]

Acceptance: the fastest qualified backend is selected for a representative
component workload, unsupported candidates return actionable reasons, and a
failed optional backend can rebuild onto qualified SDPA without masking a
model error. Trace actual kernels in the qualification harness; production
details distinguish selected policy from observed kernel. No broad package
installation or dependency upgrade just to satisfy a generic recipe.

#### 4. Model coverage and workflow qualification

All models participate in the common policy; unsupported combinations are
explicit adapter results rather than silently ignored settings.

| Model | Required optimization and validation coverage |
| --- | --- |
| MiniMax Music 3 | Lyrics/style and structured songs; separate Qwen prefill/decode, RVQ, condition encoder, diffusion and vocoder; BF16 partial residency first; attention on each applicable component; EOS-aware duration and growing KV memory. |
| Stable Audio 3 Medium | Text, variation, inpaint and continuation; transformer residency/group candidates, text encoder placement/attention, supported VAE memory controls; preserve deliberately mixed parameter/buffer dtypes and untouched source PCM. Retain FP32 on CPU/MPS: upstream identifies FP16 MPS noise.[^ai-stable] |
| ACE-Step 1.5 XL Turbo | Text/music, lyrics/style, variation, inpaint and continuation; transformer attention/placement, encoder and VAE lifetimes, existing tiling; remove hardcoded CUDA-only device/generator assumptions only with complete alternative-backend tests. Preserve Turbo's trained inference contract.[^ai-ace-current] |
| BS-Roformer separation | Effective audio-separator backend, actual SDPA behavior, supported autocast, memory-aware batch/chunk scheduling, overlap reconstruction and cancellation. Implement adapter-specific memory handling; do not call Diffusers offload APIs on this engine. |

No new model formats or export engines are required by this plan. ONNX/TensorRT,
Core ML, OpenVINO and architecture-specific distributed systems remain separate
projects until they demonstrate these exact audio workflows.

#### 5. Hardware matrix and resource coordination

Implement device enumeration and explicit device indices instead of assuming
GPU 0. Select a qualified runtime by accelerator and architecture, then choose
a policy by current memory and workload. Centralize the device/generator/memory
operations currently hardcoded to CUDA in ACE. Use adaptive, bounded CPU thread
counts instead of assuming four threads are optimal for every host.

| Platform/hardware | Implementation and qualification work |
| --- | --- |
| Windows/Linux NVIDIA | Qualify current and older supported architectures, BF16 or validated FP16/FP32, native SDPA and available Flash/xFormers kernels; test 4/6/8/12/16/24/32+ GiB capacity classes. Small-capacity results may be unsupported for a model. |
| Linux AMD discrete GPUs/APUs | Match ROCm wheel/driver/GPU support, distinguish HIP from NVIDIA, evaluate supported SDPA/AITER, and account for discrete versus shared memory. |
| Windows AMD | Add a native ROCm route only for hardware/runtime combinations in AMD's compatibility matrix and after generation tests. Existing DirectML separation support remains distinct; no implied DirectML generation support.[^ai-amd-windows] |
| macOS Apple Silicon | Native arm64/MPS with a single unified-memory budget, per-model precision/operator probes, bounded working set and no CUDA pinning assumptions. Qualify small and large memory systems. |
| Windows/Linux Intel GPU | Add XPU runtime installation, enumeration, generators, memory reporting and model-forward qualification; prefer native XPU attention/compile where demonstrated. PyTorch XPU availability alone does not establish audio-pipeline compatibility.[^ai-xpu] |
| CPU-only x86/arm64, including Intel Macs/Windows arm64 where dependencies exist | Qualify native wheels and required operators, benchmark thread pools and supported vectorized precision/quantization; report unsupported capacity/package combinations honestly. Preserve the DAW's audio-thread budget. |
| Multiple GPUs | Select the fastest fitting device first; compare supported layer/component placement with single-device offload using real interconnect measurements. Separate capacity improvements from latency gains; do not claim ordinary device maps parallelize sequential token generation. |

Coordinate generation and separation allocations through the existing host/job
ownership flow, including still-warm workers. Release idle allocations under
pressure; preserve bounded warm reuse when it measurably helps. Do not create
concurrent songs solely to increase utilization. Test playback/recording
underruns, interface latency and UI responsiveness during generation. A quieter
audio workload may allow a larger worker budget, but never perform blocking
resource coordination on the realtime audio callback.

#### 6. Quantization, compilation and caching after the baseline work

Evaluate INT8/weight-only INT8, selective quantization, TorchAO and supported
lower-precision storage per component and device. Quantization availability is
determined by the pinned backend and operator, not a general library marketing
matrix. Use Transformers configs for Qwen and Diffusers configs for Diffusers
components. Preserve original snapshots; derived artifacts need revision,
quantizer, excluded-module, dtype and runtime provenance.[^ai-quant][^ai-torchao]

**The previously rejected NF4 result stays excluded.** Revisit it only as a new,
clearly identified experiment with a concrete explanation for the prior failure
and fresh audition; a faster finite WAV does not reverse that failure. Keep
unquantized vocoder/output-sensitive components initially. Load-time RAM peaks,
dequantization cost and quantizer/offload-hook compatibility are acceptance
criteria alongside throughput. There is no automatic quality downgrade on OOM.

Qualify regional compilation before full-pipeline compilation; replace the
global Dynamo disable only for proven component/runtime combinations. Include
compiler/toolchain setup, cold compile time, amortization across expected warm
requests, shape changes, cache invalidation and a disk quota. Test compile with
each enabled attention/placement/quantization combination, not independently
and then blindly together.[^ai-speed][^ai-combinations]

Preserve MiniMax's existing KV cache. Static/offloaded/quantized caches require
integration with its custom upstream loop, not unsupported generation kwargs.
Bound conditioning caches and key them by complete source/prompt/model state.
Approximate diffusion caches, SageAttention and other numerical changes require
separate model-specific evidence and audition; do not silently shorten songs,
reduce steps or change guidance to meet a speed target.

#### 7. Selection, telemetry and delivery gates

Use qualified conservative defaults on first run. A bounded calibration in the
headless harness can choose among valid execution policies; production can
reuse that result keyed by hardware, driver, model/runtime revisions, workload
shape class and policy version. Invalidate stale results and keep calibration
time separate from generation time. Minimize measured latency subject to memory
and audio constraints; more than one policy may be appropriate for a device.

Expose effective device, precision, component placement, attention policy,
transfer mode, phase throughput and fallback reason through `AITrackEngine`,
`NativeBridge.ts` and the existing generation details. Keep ordinary song
creation automatic. Availability metadata and tested defaults replace a pile
of unsupported tuning switches or production feature flags. Keep hardware
policy outside portable musical project state; any persisted additions require
old-project/preset/Compare/portable round-trip coverage before schema changes.

Deliver in reviewable slices: (A) baseline/capabilities, (B) BF16 placement and
transfer tuning across adapters, (C) attention and staged runtime packages,
(D) platform adapters/resource coordination, (E) individually qualified
quantization/compile/cache improvements, (F) UI and release qualification.
Platform test coverage starts with A rather than being bolted on after E.

For each slice run meaningful policy/adapter and worker lifecycle tests, then
real short cold/warm requests and every supported workflow. Compare identical
inputs/parameters under matched resource conditions, with warm-up separated
and at least three timed repetitions where practical. Report medians, range,
actual generated length and timeouts. Follow with realistic 30/60-second and
maximum-duration capacity tests on representative hardware. EOS differences
must not be counted as speed improvements; report token throughput as well.

Promotion requires functional checks, a repeatable latency or capacity benefit,
acceptable peak resources, and no regression beyond measured noise on existing
fast paths. Subjective audio reports remain `diagnostic_only` or `not_asserted`
until audition; a rejected artifact is `fail`. Simulated device tests cover
selection logic only. Real NVIDIA, AMD, Apple and Intel machines are required
before claiming those execution configurations are qualified.

Frontend changes require TypeScript checks and browser geometry/accessibility
QA. Before a manual app handoff build `frontend/dist`, complete
`cmake --build build --config Debug`, stop agent-owned harness/dev processes and
verify no agent-owned listener remains on 5183. The user should need only
`python build.py dev --run`. Published performance claims additionally require
the normal release-notes and packaged-platform gates. The implementation
checkpoint above records which local checks have actually run.

### Research sources

The links below were reviewed on 2026-09-11; Hugging Face publishes these as
living documentation. Core memory, attention, Modular Diffusers, hardware and
quantization guidance was rechecked for the September 12 plan; the additional
references below identify that review. Resolve implementation details against
the pinned source rather than assuming a main-branch API exists locally.

[^ai-modular]: Hugging Face, [ModularPipeline component loading and stage composition](https://huggingface.co/docs/diffusers/main/en/modular_diffusers/modular_pipeline) and [ComponentsManager](https://huggingface.co/docs/diffusers/main/en/modular_diffusers/components_manager), reviewed 2026-09-12.
[^ai-transformers-attn]: Hugging Face, [Transformers attention interfaces](https://huggingface.co/docs/transformers/main/en/attention_interface), reviewed 2026-09-12.
[^ai-flash-install]: Dao-AILab, [FlashAttention installation and hardware requirements](https://github.com/Dao-AILab/flash-attention), reviewed 2026-09-12.
[^ai-amd-windows]: AMD, [Windows ROCm compatibility matrices](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/windows/windows_compatibility.html), reviewed 2026-09-12.
[^ai-xpu]: PyTorch, [Getting started on Intel GPU](https://github.com/pytorch/pytorch/blob/main/docs/source/notes/get_start_xpu.md), reviewed 2026-09-12.
[^ai-ace-current]: Hugging Face, [ACE-Step 1.5](https://huggingface.co/docs/diffusers/api/pipelines/ace_step), reviewed 2026-09-12.

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


## Explicit saved INT8 variants (development, September 16, 2026)

The generation and AI Tools Setup dialogs now have Original/INT8 version choices
for all three music models. This opt-in path is separate from the historical
locally auditioned MiniMax calibration described above. It does not promote or
rewrite that calibration. The selected version is part of the request and track
parameters; missing/corrupt INT8 snapshots fail without an Original fallback.

Setup installs bitsandbytes 0.50.2 without replacing the runtime dependency stack.
It reuses installed originals or downloads the official sources and prepares a
serialized INT8 component once. There is no smaller hosted download advertised:
the first transfer still uses the original weights. Prepared OpenStudio INT8
folders can be imported. Both versions coexist in managed storage. ACE-Step
uses official Diffusers revision 200ba991ae448051e14b0183157e35c2d27c9fb0; the
existing Stable Audio and MiniMax source pins remain in prepare_diffusers_audio.py.

The component is the diffusion transformer for ACE-Step/Stable Audio and the
language model (including output projection) for MiniMax. Other components keep
normal inference precision. The implementation uses supported save_pretrained /
from_pretrained serialization: https://huggingface.co/docs/diffusers/quantization/bitsandbytes.
Current exposure is NVIDIA CUDA only; other physical backends were not qualified.

MiniMax's saved variant backs inactive immutable weights with an app-owned,
quota-bounded temporary disk cache, uploading once per stage rather than per LM
token. Quantized aliases and scales move with their parameters; cache cleanup
covers normal unload and stale workers. Request cache plus a separate 1.5-GiB
GPU reserve is checked before generation. Initial load can be slower and needs
about 15 GiB of temporary disk space. Quantization is not a guarantee of speed,
fit, or equivalent audio quality. See [the dated local evidence](ai-quantization-2026-09-16.md).
