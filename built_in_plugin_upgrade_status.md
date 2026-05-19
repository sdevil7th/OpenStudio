# Built-In Plugin Upgrade Status

This file tracks the remaining work for the Studio13 built-in plugin suite. Items marked done are implemented in the current working tree, but subjective sound quality still needs user audition before it can be called final.

## Completed

- [x] Add a built-in plugin schema bridge for React editors.
- [x] Add bridge methods for built-in plugin schema, state, parameter set, and state set.
- [x] Add React schema-driven built-in plugin panel inside `FXChainPanel`.
- [x] Keep external VST/CLAP/LV2 editors native while built-ins use React panels.
- [x] Fix dev frontend fallback/HMR mismatch by using `127.0.0.1:5173` consistently.
- [x] Make dev mode rebuild packaged frontend fallback assets.
- [x] Add bundled built-in instrument plugins addable from the FX/plugin chain:
  - [x] `Studio13 Basic Synth`
  - [x] `Studio13 Piano`
  - [x] `Studio13 Drums`
- [x] Set tracks to `instrument` when a built-in instrument plugin is added.
- [x] Prevent the old fallback instrument from double-rendering when a built-in instrument FX exists.
- [x] Preserve built-in FX/instrument save/load by storing/restoring built-in plugin names.
- [x] Preserve built-in FX/instrument duplication by restoring built-ins through the built-in FX bridge.
- [x] Improve Basic Synth from a simple fallback tone to a polyphonic subtractive synth with anti-aliased oscillators, sub, noise, brightness, detune, attack, release, and output gain.
- [x] Add Basic Synth pitch-bend and mod-wheel routing.
- [x] Add a playable synthesized piano instrument with tone, body, hammer, release, and output gain controls.
- [x] Improve piano toward hybrid-modeled behavior with model flavors, sustain pedal, resonance, and stereo width.
- [x] Add a playable synthesized drum instrument with kit, tuning, room, hi-hat tightness, output gain, GM notes, and CC4 hi-hat pedal behavior for e-drums.
- [x] Improve drums toward hybrid-modeled behavior with velocity curve, punch, and stereo kit placement controls.
- [x] Improve sampler fallback interpolation from linear to cubic.
- [x] Remove selected audio-thread temporary allocations in built-in reverb and saturator paths.
- [x] Make compressor auto makeup apply adaptive makeup gain from current gain reduction.
- [x] Make compressor auto release adapt release time from current gain reduction.
- [x] Replace limiter hard-clip end stage with a preallocated lookahead gain stage and soft safety ceiling.
- [x] Add intersample-aware peak estimation to limiter detection.
- [x] Add EQ auto-gain based on the actual filter response instead of a decorative toggle.
- [x] Add compressor Peak/RMS/Auto detector modes.
- [x] Add compressor stereo-link detector control.
- [x] Add 4x oversampled true-peak detection into limiter gain reduction.
- [x] Add gate Peak/RMS/Auto detector modes.
- [x] Avoid constant gate sidechain filter coefficient rebuilds when filter values have not changed.
- [x] Smooth delay-time changes to avoid abrupt delay jumps.
- [x] Correct delay tempo-sync note mapping to match the UI labels.
- [x] Add delay ducking control.
- [x] Add tape-style delay modulation in the feedback path.
- [x] Add reverb early reflection taps independent from late-tail level.
- [x] Cache reverb wet tone filter coefficients instead of rebuilding them every block.
- [x] Replace stock reverb late-tail processing with a native 8-line feedback delay network.
- [x] Add denser reverb late-tail diffusion with algorithm-specific delay spacing.
- [x] Add reverb late-tail modulation, width shaping, freeze feedback, and shimmer-style feedback coloration.
- [x] Expose EQ magnitude response and pre/post analyzer snapshots through the built-in schema.
- [x] Add draggable EQ response graph editing in the React built-in panel.
- [x] Add EQ band audition parameter with DSP/schema/state support.
- [x] Add EQ dynamic band parameters with detector-driven gain modulation and UI visualization.
- [x] Add EQ stereo/mid/side processing mode where stereo routing supports it.
- [x] Cache EQ band parameter state to avoid rebuilding unchanged filter coefficients every audio block.
- [x] Add built-in plugin offline DSP smoke fixture to the native automated regression suite.
- [x] Add compressor sidechain HPF regression fixture comparing low-frequency gain reduction at 20 Hz vs 500 Hz HPF.
- [x] Expose dynamics gain-reduction, input/output level, and gate-open metrics through the built-in schema.
- [x] Add live dynamics gain-reduction history and meters in the React built-in panel.
- [x] Expose pitch-correct live pitch telemetry/history through the built-in schema and React panel.
- [x] Make chorus tempo sync affect LFO rate.
- [x] Add chorus/flanger/phaser character modes for Clean, Ensemble, and BBD-style modulation.
- [x] Apply chorus/flanger/phaser wet low-cut and high-cut filters.
- [x] Preallocate separate saturator 2x and 4x oversamplers and choose quality mode without audio-thread allocation.
- [x] Add saturator drive output compensation.
- [x] Add Console, Transformer, and Foldback saturator models.
- [x] Add saturator post-drive low-cut tone filter.
- [x] Remove remaining reverb audio-thread dry/early scratch resizing by preallocating larger process buffers in `prepareToPlay`.
- [x] Replace raw built-in parameter rows with plugin-aware macro controls, grouped sections, and responsive editor grids.
- [x] Add built-in latency/tail and delay smoothing regression fixtures.
- [x] Remove per-sample phaser all-pass coefficient allocation and cache dynamic EQ detector coefficients.
- [x] Add frontend Vitest coverage for built-in schema classification, primary controls, and React control rendering.
- [x] Make existing `ParametricGraph` controls theme-aware with unique clip paths and reusable graph color tokens.
- [x] Add smoothing for saturator drive, mix, and compensated output gain.
- [x] Wire the built-in EQ editor to the reusable schema-driven `ParametricGraph` adapter with response and analyzer curves.
- [x] Add responsive layout guards for every built-in panel kind across desktop, tablet, and narrow CSS contracts.

