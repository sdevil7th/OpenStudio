# Qwen DAW Assistant, TurboQuant, GGUF, and ACE Step Plan

Date: 2026-04-27

Status: planning document only. Do not treat this file as implementation.

## Goal

Build a local-only Qwen assistant for Studio13 that can understand plain English, inspect project/audio context, plan DAW/plugin actions, explain the impact of those actions, and execute only after user confirmation.

The assistant must also control the existing ACE Step 1.5 XL Turbo music-generation integration.

The installer must check hardware first, download only one supported model/runtime profile, verify that it actually runs, and fail clearly if unsupported. No runtime fallback and no downloading a larger model that cannot run on the machine.

## Key Decision

Use Qwen-only audio/music-capable models.

Do not use Gemma.

Do not use text-only Qwen models as the main assistant, even if they are easier to run, because the requirement is audio/music understanding.

ACE Step's internal `qwen_4b_ace15.safetensors` model is not the Studio13 assistant brain. It is part of the ACE generation stack and should stay there.

## What TurboQuant Actually Gives Us

TurboQuant is KV-cache compression for vLLM inference. It is not a model-weight quantizer.

That means:

- TurboQuant helps with longer context after the base model has loaded.
- TurboQuant can reduce KV memory pressure for large project/audio summaries.
- TurboQuant does not make an oversized model's weights fit into VRAM by itself.
- TurboQuant applies to the vLLM path, not the GGUF/llama.cpp path.
- For quality-sensitive audio/music planning, prefer 4-bit values where possible. TurboQuant's own README identifies low-bit value quantization as the main quality bottleneck.

TurboQuant's published hardware tests are not audio-model tests:

| TurboQuant-tested model | Hardware | Relevance to Studio13 |
| --- | --- | --- |
| `Qwen3.5-27B-AWQ` | 1x RTX 5090 32GB | Useful proof of vLLM KV compression, but not an audio/music Omni assistant target. |
| `Qwen3.5-35B-A3B` | 8x RTX 3090 24GB | Useful MoE/KV reference, but not a practical single-workstation Studio13 target. |

Studio13 should use TurboQuant as an optimization layer only after a Qwen audio model has passed a real load test.

## Runtime Families

The installer should probe both runtime families before downloading a model, then select exactly one verified profile.

### Primary: vLLM/vLLM-Omni + AWQ + TurboQuant

Use when WSL2 CUDA validates cleanly.

Includes:

- WSL2/Linux CUDA runtime.
- vLLM or vLLM-Omni.
- AWQ or AWQ-Marlin where supported.
- TurboQuant KV-cache compression.
- Triton kernels from vLLM/TurboQuant.
- FlashAttention or vLLM's optimized attention backend.
- PagedAttention.
- Fixed context, batch, and audio-window limits based on VRAM.

Preferred 16GB VRAM candidate:

- `Qwen/Qwen2.5-Omni-7B-AWQ`

Why:

- It supports text, image, audio, and video input.
- Its model card explicitly targets lower-VRAM GPUs.
- Its official table lists substantially lower memory than BF16: 11.77GB for 15s video, 17.84GB for 30s video, 30.31GB for 60s video.
- For Studio13, we should use audio-only input and `return_audio=false`, so the practical audio-only load can be lower than the video table, but it still must be verified locally.

### Secondary: llama.cpp + GGUF + mtmd/mmproj

Use only if the exact GGUF model and audio path verify successfully.

Includes:

- llama.cpp CUDA build.
- GGUF language/model file.
- matching multimodal projector or mtmd-compatible assets when required.
- GPU layer offload.
- llama.cpp flash attention where supported.
- audio-only verification prompt.

Important:

- TurboQuant does not apply to GGUF.
- GGUF model weight quantization and TurboQuant KV compression are separate technologies.
- llama.cpp multimodal/audio support is actively evolving, so GGUF profiles must be marked candidate-only until Studio13's installer proves that the exact model can accept audio and return reliable text/tool-plan output.

## Qwen Model Map: Small to Large

Only models with audio/music understanding are allowed in the assistant model map.

The installer should maintain a strict profile manifest. A model is "loadable" only if both the hardware prefilter and the real startup test pass.

