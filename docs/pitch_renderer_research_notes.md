# Pitch Renderer Research Notes

Date: 2026-04-15

Purpose:
- capture primary-source research before more renderer implementation
- separate "we tried this in code" from "the literature actually supports this family"
- guide the next queue using evidence instead of repeating near-duplicate shell experiments

## Current repo truth
- 2026-04-28 Signalsmith pitch-only formant-contract correction: this is a DSP contract fix, not a renderer-family reopening.
  - Native pitch-only renders now use `setFormantFactor(1.0f, true)` for every pitch-only block, matching live preview and `S13PitchCorrector`.
  - The active adaptive selector no longer throws away detected F0 on its Signalsmith pitch-only carriers: detected F0 guidance goes through `setFormantBase(...)` when available and is never passed as a formant-ratio curve.
  - Offline pitch-only transpose maps use the same stage-A tonality-limit controls as live preview (`OPENSTUDIO_PITCH_STAGEA_TONALITY_LIMIT_HZ_*`) while keeping the formant factor neutral.
  - Explicit formant edits pass the requested ratio directly with `compensatePitch=true`; the pitch ratio is not divided into the formant factor.
  - `OPENSTUDIO_PITCH_DOWNSHIFT_FORMANT_ALPHA` no longer drives Signalsmith pitch-only formant scaling. Downshift body-color support stays in the bounded adaptive selector own-engine blend (`OPENSTUDIO_PITCH_DOWNSHIFT_OWN_BLEND`, default `0.42`) plus envelope-transfer/post-correction stages, not inverse-ratio carrier compensation.
- 2026-04-28 entry contour-handoff correction: this is a signal-chain ownership fix, not a renderer-family reopening.
  - Hard/unknown note entries need pitch-ratio render pre-roll for shifter history, but the audible commit must still be governed by the entry bridge.
  - A delayed body ramp on canonical hard/unknown `pitchOrg` edits measured worse, so production keeps the target ratio reached by `note.startTime` for those cases.
  - Explicit continuous/internal transitions can use a minimum-jerk pitch handoff, and adjacent edited notes inside one island report that internal handoff instead of creating another dry/wet bridge.
  - New diagnostics and harness metrics track entry pitch handoff ranges plus F0 slope/acceleration; slope gates are meaningful only when a handoff is actually used.
- 2026-04-28 emergency word-grouping repair: this is a product ownership correction, not a renderer-family reopening.
  - `wordGroupId` is now assistive metadata only; normal click/drag editing no longer expands to the whole group.
  - Explicitly selected adjacent notes can still render as one note-HQ island to avoid doubled ownership.
  - Analyzer hard acoustic candidates can split broad phrase regions, but pitch hysteresis/vibrato remains diagnostic.
  - The corrected lesson is that analyzer grouping must not silently decide the user's edit target.
  - Measured after repair: analyzer destructive corner/pitch-jump splits are `0/0`, `pitchOrg +4/-4` note-HQ primary runs pass, downshift harmonic drift is `0.343`, and adjacent selected notes report one edit island for two edited notes.
- 2026-04-28 phrase-first word detection update: this is an analyzer/product-model correction, not a renderer-family reopening.
  - The previous pitch-corner demotion was incomplete because an older running-average pitch-jump rule could still destructively split continuous vibrato/bend passages.
  - Pitch jumps, hysteresis-style sustained deviations, and vibrato reversals now surface as diagnostics/boundary candidates instead of default editable cuts.
  - Short voiced detector dropouts are bridged inside a phrase, while hard automatic splits require stronger acoustic evidence.
  - Superseded by the emergency repair: the editor does not treat `wordGroupId` as the primary pitch-edit object by default.
- 2026-04-28 word-group/edit-island update: this is a product-model and signal-chain correction, not a renderer-family reopening.
  - Pitch-corner detection is now diagnostic by default; it surfaces `boundaryCandidates` without splitting editable notes unless a research env flag is set.
  - The analyzer exports `wordGroupId`, but pitch editing no longer defaults to moving the whole word group.
  - Note-HQ final apply now commits per edit island, so adjacent selected notes do not create internal dry/wet bridges or doubled ownership.
  - Commit range merging no longer averages pitch ratios; pitch ownership and the per-sample pitch curve are separate concepts.
  - The corrected lesson is that segmentation can become too "successful": cutting every curve corner can hide a stitch problem while creating broken-word editing.
- 2026-04-27 segmentation/timbre update: this is still a signal-chain correction, not a renderer-family reopening.
  - The analyzer now distinguishes pitch contour tracking from editable note/vocal boundaries by adding conservative pitch-corner splits with boundary-kind diagnostics.
  - Note-HQ bridge ownership consumes those boundary kinds: hard word-like boundaries stay tightly dry-protected, while soft legato/sustain boundaries can use wider smoothing.
  - Downshift timbre preservation now adds voiced-core spectral envelope transfer after the native directional render so the shifted vowel body is pulled back toward the original envelope.
  - This targets the failure mode where a good compositor is smoothing the wrong acoustic boundary.
  - An aggressive envelope-transfer probe regressed `pitchOrg -4` harmonic drift to `0.615`, so the kept implementation uses a small voiced-support-weighted mix and passed the primary downshift gate at `0.343`.
