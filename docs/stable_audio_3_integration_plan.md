# Stable Audio 3 + ACE-Step Source-Audio Workflow Checklist

## Summary

- [x] Keep the current ACE model/version exactly as-is: `ACE-Step 1.5 XL Turbo`.
- [x] Add `Stable Audio 3 Medium` as a separate selectable model with its own runtime, setup, and params.
- [x] Add supported source-audio workflows for both models from the clip context menu.
- [x] Do not implement ACE Extract, Lego, or Complete: no UI entries, workflow IDs, backend branches, or disabled placeholders.

## AI Track Flow

- [x] Keep AI tracks prompt-first.
- [x] Add a compact model dropdown in the AI track header:
  - `ACE-Step 1.5 XL Turbo`
  - `Stable Audio 3 Medium`
- [x] Add the same model dropdown at the top of the AI track params modal.
- [x] Make model changes update the workflow dropdown and visible params form.
- [x] Limit AI track workflows to:
  - ACE-Step: `Text to Music`, `Lyrics + Style`
  - Stable Audio 3: `Text to Audio`
- [x] If the selected model is unavailable, turn Generate into a setup CTA focused on that model.

## Clip Context Menu Flow

- [x] Add an `AI Generation` submenu to the existing audio clip right-click menu, near `Separate Stems...`.
- [x] Show the submenu only for audio clips.
- [x] Add menu items:
  - `Create Variation...`
  - `Inpaint Selection...`
  - `Continue Clip...`
- [x] Disable `Inpaint Selection...` unless the current time selection overlaps the clicked clip.
- [x] Open a new `AI Clip Generation` modal from each menu item.
- [x] Include source clip name, source track name, and duration/range summary in the modal.
- [x] Limit modal model choices to models that support the selected source workflow.
- [x] Include workflow-specific params, setup/status block, and Generate/Cancel footer.
- [x] Do not show ACE Extract/Lego/Complete anywhere.

## Output Placement

- [x] Make source-audio workflows nondestructive by default.
- [x] `Create Variation...`: create a new audio track directly below the source track named `AI Variation - <clip name>`, aligned to the source clip start.
- [x] `Inpaint Selection...`: create a new audio track directly below the source track named `AI Inpaint - <clip name>`, aligned to the source clip start.
- [x] `Continue Clip...`: insert only the generated tail at `sourceClip.startTime + sourceClip.duration`.
- [x] Place continuation on the source track when clear; otherwise create `AI Continuation - <clip name>` below the source track.
- [x] Make all generated track/clip additions undo-tracked.

## Workflow + Params Registry

- [x] Replace the single ACE-only workflow registry with a model-aware registry.
- [x] Add model IDs:
  - `ace-step-v15-xl-turbo`
  - `stable-audio-3-medium`
- [x] Add workflow IDs:
  - `text-to-music`
  - `lyrics-style`
  - `text-to-audio`
  - `variation`
  - `inpaint-selection`
  - `continue-clip`
- [x] Declare supported model IDs, surface, params schema, and source requirements per workflow.
- [x] Add ACE source params: prompt, lyrics, seed, duration/extension duration, inference steps, guidance/cfg, `audio_cover_strength`, repaint start/end.
- [x] Add Stable Audio params: prompt, negative prompt, seed, duration/extension duration, steps, cfg scale, source strength/noise amount, inpaint range.
- [x] Add Stable Audio Advanced LoRA inference fields for optional `.safetensors` path and strength.

## Frontend State + UI

- [x] Add `aiMusicModelId` to AI tracks and default existing projects to ACE-Step.
- [x] Add modal state for clip generation source, workflow, model, params, and validation/status.
- [x] Build `AIClipGenerationModal` as a sibling to `StemSeparationModal`.
- [x] Reuse current dark theme tokens, compact controls, existing modal/footer layout, and existing UI components.
- [x] Convert time selection to clip-relative inpaint range:
  - `rangeStart = max(timeSelection.start, clip.startTime) - clip.startTime`
  - `rangeEnd = min(timeSelection.end, clipEnd) - clip.startTime`
  - disable when `rangeEnd <= rangeStart`

## Backend + Bridge