| Tier | Model | Role | Audio/music support | Runtime candidates | Minimum install rule |
| --- | --- | --- | --- | --- | --- |
| Small | `Qwen/Qwen2.5-Omni-3B` | Lowest-footprint direct audio assistant | Yes. Official card reports music/audio reasoning benchmarks. | vLLM-Omni, Transformers, GGUF candidate | Install only after a real 10s audio load test. Prefer this when 7B-AWQ fails on 16GB VRAM. |
| Recommended | `Qwen/Qwen2.5-Omni-7B-AWQ` | Main consumer-GPU assistant | Yes. Better than 3B on most audio/text tasks and has low-VRAM AWQ profile. | vLLM-Omni/Transformers AWQ | Primary target for 32GB RAM / 16GB VRAM. Use 10-15s audio batches by default. |
| Medium | `Qwen/Qwen2.5-Omni-7B` BF16 | Higher-quality 7B baseline | Yes | vLLM-Omni/Transformers | Reject on 16GB VRAM. Require large-VRAM verification, roughly 48GB+ practical headroom. |
| Large analysis sidecar | `Qwen/Qwen3-Omni-30B-A3B-Captioner` | Detailed audio caption/context extractor | Yes, audio-focused text output | vLLM/Transformers, GGUF candidate | Not the main DAW control brain. Require high-VRAM verification or remote lab machine. |
| Large reasoning | `Qwen/Qwen3-Omni-30B-A3B-Thinking` | Best multimodal reasoning candidate | Yes | vLLM/Transformers, GGUF candidate | Reject on 16GB VRAM. Official BF16 table is 68.74GB minimum for 15s video. |
| Largest | `Qwen/Qwen3-Omni-30B-A3B-Instruct` | Full thinker/talker model | Yes | vLLM/Transformers, GGUF candidate | Reject on 16GB VRAM. Official BF16 table is 78.85GB minimum for 15s video. Disable talker when text output only. |

Legacy candidate:

- `Qwen/Qwen2-Audio-7B-Instruct` can understand audio, but Qwen2.5-Omni should be preferred because it has stronger documented multimodal/audio/music performance and better current runtime paths.

## Hardware Selection Rules

These are installer prefilter rules. The final authority is a real local model-load and inference test.

| Hardware | Selected profile |
| --- | --- |
| 16GB VRAM, 32GB RAM, WSL2 CUDA passes | `Qwen/Qwen2.5-Omni-7B-AWQ` through vLLM/vLLM-Omni, TurboQuant enabled after load. |
| 16GB VRAM, vLLM path fails but llama.cpp audio GGUF path verifies | `Qwen2.5-Omni-3B-GGUF` first; `Qwen2.5-Omni-7B-GGUF` only if audio load test passes with headroom. |
| 24GB VRAM | `Qwen/Qwen2.5-Omni-7B-AWQ` with longer audio windows, or verified `Qwen2.5-Omni-7B-GGUF`. |
| 48GB VRAM | `Qwen/Qwen2.5-Omni-7B` BF16 or AWQ with longer batches. |
| 80GB+ VRAM | Consider `Qwen3-Omni-30B-A3B-Thinking`. |
| 96GB+ VRAM or multi-GPU | Consider `Qwen3-Omni-30B-A3B-Instruct`. |
| No verified profile | Do not download a model. Mark assistant unsupported. |

For the current target class of 32GB RAM / 16GB VRAM, the realistic plan is:

1. Try `Qwen/Qwen2.5-Omni-7B-AWQ` with audio-only inference, `return_audio=false`, 10s default audio windows.
2. If it cannot be loaded during pre-download verification planning, try the 3B Omni profile.
3. If neither profile can be proven loadable, do not install the assistant model.

## Installer Requirements

The existing AI runtime installer should gain a separate "assistant runtime" section while keeping ACE Step installation intact.

Probe before download:

- Windows version.
- WSL2 availability.
- NVIDIA driver and CUDA visibility inside WSL2.
- GPU model, VRAM, compute capability, and free VRAM.
- System RAM and free disk.
- Existing ACE Step runtime status.
- Whether vLLM/vLLM-Omni can start.
- Whether TurboQuant can import and attach its vLLM integration.
- Whether llama.cpp CUDA build can run an mtmd/audio smoke test.