## Remaining DSP Work

- [x] EQ: add analyzer pre/post display.
- [x] EQ: add draggable response graph editing.
- [x] EQ: add dynamic bands.
- [x] EQ: add band audition.
- [x] EQ: add stereo/mid-side modes where routing supports it.
- [x] EQ: implement real auto-gain or remove misleading auto-gain behavior.
- [x] Compressor: add peak/RMS/auto detector modes.
- [x] Compressor: add stereo link control.
- [x] Compressor: complete working auto release and auto makeup behavior.
- [x] Compressor: add sidechain HPF behavior that is audibly and measurably effective.
- [x] Compressor: add gain-reduction history for UI.
- [x] Gate: add detector mode and sidechain filter polish.
- [x] Gate: add gain-reduction/open-close history for UI.
- [x] Limiter: add lookahead ring buffer if current path is insufficient.
- [x] Limiter: add oversampled true-peak detection/limiting.
- [x] Limiter: avoid hard-clip distortion at ceiling.
- [x] Delay: smooth delay-time changes.
- [x] Delay: add dotted/triplet tempo sync polish.
- [x] Delay: add ducking.
- [x] Delay: improve modulation, width, tone, and saturation in feedback.
- [x] Reverb: replace current wrapper-level behavior with stronger native room/hall/plate algorithms.
- [x] Reverb: add early reflections.
- [x] Reverb: add denser late tail.
- [x] Reverb: improve damping, modulation, width, freeze, and shimmer behavior.
- [x] Chorus/flanger/phaser: add interpolated delay lines.
- [x] Chorus/flanger/phaser: add ensemble/BBD character modes.
- [x] Chorus/flanger/phaser: improve tone filters, tempo sync, stereo spread, and modulation quality.
- [x] Saturator: complete oversampling quality modes without realtime allocations.
- [x] Saturator: add more modeled curves, bias/asymmetry polish, tone filters, and output compensation.
- [x] Pitch Correct: finish unified built-in UI/schema polish and deterministic routing tests.
- [x] Piano: improve from synthesized decent to sample-library-grade or hybrid modeled/sample playback.
- [x] Drums: improve from synthesized decent to sample-library-grade or hybrid modeled/sample playback.
- [x] Drums: add named e-drum mapping presets, including Roland TD-style mappings.

## Remaining UI Work

- [x] Replace generic schema layout with polished plugin-specific React editors for each built-in.
- [x] Add professional DAW-style graph controls for EQ, dynamics, delay, reverb, modulation, and saturation.
- [x] Refactor existing `ParametricGraph` controls into fully schema-driven graph adapters.
- [x] Add meters/history visualizations for dynamics, limiter, and gate.
- [x] Add analyzer visualization for EQ.
- [x] Add instrument-specific visual polish for synth, piano, and drums.
- [x] Check responsive layouts at desktop and narrow widths for every built-in panel.

## Remaining Realtime Safety Work

- [x] Audit all built-ins for audio-thread heap allocations.
- [x] Preallocate analyzer, delay, oversampling, scratch, and tail buffers in `prepareToPlay`.
- [x] Add parameter smoothing where zipper noise can occur.
- [x] Add denormal, NaN, and bounded-output guards across all built-ins.
- [x] Avoid expensive coefficient rebuilds inside audio callbacks where possible.

## Remaining Tests

- [x] Add offline C++ DSP harnesses for built-ins.
- [x] Test bypass parity.
- [x] Test finite output and no NaN/Inf.
- [x] Test bounded gain.
- [x] Test latency and tail behavior.
- [x] Test parameter smoothing and zipper-spike avoidance.
- [x] Test EQ curves.
- [x] Test compressor, gate, and limiter gain behavior.
- [x] Test limiter true-peak handling.
- [x] Test delay tempo timing.
- [x] Test reverb tail decay.
- [x] Test synth tuning, MIDI note handling, voice stealing, pitch bend, and mod behavior.
- [x] Test piano MIDI behavior and voice cleanup.
- [x] Test drum GM/Roland-style note mapping and CC4 hi-hat behavior.
- [x] Add frontend tests for built-in schema mapping and React controls.
- [x] Verify all new `useDAWStore` consumers use `useShallow`.

## Acceptance Status

- Objective build/type verification: pass as of the latest implementation pass.
- Objective routing/schema behavior: pass for the implemented built-in instrument/React bridge foundation.
- Subjective audio quality: not_asserted until user auditions exact artifacts in the app.
- Industry-standard parity for the full built-in suite: implementation pass complete, subjective audition pending.
