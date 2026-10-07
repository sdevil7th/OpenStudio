# In-app AI qualification — Ubuntu 22.04, 24.04 and 26.04

Status: revisions 12–14 follow-up recorded; full AI release qualification remains open. Source is `9b8f219d52faebe0c26699a9ac2848523ad01575`
plus the uncommitted Linux qualification changes. This report distinguishes
actual native app behavior from browser mocks and direct worker tests.

## Revisions 12–14 follow-up (October 1, 2026)

Evidence: `output/ai-followup/`; new native screenshots also remain under
`output/ai-ubuntu-qualification/<os>/`. Revision 14 is installed in the three QA
VMs. They initially ran this follow-up with 8 GiB/four vCPUs; clean setup correctly
blocked because guest-visible memory was below the 8 GiB minimum. The final
installer run uses 12 GiB/four vCPUs. None has a passed-through GPU.

### Implemented and verified

- **Basic Pitch: pass.** Corrected fixed-size waveform windows, output-head
  names and exclusive note ends; failed inference returns an actionable error.
  The frontend does not create empty MIDI tracks. Real bundled-model native
  regressions cover silence, nonfinite input, three sample rates and window
  boundaries. Installed Convert to MIDI, undo/redo, save and reopening the saved
  project work on all three Ubuntu versions. The synthetic 3-second source
  creates a valid note-on/off pair for MIDI note 57. This does not qualify
  transcription accuracy on arbitrary music.
- **Setup navigation: pass in browser regressions and native Ubuntu 22/24/26.**
  MiniMax's setup action selects MiniMax; all three model destinations have
  Chromium and Playwright WebKit coverage. Native screenshots confirm MiniMax is selected on all three systems.
- **Download timer: pass on the native host.** It counts from the initial
  download, before Python starts, and does not reset when the worker launches.
  Screenshots show 3 and 35 seconds during actual runtime transfer, then
  7m9s downloading and 8m46s installing the backend in the completed retry.
  Native timer regressions also cover the stage boundary.
- **AMD hardware: pass on Ubuntu 26.04 host.** ROCm GPU pools identify the shared
  memory correctly; CPU pools are excluded. A gfx1151-specific installer plan
  pins AMD ROCm 7.2/PyTorch 2.9.1 wheels. Other architectures keep their existing
  plans. Only AI child processes get the standard ROCm library path.
- **Fresh in-app AMD installation: pass.** The native Release candidate
  downloads runtime 0.0.14 from the public manifest, automatically selects
  `linux-rocm-gfx1151-7.2`, installs AMD's wheels, reuses the complete existing
  ACE-Step snapshot and reports ready with ROCm selected. `pip check` passes.
  This test uses an isolated runtime directory on the host, not its installed
  system DEB. The first run was interrupted when the test display/app processes
  exited during download; the completed retry used managed test services.