Profile manifest fields:

- `profileId`
- `modelRepo`
- `modelRevision`
- `runtimeFamily`
- `quantization`
- `requiresAudioInput`
- `requiresMmproj`
- `minRamGb`
- `minVramGb`
- `minFreeDiskGb`
- `defaultAudioWindowSeconds`
- `maxVerifiedAudioWindowSeconds`
- `contextTokens`
- `gpuOffloadPolicy`
- `turboQuantEnabled`
- `flashAttentionEnabled`
- `tritonRequired`
- `startupTestPrompt`
- `audioSmokeTestFile`
- `sha256` or pinned file checksums where possible

Verification after download:

1. Load the model.
2. Load multimodal/audio projector if required.
3. Run a 10s audio/music understanding test.
4. Run a strict JSON action-plan test.
5. Validate against Studio13's assistant action schema.
6. For vLLM path, verify TurboQuant integration and the attention backend.
7. For GGUF path, verify llama.cpp audio input through its supported local API/CLI.
8. Record the verified profile in a runtime status file.

No fallback policy:

- The installer may probe multiple profiles before download.
- The installer must download only the selected profile.
- After download, if verification fails, mark assistant unsupported.
- Do not silently install a smaller model after a failed selected install.
- User can explicitly rerun setup to select a different profile.

## Audio Context Strategy

Do not feed all multitrack audio directly into the LLM.

Use deterministic project/audio analysis first, then send compact structured context plus selected raw audio windows only when needed.

Per clip context:

- file path/id
- duration
- sample rate
- channels
- clip gain
- fades
- offset/trim
- loudness
- peak/true peak
- silence regions
- transient density
- pitch/key estimate where relevant
- tempo hints
- spectral tilt
- stereo width

Per track context:

- track name/type guess
- clips
- volume/pan/mute/solo/arm
- routing/sends
- FX chain and plugin params
- automation summary
- loudness and peak range
- frequency balance
- role guess such as vocal, drums, bass, guitar, keys, FX, bus, master

Master context:

- integrated LUFS
- short-term LUFS
- true peak
- crest factor
- clipping risk
- spectral balance
- stereo width
- phase/correlation
- dominant problem regions

Batching rules:

| Situation | Audio window policy |
| --- | --- |
| Selected clip edit | Send selected clip summary plus 5-10s raw audio around selection. |
| Track-level mix command | Send full track summary plus 10s representative windows. |
| Master mix command on small project | Send all track summaries plus representative 10s windows from loud/active sections. |
| Master mix command on large project | Batch by buses/stems first, then request track-level details only for problematic groups. |
| Many tracks or long project | Use section summaries first. Raw audio only for selected sections. |
| Micro timing/glitch tasks | Use 1s windows around transient/problem locations. |
| Arrangement/structure tasks | Use 30-100s symbolic/summary windows, not raw audio by default. |

Default for 16GB VRAM:

- 10s audio windows.
- No video input.
- Text output only.
- `return_audio=false`.
- TurboQuant enabled only on the vLLM path after model load.

## Assistant Action Surface

All actions must be typed, validated, reversible where possible, and confirmation-gated.

The assistant should not directly mutate state. It should produce an action plan that Studio13 executes through existing store/bridge paths.

Every clip/track/project data mutation must use undo-aware command paths.

### Transport and Timeline

- Play, stop, pause, record.
- Seek to time/bar/marker.
- Set loop region.
- Toggle metronome/count-in.
- Set tempo/time signature.
- Add, remove, rename, and navigate markers/regions.
- Set snap/grid/zoom/tool mode.

### Tracks and Mixer

- Add, duplicate, remove, rename, color, reorder tracks.
- Create folder tracks, buses, VCAs, groups.
- Set volume, pan, width, phase, mute, solo, arm, monitoring.
- Set input/output routing.
- Add/remove/adjust sends.
- Create mix snapshots.
- Compare or restore mixer snapshots.

### Clips and Editing

- Import audio/MIDI.
- Add generated audio clips.
- Move, split, trim, resize, duplicate, delete clips.
- Set clip gain, mute, color, lock, group, reverse.
- Apply fades/crossfades.
- Quantize, nudge, align, slip edit.
- Dynamic split by transients.
- Normalize or adjust gain.
- Render/bounce selected clips.

