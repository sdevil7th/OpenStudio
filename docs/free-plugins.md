# Built-in effects and instruments

This is the maintenance guide for the sixteen non-NAM processors in the development checkout. User controls and workflows belong in the [manual](USER_MANUAL.md#9-effects); repeatable checks belong in [testing](testing.md#free-plugin-processing-and-editor-checks). NAM has its own [guide](nam-rack.md). Source capabilities are not a claim about an existing installer; consult the release notes for shipped behavior.

## Product and design contract

Fifteen effects/instruments have dedicated editors. Reverb, Delay and Chorus use the revised approved compositions. Pitch Correct opens the existing clip **Edit Pitch** session, including its docked/detached view and history; its realtime FX settings remain a separate compatible processing path.

- Keep processors independently insertable and reorderable. A family selector changes the engine inside that processor, not another processor's saved identity.
- Show the main musical decisions first, with contextual detail pages for controls the selected engine actually consumes. Do not expose inactive controls merely because a descriptor exists.
- Keep type, processing character and preset separate. Hide an inapplicable control without deleting its saved value. Closed detail pages indicate non-default or active settings.
- Use the shared theme and original artwork. The primary surface fits its host; detailed pages may scroll. Native minimum client size is 640x480 for this suite; NAM and hosted editors retain their own rules.
- Support numeric entry, fine drag, reset, keyboard and profile-aware wheel input. One continuous gesture or compound edit must produce one Undo entry and correctly paired automation gestures.
- Metering and performance displays must come from native telemetry. Distinguish received MIDI keys from sounding/releasing voices, and show idle/unavailable states explicitly.
- Require no sample pack or download. Convolution has one original default IR; user IRs travel in complete state. Do not ship proprietary libraries, reference artwork or vendor branding.

The approved prototypes and repeated review screenshots were development aids. Their simulated telemetry, example presets and fake IR states are not production code. Superseded previews and raw runs belong under ignored `output/`, not in the source tree.

## Source ownership

| Concern | Authoritative code |
| --- | --- |
| Processor factories, parameters and state | `Source/BuiltInEffects.*`, `BuiltInEffects2.*`, `BuiltInUtilityEffects.h`, `BuiltInGraphicEQ.h` and family DSP headers |
| Native schema, configuration preparation, host routing and telemetry | `Source/AudioEngine.*`, its focused `.inc` implementations, `MainComponent.cpp`, `TrackProcessor.*` |
| Editor selection and bounds | `frontend/src/components/builtin/editorRegistry.ts`, `BuiltInPluginPanel.tsx`, `Source/Main.cpp` |
| Shared gestures, optimistic writes and retained instance history | `SuiteParameter.tsx`, `BuiltInPluginPanel.tsx`, `builtInPluginParamHistory.ts`, `suiteParameterGesture.ts` |
| Presets, Compare and host bypass | `EQToolbar.tsx`, native full-state operations, `AudioEngineBuiltInPresetFiles.inc`, `builtInHostBypassHistory.ts` |
| Shared control styling | `PluginEditorControls.ts` Tailwind utilities; processor-owned CSS for artwork, pseudo-elements and scene geometry |
| Graphical pitch entry and ownership | `PitchFXEditorEntry.tsx`, `pitchEditorFXEntry.ts`, `pitchEditorStore.ts`, `PitchEditorLowerZone.tsx`, `PitchEditorWindowApp.tsx` |
| Native correctness fixtures | `Source/FreePluginRegression.cpp`, its family regression headers, host regression `.inc` files and `tests/fixtures/free-plugins/` |

Small DSP headers and regression files are dependencies, not generated output. Keep compatibility fixtures immutable when fixing a regression. Avoid merging unrelated modules merely to reduce Git's file count.

## Implemented capability boundaries

These are implemented paths, not claims of commercial equivalence. The manual documents their controls in detail.

| Family | Current implementation | Important boundary |
| --- | --- | --- |
| Parametric EQ | 24 bands, extended shapes/ranges/targets, per-band dynamics and detector routing; prepared Linear/Minimum FIR/Analog targets; original spectral correction; Draw/Match/Grab audition; groups, inter-instance analysis, native presets and 32-entry prepared MIDI programs | Static phase, ordinary dynamics and spectral processing are distinct. Mixed-configuration recall reserves the largest prepared latency; its audible transition is not instantaneous. Proprietary Natural Phase and spectral-mask equivalence are unqualified. |
| Graphic EQ | Independent 10/31-band banks, grouped gestures/offsets, cuts, targets, Flat and native response/analyzer | Compact frequency pages retain every band. Proportional-Q, flat-top and separate linked curves remain extension decisions. |
| Compressor | Clean/Legacy, FET, two opto and two VCA profiles; engine-specific controls, detector tilt/emphasis, channel/link/monitor options and per-model memories | Original stages is opt-in. Digital response tests do not establish hardware transfer, amplifier or meter calibration. |
| Gate | Gate/expansion, filtered internal/external keys, detector audition and envelope controls | New Transient response changes Peak/Auto onset in Gate only. RMS integrates; Expansion preserves its prior continuous law. Legacy and NAM retain their behavior. No lookahead or instantaneous-pulse preservation is promised. |
| Limiter | Eight original responses, audio oversampling, final-output guard, latency alignment, reconstructed-peak and loudness/history displays | Finite final-output tests are not an arbitrary-input ceiling proof or full BS.1770/EBU certification. Export dither belongs after sample-rate/channel conversion. |
| Preamp / Saturator | Stepped preamp tone/HPF and separate input/output drive/trim; retained Legacy and original stateful saturation voices, compensation/mix and meters | Compensation is an estimate. Circuit matching, broad alias qualification and perceptual acceptance remain open. |
| Gain Phase | Manual fractional timing/polarity, all-pass and saved 48-point/channel spectral FIR; 2-8-instance capture, proposal audition and whole-group Undo | Fixed-duration sparse captures are explicitly sparse. To-project-end streams the selected span through a bounded queue for up to 30 minutes. Route/source/latency changes or missing coverage invalidate Apply. |
| Reverb | 41 types across studio, vintage, plate/modal, spring, shimmer, nonlinear, spatial, ambient and convolution families; per-type memories, Send/mix lock, supported Hold and wet-tail spillover | Controls follow the actual engine. Legacy crossfades, finite-only modes and deferred changes under Hold remain explicit. Nominal decay/geometry is not a measured commercial room or circuit. |
| Convolution | Portable mono/stereo/four-path IRs; cancellable preparation, shaping, synthetic extension/brightness, source blend, wet EQ/modulation, declared geometry, isolated audition and diagnostic decay analysis | Four outputs split diagonal paths to Main 1/2 and cross paths to auxiliary 3/4. This is not arbitrary surround or measured venue reconstruction. Applied IR remains usable when preparation fails/cancels. |
| Delay | Digital/Tape/Analog/Multi/Dual, stereo timing/sync, tone/colour, motion, ducking and post-repeat diffusion | Native effective timing includes tempo source/capacity. Existing diffusion adds span after the repeat. Pitch/reverse/frequency-shift families and compensated diffusion remain explicit scope decisions. |
| Chorus | Chorus/Flanger/Phaser with contextual voices/stages, independent sync divisions, waveform, feedback and tone | Ensemble discloses effective minimum voices and cutoff; inactive Phaser spread stays saved. No TAL/Juno emulation claim. |
| Synth | Two oscillators/sub/noise, filter and amplitude envelopes, shared/per-note LFO, eight routes with 28 destinations, four CC-learn macros and MPE | Saved base values and transient MIDI targets are distinct. Voice allocation, pedals, controller chase and export releases are bounded. |
| Piano / Guitar | Synthesized voices, expressive pedals/releases; guitar plucked loop, nine articulations/keyswitches, string ownership and chorus; optional secondary coupled bodies | Coupled bodies do not replace the primary synthesis engine. Guitar telemetry reports actual block-end allocations and latched articulation, before bend/slide; resonance tails are separate. |
| Drums | Sixteen audition pads, eight shared piece inspectors, 128-note remapping/Ignore, articulations/chokes and exclusive Main/auxiliary output pairs through 17/18 | Incoming MIDI note and resulting piece/articulation are distinct. Audition folds its isolated clone to stereo without changing saved routing. No sample library or full groove product is implied. |
| Pitch Correct | Existing clip editor entry, source/confidence controls and compatible realtime FX; opt-in sustained-note Humanize | Clip Apply and realtime route processing are different. Opening the editor does not silently bypass FX; warn about active correction. Graphical formant editing and broad vocal-quality claims remain unqualified. |

## Compatibility and host invariants

1. Preserve native IDs, descriptor indices, normalized automation ranges and missing-field defaults. Expanded selectors use appended aliases. Do not replace old selector ranges in place or bump a schema/DSP version without migration and round-trip coverage.
2. Complete state includes hidden engines, family memories, embedded IR bytes and MIDI maps. Presets, Compare and Undo must restore that state, not approximate it with a few visible scalar writes. Imported preset files must match processor type and fail without replacing valid data.
3. Host bypass belongs to the FX slot; saved processor bypass belongs to DSP state. Keep their histories and serialization distinct. Resolve mutations by instance identity after reorder and reject removed/replaced instances and stale project epochs.
4. Any configuration mutation that changes preparation or latency must synchronize PDC and the host's dry bypass path, including full-state, preset, factory, Compare and history recalls. Master/monitor stage desired state must agree with the active processor.
5. Publish restored sends as one validated complete configuration. Creating an enabled Main 1/2 send and setting its auxiliary pair/level later leaks an intermediate audible route. Preserve ordering, disabled sends, source pairs and rollback on rejection.
6. Export uses the processor's finite release bound at the export sample rate, including supported modulation. Release CC64 and CC66 at content end. Held notes, intentional infinite effects and continuous noise are not finite tails.
7. Prepare large buffers, FIR kernels, IRs and configuration banks off the audio callback. Publish prepared owners safely and retire them outside the callback. Never add callback file access, heap work or blocking locks to implement a UI feature.
8. Share telemetry through bounded atomic snapshots and subscribed UI leaves. Keep fast meters out of track-array state and full-schema parameter rendering; pause hidden polling and discard stale replies. Instrument preview owns its notes and releases them on cancel, blur, hide, close and source replacement.
9. EQ phase changes preserve supported active dynamics through one prepared, undoable configuration transition. Prepared MIDI banks reject unsupported live configuration edits. Draw/Match/Grab previews are transient state with explicit Apply/Cancel, not destructive preset changes.
10. Reverb preparation uses begin/status/cancel/release and staged Apply/Revert. Preserve IR source identity, original portable bytes, channel order and last working response. Hold semantics are engine-specific: Infinite may accept new excitation while Freeze rejects it. Type switching must process only active/draining engines with bounded tail retirement.

## Original audio stages

Compressor and Preamp retain Legacy as both the new-instance and missing-field default. Opt-in Original uses model-specific nonlinear input/output laws, low-frequency state, drive memory, DC rejection and digital headroom scaling. It is original processing, not a fitted model of a commercial circuit.

Compressor places input colour before reduction and output colour after it; both VCA response engines apply exactly one stage pair. FET Ratio Off preserves colour. Clean/Legacy compressor models remain linear. Preamp places input colour before Tone EQ, output drive after Tone EQ, and linear trim last.

Original uses prepared 16x FIR processing. Its filter delay is 78 samples; Compressor additionally reserves 20 ms (1038 samples total at 48 kHz). Legacy Preamp retains its 4x IIR path. Character changes are prepared configuration edits, while supported headroom/output-drive controls are automatable. Dry, processor bypass and host bypass must all follow the prepared latency. A conservative one-second stage tail excludes intentional Punch noise.

The 3 October deterministic tests passed four-rate timing, state, block-partition and headroom-similarity contracts. A selected-bin alias test at 48 kHz, with a 6170 Hz/0.65-peak sine and separate +12/+24 dB drives at nominal headroom/reference, passed its -80 dBFS gate against a 64x comparison. The worst qualified bin was about -113.7 dBFS. This is a narrow test, not broadband alias certification. Combined extreme controls reached about -48.3 dBFS in diagnostic bins. Those extremes, harmonics/IMD and Debug CPU measurements remain `diagnostic_only`; listening and commercial fidelity remain `not_asserted`. Original costs more CPU than Legacy and remains opt-in.

## Research sources and decisions

Manufacturer manuals describe observable controls and workflows; they do not disclose all internal algorithms or prove our response matches theirs. Use independent measurements and an explicit calibration target before making fidelity claims. Do not reproduce proprietary algorithms, presets, artwork or sample libraries from a visual resemblance.

| Reference | Research retained for maintenance |
| --- | --- |
| [Pro-Q dynamic EQ](https://www.fabfilter.com/help/pro-q/using/dynamic-eq), [processing modes](https://www.fabfilter.com/help/pro-q/using/processingmode), [spectral dynamics](https://www.fabfilter.com/help/pro-q/using/spectral-dynamics) | Graph-first editing, contextual band controls and explicit phase/dynamics restrictions. Keep OpenStudio's ordinary and spectral paths distinct. |
| [Waves GEQ manual](https://www.waves.com/1lib/pdf/plugins/geq-graphic-equalizer.pdf) | Bank/group workflow; do not imply its filter variants exist in our current GEQ. |
| [UA 1176](https://help.uaudio.com/hc/en-us/articles/4419447352980-UA-1176-Classic-Limiter-Collection-Manual), [LA-2A](https://help.uaudio.com/hc/en-us/articles/4419496124180-Teletronix-LA-2A-Leveler-Collection-Manual), [LA-3A](https://media.uaudio.com/assetlibrary/l/a/la-3a-manual.pdf) | Input-driven versus reduction/gain workflows, independent amplifier colour and history-dependent optical recovery. Hardware meter scales are not interchangeable with dBFS. |
| [Focusrite Red 3](https://userguides.focusrite.com/hc/en-gb/articles/21547985697682-Using-the-Red-Plugin-Suite-s-Red-3-Compressor), [dbx 160](https://assets.wavescdn.com/pdf/plugins/dbx-160.pdf) | Distinct VCA timing/knee/routing and monitoring requirements; retain independent original response laws. |
| [Neve 1073](https://help.uaudio.com/hc/en-us/articles/4419497223188-Neve-1073-Preamp-EQ-Manual), [Decapitator](https://www.soundtoys.com/wp-content/uploads/Decapitator-Manual.pdf) | Gain staging, stepped tone/HPF and separate drive/output decisions. Digital headroom is not hardware impedance or dBu calibration. |
| [Pro-G](https://www.fabfilter.com/help/pro-g), [Pro-L oversampling](https://www.fabfilter.com/help/pro-l/using/oversampling), [L2](https://assets.wavescdn.com/pdf/plugins/l2-ultramaximizer.pdf) | Detector/envelope distinctions, reconstruction after rate conversion and separation of limiting from final export quantization. |
| [Avid Audio Plug-Ins 2024.3, D-Verb](https://resources.avid.com/SupportFiles/PT/Audio_Plug-Ins_Guide_2024.3.pdf), [VintageVerb modes](https://valhalladsp.com/2023/02/10/valhallavintageverb-the-modes/), [PLATE-140 1.0.0](https://downloads.arturia.net/products/rev-plate140/manual/ReverbPlate_Manual_1_0_0_EN.pdf) | Mode-specific space controls, decay hierarchy and separation of plate input colour from wet processing. Unpublished size/decay/density laws remain uncalibrated. |
| [BigSky plug-in Rev A](https://www.strymon.net/manuals/BigSky_Plugin_UserManual_RevA.pdf), [RAUM Freeze](https://docs.native-instruments.com/ni-tech-manuals/raum-manual/en/global-controls-and-freeze) | Stable common controls with contextual engine detail; continuing-input versus input-rejecting Hold and deferred topology changes. Use each OpenStudio engine's actual policy. |
| [Altiverb 8 manual](https://www.audioease.com/altiverb/files/Altiverb-8-manual.pdf), [REW decay analysis](https://www.roomeqwizard.com/help/help/html/graph_rt60.html) | IR identity, preparation and channel routing; separate declared geometry and diagnostic decay from measured venue reconstruction/certified acoustics. |
| [ValhallaDelay diffusion](https://valhalladsp.com/2019/06/13/valhalladelay-the-diffusion-section/), [TAL-Chorus-LX](https://tal-software.com/products/tal-chorus-lx) | Strong timing hierarchy and compact modulation controls. Existing OpenStudio diffusion timing and mode names retain their own contracts. Valhalla live pages were access-blocked during the visual review; the inspected 2013/2019 screenshots were historical, not current-version evidence. |
| [Auto-Align 2.2.1](https://assets.soundradix.com/downloads/Auto-Align_2.2.1_User_Manual.pdf) | Capture/review/apply, linked policies and confidence disclosure; correlation thresholds are heuristics, not acoustic correctness probabilities. |
| [Surge XT](https://surge-synthesizer.github.io/manual-xt/), [Ableton instruments](https://www.ableton.com/en/live-manual/12/live-instrument-reference/), [Pianoteq](https://www.modartt.com/pianoteq_features), [Strum GS-2](https://www.applied-acoustics.com/strum-gs-2/manual/), [Ample manuals](https://www.amplesound.net/en/manual.asp), [Drum Racks](https://www.ableton.com/en/live-manual/12/instrument-drum-and-effect-racks/) | Signal-flow hierarchy, articulation/string/performance ownership and incoming-note versus mapped-piece identity. They do not change the no-pack synthesized-instrument scope. |
| [Auto-Tune Pro 11](https://www.antarestech.com/documentation/auto-tune-pro-11), [MAutoPitch](https://www.meldaproduction.com/MAutoPitch) | Realtime target and sustained-note correction are distinct from graphical clip editing. Preserve Legacy Humanize while qualifying the note-age-aware option. |

## Remaining work and explicit scope decisions

These rows retain the older reference backlog without its superseded schedules and completed-task diaries. A design approval or deterministic pass does not close them.

| Area | Still open |
| --- | --- |
| All families | Exact-artifact listening, real audio/MIDI devices, Release/platform lifecycle and Windows 100/125/150/200% mixed-monitor qualification. Broad CPU/automation extremes and acoustic/reference calibration need their own evidence. |
| Preamp/compressor/saturation | Measured amplifier/transformer transfer, headroom, timing and meter ballistics; broad alias/IMD/automation qualification, especially combined extreme controls. Hardware impedance itself is outside software scope. |
| EQ/GEQ | Reference phase/filter calibration. Character/global gain-scale/pan/polarity, flat-tilt dynamics, proportional-Q/flat-top GEQ, separate linked curves, floating-bell/Draw variants and wider ranges are named extension decisions. Existing prepared mixed-configuration MIDI recall is implemented. |
| Gate/limiter | Broader onset/material and limiting-style qualification, complete metering standards validation. Additional triggers/styles/routes, external-key extensions, DC/delta/output-lock and truly low-latency variants need individual scope decisions. |
| Delay | Decide compensated diffusion, pitch, reverse and frequency-shift families individually; preserve old timing/state if adding them. |
| Gain Phase | Persistent Auto/Manual/Locked groups, long-capture spectral fitting, broader sends/feedback graphs, frequency-dependent downstream compensation and weak-bleed acoustic acceptance. Continuous selected-span capture and declared fixed-latency support already exist. |
| Pitch | Audition sustained Humanize and combined graphical/realtime routes. MIDI targets, vibrato/harmony/Flex-Tune-like behavior and lower-latency alternatives remain separate extensions; none authorize a replacement pitch canvas. |
| Reverb | Independent size/decay/density/era, material/transducer, hold/transition and live/offline calibration. Certified decay analysis and measured position reconstruction remain open. Current four-output convolution is implemented; arbitrary surround is separate. |
| Instruments | Physical MIDI/controller/device qualification and listening. Full primary-string/hammer/body simulations, proprietary sample libraries, full Strummer/Riffer/Tab or groove products remain outside the bounded no-pack delivery unless separately requested. Drum auxiliary outputs are implemented. |

Local validation on 3 October recorded 2,480 frontend tests, 168 native suite checks, 233 host integration checks and the stated browser/native-window cases as `pass`. Intermediate failures were retained locally and corrected, including expansion onset behavior, VCA colour routing and bypass latency recall. These counts are a dated baseline, not a permanent certification or a substitute for running the current source's checks.