- **ACE-Step inference: pass on the AMD host.** The native Release candidate
  runs without a caller-provided ROCm library environment, shows a successful
  hardware check, generates/imports a 10-second clip, and passes undo/redo.
  This also passes after the fresh in-app installation. Trace timestamps record
  154 seconds for the first request and 2 seconds for the next warm request;
  cold startup performance is not qualified by the warm result. The cold run
  logs MIOpen convolution solver evaluations, consistent with AMD's documented
  [find/cache behavior](https://rocm.docs.amd.com/projects/MIOpen/en/latest/how-to/find-and-immediate.html),
  but kernel timing was not independently profiled. Cancelling during denoising
  stops the worker without a new output file or late import. A subsequent retry
  starts a new worker and succeeds in 55 seconds. All three native outputs are
  finite 10-second, 48 kHz stereo WAVs; see
  `output/ai-followup/native-generation/` for files, traces and results.
  Five direct workflows pass on ROCm: Text to Music, Lyrics + Style, Variation,
  Inpaint Selection and Continue Clip. Four direct workflows also run with the
  new CPU runtime: text generation, variation, inpainting and continuation. Output duration/channel/
  finite-sample checks pass; CPU workers run on the 26.04 host, not the VMs.
  The final GPU harness uses the product's exact workflow IDs; an earlier CPU
  harness uses the worker's generic text-generation path. The native request
  explicitly records `text-to-music`. Subjective quality, lyric adherence
  and source-pattern preservation are **not_asserted/diagnostic_only**.
- **Model-cache readiness: pass.** Setup, hardware preflight and inference use
  the same complete ACE-Step snapshot. Missing/empty weights and incomplete
  shards cannot report ready. The installer reuses a complete standard Hugging
  Face cache. It does not download another copy merely because the managed cache
  is empty. Six focused cache tests cover these cases.
- **Published runtime: pass.** [Linux runtime 0.0.14](https://github.com/sdevil7th/OpenStudio/releases/tag/ai-runtime-linux-v0.0.14)
  uses Python 3.11.15. Its requirements match 0.0.13; only Linux was replaced.
  SHA256 `9261faee0ac3886d45e09fc38961becc9ada9c8dfe87b982535c095d11680bd6`,
  size 629730575 bytes. Packaging now includes hidden metadata and handles
  standalone Python links. Relocated archive checks and dependency imports pass
  on Ubuntu 22/24/26. [Website deployment](https://github.com/sdevil7th/OpenStudioWebsite/actions/runs/36865019649)
  succeeded; both public runtime manifests contain this exact asset. Windows,
  macOS and desktop installer assets were preserved. Fresh in-app runtime download, checksum validation, extraction, stem setup
  and six-stem separation/import/save/reopen pass on all three Ubuntu VMs. All six
  files have finite samples and the expected 3-second duration at 44100 Hz. Existing stem weights were retained; these
  are fresh runtimes, not fresh model downloads.

Supporting checks: 280 Debug native assertions; 279 installed Release assertions
on each VM; 20 AI browser checks (10 Chromium, 10 Playwright WebKit); 67 focused
frontend AI unit checks; 78 Python runtime/installer/ACE checks and seven website
manifest checks. Browser mocks are not native-inference evidence. Existing dependency
warnings remain recorded and are not waived as a zero-warning build.

### Still not asserted

NVIDIA-only INT8 execution cannot run on this AMD GPU. MiniMax and Stable Audio
model/license approval has not been supplied; no terms were accepted on the
user's behalf. Their real downloads/inference and subjective audio quality remain
unqualified. GPU inference on native Ubuntu 22/24 also remains untested. The
runtime hotfix is public; app fixes remain in the unpublished Linux candidate.

Host Xvfb automation had unreliable pointer targeting after scrolling/focus
changes in the generation form; keyboard traversal supplied the verified final
request. Native pointer behavior in that scrolled form is not qualified by this
test. The older host save-dialog attempts likewise do not establish a host
generation project save/reopen pass. VM project persistence checks above are
separate evidence.

### Delivery and cleanup

The local package is `/home/sayak/Downloads/OpenStudio-0.1.04-14-ubuntu-22.04-amd64.deb`.
It was upgraded and reopened on all three VMs; the host's installed DEB was not
replaced. The frontend production build and CMake Debug/Release builds completed;
Debug assets are current. No pre-running Vite server is needed for
`python build.py dev --run` (use `python3` on this host where `python` is absent).
The QA VMs, managed Xvfb/app services and owned AI workers have stopped. Port
5183 is clear. Generated evidence/audio and VM disks are retained.

## Revision 11 historical environment and evidence

Evidence root: `output/ai-ubuntu-qualification/`. All three systems are real KVM
VMs with 24 GiB RAM and six vCPUs. Ubuntu 22.04 uses the existing GNOME/X11 desktop;
24.04 and 26.04 are fresh Ubuntu cloud images with an Xvfb/Openbox desktop and
system WebKitGTK. They run the installed DEB, not a Vite/mock frontend. No GPU
is passed through. The host's installed package and physical audio are unchanged.

Image sources and SHA256 checks are recorded in each new VM's `image-source.json`:
[Ubuntu 24.04](https://cloud-images.ubuntu.com/noble/current/) and
[Ubuntu 26.04](https://cloud-images.ubuntu.com/resolute/current/).
The app fetches the public AI runtime manifest, recorded as
`published-manifest.json`, then runtime 0.0.13. The later follow-up below publishes
Linux runtime 0.0.14; these revision 11 results retain their original context.

## Findings and implementation

- **Fail, revision 8, all three OSes:** clicking Install Stem Separation does not
  install it. The local Release candidate had development system-Python fallback
  enabled. `build.py` now explicitly disables it for production, and native and
  AppImage packaging rejects a cache with this option enabled or missing.
- **Fail, native POSIX process arguments:** installer and runtime-probe commands
  included shell quotes which JUCE's POSIX string launcher retained in argv.
  The stem worker had the same construction. They now use argument arrays;
  quoting in installer command logs is diagnostic only. This also fixes paths
  containing spaces and Unicode. Native argument transport gets a regression.
- The installer previously captured stdout without draining it while reading
  structured events from a log file. It now uses the existing owned-process
  wrapper, drains its nonblocking output, and retains unexpected errors in
  `AiToolsProcess.log`. Stem workers use the same wrapper for nonblocking polling,
  reliable exit status and owned process-tree cancellation.
- **Still open:** the publicly downloadable CPU runtime has Python 3.10; prior
  direct tests establish that it cannot run current music generation. A corrected
  runtime has not been published. This app package does not silently replace it.
- **Restricted evidence:** VM generation hardware, licensed/gated model access,
  GPU backends and subjective sound quality require separate qualification.
  User questions about available GPU hardware and already accepted/downloaded
  models are pending. Do not bypass product gates or accept model terms for tests.

## Scenario inventory

| Area | Required native scenarios |
| --- | --- |
| Stem setup | Fresh install, real download/verification, progress, close/reopen panel, cancellation/retry, restart readiness |
| Stem separation | All six stems, subset, cancel/no late import, finite files/duration, import/undo/redo/save/reopen, source preservation, path with spaces/Unicode |
| Basic Pitch | Bundled ONNX readiness, Convert to MIDI from an audio clip, valid note events, undo/redo/save/reopen |
| ACE-Step | Setup original/INT8, Text to Music, Lyrics + Style, Variation, Inpaint Selection, Continue Clip |
| Stable Audio 3 | License/access and local-folder validation, setup original/INT8, Text to Audio, Variation, Inpaint Selection, Continue Clip |
| MiniMax Music 3 | License/access and local-folder validation, setup original/INT8, Lyrics + Style, Song Sections; source editing must remain unavailable |
| Generation lifecycle | Progress, cancellation/no stale import, retry, cold/warm run, generated clips, undo/save/reopen, recovery |
| Failure handling | Unsupported hardware, missing runtime/model, denied model access, interrupted download, bad model folder, actionable diagnostics |

Rows are an inventory, not passing assertions. Unsupported or unrun combinations
must remain blocked/not_asserted in the final results.

## Supporting regression checks

- 69 Python installer/runtime/generation-policy tests pass in the prepared Python
  3.11 runtime. The system Python run lacked NumPy and was an environment failure,
  not counted as a product result.
- 60 focused frontend AI unit tests pass.
- 14 Chromium/Playwright WebKit AI workflow tests pass, including cancellation,
  stale-result rejection, hidden-track completion/undo and source coordinates.
  These use bridge mocks and do not establish installed-app inference success.
- Native package gate tests pass after including realistic CMake cache comments.
- The new native argument fixture initially used CRLF in a POSIX shebang and
  failed before invoking the probe. Its line endings were corrected; original
  evidence is retained. It does not establish a production failure.
- Full Release rebuild warnings from existing dependency code and the mixer
  array removal remain recorded. This is not a warning-free full-build claim.

## Earlier candidate checkpoint (superseded below)

Revision 9 is installed on all three systems. Each passes 243 native runtime
safety assertions, including the real argument-transport regression. Debug passes
244 checks (configuration-specific count). These checks are not AI inference.

## Additional native findings (revisions 9–11)

- Revision 9 failed the public manifest fetch on all three OSes. Independent
  HTTPS requests returned HTTP 200. JUCE had compiled `JUCE_USE_CURL=0` because
  the app omitted `NEEDS_CURL TRUE`; linking libcurl separately was insufficient.
  Revision 10 enables HTTPS and downloads the real public runtime on all three.
- Revision 10 passes 244 native safety checks on each VM; Debug passes 245.
  Ubuntu 22.04 also passes installer cancellation/retry; Ubuntu 24.04 passes
  closing/reopening setup while the download continues.
- Revision 10 incorrectly selects the CUDA installation plan on CPU-only VMs.
  Its quoted shell command fails, but the error text contains “nvidia”, which
  was mistaken for hardware evidence. Revision 11 uses direct argument arrays
  and requires successful stdout. Tests cover failed output and successful argv.
  The three erroneous backend installations were cancelled through the app.
- Ubuntu 26.04 audio-to-MIDI initially failed because the native bridge received
  a corrupted non-ASCII source filename (`音`). JavaScriptCore returns UTF-8;
  JUCE's implicit char-pointer variant construction treated it as ASCII. The
  pinned Linux browser patch now explicitly decodes UTF-8. This affects other
  non-ASCII bridge strings as well, including prompts. Installed revision 11 reads the Unicode source successfully on all three OSes.
- Open cosmetic defect: runtime-download progress advances, but elapsed time
  displays zero until the Python installer process starts.
- Python ROCm detection also disagreed with native eligibility. The installer
  now accepts detected ROCm while preserving the memory threshold. Six hardware
  gating tests pass, including sufficient/insufficient ROCm memory. No GPU
  inference qualification is implied.

## Basic Pitch: confirmed failure on all three systems

Revision 11 can now read the Unicode source path, but real inference fails:
`Got: 66151 Expected: 43844` for the model's audio dimension.
`PolyPitchDetector::analyze` assumes variable-length input; the bundled ONNX
model has a fixed 43,844-sample input. The exception is logged but is not
propagated as a frontend error. All three installed apps create an empty MIDI
clip (zero events), confirmed by saving and inspecting the project.
Evidence: `<os>/basic-pitch-result.osproj`, native startup logs and screenshots.

This is a release-blocking failure, not successful conversion or a quality
judgment. A proper fix needs fixed-window inference with documented overlap/time
mapping, correct output-head mapping, error propagation and no empty-track
creation on failure. Test short/long clips, boundaries, sample-rate conversion,
trimmed sources, silence and a known-note fixture before qualifying polyphonic
editing or audio-to-MIDI. The current candidate does not claim that fix.

## Final installed candidate: revision 11

Package: `OpenStudio-0.1.04-11-ubuntu-22.04-amd64.deb`, local/unpublished.
SHA256: `9b5ca8cfe44cc4b29d059898d8f4d60623e3723263462551fc136c0dce5684ad`.
Installed in all three QA VMs; the physical host remains on revision 5.
This is a qualification artifact, not an all-AI release approval.

| Native result | Ubuntu 22.04 | Ubuntu 24.04 | Ubuntu 26.04 |
| --- | --- | --- | --- |
| Public CPU runtime and stem model installation through the app | pass | pass | pass |
| Correct CPU backend, managed runtime readiness | pass | pass | pass |
| Six-stem inference and import | pass | pass | pass |
| One-step undo/redo; source mute restored/reapplied | pass | pass | pass |
| Save, close, reopen stem project | pass | pass | pass |
| Cancel running separation, then retry Vocals-only | pass | pass | pass |
| Finite WAVs, expected duration/rate/channels, source unchanged | pass | pass | pass |
| Unicode/spaces in native source path | pass | pass | pass |
| Basic Pitch real audio-to-MIDI inference | **fail** | **fail** | **fail** |
| Generation workflow forms and missing-model/hardware gates | checked | checked | checked |
| Licensed-model acceptance gate, disabled INT8 without NVIDIA | checked | checked | checked |
| Generation model installation and real generation | blocked | blocked | blocked |
| Subjective separation/generation sound quality | not_asserted | not_asserted | not_asserted |

Real stem setup downloaded the public runtime (approximately 528 MiB) and
BS-Roformer-SW checkpoint (approximately 699 MB). Final structured installer
state is `ready` on all three. The six output types are vocals, drums, bass,
guitar, piano and other. All 18 inspected WAVs are finite, stereo, 44.1 kHz,
132,300 frames (three seconds). These deterministic checks do not establish
musical separation quality. Original source SHA256 remains
`f8ce4399459a7f6ffc218c252a675e8fa1126b226a763cad56740367e3904970`
on every VM. Cancellation followed by Vocals-only retry adds exactly one new
track; a cancelled six-stem result does not appear later in those saved projects.

Installer download cancellation/retry was exercised on 22.04; closing and
reopening setup while downloading was exercised on 24.04. These specific
installer lifecycle cases are not claimed as repeated on every OS. Stem-job
cancellation/retry was repeated on all three. Restarted readiness was explicitly
inspected in the setup panel on 22.04/24.04; 26.04 reopened its saved subset project.

### Generation coverage and limits

All eleven workflow forms were opened in the native installed application on
**each** Ubuntu version:

- ACE-Step: Text to Music, Lyrics + Style, Variation, Continue Clip, Inpaint Selection.
- Stable Audio 3: Text to Audio, Variation, Continue Clip, Inpaint Selection.
- MiniMax Music 3: Lyrics + Style and Song Sections.

Inpaint displays the selected 0.50–1.50 second range within the three-second
source. Source-editing model selection excludes MiniMax. Missing-model or
unsupported-hardware states prevent starting generation. Model download/import
remains disabled until license acceptance; terms were not accepted on the user's
behalf. Original/INT8 selection shows INT8 unavailable without NVIDIA.

**Open navigation defect:** from the MiniMax generation workflow, “Set Up MiniMax”
opens the ACE-Step setup page. `AIWorkflowModal.tsx` passes only the generic
`audioGeneration` feature to `onOpenAiToolsSetup`, losing the selected model.
The same generic callback is used by other models; qualify each setup destination
when fixing it. This issue is not fixed in revision 11.

Native generation installation/inference, GPU/CUDA/ROCm execution, INT8 preparation,
large-model memory/performance, accepted-license local-folder validation, denied
remote model access, offline/interrupted model recovery, generation cancellation
and post-generation import/undo/save/reopen remain **blocked/not_asserted**.
The VMs have no passed-through GPU. The initial host assessment read only the
2 GiB display reservation and was incorrect: Radeon 8060S exposes 100000 MiB
(97.656 GiB) of GPU-addressable shared memory. The follow-up verifies real ROCm
inference. Approved MiniMax/Stable Audio model access remains unconfirmed. The
public CPU runtime's Python 3.10 also needs replacement before qualifying the
current generation stack. Previous direct-worker tests using a separately
prepared Python 3.11 runtime are supporting evidence only, not native in-app passes.
No Windows/macOS parity is established by this Linux audit.

### Evidence and regression results

Under `output/ai-ubuntu-qualification/`, each OS retains native screenshots,
`ui-operations.jsonl`, `final-installer.log`, `final-installer-status.json`,
`final-startup.log`, `source-preservation.txt`, saved `.osproj` cases and six WAVs.
`stem-files.json` records output validation. Screenshots 42–60 cover generation
forms/gates; screenshot 46 was initially named as sections but still shows lyrics,
and screenshot 52 is the corrected Song Sections check. These retained intermediate
screenshots are not counted as extra passing scenarios.

Revision 11 passes **246 native runtime safety assertions per VM** and **247 in
Debug**. Seven native packaging tests and six hardware-policy tests pass. The
69 Python, 60 frontend unit and 14 browser tests above remain supporting checks;
browser bridge mocks do not substitute for native inference. The baseline ABI
check passes the glibc 2.35 ceiling, and real installation/startup succeeded on all
three systems. Debug and Release builds are current. Website guide TypeScript
validation passes. Existing full-build dependency warnings remain unresolved.

### Follow-up order

1. Fix Basic Pitch fixed-window inference and frontend failure handling; qualify
   short/long/trimmed/non-44.1 kHz/silent/known-note fixtures with the real ONNX model.
2. Preserve the selected model when opening setup; test all setup entry points.
3. Correct download elapsed-time reporting; retain real cancellation/retry coverage.
4. Publish and verify the corrected generation runtime after release gates, then
   repeat clean in-app installation against the actual public manifest.
5. On eligible GPU hardware with approved model access, execute every model's
   Original/INT8 installation and supported workflow, including cancellation,
   failed-download recovery, import/undo/save/reopen and cold/warm runs.
6. Audition the exact generated/separated artifacts. Audio quality remains
   `not_asserted` until that review; do not equate file sanity with sound quality.

### Cleanup

Test applications were closed, the 22.04 desktop idle timeout restored, and all
three owned QA VMs shut down. Their disks and evidence are retained. QA SSH ports
and Vite port 5183 are closed (`cleanup.json`). One old pre-upgrade process was
revealed behind the closed revision 11 window on 22.04; its executable was deleted
and the revision 11 service was inactive. It was closed during cleanup; its stale
setup screen is not counted as a revision 11 readiness result. No test server is
required for the normal `python build.py dev --run` workflow; the CMake Debug
build and frontend assets were updated during this work.
