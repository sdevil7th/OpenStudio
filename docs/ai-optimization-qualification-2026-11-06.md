# AI memory and acceleration qualification — November 6, 2026

These tests used development builds of the AI workers and native host.
The measurements apply to the specific builds and hardware described below.

## Machines and source

- Windows: Ryzen 9 7900X, 32 GB RAM, NVIDIA RTX 4080 16 GB. Stem tests use
  Torch 2.11.0+cu128 and audio-separator 0.41.1. Generation tests use the
  separate, disposable qualification runtime with Diffusers commit
  `7643c4826609c47755e3da0e5b768e8070468f49`, Transformers 5.16.1 and
  Accelerate 1.14.0. Optional compiler tests use triton-windows 3.6.0.post26.
- Linux: Ubuntu 26.04, Ryzen AI MAX+ 395, Radeon 8060S/gfx1151, 128 GB unified
  memory. The isolated runtime has Torch 2.9.1+ROCm 7.2, audio-separator 0.41.1
  and Diffusers 0.39.0. The ROCm recipe checks Torch's runtime version, HIP
  version, architecture, separator version and checkpoint/config SHA-256.
- Song: the user-approved source is a 410.870125-second MP3 mixdown.
  The similarly named WAV was a different mix and did not contain the expected
  main vocal. Rejected previews from that WAV are not quality evidence.
  Original project and media remain unchanged.

Reports, immutable worker snapshots, source hashes, audio and retained failures
are under `output/ai-optimization-qualification/`; earlier issue investigation
and installer evidence remain under `output/ai-optimizations/` and
`output/issue-38-investigation/`. Reports record the actual worker source used;
later edits do not retroactively qualify an earlier run.

## Separation

**Pass — deterministic correctness:** full-song NVIDIA streaming and the
original full-buffer path have identical stored samples in all six stems.
The new Automatic path was also exercised with a reported 2 GiB qualification
RAM limit. It selected rolling buffers, retained CUDA weights and matched every
stored reference sample. That RAM limit is fault injection, not a claim that
the host physically had only 2 GiB free. Its observed peak Torch allocation
was 1,899,336,704 bytes. Earlier CPU and ROCm 31-second comparisons also matched.

Automatic rolling selection requires the reviewed six-stem checkpoint,
audio-separator 0.41.1, a tested backend, known mono/stereo metadata and disk
headroom. Explicit 30-second sections remain available and take precedence;
their boundaries can change results. Unsupported automatic configurations
retain the section strategy. The explicit rolling option also supports the
tested FFmpeg fallback path.

**Pass — decoder invariants:** PCM16, PCM24, float WAV, FLAC, VBR MP3 and AAC/M4A
were compared with an independent whole-source decode/resample on Windows and
Linux. Streaming reads are bounded; fractional tails and mono channel count
are retained. Invalid/nonfinite input fails without publishing stems.
These checks do not assert subjective codec or separation quality.

**Pass — native publication/cancellation:** the Windows native worker completed
six-stem rolling separation with CUDA tensor/allocation receipts. Cancellation
during decode and inference acknowledged worker retirement and removed owned
scratch/output staging. File-lock tests retain the ownership marker until all
data files are removable. Windows retirement requires both the process handle
and its child job to finish. The initial cleanup failure is retained; it
deleted its marker before locked files, and is not counted as a pass.

The installer regression now runs both regular and rolling six-stem inference
through the actual newly installed/repaired interpreter, with GPU tensor
receipts. The current fresh Windows CUDA stem-only path and existing CPU-to-CUDA
repair with both feature selections passed twelve regular/rolling inference
cases in total. Generation dependencies were installed in the latter test;
generation checkpoints and inference were explicitly outside that installer case. Its CI hardware workflow remains manually dispatched; local tests do
not imply that every remote hardware job has run.

## ROCm FP16/AOTriton

Three fresh-process full-song runs per policy, with the same checkpoint and
request:

| Policy | Elapsed seconds | Median | Peak Torch allocation |
| --- | --- | --- | --- |
| FP32 | 214.811, 216.508, 217.444 | 216.508 s | 7,237,764,096 bytes |
| FP16 + AOTriton | 69.580, 69.842, 69.983 | 69.842 s | 2,005,129,728 bytes |

**Pass — exact recipe and rolling combination:** the new opt-in recipe
completed the full song in 68.478 seconds with rolling buffers. All six stored
stems matched the FP16 full-buffer reference exactly. These are device
allocator figures; the AMD machine uses unified memory.

**User audition accepted:** the presented vocal, guitar and drum excerpts had
“No new degradation heard.” This acceptance is scoped to those artifacts.
Other songs, instruments, runtime versions and AMD architectures are
**not_asserted**. Standard precision remains the default; unmatched recipes
keep it. A CPU fallback also returns to standard CPU precision.

## Generation memory and compilation

**Pass — ACE-Step bounded disk placement:** only transformer blocks use disk
backing. The condition/text encoders and VAE retain their audited placement;
direct encode/decode calls are not covered by generic forward hooks. Storage
has one owner, unique per-load/component paths, quota/disk admission and a
request lease. Closing retires the models before storage removal.

The Windows ordinary component-offload attempt completed two short requests
then reached the host-RAM guard. A native Diffusers disk-hook attempt crashed
before inference with `0xC0000005`; this is a separate retained failure, not
issue #38's `0xC0000409`. The production candidate uses immutable app-owned
storage and bounded synchronous block reads instead.

The normal persistent worker passed 30, 30, 60 and 30-second requests and idle
shutdown with explicit disk placement. Automatic placement then passed the
same sequence: 60.55 seconds cold, followed by 30.92, 31.66 and 31.02 seconds.
Automatic and explicit disk outputs were sample-identical for all four
requests. Peak allocation was approximately 3.86 GiB for 30 seconds and 4.03
GiB for 60 seconds. Automatic disk selection is scoped to the tested Windows
CUDA/Torch 2.11 BF16 ACE adapter and host-copy budget; a warm disk policy stays
stable until unload. Other configurations retain their existing planner.