- 2026-04-27 update: the latest pitch editor work was a signal-chain correctness pass, not a new renderer-family experiment.
  - The main timbre bug was an argument-order bug: detected F0 guidance was being supplied where `formantRatios` belong in pitch-only `SignalsmithShifter::process(...)` calls.
  - Pitch-only paths now call explicit pitch-only entrypoints and keep explicit formant rendering separate.
  - The note-HQ harness now scores phrase/full-clip results as full-clip audio instead of always slicing as if the candidate were window-local.
  - Transition shoulders are now owned by the note-HQ commit range, which reduces hard body-edge switching without reopening the rejected seam-tweak families.
- 2026-04-27 direction-specific update: the follow-up fix is also a signal-chain correction, not a new renderer-family experiment.
  - Production `note_hq` pitch-only now defaults to native direction-specific HQ.
  - Upward edits keep the existing native adaptive path.
  - Superseded carrier detail: downward edits used a gentler `pow(1 / ratio, alpha)` formant guard for a period, but pitch-only Signalsmith now preserves formants with neutral `setFormantFactor(1.0f, true)`.
  - Rubber Band stays available as a diagnostic/benchmark backend, and its benchmark pitch map now uses effective transition shoulders, but it is not quality-promoted for production until it passes the same formant and boundary gates as native.
  - New diagnostics include pitch direction, renderer branch, downshift guard usage, guard alpha, effective transition range, and Rubber Band quality-promotion status.
  - The harness now includes an exit-to-next-note artifact score so edited-note release and next-note head issues are measured directly.
  - Primary `pitchOrg -4` harmonic drift improved from the prior native `0.469` to `0.353`; primary `pitchOrg +4` stayed stable at `0.378`.
- 2026-04-27 two-sided boundary follow-up:
  - This is still a signal-chain/compositor correction, not a new renderer family.
  - The renderer needs shoulder context, but final audible commit ownership must not include the previous word.
  - Commit ranges now carry both context/effective range and note-body start/end.
  - The compositor copies `[effectiveStartTime, note.startTime)` dry, fades dry-to-wet inside the first `12 ms` of the edited note body, and keeps the exit release fade through the right shoulder.
  - The failed lesson is explicit: widening left shoulder ownership can move the stutter backward into the previous word.
  - The harness now reports `preBodyTailOriginalResidualDb`, `candidateActiveDifferenceStartSec`, and `preBodyTailArtifactScore` in addition to onset and exit-next artifacts.
  - Primary final runs passed with pre-body residuals below `-169 dB`, active difference starting at `0.900063s`, onset artifacts `1.706 / 2.721`, and exit-next artifacts `2.307 / 0.091` for `pitchOrg +4 / -4`.
- 2026-04-27 entry-bridge follow-up:
  - This remains a signal-chain/compositor correction, not a renderer-family experiment.
  - The fully dry pre-note rule protected the previous word, but left a phase/envelope discontinuity at the edited-note entry.
  - Final apply may now use a bounded bridge before `note.startTime`; everything before `noteHqEntryBridgeStartSec` must remain dry.
  - Upward edits use a tight in-body bridge; downward edits use a bounded pre-note bridge with a temporary wet-read delay and capped envelope correction.
  - Primary final runs: `pitchOrg +4` entry lag `-0.125 ms`, onset artifact `1.479`, pre-bridge residual `-172.823 dB`; `pitchOrg -4` entry lag `+0.771 ms`, onset artifact `1.598`, harmonic drift `0.344`, pre-bridge residual `-240.000 dB`.
- Best working editor path is still `pitch_only_adaptive_selector`.
- We have already exhausted:
  - blend/ramp handoff families
  - dry-attack/body-replacement families
  - continuation families
  - heuristic HPSS shell
  - WSOLA shoulder-only seam pass
  - lightweight phase-lock boundary-alignment pass
  - median HPSS shell without envelope correction
- The persistent audible problems are still:
  - onset stutter / seam artifact
  - formant/timbre drift on note changes
  - weak generalization from `pitchOrg` to `pitchTestOrg`

## Primary-source findings

### 1. Median-filter HPSS is real, but it is a separation tool, not a complete vocal pitch-editor solution
- FitzGerald 2010 presents a fast harmonic/percussive separation method using median filtering on the spectrogram.
- The paper supports HPSS as a useful structural decomposition step.
- It does not claim that median HPSS alone solves vocal pitch-edit rendering, onset/body continuity, or formant preservation.
- This matches the repo result:
  - onset-side improvement is plausible
  - body/pitch/timbre can still collapse if the harmonic renderer is weak

Source:
- Derry FitzGerald, "Harmonic/Percussive Separation Using Median Filtering," DAFx-10, 2010
- https://dafx.de/paper-archive/2010/DAFx10/DerryFitzGerald_DAFx10_P15.pdf