### Plugins and FX Chains

- Insert built-in FX or scanned plugins.
- Remove, bypass, enable, reorder plugins.
- Read plugin parameters.
- Set plugin parameters.
- Load presets where available.
- Create common chains, such as vocal cleanup, bass control, drum bus glue, mastering limiter.
- Explain expected sonic impact before applying.

### Automation

- Create/show/hide automation lanes.
- Add, move, delete automation points.
- Set automation mode.
- Draw fades, ramps, ducking, pan moves, filter sweeps.
- Summarize automation conflicts.

### Pitch, Stem, and Audio Analysis

- Analyze pitch contour.
- Apply pitch correction.
- Extract MIDI where supported.
- Separate stems.
- Detect tempo/key.
- Detect transients/silence.
- Analyze loudness/spectrum/stereo.
- Suggest corrective chains based on analysis.

### Render and Export

- Configure render format.
- Render master.
- Render selected tracks/stems only when backend support exists.
- Normalize/tail options where supported.
- Explain unsupported render options rather than pretending they work.

### ACE Step 1.5 XL Turbo

The assistant must be able to control ACE Step through Studio13's existing AI generation pipeline.

Actions:

- `ai.getRuntimeStatus`
- `ai.openSetup`
- `ai.createAITrack`
- `ai.setWorkflow`
- `ai.setGenerationParams`
- `ai.generateMusic`
- `ai.cancelGeneration`
- `ai.pollGeneration`
- `ai.insertGeneratedClip`

ACE workflow params to expose:

- `workflowId`
- `prompt`
- `lyrics`
- `seed`
- `bpm`
- `duration`
- `timesignature`
- `language`
- `keyscale`
- `generate_audio_codes`
- `inferenceSteps`
- `cfg_scale`
- `guidance_scale`
- `shift`
- `temperature`
- `top_p`
- `top_k`
- `min_p`

The assistant should not call `tools/generate_music.py` directly. It should use the app's existing NativeBridge/store flow so progress, cancellation, UI status, and generated clip insertion stay consistent.

If the user requests continuation from an existing clip, the assistant should only use ACE continuation if that workflow is implemented and marked available. Otherwise it should say continuation is unavailable and offer a prompt/style-based generation using extracted clip context.

## Example Action Chains

### "Make the vocal clearer"

Plan:

1. Analyze selected vocal track loudness, spectral balance, silence, and FX chain.
2. Add or adjust high-pass EQ.
3. Add gentle compression.
4. Add de-esser if sibilance is detected.
5. Raise presence band only if masking is detected.
6. Lower competing instruments or add sidechain/dynamic EQ if needed.
7. Preview and keep changes undoable.

Impact:

- Improves intelligibility.
- May make vocal brighter or more forward.
- Can increase harshness if overdone, so cap boosts conservatively.

### "Make the master louder without clipping"

Plan:

1. Analyze master LUFS, true peak, crest factor, clipping risk.
2. Identify tracks/buses causing peak spikes.
3. Lower or compress those tracks first.
4. Add/adjust master bus compression only if needed.
5. Add limiter ceiling, e.g. -1.0 dBTP.
6. Increase gain to target loudness.
7. Re-analyze and show before/after.

Impact:

- Raises perceived loudness.
- May reduce dynamics.
- Safer than only pushing a limiter because it fixes source peaks first.

### "Generate a dark synthwave intro"

Plan:

1. Read project tempo/key if present.
2. Create or select an AI track.
3. Set ACE Step workflow to `text-to-music`.
4. Translate request into ACE params: prompt, BPM, key, duration, seed.
5. Confirm with the user.
6. Start ACE generation.
7. Poll progress.
8. Insert generated clip.
9. Name/color/route track.

Impact:

- Adds a new generated audio clip.
- Does not modify existing audio.
- Can be regenerated with a seed change.

### "Use this clip as context and create drums that fit"

Plan:

1. Analyze selected clip tempo/key/energy/transients.
2. Summarize style and rhythmic feel.
3. Build an ACE prompt from the summary.
4. Generate a drum-focused clip on a new AI track.
5. Align clip start to selection.
6. Set gain conservatively and route to drum bus if present.