**Pass — real compilation, not wrapper availability:** observed Torch-Compiled
Regions were required during real generation. Stable Audio's compiled
persistent worker passed 30, 30, 60 and 30-second requests, then shutdown.
Compilation targets repeated blocks; transfers and disk reads stay eager.
CUDA graphs are disabled, matmul precision is unchanged, and compilation is
opt-in. The native host starts a new worker when the requested optimization
changes.

For Stable Audio 30-second direct-session tests, the unprofiled warm compiled
run took 0.533 seconds; ordinary warm runs took 0.843–0.906 seconds. Compilation
increased the first request from 5.134 to 15.816 seconds. Profiling runs must
not be included in performance medians. The original benchmark's short ACE
request was normalized from 5 to 10 seconds; those artifacts do not establish
5-second output. ACE compilation with disk placement provided no useful warm
speed improvement in that test.

Compilation changed Stable Audio samples (relative L2 difference 0.1394 is
**diagnostic_only**). Compiled subjective quality is **not_asserted separately**
from the user's three-way response. It is not selected automatically.

Compiler storage is private to a worker, with quota admission and an enforced
per-worker reservation. Imported Windows compiler DLLs remain locked until
process exit; cleanup retains the ownership marker and the next worker
reclaims only retired PID/birth pairs. The first shutdown failure and the
subsequent passing retirement test are both retained.

## Additional Linux generation startup finding

**Pass — execution:** the current frozen ROCm worker completed variation and
inpainting at 31 seconds, eight-second continuation, and 30-second text
generation, then retired cleanly. Their request times were 556.750, 193.405,
348.364 and 85.706 seconds. This exposes a substantial first-shape startup cost;
previous warm ordinary requests were much faster. Source-pattern preservation
is **diagnostic_only** because the pinned ACE snapshot lacks audio tokenizer/
detokenizer weights; the worker reports this limitation. Valid output does not
prove the intended cover pattern.

