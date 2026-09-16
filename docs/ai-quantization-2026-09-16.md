# Saved INT8 model qualification ? September 16, 2026

Development working-tree evidence after app commit `7f59cff`; not a released-feature claim. Model checkpoints and audio outputs are local, not committed. The exact request JSON, worker events, package/hardware reports, WAV files and build logs are under `build/ai-qualification/quantized-20260916/`.

## Scope and installation

The model selector and AI Runtime Setup offer Original and INT8 for ACE-Step 1.5 XL Turbo, Stable Audio 3 Medium and MiniMax Music 3. They retain independent install status. Generation requests explicitly carry `modelVariant`; track edits retain undo/redo. Missing INT8 weights fail instead of silently selecting Original. Both installations can coexist, and the INT8 slot does not require the Original slot to remain installed.

This is **download-and-prepare**, not a smaller hosted download: setup reuses original weights when available or downloads official originals, quantizes once, saves a separate checkpoint, and verifies that it reloads as real bitsandbytes INT8 layers. An already prepared OpenStudio snapshot can be imported. Setup publishes through the existing staging/backup flow. A fresh network download and the entire native installer transaction were not rerun: this machine already had the official sources. Preparation and serialized reload were actually run for all three.

Only NVIDIA CUDA is enabled for this variant. CPU-only, AMD, Intel and Apple hardware were not physically tested. INT8 does not make MiniMax suitable for every small GPU; the UI suggests ACE-Step or Stable Audio below 16 GB.

## Machine and saved weights

Windows, NVIDIA RTX 4080 with 16 GB VRAM, 32 GB system RAM. Base runtime: PyTorch 2.10.0+cu128, Diffusers 0.41.0.dev0 at the repository's pinned revision, Transformers 5.16.1, Accelerate 1.14.0, bitsandbytes 0.50.2. Existing staged INT8 runtime was used for conversion and initial benchmarks; final worker tests used the app's base Diffusers runtime with the pinned bitsandbytes package. Original weights were retained.

| Model | Quantized component | INT8 layers | Installed snapshot |
| --- | --- | ---: | ---: |
| ACE-Step | Diffusion transformer | 359 | 6.47 GiB |
| Stable Audio | Diffusion transformer | 226 | 3.50 GiB |
| MiniMax | Language model, including output projection | 253 | 19.33 GiB |

Other components use their normal inference precision. Sizes include shared components copied into each independent snapshot. The larger MiniMax snapshot includes original-precision components that are cast for inference.

## Real generation results

All rows below are **pass** for finite stereo output, selected INT8 execution, and request completion. These are observed timings, not promises for other hardware or prompts. Cold request timings include loading; earlier direct-session timings below separate loading.

| Base-runtime request | Requested length | Actual output | Elapsed |
| --- | ---: | ---: | ---: |
| ACE-Step text-to-music, 8 steps | 195 s | 195 s | 25.59 s |
| Stable Audio text-to-audio, 8 steps | 195 s | 195 s | 15.06 s |
| Stable Audio variation, warm | 195 s | 195 s | 7.15 s |
| Stable Audio inpaint, warm | 195 s | 195 s | 7.56 s |
| Stable Audio continuation, warm | 20 s | 20 s | 4.92 s |
| MiniMax lyrics + style, 30 steps | Up to 195 s | 158.36 s | 1,081.53 s (18.03 min) |
| MiniMax structured song, warm, 8 steps | Up to 5 s | 4.99 s | 34.17 s |

The long ACE-Step and MiniMax requests used the existing OpenStudio rock-song fixture and seed 470655306. MiniMax ended before the maximum duration; no truncation or duration/step reduction was used to get a passing result. Its recorded generation phases were 770.81 s composing tokens, 221.14 s synthesizing audio, 4.11 s decoding, plus preparation and loading. Peak torch allocated memory was 12.52 GiB; this excludes non-torch GPU allocations. MiniMax remains substantially slower than the other models.

Stable Audio and MiniMax persistent worker checks also passed second-request reuse, wrong-model rejection, active cancellation by worker termination, worker exit, and absence of cancelled output. ACE-Step additionally passed two direct 195-second renders: 6.42 s load, then 17.40 s cold generation and 10.54 s warm generation. Stable Audio's direct pair was 5.41 s load, then 7.09 s and 3.11 s generation. See `ace-saved-int8`, `stable-saved-int8`, `ace-worker-report.json`, `stable-worker/report.json`, and `minimax-worker/report.json`.

## MiniMax memory correction and retained failure

**Fail, retained evidence:** the first saved-INT8 MiniMax attempt retained full CPU stage copies and was stopped by the resource guard with approximately 0.91 GiB RAM free; it produced no audio (`minimax-saved-int8-short`). That path was replaced with bounded disk-backed inactive weights. Parameters, quantization scales and bitsandbytes aliases move together. The language model and depth decoder stay GPU-resident throughout token generation; weights are not uploaded per token.

**Pass:** the disk-backed path completed two 10-second requests (69.54 s load, then 59.93 s / 58.10 s), followed by the base-runtime full-song and structured-song worker tests above. The immutable temporary cache is 15,718,523,584 bytes (14.64 GiB). A real CUDA bitsandbytes test passed three stage activation/release cycles with output parity and cleanup. Stale caches from terminated test workers were reclaimed; no owned cache directories remained at handoff. The 195-second preflight resolved the installed INT8 slot even with a nonexistent Original root and reported sufficient memory on this machine.

## UI, build and limitations

**Pass:** real Chromium checks at 1280 px and 390 px widths covered model/version selection, installer submission payload, independent installation labels, disabled incompatible INT8 selection, the below-16-GB MiniMax suggestion, focus visibility, no horizontal overflow, track undo/redo, and source-clip selection. Browser fixtures used a mocked native bridge; screenshots are in `output/playwright/quantized-*.png`. Browser-only startup native-reporting errors were expected because no desktop bridge was attached.

**Pass:** 34 frontend tests across six relevant suites; Python policy/variant, installer, pipeline, worker, disk-store and placement tests; frontend notices/TypeScript/Vite build; CMake Debug build with no C++ warnings; native runtime-safety self-test (including preservation of the INT8 install identity during status refresh). The Debug `webui` and worker scripts were refreshed. Test browsers and the Codex-started Vite server were stopped.

**Diagnostic_only:** performance and allocator measurements are machine- and request-specific. No controlled same-prompt Original-vs-INT8 speedup claim is made.

**Not_asserted:** subjective music quality, lyric fidelity, equivalence to Original, other physical GPUs/CPU platforms, Windows Release UI readiness, a complete fresh native installation, and smaller network downloads. The generated audio has not been approved by user audition. The historical MiniMax audition calibration remains untouched; these newly serialized INT8 artifacts are separate from it.