### 2. WSOLA is strong for local continuity and time-scale seams, but it is not a full answer to vocal pitch-edit artifacts
- Verhelst and Roelands 1993 introduced WSOLA for high-quality time-scale modification of speech.
- It is good at local alignment and reducing overlap-add discontinuities.
- It does not by itself solve harmonic-body retuning, formant preservation, or residual/noise modeling.
- This matches the repo result:
  - shoulder-only WSOLA did not beat the current adaptive editor

Source:
- Werner Verhelst and Marc Roelands, "An Overlap-Add Technique Based on Waveform Similarity (WSOLA) for High Quality Time-Scale Modification of Speech," ICASSP 1993
- publication record: https://www.etrovub.be/research/publications/publication-details/overview/3449/

### 3. Stronger phase-vocoder work is still genuinely untried here
- Laroche and Dolson 1999 directly target classical phase-vocoder weaknesses with peak-centered frequency shifting and better phase handling.
- "Phase Vocoder Done Right" (2022) goes further and explicitly argues that phase-gradient-based integration can avoid typical phase-vocoder artifacts without separate transient handling.
- The repo only tried a lighter boundary-alignment variant, not a research-grade phase-coherent PV path.
- Therefore:
  - the phase family is not exhausted in the literature sense
  - only the lightweight local branch we tried is exhausted

Sources:
- Jean Laroche and Mark Dolson, "New Phase-Vocoder Techniques for Pitch-Shifting, Harmonizing and Other Exotic Effects," 1999
- https://www.ee.columbia.edu/~dpwe/papers/LaroD99-pvoc.pdf
- "Phase Vocoder Done Right," arXiv 2202.07382
- https://arxiv.org/abs/2202.07382

### 4. DDSP is the strongest research-backed engine-redesign direction
- DDSP combines harmonic/noise DSP structure with learned control.
- The paper specifically highlights interpretable, modular control over pitch, loudness, and timbre-relevant components.
- This is a strong fit for our real problem:
  - harmonic body
  - noise/residual
  - timbre preservation
  - controllable pitch change
- It is not a small patch; it is a true engine-v2 direction.

Source:
- Jesse Engel et al., "DDSP: Differentiable Digital Signal Processing," 2020
- https://arxiv.org/abs/2001.04643

### 5. The strongest paper match to our current product problem is restoration-after-shift
- The 2026 shallow-diffusion singing restoration paper reframes pitch shifting as restoration.
- This is highly relevant to the repo because our best current path already produces a usable pitch-correct render, but still leaves:
  - stutter
  - robotic coloration
  - formant drift
- The paper explicitly targets those tradeoffs while preserving melody and timing.
- This makes offline restoration a stronger next benchmark than more small DSP shell variations.

Source:
- Yunyi Liu and Taketo Akama, "Self-supervised restoration of singing voice degraded by pitch shifting using shallow diffusion," 2026
- https://arxiv.org/abs/2601.10345

### 6. WORLD remains useful as a support decomposition, not necessarily as the final renderer
- WORLD gives explicit decomposition into:
  - F0
  - spectral envelope
  - aperiodicity
- That is valuable for support features and diagnostics.
- The repo history still does not support pure WORLD-style rendering as the final pitch-editor path.

Source:
- Masanori Morise et al., "WORLD: A Vocoder-Based High-Quality Speech Synthesis System for Real-Time Applications," 2016
- https://www.jstage.jst.go.jp/article/transinf/E99.D/7/E99.D_2015EDP7457/_pdf/-char/en

## Research-backed conclusions

### Exhausted enough for now
- WSOLA as a shoulder-only seam fix
- heuristic HPSS shell
- scalar median HPSS shell
- lightweight boundary-aligned phase-lock variant

### Still genuinely viable
- a true research-grade phase-vocoder family:
  - identity / peak phase locking
  - or phase-gradient / RTPGHI-style integration
- an offline restoration benchmark on top of the best current renderer
- DDSP-style engine-v2 work if we accept a larger revamp

### Lower priority or support only
- WORLD as decomposition support only
- further HPSS shell variants without a stronger harmonic/timbre model
- more seam-only local overlap tweaks

## Recommended next queue
1. `FAM-PVDR`
   - proper phase-coherent phase-vocoder family
   - not another boundary-alignment patch
   - long/stable voiced regions first
2. `FAM-ML-RESTORATION`
   - offline benchmark on top of `pitch_only_adaptive_selector`
   - treat artifacts as restoration rather than trying to make the base shifter perfect
3. Broader validation sweep on `FAM-ADAPTIVE-SELECTOR`
   - keep the current best editor stable while new work stays benchmark-only

## Why this matters
- The current repo pattern is clear:
  - shell/onset ideas can improve onset metrics on the easy case
  - but they do not reliably preserve body, pitch exactness, or hard-case generalization
- The literature supports moving either:
  - deeper into true phase-coherent DSP
  - or into restoration-after-render
- It does not support more time on small seam-only tweaks as the highest-value next move