**Initial candidate:** a separate process using `MIOPEN_FIND_MODE=FAST`, initially
empty private MIOpen database/kernel directories and identical requests completed
in 19.754, 7.270, 8.516 and 4.505 seconds and retired cleanly. AMD documents
[fast selection and private caches](https://rocm.docs.amd.com/_/downloads/MIOpen/en/docs-7.2.2/pdf/).
The intervention is consistent with convolution selection contributing to slow
startup; no MIOpen API/kernel trace established exclusive causality. This is
one sequence per policy, not a three-repetition performance qualification.

The WAVs are not sample-identical. Relative L2 differences range from 0.0061
to 0.3891 (**diagnostic_only**); neither those metrics nor finite output establish
subjective quality. Paired previews cover variation, the inpaint interval,
continuation and text output. The user subsequently reported **“No new
degradation heard”** for these exact paired previews. Their hashes and scope are
in `audition-record.json`; quality of other outputs is not asserted.

**Qualified opt-in after integration:** three fresh workers with initially empty
private MIOpen database/kernel directories completed all four workflows and
retired cleanly. Median request times were 17.957, 7.223, 8.395 and 4.495 seconds;
the first-request range was 16.975–20.209 seconds. The standard baseline above
has one sequence, so these are recorded timings rather than a universal speed
factor. Repeated fast outputs are not sample-identical to the accepted reference;
the differences are diagnostic only, and the app explains that audio can vary.

AI Tools Setup now offers **Faster startup — qualified AMD** for ACE-Step Original
on Linux gfx1151. The worker requires Torch `2.9.1+rocm7.2.0.git7e1940d4`, HIP
`7.2.26015-fc0010cf6a`, MIOpen 3.5.1, Diffusers 0.39.0, cached snapshot
`200ba991ae448051e14b0183157e35c2d27c9fb0` and the recorded index/transformer/VAE
configuration hashes. It checks before allocating model weights, requires
resident placement and rejects other precision/attention/compile combinations.
A final four-workflow sequence with the additional MIOpen-version guard passed,
as did real read-only preflight. This changes only a new worker's environment;
Automatic remains the standard default. Local preferences stay outside projects.
A separate 30/60/600/30-second sequence passed, including a 600-second output
in 250.540 seconds, then a 4.077-second warm 30-second request and clean shutdown.
The ten-minute peak was 28,475,709,952 device-allocation bytes (26.52 GiB), with
11,085,397,636 weight bytes. This exposed an underestimate in the generic
reservation. The recipe now uses a conservative envelope: 5 GiB activation/
headroom reserve through 60 seconds, growing to 21 GiB at 600 seconds. Preflight
and loaded-model admission use the same reserve; a regression rejects residency
when a 30 GiB budget cannot fit the ten-minute workload. This budget test does
not qualify a physical 30 GiB device. The final recipe validation and four-workflow worker
sequence passed with hardened admission without changing inference precision
or musical parameters. Real 600-second preflight on that final source reported
resident placement with the full 21 GiB reserve. The recorded capacity timings precede that reservation
adjustment; the selected resident execution is unchanged on the 128 GiB host.
It is distinct from the qualified FP16/AOTriton stem recipe. Exact reports and
private-cache provenance are under `linux-reports/phase7/`, with integrated
sequences retained in `linux-reports/phase8`, `phase9` and `phase10`.

## Quantization decision

**Pass — execution only:** TorchAO INT8 Stable Audio completed three 30-second
generations and a persistent 30/30/60/30 sequence. Peak allocation fell from
5,315,287,040 to 3,877,268,480 bytes; warm inference was slightly slower.

**Fail — user audition:** “Degradation in INT8.” Exact preview hashes and the
response are in `audition-record.json`. This candidate is now rejected before
model allocation in production selection and Stable Audio session loading.
Original remains the default. This does not establish a result for separately
saved bitsandbytes INT8 variants; their earlier evidence and limitations remain
in [September's quantization notes](ai-quantization-2026-09-16.md). NF4 remains
excluded after its earlier rejected audition.

## FP8 storage and local preferences

**FP8 storage — pass for recorded forwards and exact audition:** a separate
Stable Audio recipe keeps normalization, conditioning, timestep and audio
boundary projections at normal precision. Selected attention/feed-forward
weights use FP8 storage and BF16 computation. Transformer storage decreased
from 2,906,341,920 to 2,226,864,672 bytes; 30-second peak device allocation was
4,637,663,232 bytes. The user reported “No new degradation heard” for the exact
30-second preview. This does not establish universal output quality.

The persistent worker passed 30/30/60/30/300 seconds, variation, inpainting and
continuation. An isolated runtime matching the app's Torch 2.10 CUDA installer
also passed eight mixed requests, including 300 seconds and all source
workflows. Its 30-second output matched the auditioned Torch 2.11 output within
one PCM16 sample step; separate listening acceptance for that file is
`not_asserted`. The final eight-request rerun also checked that FP8 parameter
storage was restored after every forward, including source-pipeline changes.
Original model files are retained. App choices are restricted
to the recorded Windows RTX 4080 configuration; additional hardware remains
unqualified. Saved INT8 is separate and never combined with these options.

The frontend stores per-model execution choices in local device preferences and
adds them only at the native request boundary. Project/track/preset parameters
remain unchanged. Browser transport and geometry tests cover the setting,
native request and hardware-check propagation, and exclusion from saved INT8.

## MiniMax and remaining limits

The planner now accounts for measured component weights, simultaneous LM/RVQ
placement, real request token/KV storage and bounded prefetch staging rather
than only fixed GPU-size thresholds. An explicit partial/disk candidate can
archive each component before loading the next. CPU/CUDA tests verify separate
equal-shaped components, exact stored weights, stage moves and cleanup.

**Pass — bounded short real inference:** the pinned 26.6 GiB MiniMax snapshot
is present on E:. All 23 files passed upstream LFS SHA256 or git-blob identity
and size checks. Component-by-component disk loading completed in 68.681 seconds
on the 32 GiB Windows host. Two declared five-second, 30-step, normal-EOS
requests completed in 483.809 and 427.448 seconds, each producing 4.99229 seconds
of finite stereo 44.1 kHz output. Peak Torch device allocation was about
8.87 GiB; actual parameters were on CUDA and normal BF16 precision was retained.
The process completed and released its owned state. All 23 source files still
matched their verified hashes after inference. Subjective MiniMax quality
is **not_asserted**. These are two short requests, not 30/60/300-second or
structured-song qualification. At this gate, Original partial residency and disk staging
were experimental and excluded from automatic promotion. The November 7 automatic
loading follow-up below supersedes that restriction for its recorded scope. Do not interpret small-module
tests as full MiniMax qualification, or load an old local calibration after the
worker/runtime/model identity changes.

The short run uploaded 1,312,807,523,328 weight bytes. A separate post-inference
128 MiB pinned-memory probe measured median CPU-to-GPU 3.385 GB/s and GPU-to-CPU
3.353 GB/s across three copies in each direction. NVIDIA reported Gen 1 x16
under both model load and the copy probe (the card reports Gen 4 capability).
These measured transfer limits contribute materially to offload latency on the
**current Ryzen 9 7900X/RTX 4080 test PC**. The reading alone does not identify a
BIOS, motherboard, driver or firmware cause. No system configuration was changed.
This is separate from issue #38's CPU-wheel/DirectML failure on the reporter's
i7-12700/RTX 3060 machine. Transfer and model reports retain the driver/runtime
identity; faster-link extrapolations are not benchmark results.

Native worker identity now uses one dependency manifest shared by C++ and
Python. Actual native ready/retirement checks passed for standard and compiled
ACE/Stable workers. Missing manifests and mismatched versions were rejected.
These handshake tests do not themselves prove inference.

Physical Apple/Intel GPU execution, other NVIDIA/AMD families, Linux native
window/packaging behavior, and universal audio quality remain **not_asserted**.
The default AI installer does not silently add compiler packages. The November 7
follow-up below adds explicit app setup in a separate compiler runtime, with
real-forward validation before activation. Bounded-memory, FP8 and qualified
AMD startup choices also have app controls in the development checkout.

## Model locations

An all-drive accessible-file scan covered C:, D: and E: (about 6.1 million file
paths). It found original/converted Stable Audio 3 on C: and ACE-Step snapshots
in MoDiff's cache on E:, which were reused read-only. It found no existing
MiniMax Music 3 weights or OpenStudio saved-INT8 markers. Protected directories
were reported as unreadable, not assumed empty.

The app currently has no AI storage-drive selector. Importing a model from
another drive copies it into managed storage. Windows runtimes and most models
use `%LOCALAPPDATA%/OpenStudio`; ACE-Step uses a separate home-directory cache.
External-drive storage needs a coordinated location setting for models,
runtimes, download/conversion caches and offload storage, with existing paths
retained until a verified migration completes.

## Final development checks

The latest frontend production build, e2e typecheck, 20 focused frontend unit
tests and eight Chromium interaction/geometry tests passed. The latter includes
complete six-stem publication, undo/source placement, cancelled stale results,
rolling/AMD options, and local generation preferences reaching both preflight
and generation without entering project data. Unsupported FP8 device choices
are disabled. These browser tests use the native-bridge fixture, not a claim
of Windows Release WebView qualification.

The latest CMake Debug build completed without compiler diagnostics. All 422
native safety checks passed. Current packaged workers passed native FP8/compiled
handshakes and actual CUDA rolling separation; handshake success alone does not
prove generation. The final Windows Python policy and integration sets passed
105 and 78 tests respectively. Linux's current frozen AI policy set passed 95
tests after the required workflow fixture was included; the initial missing-
fixture failure is retained. Remote CI has not been dispatched for this tree.

The original project, original WAV and accepted MP3 still match their recorded
SHA256 identities. Port 5183 has no qualification-owned dev server left running.

The follow-up AMD option checks passed 103 focused Windows policy/integration
tests, 71 Linux policy tests, 20 frontend unit tests and eight browser scenarios.
Native hardware status now includes platform (previously omitted) and GPU
architecture; the native regression covers that payload and rejects ambiguous
multiple-GPU architecture selection. Missing platform data could previously
leave the FP8 option unavailable despite a qualified runtime. The latest native
manifest handshake passed with the new startup helper packaged. Linux native
window/packaging integration remains not asserted by these separate checks.

## November 7 follow-up: Stable Audio compilation setup

**Pass — exact-artifact listening:** the user reported **"No new degradation
heard"** for the paired 30-second `compile210-fair-standard/run-1.wav` and
`compile210-fair-compile/run-1.wav` previews. Their SHA256 identities and the
reply are retained in `output/ai-optimization-qualification/audition-record.json`.
This acceptance applies to those previews, not earlier compiled artifacts,
every generated result, or another hardware/runtime recipe.

The tested setup is Windows RTX 4080, Python 3.11, Torch 2.10.0+cu128 and
Triton Windows 3.6.0.post26, using the pinned Diffusers revision listed above.
The native app now offers **Prepare optional compilation** for installed Stable
Audio Original. It stages a separate runtime, installs the reviewed dependency
closure, checks package consistency/provenance, and performs two real 30-second
compiled generations through normal worker IPC. Activation requires readable,
finite, duration-checked outputs, observed Torch-Compiled Regions, graceful
shutdown and worker retirement. Selecting compilation routes native preflight
and generation to that slot. Standard precision and the default runtime remain
available. The local selection stays outside project parameters and saved INT8.

The installer admits within a 32 GiB owned root budget and requires 20 GiB free.
Repair stages a replacement; the active marker changes only after successful
validation. The previous slot remains available, and pruning checks ownership,
PID/birth and actual executable retirement before removing an inactive slot.
It does not rewrite the original model or standard runtime.

| Gate | Result and exact scope |
|---|---|
| New isolated compiler slot | **pass** — public bootstrap identity, reviewed dependencies, self-contained runtime, two compiled 30-second requests, activation and retirement |
| Mixed workflows in that freshly installed runtime | **pass** — 30/30/60/300-second text requests plus 31-second variation/inpainting, 8-second continuation and another 31-second text request |
| Failed upgrade | **pass** — actual corrupt bootstrap fails integrity validation; previous active selection is unchanged |
| CLI repair | **pass** — a different validated slot is selected and the previous slot retained |
| Native app fresh setup | **pass** — real installer, ready status, compiler runtime selection, preflight, compiled 30-second generation and retirement; standard runtime fingerprint unchanged |
| Native app repair | **pass** — a new validated slot selected, previous slot retained, standard runtime fingerprint unchanged; native preflight, compiled 30-second output and retirement passed again |
| Subjective quality of setup/native/mixed-workflow outputs | **not_asserted** — these are execution checks; only the paired previews above were accepted |

Retained staged evidence is under
`output/ai-optimization-qualification/compiler-staged-evidence-v4/`.
The native reports are
`E:/OpenStudio-AI-Qualification/native-compiler-flow/native-result-{fresh,repair}.json`;
copies and independent readable/finite 30-second stereo WAV checks are retained
under `output/ai-optimization-qualification/compiler-native-evidence/`. The
current native CUDA rolling separation smoke also passed and retired its worker.
Initial failed candidates are retained: a Windows subprocess compile pool
rejected `pass_fds`; the fix uses one Inductor compile worker on Windows.
A transported CRLF requirements file exposed a recipe identity mismatch;
checks now canonicalize UTF-8 BOM/newlines, with LF/CRLF/BOM regression coverage.
Neither failed candidate became active.

**Diagnostic performance — not a universal speed claim:** fair normal-IPC
sequences of four 30-second requests measured standard first/warm-median
17.578/2.063 seconds and compiled 36.938/1.453 seconds. On that sequence the
extra cold cost would take about 32 warm requests to recover. This is one cold
sequence per mode; different shapes, steps and runtime conditions can change
both compilation cost and benefit. Compilation is opt-in and changes no matmul
precision or CUDA-graph policy.

Final follow-up checks passed 108 Windows AI policy tests, 129 focused integration
tests, 35 frontend unit tests, nine Chromium interaction/geometry scenarios,
the frontend production build and e2e typecheck, and 426 native safety checks.
The Debug CMake build completed without C++ compiler diagnostics. The website
guide typecheck and direct Vite build also passed. These do not qualify Windows
Release WebViews or publish a release.

The final frozen Linux helper set passed 108 policy tests and real 30-second
ACE-Step generation using the qualified MIOpen option (12.123 seconds), followed
by graceful shutdown and retirement. Its 160 input file hashes and report are
under `output/ai-optimization-qualification/linux-reports/phase12/`. The preceding
phase 11 bundle omitted a workflow file used by two release-policy tests; that
failed bundle/log is retained, and phase 12 includes and hashes the fixture.
Linux generation compilation was not enabled or inferred from this AMD smoke.

The final Debug refresh passed with 23 worker/setup assets and all 148 current
frontend files matching their source/build inputs. The original project, WAV
and accepted MP3 still match their recorded SHA256 values. No qualification-owned
worker or server remains running, and port 5183 is clear. The unrelated MoDiff
worker was left untouched. `python build.py dev --run` needs no pre-running server.

## Automatic generation loading and longer MiniMax — November 7 follow-up

This follow-up keeps Original weights, normal BF16 computation, native attention,
request duration, lyrics, seed and step count. It changes loading and placement,
not the generation algorithm. New outputs have **not_asserted** subjective audio
quality; earlier accepted FP8/compiled/AMD previews do not cover these artifacts.

### Loading failure and correction

The first bounded Windows 30-second attempt reached the harness's system-RAM
safety floor during component loading and was retired. Selecting inference
offload alone did not bound the earlier CPU conversion peak. Loading now reads
checkpoint headers first, reserves conversion/staging headroom and archives one
component before loading the next. When CPU conversion cannot fit but the
component fits on the selected GPU, it loads there before archiving. Registered
buffers also return to CPU. File writes finish before the next component loads;
temporary GPU loading allocations are released before the inference budget is
assigned. The inference planner counts the owner's reusable allocator pool.

Larger MiniMax duration **or normalized input-token count** now rebuilds every
placement budget, including resident and ordinary group modes. Previously the
growth check covered only partial-resident/saved-INT8 sessions. Smaller requests
can reuse an already admitted session. No lower precision is selected implicitly.

### Completed worker checks

| Host and workload | Result and actual scope |
|---|---|
| Windows RTX 4080 16 GiB / 32 GiB RAM, Original automatic 30-second MiniMax | **pass** — CUDA BF16 with disk-backed partial placement; finite stereo 44.1 kHz, 30.023401 seconds; owned worker retired |
| Linux Radeon 8060S / 128 GiB shared memory, MiniMax normal 30/60 seconds | **pass** — resident BF16; 30.023401/60.070023-second outputs, including request-growth rebuild |
| Same Linux host, MiniMax normal structured 300-second maximum followed by 30 seconds | **pass** — normal EOS ended the long song at 125.561905 seconds; subsequent 30.023401-second request and graceful retirement passed. This establishes normal-worker behavior, not full 300-second capacity |
| Same Linux host, MiniMax EOS-suppressed full 300-second capacity | **pass** — all 7,500 AR frames, 30 denoising steps across 74 windows, full decoding and process retirement; exact 13,247,488 samples / 300.396553 seconds at stereo 44.1 kHz |
| Same Linux host, ACE-Step automatic 30/60/30 seconds | **pass** — resident BF16, exact requested output lengths, warm reuse, graceful retirement |
| Same Linux host, Stable Audio automatic 30/300/30 seconds | **pass** — resident BF16, exact requested output lengths, warm reuse, graceful retirement |

The Windows 30-second MiniMax request took 4,120.484 seconds in its reported
generation phases, including 4,069.250 seconds composing tokens. Peak Torch
allocation was 6,258,163,712 bytes. Under the concurrent host/GPU load the planner
retained zero language-model transformer blocks and streamed weights for GPU
computation. The measured Gen 1 PCIe link described above and repeated transfers
make this functional result **very slow**; it is not a speed qualification or a
300-second capacity result for the 16 GiB GPU.

The Linux MiniMax long normal request took 1,971.403 seconds; its warm short
request took 402.399 seconds. Peak device allocation across these requests was
25,093,330,432 bytes. ACE-Step's three requests took 246.819/258.725/6.306 seconds
with peak allocation 13,737,185,792 bytes. Stable Audio took
19.896/95.710/6.496 seconds with peak allocation 7,895,045,632 bytes. ACE/Stable
ran serially to one another while the independent MiniMax capacity workload was
active: these timings are **diagnostic_only**, not isolated speed comparisons.
Native app exclusivity is a separate Windows test, not inferred from these
independent Linux workers.

MiniMax's pinned upstream decoder stitches overlapping windows. Its exact
30/60-second maxima are 1,324,032/2,649,088 samples, so a fixed 50 ms tolerance
incorrectly rejected the otherwise successful 60-second output. The original
failed QA report is retained; a separate audit validates both WAVs against the
installed decoder's actual geometry. Audio samples were not cropped or changed
to satisfy the test. Normal EOS is allowed to end a song before its maximum;
the separate capacity test suppresses EOS only in the benchmark harness.

### Windows native all-model ownership and placement

**Pass:** the headless Debug app exercised the real `AudioEngine` generation
dispatch with qualification-owned storage and reused read-only models/runtimes.
All nine requests produced finite stereo audio. ACE/Stable durations matched
the requests; the two MiniMax outputs followed normal EOS/decoder geometry.

| Automatic sequence | Actual placement | Request times, seconds |
|---|---|---|
| MiniMax 5/5 | Disk-backed partial residency, nine retained LM blocks | 596.229 / 450.904 |
| Stable Audio 30/300/30 | Resident → model offload → resident | 16.937 / 11.854 / 7.211 |
| ACE-Step 30/60/30 | Disk-backed group offload throughout | 80.768 / 33.968 / 32.848 |
| Return to Stable Audio, 30 | Resident in a new worker | 17.998 |

Busy `Release idle AI memory` requests were refused, as were competing
separation resource leases. Completed requests released the active lease while
retaining a warm worker. An independent process-tree observer saw no overlap
between different model workers and verified every observed PID/birth retired
after final idle release. The same model reused its worker; model switches
retired it before starting the next. Whole-system available RAM stayed above
5,605,294,080 bytes in this sequence. Actual GPU allocation and CUDA BF16
execution were recorded for all three models.

MiniMax's warm standalone hardware probe reported insufficient free GPU memory
because it could not count the existing owner's reusable pool. This check is
already advisory in the UI; the live worker admitted the request against its
own reclaimable budget and completed it. The harness records that distinction
rather than treating a cold-process probe as the final allocation decision.

The first native fixture attempt was rejected before launching an inference
worker: Windows hard-link reuse of Hugging Face relative symlinks produced
dangling fixture aliases. The fixture repair resolves source symlinks before
linking the actual weight files; source snapshots were not changed. Both the
original failure and the corrected native report are retained. ACE setup-ready
status is a fixture for its reused snapshot; this sequence does not test a new
ACE installation. Stable/MiniMax app model readiness used real files.

The native inference build differs from final helpers only in explanatory text
in two files, model-specific writing/completion labels, and the progress
reading's explicit selected-GPU argument. Their exact
diff is retained in `native-tested-source-differences.json`; allocation and
placement code are identical. The final Debug refresh copies current helpers;
all three native ready/fingerprint/retirement checks pass on that refreshed
build. This is not a new inference run or physical multi-GPU qualification.

### Completed full 300-second capacity gate

**Pass:** an independent final validator checked the exact upstream decoder
sample count, stereo/rate, every block for finite samples and retirement of both
observed benchmark processes by PID/birth. The run took 5,261.636 seconds
(87.694 minutes): 3,482.677 seconds composing tokens, 1,675.423 denoising and
101.543 decoding. The test-only EOS mask recorded 7,501 semantic sampling calls
and the decoder produced the exact full-window sample count above. This
artificial run establishes memory/execution capacity; it does not establish
normal song length or subjective musical quality.

Peak Torch allocation was 27,166,957,056 bytes (25.30 GiB); peak reservation was
71,225,573,376 bytes (66.33 GiB). These are different measurements: the allocator
retained reusable composition cache and released it at the denoising boundary,
where reservations fell to 24,551,358,464 bytes. Whole-system available RAM
stayed above 52,465,905,664 bytes (48.86 GiB), sampled 5,296 times. The run kept
resident Original BF16 weights, native attention and the requested 30 steps.
It does not qualify 300-second MiniMax generation on the 16 GiB Windows GPU.

All follow-up execution gates are complete for the recorded hardware/runtime
scope. The final validation and copied Linux reports are in
`output/ai-long-generation-2026-11-07-v1/{capacity-final-validation.json,linux-evidence/}`;
the native summary/retirement receipts are beside them. No quality acceptance
is inferred from successful execution.

### Runtime and evidence scope

Windows MiniMax/Stable use Python 3.11, Torch 2.10/CUDA 12.8 and Diffusers revision
`7643c4826609c47755e3da0e5b768e8070468f49` (0.41.0.dev0). Windows ACE uses the
existing repaired Torch 2.11/CUDA 12.8, Diffusers 0.39 runtime. Linux ACE uses the
existing reviewed Torch 2.9.1/ROCm 7.2, Diffusers 0.39 runtime. Linux MiniMax and
Stable use a separate virtual-environment overlay with that same base ROCm Torch
and the pinned newer Diffusers revision; its dependency check and MiniMax import
passed. This overlay is **not** a self-contained fresh app installer result.
No MIOpen FAST or alternative attention option was enabled for these default
automatic-memory checks. MiniMax's 23 source files passed upstream identity and
copy checks; all 15 copied Stable Audio model files match the Windows source by
size and SHA256.

Evidence is retained under `output/ai-long-generation-2026-11-07-v1/`, including
frozen source/hash bundles, original failed attempts, Windows reports and copied
Linux reports/logs in `linux-evidence/`. The focused Windows policy suite passed
99 tests. Final Windows checks passed 111 AI tests plus 48 generation tests;
the frozen Linux bundle passed 111 plus 47 (the selected-GPU diagnostic unit
was added later and ran on Windows). The frontend production build, website
guide typecheck/direct Vite build, Debug CMake refresh and 426 native safety
checks passed. All 23 packaged worker/setup assets and current frontend files
match their build inputs, and the original project/WAV/MP3 retain their hashes.
Physical multi-GPU execution, FP32-only GPUs, Apple/Intel acceleration, other GPU families,
Linux native app/window/installer integration and universal quality remain
**not_asserted**.

### Repeating the long worker checks

Run from the checkout with the intended model runtime's Python and an existing,
validated local model folder. Use a new output directory for each qualification.
The checked-in request fixtures preserve the tested prompts, lyrics and settings.
They contain synthetic lyrics, no machine paths or user recordings. These commands perform
real, potentially lengthy inference; the ordinary CI policy tests do not load
the large model weights.

```text
<runtime-python> tools/qualify_generation_worker.py --model minimax-music-3 --model-root <minimax-folder> --requests tests/fixtures/generation-memory/minimax-normal-workloads.json --timeout 7200 --output-dir <new-normal-results>
<runtime-python> tools/run-ai-benchmark.py --model minimax-music-3 --model-root <minimax-folder> --placement auto --request tests/fixtures/generation-memory/minimax-capacity-300-request.json --duration 300 --repeats 1 --minimax-capacity-only --timeout 10800 --output-dir <new-capacity-results>
<runtime-python> tools/qualify_generation_worker.py --model stable-audio-3-medium --model-root <stable-audio-folder> --durations 30 300 30 --timeout 3600 --output-dir <new-stable-results>
<runtime-python> tools/qualify_generation_worker.py --model ace-step-v15-xl-turbo --model-root <ace-folder> --durations 30 60 30 --timeout 3600 --output-dir <new-ace-results>
```

The second command is an artificial capacity stress test, not normal musical
generation. Linux qualification used `LD_LIBRARY_PATH=/opt/rocm/lib`; that path
is specific to the recorded ROCm installation. Preserve report/runtime identities,
worker logs, finite-waveform checks and retirement evidence alongside timings.

Final cleanup confirmed no qualification-owned inference worker remained on
either machine and port 5183 was clear. Other applications were left running.
The CMake Debug refresh is complete; `python build.py dev --run` needs no
pre-running server. Failed attempts and their diagnostics remain available.

## Automatic existing-runtime maintenance — November 7 follow-up

This follow-up is development work based on app commit `e8c9c013`,
not a published update. It adds the missing startup migration for installed
managed stem tools. The existing manual Repair action remains a recovery option.
The app checks its reviewed core package pins and selected backend while audio
and other AI work are idle. It stages an incompatible runtime's replacement and
requires real execution on the expected backend before activation. Models and
the selected old runtime remain intact until that point. An explicit CPU-only
setup preference is preserved. No first-use AI setup or new generation checkpoint
download is started by this service.

### Windows native startup and recovery matrix

These runs used the CMake Debug host on the RTX 4080 machine described above.
Every case called the real AudioEngine status service; none invoked the manual
Repair action. The old runtime was a real installer-qualified Torch 2.11 CPU
installation, copied into marked test storage. The replacement used the pinned
0.0.16 base archive and app-local CUDA recipe, not a prebuilt CUDA fixture.

| Case | Result |
|---|---|
| Existing CPU runtime on NVIDIA, Automatic | **pass**: automatic CUDA replacement and six finite stems from the 31-second user-song excerpt; 458.36 seconds including setup, imports and separation |
| Restart with compatible CUDA runtime | **pass**: no replacement or duplicate download; 37.66 seconds including probes |
| Invalid pinned archive | **pass**: checksum failure retained the old selection and unchanged interpreter/model; actual CPU separation still produced six stems; 62.15 seconds |
| Restart after failed update | **pass**: failure remained visible and no automatic retry; 37.76 seconds |
| Cancel automatic setup | **pass**: cancellation retained the old selection; 37.87 seconds |
| Restart after cancellation | **pass**: no automatic retry; 37.25 seconds |
| Explicit CPU-only setup on NVIDIA | **pass**: no CUDA conversion; six CPU stems; 48.54 seconds |

The successful NVIDIA run retained measured device evidence:
`parameterBytesByDevice={"cuda:0":698626256}`, peak CUDA allocation
**1,899,336,704 bytes (1.77 GiB)**, Torch CUDA 12.8, RTX 4080. This establishes
actual model placement and VRAM use for that run. Every matrix case checked busy
deferral, source interpreter/model hashes, expected activation or rollback and
absence of a retry loop. No qualification-owned child remained after each case.
Evidence is retained under ignored
`output/automatic-runtime-maintenance/native-matrix.json` and the marked
`E:/OpenStudio-AI-Qualification/automatic-runtime-maintenance-v1/` fixtures.

An initial qualification failed because the new native maintenance command
passed `--skip-generation-checkpoints` before its Python parser/behavior had been
implemented. That integration failure was corrected, a real-parser regression
was added, and the failed fixture/logs were retained. The outer observer also
needed to tolerate a process exiting during descendant enumeration; its corrected
seven-case rerun passed. These were development qualification failures, not new
reproductions of the reporter's original 0xC0000409 crash.

### Both-feature automatic repair and CI regression driver

The idle-time trigger in these historical runs was replaced by explicit, exclusive maintenance before recording devices open. The installer results apply to the recorded builds.

**pass**: the same `qualify_automatic_repair` function used by the new CI option
was run against a separately copied, real installer-qualified runtime containing
both stem and generation libraries. Its owned audio-separator metadata was
temporarily hidden to create a reversible compatibility failure. App startup
automatically staged and selected the replacement; both feature selections were
retained, Diffusers 0.39.0 was present afterward, and no generation checkpoint
files were downloaded. Actual CUDA separation produced six valid one-second
stems. Model parameters occupied 698,626,256 bytes on `cuda:0`; peak measured
allocation was **1,194,659,840 bytes (1.11 GiB)**. The run took **501.46 seconds**
including setup. The previous slot's metadata was restored in `finally`, its
interpreter/model hashes stayed unchanged, and no test-owned child remained.

This fixture intentionally had generation libraries without generation
checkpoints; it establishes dependency preservation, not generation output from
this replacement. Earlier generation qualification remains separately scoped.
Evidence: `output/automatic-runtime-maintenance/both-ci.log`,
`both-ci-processes.json` and
`E:/OpenStudio-AI-Qualification/automatic-runtime-maintenance-v1/both-ci/native-result-automatic-upgrade.json`.
Together with the seven-case matrix, **eight native end-to-end cases passed**.

### Checks and remaining limits

- **pass**: 444 Windows native safety checks, including migration decisions,
  persistent attempt claims, interrupted/failing/cancelled attempt suppression,
  stale interpreter probes and terminal-state preservation.
- **pass**: 87 Windows Python checks plus 120 subtests; Linux ran the same 87
  cases with 83 passing and four PowerShell-only skips.
- **pass**: real Linux ROCm tensor allocation, multiplication, synchronized result
  verification using the installed Torch 2.9.1/ROCm 7.2 runtime. As in prior Linux
  qualification, this installation required `LD_LIBRARY_PATH=/opt/rocm/lib`.
  Omitting that local driver-library path failed to import `libroctx64.so.4`;
  that failure is retained. Initial isolated Linux test bundles also lacked
  numerical dependencies/source fixtures; the complete fixture/runtime run above
  passed without modifying the installed runtime.
- **pass**: 11 Chromium separation/setup scenarios, including automatic-update
  progress, cancellation, failure notice and narrow-window geometry; frontend
  TypeScript and production build; website guide TypeScript and Vite build.
- **pass**: final CMake Debug build with no compiler warnings. Packaged installer,
  probe, CUDA/CPU plans and all 148 frontend distribution files byte-match their
  current sources. No test-owned worker remained and ports 5183/5197 were clear.
  `python build.py dev --run` requires no pre-running server.
- **not_asserted**: subjective quality of these new outputs, NVIDIA Linux
  migration, macOS maintenance, or all GPU/driver combinations. Native Linux
  ROCm/CPU migration was subsequently qualified below. Platforms without an applicable reviewed plan do not auto-update.
  The reporter's RTX 3060 machine has not been retested by the reporter here.

The Windows and Linux Release CI installer-to-separation commands now include
`--automatic-repair-regression`: after fresh installation it makes a reversible
metadata incompatibility inside its owned runtime and requires startup repair
and separation again. They retain native result JSON and the automatic-upgrade
log. Remote results belong to the specific PR commit/run; the local results here
do not establish that an unrun workflow has passed.


## Native Linux migration completion — November 7

The isolated Linux Debug app was built from the same AI runtime sources on the
Ubuntu 26.04 / Radeon 8060S (`gfx1151`) machine above. The fixture started with the
published Linux CPU archive (Torch **2.5.1+cpu**, archive SHA-256
`9261faee0ac3886d45e09fc38961becc9ada9c8dfe87b982535c095d11680bd6`).
The downloaded catalog's old feature-gated ROCm plan was retained in the fixture;
the app's reviewed gfx1151 recipe selected Torch **2.9.1 / ROCm 7.2** instead.
There was no external-Python bootstrap or manual Repair call in these migrations.

**pass: nine native Linux end-to-end cases**, all using the real AudioEngine
status service, installer, activation marker and separation worker:

| Case | Result |
|---|---|
| Explicit CPU-only setup on the AMD machine | **pass**: no automatic conversion; six CPU stems; 58.96 s |
| Published CPU runtime to ROCm, 31-second song excerpt | **pass**: automatic replacement, six GPU stems, original interpreter/model retained; 444.91 s |
| Compatible ROCm runtime after restart | **pass**: no installation or retry; 35.26 s |
| Invalid archive checksum | **pass**: old runtime retained and six CPU stems still produced; 60.00 s |
| Restart after failure | **pass**: no automatic retry; 34.77 s |
| Cancel setup | **pass**: prior selection retained; 39.36 s |
| Restart after cancellation | **pass**: no automatic retry; 34.81 s |
| Both-feature CPU runtime, reversible separator-metadata fault | **pass**: automatic ROCm replacement, shared generation libraries retained, no new generation checkpoints, six GPU stems; 229.45 s |
| Cache-isolated stems-only CPU runtime | **pass**: only `stemSeparation` selected, automatic ROCm replacement and six GPU stems; 212.82 s |

The main song run put **698,626,256 parameter bytes on `cuda:0`**, with
**7,237,764,096 bytes (6.74 GiB)** of peak device allocation. On this machine the
`cuda:` device name is PyTorch's HIP API: the device was **Radeon 8060S Graphics**,
`torchCudaVersion=null`, `torchHipVersion=7.2.26015-fc0010cf6a`. The shorter GPU
cases peaked at **1,348,024,832 bytes (1.26 GiB)**. These are measured GPU
allocations on an APU with unified memory, not dedicated NVIDIA VRAM figures.
The native host launched with **no DISPLAY and no LD_LIBRARY_PATH override**;
the app supplied the standard ROCm library path only to its AI children.

The published CPU archive bundles Diffusers. Additionally, normal capability
probing found the machine's existing ACE-Step snapshot in its standard Hugging
Face cache. Preserving that detected feature is expected, but it would conceal a
stems-only feature-gating regression. The final fixture therefore moved its
owned generation library folders out of Python's search path and supplied an
empty, fixture-local Hugging Face cache. Its selected feature list was exactly
`["stemSeparation"]`. The qualification tool now gives its children a private
cache too, and a regression verifies that the parent environment is unchanged.
The real user cache/model files were retained.

Native testing also found hardware detection inside **every 64 KiB download
progress callback**, under the status lock. The interrupted diagnostic run is
retained. The fix captures hardware once outside that callback. Automatic native
qualification now rejects more than 64 hardware probes over the transaction;
positive Linux and Windows migrations each recorded **19**. Probe counting is
restricted to explicitly marked qualification runs. A missing progress-field
default initializer was corrected after GCC exposed warnings. The qualified
Linux and Windows builds have no compiler warnings.

An initial fixture had a checkpoint without the YAML required by the native
app. Its precondition failure was retained; the corrected fixture reused the
already-qualified configuration. The completed runs verified old interpreter
and checkpoint hashes, unchanged configuration files, correct activation or
rollback, busy deferral and absence of retry loops. Final process inspection
found **no qualification-owned worker remaining**.

The current Windows build also repeated a fresh CPU-to-CUDA automatic migration:
**pass**, six GPU stems, 574.02 s including downloads, **19 hardware probes** and
**1,194,659,840 bytes** peak VRAM allocation on RTX 4080. Together with the earlier
Windows matrix, nine Windows end-to-end cases have passed across this follow-up.
Current native safety runs passed **444 Windows checks** and **395 Linux checks**.
The final focused Python suite passed **88 Windows tests plus 120 subtests**;
Linux ran the same 88 cases with **84 passing and four PowerShell-only skips**.
The previously recorded 11 browser scenarios cover the unchanged frontend.
Subjective quality of the new outputs remains **not_asserted**.

Retained local evidence is under `output/native-linux-migration/`; the remote
owned source/build and fixtures are under
`/home/sayak/dev_work/openstudio-native-migration-20261107/`. The evidence archive
contains the native result files, device receipts, safety results and source
hashes. Release CI now executes fresh native setup, automatic repair and real
separation on both Windows and Linux; remote CI results must be checked at the
pushed PR head. This work does not publish an app release or qualify NVIDIA Linux,
macOS migration, arbitrary drivers or every possible GPU.

### Explicit maintenance and recording exclusion

The release candidate moved compatibility checking out of the workstation status timer. AI Tools Setup saves a request for the next launch. The maintenance window owns exclusive access before probing, downloading or activating a runtime. Each DAW session holds shared access from startup through shutdown.

- Windows Debug passed 451 native safety checks. Linux Debug passed 402. Separate processes exercised both launch orders, two simultaneous workstations, and a live installer retaining the lock after its owner released its handle.
- During a four-second Windows capture, a second process attempted maintenance and was refused. The native recorder wrote all 192,000 stereo frames at 48 kHz with eight-sample blocks. Every frame matched the synthetic source within 16-bit quantization, with zero writer lock misses, FIFO overflows or disk errors. Maintenance was admitted after the recording process exited. Hardware latency and listening quality for this capture were **not_asserted**.
- On the Windows RTX 4080, a real CPU-to-CUDA replacement produced six stems. A bad checksum and cancellation each retained the prior runtime and model. Separate repeat sessions for the successful, failed and cancelled cases did not start an installation. The CPU-only preference was preserved.
- On Linux, an isolated graphical launch consumed a saved request, displayed the maintenance confirmation and refused a separate workstation while the window was open. The empty-install case completed without downloading models. Eleven Chromium scenarios passed, including scheduling stem and compiler repair without starting an installer in the DAW.

### Post-update repair offer

Windows Debug passed 456 native safety checks and Linux Debug passed 407. The new cases cover existing and first-time installations, version comparison, repeat suppression, project launches and diagnostic bypass.

On an isolated Linux display, opening a project after an update showed the offer. Pressing Enter opened the DAW. Opening it again did not repeat the offer. A second DAW could start while the offer was visible. Choosing **Check and repair** during a four-second synthetic recording saved the repair request for a later launch. All 192,000 stereo frames at 48 kHz and eight samples per block matched the source within 16-bit quantization. An accepted repair with no DAW open held exclusive access and returned it to the DAW on completion. Physical interface latency and subjective audio quality were **not_asserted**.