- [x] Extend generation start API to `startAIGeneration(trackId, modelId, workflowId, paramsJSON)`.
- [x] Preserve old three-argument behavior by treating it as ACE-Step.
- [x] Enforce one global generation job at a time for v1.
- [x] Refactor `AITrackEngine` into provider routing.
- [x] Keep ACE provider on the existing persistent ACE worker.
- [x] Add a separate Stable Audio provider/runtime.
- [x] Include source file path, clip offset, clip duration, source track/clip IDs, inpaint range, or extension length in source params.
- [x] Prepare exact source-segment temp WAV before inference so trimmed clips behave correctly.
- [x] Map ACE Variation to Cover with `src_audio` and `audio_cover_strength`.
- [x] Map ACE Inpaint to Repaint with `src_audio`, `repainting_start`, and `repainting_end`.
- [x] Map ACE Continue to Repaint at the source clip end and crop the output to the generated tail before import.
- [x] Map Stable Audio Variation, Inpaint, and Continue to its source-conditioned workflows.
- [x] Add optional `modelId`, `workflowId`, and `sourceClipId` to progress payloads.

## Setup Flow

- [x] Add a music model section under AI Tools Setup > Audio Generation.
- [x] Keep ACE setup unchanged.
- [x] Add Stable Audio 3 Medium setup as strict opt-in.
- [x] Show Stability/Gemma license notice and require explicit checkbox confirmation.
- [x] Show `Powered by Stability AI` attribution when Stable Audio is selected or used.
- [x] Use manual Hugging Face download/import, not stored HF credentials.
- [x] Add `Open Hugging Face Model Page`.
- [x] Show required folder layout help text.
- [x] Add `Proceed with Setup` folder picker and validation.
- [x] Validate Stable Audio folder files:
  - `model.safetensors`
  - `model_config.json`
  - `LICENSE.md`
  - `LICENSE_GEMMA.md`
  - `NOTICE`
  - `t5gemma-b-b-ul2/model.safetensors`
  - `t5gemma-b-b-ul2/config.json`
  - `t5gemma-b-b-ul2/tokenizer.json`
  - `t5gemma-b-b-ul2/tokenizer.model`
  - `t5gemma-b-b-ul2/tokenizer_config.json`
  - `t5gemma-b-b-ul2/special_tokens_map.json`
- [x] Validate the initial local target `C:\Users\srvds\Downloads\stable_audio_3`.
- [x] Copy/import the snapshot into a managed OpenStudio model folder.
- [x] Keep Stable Audio runtime separate from ACE.

## Test + Visual Harness

- [x] Add unit tests for model-aware workflow filtering, default params, normalization, inpaint range conversion, disabled inpaint, and no unsupported workflow IDs.
- [x] Add store tests for model changes, undoable generated source outputs, and continuation placement.
- [x] Add installer/probe tests for Stable Audio folder validation and license confirmation.
- [x] Add `tools/ai-generation-ui-harness.mjs`.
- [x] Harness scenario: `ai-track-model-selector`.
- [x] Harness scenario: `clip-context-ai-menu`.
- [x] Harness scenario: `ai-clip-generation-modal`.
- [x] Harness scenario: `stable-audio-setup`.
- [x] Harness checks desktop and compact screenshots.
- [x] Harness checks text overflow, viewport bounds, menu placement, and theme alignment.
- [x] Harness writes `qa/ai-generation/<date>/screenshots` and `qa/ai-generation/<date>/report.json`.

## Verification

- [x] Run `npx tsc --noEmit`.
- [x] Run the frontend visual harness.
- [x] Build frontend assets into `frontend/dist`.
- [x] Run `cmake --build build --config Debug`.
- [x] Stop Codex-started dev servers and leave port `5173` free.
- [ ] Manual check: ACE text generation from AI track.
- [ ] Manual check: ACE lyrics generation from AI track.
- [ ] Manual check: ACE clip variation.
- [ ] Manual check: ACE inpaint with overlapping time selection.
- [ ] Manual check: ACE continuation.
- [ ] Manual check: Stable Audio setup using `C:\Users\srvds\Downloads\stable_audio_3`.
- [ ] Manual check: Stable Audio text generation from AI track.
- [ ] Manual check: Stable Audio variation, inpaint, and continuation.
- [ ] Verify generated WAVs import, appear at expected positions, play back, and can be undone.
