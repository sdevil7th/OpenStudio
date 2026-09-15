# Full-song generation and hardware preflight — September 13, 2026

Working-tree qualification, not a released feature claim. Hardware: Windows,
RTX 4080 16 GB, Ryzen 9 7900X, 32 GB RAM. No Linux AMD, Apple Silicon, Intel GPU,
or additional NVIDIA machines were available. Worker `77d8f16feb593810`.

## Request and measured results

The exact user rock prompt, seed `470655306`, and 195-second duration were used.
ACE-Step received the exact lyrics too. Stable Audio has no structured-lyrics
input, so its request deliberately contains only the prompt. Both models used
their eight-step defaults and original BF16 weights, without quantization.
Times below exclude model loading and are single cold/warm pairs, not population
statistics or a guarantee for another machine/request.

| Model and placement | Load | Cold generation | Warm generation | Result |
| --- | ---: | ---: | ---: | --- |
| Stable Audio 3, automatic resident, original decoder | 11.55 s | No output within 900 s | Not reached | timeout during decode |
| Stable Audio 3, automatic resident, bounded decoder | 3.80 s | 5.57 s | 2.30 s | pass: two 195-second stereo files |
| Stable Audio 3, explicit model offload, bounded decoder | See report | 8.21 s | 6.15 s | pass: two 195-second stereo files |
| ACE-Step, automatic model offload | 16.16 s | 23.61 s | 16.66 s | pass: two 195-second stereo files |
| ACE-Step, explicit group offload | See report | 35.17 s | 29.83 s | pass: two 195-second stereo files |

Reports and WAVs live in `build/ai-qualification/` under
`stable-user-song-195s`, `stable-user-song-windowed-195s`,
`stable-user-song-offload-195s`, `ace-user-song-195s`, and
`ace-user-song-group-195s`. All output durations were checked from decoded files.
There is no completed original Stable Audio full-song time, so no exact speedup
percentage is claimed. Other applications and cache state were not controlled
identically across all runs.

The normal Stable Audio IPC worker also passed two full-length runs, expected
unquantized precision, exact seed, wrong-model rejection, active cancellation,
and cleanup (`stable-user-song-worker-195s`). A second IPC sequence passed
variation (195 s), inpainting (195 s), and continuation (20 s), followed by
active cancellation (`stable-user-song-source-worker-validated`). These use the
full generated song as source and the user's direction prompt. The initial
source-fixture attempt failed before inference on an encoding/missing-file error;
its report is preserved separately, not counted as a passing model test.

## Stable Audio decoder change and numerical limits

The pinned [SAME implementation](https://github.com/huggingface/diffusers/blob/7643c4826609c47755e3da0e5b768e8070468f49/src/diffusers/models/autoencoders/autoencoder_same.py)
constructs dense square attention masks for locally connected transformer
resampling blocks. At full-song lengths this wastes substantial memory and work.
The adapter calls each original block on stride-aligned windows with a halo of
`transformer depth × local window`. Only each unaffected core is retained;
there is no crossfade. Absolute RoPE positions, including BF16 rounding, are
preserved through scoped per-block offsets. Original block forwards, weights,
attention processors, and source-workflow composition remain in use.

- **pass**: real pinned small FP32 blocks with nonzero attention/FFN weights,
  encoder padding, decoder boundaries, idempotence and short requests after long.
- **pass**: full-checkpoint FP32 numerical comparison, relative RMSE
  `2.2654e-5`, below the `1e-4` numerical regression tolerance.
- **diagnostic_only**: full-checkpoint BF16 relative RMSE `0.0274887`, maximum
  absolute difference `0.0222168`, on fixed synthetic latents. Changing only the
  batch size in the **unmodified** decoder gives relative RMSE `0.0272884`.
  FP32's unchanged batch-shape control similarly gives `2.2622e-5`. This supports
  shape-dependent floating-point variation; it does not prove audible parity.
- The first real-checkpoint experiment used an uncalibrated 1% BF16 difference
  threshold and reported **fail**; disabling reduced-precision accumulation also
  exceeded that threshold. Both original reports are retained. That arbitrary
  audio-difference threshold is not treated as an audio-quality gate. The final
  diagnostic tool explicitly separates finite/shape checks, FP32 numerical
  parity, and uncalibrated BF16 audio differences.
- **not_asserted**: subjective quality of the new full-length files. User audition
  was requested; no acceptance has been recorded for these exact artifacts.

This is a model-specific adapter. Generic image-VAE tiling settings cannot be
assumed to exist on SAME; see the [Stable Audio pipeline contract](https://huggingface.co/docs/diffusers/main/en/api/pipelines/stable_audio_3)
and [Diffusers memory guidance](https://huggingface.co/docs/diffusers/optimization/memory).

## Hardware warning before generation

Both generation dialogs now show a debounced, refreshable hardware check:
selected adapter, estimated precision/placement, estimated required and measured
available RAM/VRAM, and shortfalls to three decimal places in GiB. Source requests
include clip context. Estimates are explicitly advisory, timestamped, and distinct
from runtime validation; idle worker caches can make a separate process's free
memory snapshot conservative. Unified memory is not counted twice.

The native call runs an owned background process with a 30-second deadline,
bounded output, app-shutdown cancellation, and temporary request-file cleanup.
It reads local checkpoint headers and, for MiniMax, tokenizer/configuration and
local qualification metadata. It does not load weights, download, generate audio,
or publish a qualification. Probes serialize and obsolete queued UI requests are
discarded. Text/lyrics are passed through the temporary file, not process argv.

Real CLI probes returned resident BF16 for Stable Audio, expected model-offload
BF16 for ACE-Step, and an explicit unavailable/stale INT8 calibration warning for
MiniMax. MiniMax counted the actual 405 tokens. Its last local estimate was
13.675 GiB GPU and about 18.4 GiB available host RAM; only about 16 GiB host RAM
was available. The old qualification was **not** relabelled or promoted.
`minimax-user-song-current-rejection` passed rejection before inference/output.
Full MiniMax cold/warm capacity and automatic-selection qualification remain
blocked on sufficient host headroom; prior work suggested about 22–23 GiB free
at test startup to retain the 2 GiB whole-system reserve.

## Verification

- **pass**: 73 policy/preflight/benchmark/model/dependency tests, seven pipeline
  contract tests, two separator attention tests in its installed runtime, and the
  SAME block test above.
- **pass**: TypeScript/Vite build and CMake Debug build without C++ warnings.
- **pass**: all 152 packaged worker/helper and frontend files matched source/dist;
  packaged worker identity is `77d8f16feb593810`.
- **pass**: 196 native runtime safety checks (headless, crash scenarios skipped).
- **pass**: actual browser warning layout at 390×844 and 1280×900, request change,
  small shortfall visibility, no horizontal overflow and keyboard refresh.
  Browser fixture data is UI evidence, not hardware measurement.
- Browser/server/temporary frontend fixtures were cleaned up. The usual
  `python build.py dev --run` needs no pre-running server.
- **not_asserted**: maximum possible performance, all optional attention packages,
  multi-GPU execution, other physical platforms, and subjective audio quality.
  The observed PCIe Gen 1 host link also remains unresolved.