Impact:

- Creates a new generated drum layer.
- Existing clip remains untouched.
- Exact continuation depends on whether ACE continuation workflow is available.

## UI Plan

Add a collapsible chat bar on the right side of the DAW.

States:

- collapsed icon button
- expanded chat
- context selected
- thinking/planning
- awaiting confirmation
- executing
- success
- failed/unsupported

The assistant response should show:

- interpreted intent
- affected tracks/clips/plugins
- proposed action chain
- expected sonic impact
- risk/destructive status
- undo availability
- confirmation controls

Execution policy:

- Never auto-execute data-changing actions from plain text.
- Always ask for confirmation.
- Allow safe read-only analysis without confirmation.
- Let the user inspect the exact action chain before execution.

## Feasibility Report

Feasible, with the right constraints.

Most realistic for 32GB RAM / 16GB VRAM:

- `Qwen/Qwen2.5-Omni-7B-AWQ`
- vLLM/vLLM-Omni in WSL2 CUDA
- audio-only input
- `return_audio=false`
- 10s default raw audio windows
- project summaries for larger context
- TurboQuant for KV/context pressure after load

Likely not feasible on 16GB VRAM:

- Qwen3-Omni 30B BF16 variants.
- Long raw multitrack audio context in one prompt.
- Full raw master mix analysis for many tracks without batching.

GGUF feasibility:

- Useful as a secondary path.
- Must be verified per exact model because llama.cpp audio/multimodal support is still moving quickly.
- Do not assume a GGUF file is enough; audio input support and projector compatibility must pass a real smoke test.

ACE Step feasibility:

- Already integrated as a music-generation engine.
- Very useful as an assistant-controlled tool.
- Not suitable as the general DAW assistant model.
- The assistant should use ACE for generation, not for reasoning/planning.

## Implementation Phases

### Phase 1: Documentation and manifests

- Create assistant model profile manifest.
- Add action schema draft.
- Define installer probe outputs.
- Define verification prompts and audio smoke-test assets.

### Phase 2: Runtime probe

- Extend AI runtime probe for assistant runtime.
- Add WSL2 CUDA checks.
- Add vLLM/vLLM-Omni import checks.
- Add TurboQuant import/hook checks.
- Add llama.cpp CUDA/mtmd checks.

### Phase 3: Installer selection

- Select exactly one model profile before download.
- Download only selected model.
- Run verification.
- Save verified runtime status.
- Fail clearly if unsupported.

### Phase 4: Assistant service

- Local HTTP service wrapper around selected runtime.
- Strict JSON output mode.
- Tool/action schema validation.
- Project/audio context assembler.
- Plan generation and confirmation flow.

### Phase 5: DAW integration

- Collapsible right chat bar.
- Action preview UI.
- Confirmation and execution state.
- Undo-aware action execution.
- ACE Step action control.

### Phase 6: Audio intelligence

- Clip/track/master feature summaries.
- Representative audio window selector.
- Batch planner for large projects.
- Before/after analysis for mix actions.

## Acceptance Criteria

- On unsupported hardware, no assistant model is downloaded.
- On supported hardware, exactly one assistant model profile is downloaded.
- Startup verification proves audio input, JSON planning, and schema validation.
- The assistant can explain and confirm a DAW action chain before running.
- The assistant can control ACE Step generation through Studio13's existing AI generation flow.
- Master mix requests use track/bus analysis and batched context instead of dumping all audio into the LLM.
- All data-changing actions remain undoable where Studio13 supports undo.

## Sources

- TurboQuant: https://github.com/0xSero/turboquant
- vLLM-Omni supported models: https://docs.vllm.ai/projects/vllm-omni/en/latest/models/supported_models/
- Qwen2.5-Omni-3B: https://huggingface.co/Qwen/Qwen2.5-Omni-3B
- Qwen2.5-Omni-7B-AWQ: https://huggingface.co/Qwen/Qwen2.5-Omni-7B-AWQ
- Qwen3-Omni-30B-A3B-Instruct: https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct
- llama.cpp multimodal/mtmd notes: https://github.com/ggml-org/llama.cpp/blob/master/tools/mtmd/README.md

