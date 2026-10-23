# Built-in effects and instruments

This is the maintenance guide for the sixteen non-NAM processors in the development checkout. User controls and workflows belong in the [manual](USER_MANUAL.md#9-effects); repeatable checks belong in [testing](testing.md#free-plugin-processing-and-editor-checks). NAM has its own [guide](nam-rack.md). Source capabilities are not a claim about an existing installer; consult the release notes for shipped behavior.

## Product and design contract

The October 22 Design 03 layouts are implemented in the working tree for the dedicated non-NAM editors. [Production qualification](testing.md#design-03-production-integration-22-october-2026) records automated results and the remaining device, platform and listening gates. The editors use the existing native parameters, complete-state bridge and history owners. This development work is not a claim about a published installer or final visual/listening acceptance. Pitch Correct retains the existing clip **Edit Pitch** session, including its docked/detached view and history; its realtime FX settings remain a separate compatible processing path.

- Keep processors independently insertable and reorderable. A family selector changes the engine inside that processor, not another processor's saved identity.
- Show the main musical decisions first, with contextual detail pages for controls the selected engine actually consumes. Do not expose inactive controls merely because a descriptor exists.
- Keep type, processing character and preset separate. Hide or disable an inapplicable control with an explanation, without deleting its saved value. Detail pages expose non-default or active state where supported.
- Use the shared theme and original artwork. Group controls beside proportionate plots; bound graph height and scale controls for readability instead of stretching blank panels. Respond to the host's available width and height, including short wide windows. The primary surface fits its host; detailed pages may scroll and retain explicit open/close choices. The native outer-window minimum is 640x480 for this suite; its usable client area is smaller because of the window frame and title bar. NAM and hosted editors retain their own rules.
- Support numeric entry, fine drag, reset, keyboard and profile-aware wheel input. One continuous gesture or compound edit must produce one Undo entry and correctly paired automation gestures.
- Metering and performance displays must come from native telemetry. Distinguish received MIDI keys from sounding/releasing voices, and show idle/unavailable states explicitly.
- Require no sample pack or download. Convolution has one original default IR; user IRs travel in complete state. Do not ship proprietary libraries, reference artwork or vendor branding.

Prototypes and repeated review screenshots are development aids. Their simulated controls and example states are not production code or native qualification. Superseded previews and raw runs belong under ignored `output/`, not in the source tree. A feature inventory or a passing geometry check does not establish that an editor is complete, usable or visually approved.

## Editor maintenance and qualification

The editors prioritize a clear main task, readable controls at every supported
size, fast exact adjustment, trustworthy comparison and visible native feedback.
The working-tree implementation uses
matte controls, reduced toolbar chrome, primary controls beside native meters,
compact subpages and host-sized overviews. Further review and qualification use
the gates below; implementation is not final visual approval.

**Implemented navigation and interaction:** the shared **Find** searches canonical
native controls and named workflows, opens the owning page and focuses the
result. It does not change model, mode or audio settings to make an inactive
control usable; those results explain that their stored value is retained. Saved
machine banks and compatibility aliases are not duplicate editable search
results. Numeric entry, fine drag, keyboard/profile-aware wheel gestures and
reset use the production parameter/history path. A/B captures complete native
state; its copy button follows the active bank. Host bypass remains separate
from saved processor bypass.

**Implemented responsive workspaces:** instrument output and audition controls
stay outside the scrolling detail body. Synth Voice and Modulation, Piano
Performance, Guitar Play and the Drums kit use compact subpages. At sufficiently
wide and tall host sizes the instruments offer **Overview**, showing the same
existing sections and parameter identities together; reducing the host returns
an active Overview to the main page. Dense detail/overview content can scroll.
Effects retain their own graph, meter and contextual-control layouts; wide
Reverb exposes additional machine sections and its manually requested response
analysis. These are host dimensions, not monitor-resolution detection.

**Reverb setup:** **Setup** holds the shared **Controls** and **Return level**
policies; **Processing** remains with the applicable machine's Character
controls. **Plugin options** contains **Load voice preset** and **Load voiced
collection**. Type browsing retains each bank's edits, whereas those actions
recall complete settings. Wet/Dry/Output and native input/output/ducking readouts
remain directly reachable; Metering and Response retain their separate tools.

The October 22 source audit mapped **2,505 native parameter descriptors** across the sixteen
non-NAM processors, plus **49 convolution complete-state shape fields**. The
descriptor total includes 129 compatibility aliases and 920 saved machine-memory
entries; it is not a count of controls to display simultaneously. The review's
ignored feature inventory records native bounds, units, canonical aliases,
contextual pages and workflow entry points. It enumerates 2,378 pure Reverb
layout scenarios against `reverbControlLayout.ts`. This checks planned placement,
not browser rendering, DSP response or sound. Regenerate the inventory when the
native schema changes and separately verify every reachable surface.

### Feature retention and discoverability

| Area | Implemented surface and retained workflow to qualify |
| --- | --- |
| Shared shell | Preset browsing/save/modified state, complete-state import/export, Undo/Redo, active-bank A/B and correctly directed copy, host versus saved DSP bypass, and Signal path where implemented. Find-control search reveals a named page and explains applicability; it must not change the sound simply to reveal a result. |
| EQ | Graph-first 24-band and group editing; Filter/Dynamics/Detector inspector; target/phase/quality/ordinary/spectral restrictions; analyzer views, references, peaks and frequency range; discoverable Draw, Match and Grab with audition/Apply/Cancel; inter-instance tools, preset/startup library and 32 prepared MIDI configurations. |
| Graphic EQ | All 10/31-band controls, independent saved banks, selected/group offsets, target/cuts and native response/analyzer. Flat bank affects the active bank; Reset selected affects its selected bands in one grouped UI edit, without adding a DSP parameter. |
| Gain Phase | Manual timing/polarity remains reachable beside a guided reference/group/capture/results workflow. Retain 2–8-instance independent/linked policies, related groups, timing/all-pass/spectral fit, sparse versus continuous capture, route policy, cancel, stale-result rejection, audition and whole-group Undo. Keep saved 48-point/channel phase curves discoverable. |
| Pitch Correct | Clearly distinguish realtime source/correction/MIDI-output settings from choosing recorded audio for the existing graphical editor. Preserve its dock/detach/history and active-realtime warning. No replacement pitch canvas or implied MIDI-target correction. |
| Compressor | Stable positions for applicable controls, with distinct FET/opto/VCA workflows; model/engine memories, VCA channel banks, external key, detector filtering, original stages/headroom, calibrated metering, Punch noise/monitor and Ratio Off/Infinity/Auto-release explanations. |
| Gate | Threshold/range and envelope beside input/reduction feedback; gate/expander distinction, filtered internal/external key, key audition and detector policy. Hold/Hysteresis/Transient response are contextual; Closed/Opening/Open/Holding/Closing/Expanding status comes from the native gate stage, with unavailable feedback explicit. |
| Limiter | Threshold/ceiling and gain reduction together; eight styles, linking/unity audition, quality/latency and distinct sample-peak/reconstructed-peak/loudness history/reset. Hide or explain Classic/Edge inactive controls while retaining values. |
| Preamp / Saturator | Input drive, output drive where applicable and final trim remain distinct. Preserve stepped tone/HPF, reference/headroom/Legacy/Original choices, eight Legacy saturation types and five colour engines, compensation, bias, quality and input/filter detail. Label estimated compensation honestly. |
| Reverb | Keep the existing searchable/category browser and all 41 contextual layouts, per-machine memories, voiced preset versus collection recall, return/processing/control policies, timing/capacity, ducking, metering and rendered Response tools. Clearly show engine-specific Hold input policy, deferred changes and spillover. Favourites would be a new UI feature. |
| Convolution | Source/draft/applied identity; cancellable preparation and failed-load recovery; Shape, Balance, Sources, Position, Damping, Bright, EQ, Decay and Audition pages. Retain four-path order, exclusive Main/aux routing, source blend, declared geometry, portable original bytes and all Apply/Revert constraints. Direct trim handles supplement exact numeric entry. |
| Delay / Chorus | Timing and main musical controls remain together. Preserve all Delay modes, Multi/Dual topology and second-engine controls, motion/custom wow, ducking and post-repeat diffusion. Preserve Chorus/Flanger/Phaser voices/stages, waveform, tone and effective Ensemble limits. Free/synced values and actual tempo source must be distinct. Optional Delay L/R edit-link needs an explicit offset/equal-value gesture contract. |
| Synth | Oscillators/filter/amplifier remain useful in compact mode. Retain eight matrix routes/28 destinations, independent filter envelope, LFO mode, four macro base/live values, CC/channel Learn and all lower/upper MPE member/master ranges. Use one matrix heading row and contextual route help. |
| Piano / Guitar | Prioritize tone/touch/articulation over decorative drawings. Preserve expressive pedals/releases, secondary bodies, guitar plucked engine, nine articulations/keyswitches/string assignment and separate original motion/delay chorus. Distinguish editable pick/pickup positions, static artwork, incoming keys and actual allocated/releasing voices. |
| Drums | Keep selected-piece editing beside useful pads at compact sizes. Preserve sixteen inputs/eight groups, 128-note mapping/Ignore/Learn, draft Apply/reset, articulation/choke behavior and exclusive Main/auxiliary output pairs through 17/18. Names outweigh MIDI numbers; ignored input is visibly silent. |

The production surfaces use native jobs and telemetry where available. Browser
fixtures exercise the real React editors against native-exported schemas with a
recording bridge; they do not run audio, MIDI Learn, project routing or device
operations. An inventory entry or fixture interaction does not qualify those
host workflows. Never substitute a second independent prototype control state
for the production parameter's native state and automation identity.

### Maintenance acceptance gates

The shared interaction and family layouts are implemented. Changes to them must
retain these contracts; deterministic passes do not close the separate device,
performance and listening gates.

| Area | Maintenance responsibility | Required evidence |
| --- | --- | --- |
| 1. Contract and correctness | Verify current native schemas and complete-state operations; reproduce reported UI/DSP defects; preserve identifiers, aliases and historical defaults. Separate signal-preserving repairs from audible changes. | Every descriptor/full-state field/workflow has an owner and reachable location or an explicit retained-memory/compatibility explanation. Regressions cover old project, preset, Compare, portable state, Undo and PDC before any schema/DSP version change. |
| 2. Common interaction and compact layout | Implement shared exact entry, fine/reset/keyboard/profile wheel input, one-step gesture Undo, immediate linked readouts, dynamic A/B copy, search-to-reveal, visible focus and active/inactive/modified detail state. Reduce chrome; keep primary controls reachable in short windows. | Real-browser behavior and geometry tests at 640×480, each native preferred size, common desktop sizes, 4K and 125/150/200% equivalents. Test dense pages, open details, all modes, focus order, overlap and child clipping; a scroll-height pass alone is insufficient. |
| 3. Family workspaces | Migrate one coherent family at a time using the table above. Reuse existing native jobs and history owners; contextual pages retain every implemented advanced workflow. Give displays an editing/feedback purpose and keep all signal feedback truthful. | Per-family parameter/workflow coverage, inactive-value recall, page/selection persistence, cancel/error/retry and stale-instance tests. Connected Debug and Release WebViews must reach boot-ready, including detached windows and repeated close/reopen. |
| 4. Measured CPU work | Profile Release callbacks by engine, configuration, rate, buffer, channel/voice/instance count and transitions; include UI-open/closed runs. Prioritize measured deadline overruns, callback allocations/locks and redundant unchanged configuration work. Prepare expensive state off-thread and safely retire it. | Retain source/binary hashes, callback percentiles/maxima/deadline counts, CPU/memory, configuration and actual device context. Demonstrate unchanged deterministic output/state/latency where claiming a transparent optimization; otherwise use an opt-in compatibility-preserving policy and exact-artifact audition. |
| 5. Audio and release qualification | Execute baseline, adversarial parameter/state, render, performance, device and listening matrices below. Build current frontend assets and Debug app for the standard `python build.py dev --run` handoff. | Record `pass`, `fail`, `diagnostic_only` and `not_asserted` separately. No unresolved deterministic regression is waived as subjective; no metric or screenshot certifies tone. User audition of identified artifacts and physical-device/platform qualification remain separate gates. |

Production implementation reuses typed native descriptors and bridge/history
contracts rather than introducing parallel parameter stores or unchecked casts.
Use Tailwind for ordinary layout and component-owned CSS for hardware artwork
and scene geometry, with one owner per rule, typed runtime geometry, container
queries and fluid sizing. Preserve subscribed meter leaves, hidden-view polling
cleanup and instance/epoch guards. Do not copy runtime stylesheet strings,
`!important`, decorative fake telemetry or prototype-only shortcuts into the app.

### DSP and performance qualification matrix

Use manufacturer documentation for observable responsibilities and musical
context, not identical knob positions or an undocumented circuit model. Existing
research links above and named regression fixtures are the starting point.

- For every enum/mode and supported parameter, test defaults, minimum/maximum,
  near-boundary values and representative intermediate values; pair dependent
  controls and exercise relevant adversarial combinations. State clearly that
  this is bounded coverage rather than every point in a continuous parameter
  space. Use silence, impulses, steps/bursts, multitone/sweep/noise, transients and
  identified vocal/guitar/drum/music material, with mono/stereo and varied input
  headroom.
- Check effect-specific laws: EQ/GEQ frequency/gain/Q/phase and dynamics targets;
  compressor ratio/knee/timing/sidechain/mix and model-specific colour; gate
  threshold/range/hysteresis/hold/expansion; limiter final-output peaks, release,
  stereo links and latency; nonlinear bias/headroom/alias/IMD; Delay timing and
  feedback/diffusion; Chorus rate/depth/voices and sync; Reverb onset, decay,
  spectral damping, hold/input policy and engine transitions; convolution
  geometry/order/trim/routing; instrument pitch/envelopes/controllers/voice
  ownership and releases; realtime pitch detector/correction/latency.
- Exercise parameter ramps, randomized callback partitions, mode switches,
  complete-state recalls and concurrent editor activity. Check finite output,
  denormals, stale tails, discontinuities, DC, channel isolation, bounded memory,
  declared latency/tail and live/offline consistency. Diagnostic spectral or
  timbral measures need calibrated expectations before becoming pass/fail gates.
- Measure representative and stress settings at 44.1/48/96/192 kHz and supported
  small/normal buffers, including 8/16/32/64/128/256/512 samples where the device
  actually supports them. Include multiple effect instances, dual armed-track
  monitoring, oversampling, sustained polyphony, IR/FIR preparation and the
  expensive old/new-engine overlap during transitions. Debug speed is diagnostic;
  Release timing on one machine is not a portable realtime guarantee.
- Prioritize known retained risks: Shimmer and realtime Pitch Correct deadline
  overruns, Original/Spread transition costs, unqualified indefinite Infinite
  Hold accumulation, and high-quality oversampling cost. Do not reduce quality, change
  Hold input semantics or drop voice/tail work merely to improve a benchmark.
  Consider settings caches, bounded incremental work and proven inaudible-engine
  sleep only after profiling and state/transition parity checks.
- The pre-implementation October 22 audit identified Nonlinear Infinite guard
  activation under continuing input and Corrected Pitch deadline misses at
  192 kHz with four instances at 32/64/128-sample buffers. Those are dated
  baselines, not measurements of every subsequent revision. Infinite still
  accepts new input; attenuating Output does not prove internal headroom, and
  Freeze must not replace Infinite as a transparent repair. The implemented
  buildup handling subsequently passes all 16 bounded headroom fixtures on the
  final Release build. Indefinite accumulation and listening acceptance remain
  unasserted; current evidence and limits are maintained in the testing guide.
- The working-tree stress fixtures now select the explicit Shimmer enum for
  Room-to-Shimmer transitions, distribute 32 note-ons across two MIDI channels,
  and report observed rendering voices separately from requests. The headless
  render/export entry chooses offline device startup before AudioEngine
  initialization. These repairs make the intended cases observable; skipped
  host/export work remains `not_asserted`, and an offline pass does not qualify
  a physical device.
- Source-preserving work now includes unchanged-setting caching in Clear,
  prepared note frequencies and invalidated bend/pan/invariant-work caches in
  Synth, and bounded incremental pitch-detector/FFT scheduling. Pitch retains
  its warm processing history during bypass; bypass sleep remains a separate
  proposal rather than an implemented optimization. Cache invalidation,
  controller expression, sample-rate behavior, transition history and callback
  allocation remain regression obligations. These implementation descriptions
  make no benchmark or listening claim; ordinary factory profiles and one
  modest session cannot clear high-rate or transition deadline cases.
- Keep exact rendered artifacts and source/model/configuration hashes. Listening
  compares loudness-controlled references where appropriate, includes a whole
  musical chain, and records user acceptance for that exact revision. Videos or
  manuals provide context; reviewing their text does not constitute listening.

Current measured failures and new qualification results belong in the existing
[testing guide](testing.md#retained-audio-qualification-and-limits), with raw
artifacts under ignored `output/`. The roadmap links these gates; do not create
parallel implementation-plan documents or treat a planned test as a completed
result.

## Source ownership

| Concern | Authoritative code |
| --- | --- |
| Processor factories, parameters and state | `Source/BuiltInEffects.*`, `BuiltInEffects2.*`, `BuiltInUtilityEffects.h`, `BuiltInGraphicEQ.h` and family DSP headers |
| Native schema, configuration preparation, host routing and telemetry | `Source/AudioEngine.*`, its focused `.inc` implementations, `MainComponent.cpp`, `TrackProcessor.*` |
| Editor selection and bounds | `frontend/src/components/builtin/editorRegistry.ts`, `BuiltInPluginPanel.tsx`, `Source/Main.cpp` |
| Shared gestures, optimistic writes and retained instance history | `SuiteParameter.tsx`, `BuiltInPluginPanel.tsx`, `builtInPluginParamHistory.ts`, `suiteParameterGesture.ts` |
| Find and responsive instrument navigation | `PluginFeatureFinder.tsx`, `pluginFeatureNavigation.ts`, `InstrumentEditorParts.tsx`, `instrumentControlLocation.ts` |
| Presets, Compare and host bypass | `EQToolbar.tsx`, native full-state operations, `AudioEngineBuiltInPresetFiles.inc`, `builtInHostBypassHistory.ts` |
| Shared control styling | `PluginEditorControls.ts` Tailwind utilities; processor-owned CSS for artwork, pseudo-elements and scene geometry |
| Graphical pitch entry and ownership | `PitchFXEditorEntry.tsx`, `pitchEditorFXEntry.ts`, `pitchEditorStore.ts`, `PitchEditorLowerZone.tsx`, `PitchEditorWindowApp.tsx` |
| Native correctness fixtures | `Source/FreePluginRegression.cpp`, its family regression headers, host regression `.inc` files and `tests/fixtures/free-plugins/` |
| Real-editor browser fixtures | `frontend/e2e/support/freeSuiteHarness.ts`, `free-suite-design03.spec.ts`, `free-suite-effects.spec.ts`, `free-suite-precision.spec.ts` and `tools/run-free-suite-ui-regression.ps1` |

Small DSP headers and regression files are dependencies, not generated output. Keep compatibility fixtures immutable when fixing a regression. Avoid merging unrelated modules merely to reduce Git's file count.

The Windows PowerShell browser runner exports the selected native
`editor-schemas` group, then runs the three `free-suite-*` specs and
`release-review-ui` against the same shared fixture. Build the current Debug app
and install frontend/Playwright dependencies
before invoking it; the runner does not rebuild or prove that an existing binary
matches the working tree. Its schema report belongs in ignored
`output/review/free-suite-ui/`. `OPENSTUDIO_FREE_SUITE_SCHEMAS` can select an
explicit report for direct Playwright runs. An explicitly requested missing or
invalid report fails qualification. A direct run without an explicit path may
skip when its default fixture is absent; that is not a qualification pass.
The browser bridge
records parameter, gesture and audition calls without processing audio; it does
not qualify Windows WebView2, Linux, macOS or a physical audio device.

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
| Reverb | 41 types across studio, vintage, plate/modal, spring, shimmer, nonlinear, spatial, ambient and convolution families; per-type memories, 41 authored factory profiles plus collection, Output/return trims, opt-in Spread Shimmer scheduling and Vowel broadband body, Send/mix lock, supported Hold and wet-tail spillover | Controls follow the actual engine. Spread adds one pitch hop and prepared memory; old state retains Original. Legacy crossfades, finite-only modes and deferred changes under Hold remain explicit. Nominal decay/geometry is not a measured commercial room or circuit; listening acceptance is unqualified. |
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

Compressor places input colour before reduction and output colour after it; both VCA response engines apply exactly one stage pair. FET Ratio Off preserves colour. Clean/Legacy do not add Original nonlinear colour stages. Preamp places input colour before Tone EQ, output drive after Tone EQ, and linear trim last.

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
| [Pro-C 2 manual](https://www.fabfilter.com/downloads/pdf/help/ffproc2-manual.pdf), [basic compressor controls](https://www.fabfilter.com/learn/compression/basic-compressor-controls) | Ratio 1:1 removes reduction; Attack/Release govern response, and Makeup/Mix remain separate. Use these observable laws for the Clean engine, not a copied commercial response. The versioned PDF preserves the Pro-C 2 reference; the current unversioned online help now describes Pro-C 3. |
| [Pro-G manual](https://www.fabfilter.com/help/ffprog-manual.pdf), [BOSS NS-2 manual](https://static.roland.com/assets/media/pdf/NS-2_e01_W.pdf) | Threshold, attenuation range, hysteresis, opening, Hold and closing are distinct decisions. Lookahead is optional, so a no-lookahead gate need not preserve a single-sample pulse. The NS-2 separates instrument detection from noisy effect returns and places Delay/Reverb after suppression to retain their tails; this is routing guidance, not a matching detector curve. |
| [Pro-L true-peak limiting](https://www.fabfilter.com/help/pro-l/using/truepeaklimiting), [oversampling](https://www.fabfilter.com/help/pro-l/using/oversampling), [L2](https://assets.wavescdn.com/pdf/plugins/l2-ultramaximizer.pdf) | Distinguish an input peak detector or final sample clamp from reconstructed peaks after gain modulation and downsampling. Qualify final output independently and keep limiting separate from final export quantization. Finite fixtures do not establish full metering-standard conformance. |
| [Avid Audio Plug-Ins 2024.3, D-Verb](https://resources.avid.com/SupportFiles/PT/Audio_Plug-Ins_Guide_2024.3.pdf), [VintageVerb modes](https://valhalladsp.com/2023/02/10/valhallavintageverb-the-modes/), [PLATE-140 1.0.0](https://downloads.arturia.net/products/rev-plate140/manual/ReverbPlate_Manual_1_0_0_EN.pdf) | Mode-specific space controls, decay hierarchy and separation of plate input colour from wet processing. Unpublished size/decay/density laws remain uncalibrated. |
| [BigSky plug-in Rev A](https://www.strymon.net/manuals/BigSky_Plugin_UserManual_RevA.pdf), [BigSky MX Rev B](https://www.strymon.net/manuals/BigSky_MX_UserManual_RevB.pdf), [RAUM Freeze](https://docs.native-instruments.com/ni-tech-manuals/raum-manual/en/global-controls-and-freeze) | Stable common controls with contextual engine detail; continuing-input versus input-rejecting Hold and deferred topology changes. MX page 21 explicitly keeps new notes outside Freeze but admits them in Infinite. Use each OpenStudio engine's actual policy. |
| [Altiverb 8 manual](https://www.audioease.com/altiverb/files/Altiverb-8-manual.pdf), [REW decay analysis](https://www.roomeqwizard.com/help/help/html/graph_rt60.html) | IR identity, preparation and channel routing; separate declared geometry and diagnostic decay from measured venue reconstruction/certified acoustics. |
| [ValhallaDelay diffusion](https://valhalladsp.com/2019/06/13/valhalladelay-the-diffusion-section/), [TAL-Chorus-LX](https://tal-software.com/products/tal-chorus-lx) | Strong timing hierarchy and compact modulation controls. Existing OpenStudio diffusion timing and mode names retain their own contracts. Valhalla live pages were access-blocked during the visual review; the inspected 2013/2019 screenshots were historical, not current-version evidence. |
| [TimeLine Rev F](https://www.strymon.net/manuals/TimeLine_UserManual_REVF.pdf), [Mobius Rev F](https://www.strymon.net/manuals/Mobius_UserManual_Mobile_REVF.pdf) | TimeLine pages 2/22 distinguish delay time, feedback, wet/dry mix and retained preset tails. Mobius pages 2/10 distinguish LFO speed/depth and Chorus wet/dry mix; its variable-clock, multi-LFO, vibrato and digital modes are different algorithms. These establish control responsibilities, not universal chorus/delay curves or matching knob positions. |
| [Auto-Align 2.2.1](https://assets.soundradix.com/downloads/Auto-Align_2.2.1_User_Manual.pdf) | Capture/review/apply, linked policies and confidence disclosure; correlation thresholds are heuristics, not acoustic correctness probabilities. |
| [Surge XT](https://surge-synthesizer.github.io/manual-xt/), [Ableton instruments](https://www.ableton.com/en/live-manual/12/live-instrument-reference/), [Pianoteq](https://www.modartt.com/pianoteq_features), [Strum GS-2](https://www.applied-acoustics.com/strum-gs-2/manual/), [Ample manuals](https://www.amplesound.net/en/manual.asp), [Drum Racks](https://www.ableton.com/en/live-manual/12/instrument-drum-and-effect-racks/) | Signal-flow hierarchy, articulation/string/performance ownership and incoming-note versus mapped-piece identity. They do not change the no-pack synthesized-instrument scope. |
| [Auto-Tune Pro 11](https://www.antarestech.com/documentation/auto-tune-pro-11), [MAutoPitch](https://www.meldaproduction.com/MAutoPitch) | Realtime target and sustained-note correction are distinct from graphical clip editing. Preserve Legacy Humanize while qualifying the note-age-aware option. |

Manufacturer videos supplement these written contracts: [FabFilter's Pro-C 2
introduction](https://www.youtube.com/watch?v=2zjQNeM2RxU) and [Strymon's BigSky
Infinite Sustain/Freeze demonstration](https://www.youtube.com/watch?v=Qv9QWoHCFhQ).
The October 22 review inspected available titles/descriptions and written manuals;
it did not listen to these demonstrations or compare their audio with OpenStudio.
Infinite continues adding new input to the held reverb; Freeze excludes new input
from the held wet path. Muting new input is therefore not a sound-preserving fix
for Infinite overload. Retain OpenStudio's own algorithms and evaluate any new
overload policy separately.

The same review found contextual-control gaps addressed in the working-tree
editors: Gate disables Hold/Hysteresis in Expander mode, and Limiter Classic explains
its inactive Slow Attack, Auto Release, Transient Link and Release Link controls.
Edge has its own applicability explanation. These settings remain saved when
their controls are absent or disabled. Generic Compressor Stereo
Link blends average and maximum detection; zero does not select dual mono.
These are presentation/semantics findings, not authorization to replace the DSP
with the referenced products' algorithms.

## Corrected signal paths

EQ, Preamp, Saturator, Chorus, realtime Pitch Correct, Basic Synth, Piano,
Clean Guitar and Drums append **Plugin options > Signal path > Legacy /
Corrected**. New instances and factory reset use Corrected. Older complete
states, named numeric snapshots and EQ MIDI configurations missing the field
use Legacy. This is a stopped configuration change that resets processing
history; full-state Undo, Compare and portable recall retain it. Descriptor
indices and persistence versions are unchanged. Instrument voice engines and
Preamp/Compressor audio character are independent choices. Embedded NAM paths
retain their existing defaults.

The inline Pitch Correct panel also stores Signal path in its custom presets
and A/B snapshots, together with the deeper detection, formant and MIDI
settings exposed by the full editor. An old custom preset without Signal path
uses Legacy so its root-relative note mask keeps its meaning. Factory tonal
templates preserve the current mode and note mask. Recall applies one guarded
native state transaction; a failed write or preset file save is reported.

| Corrected path | Maintenance contract |
| --- | --- |
| EQ / Saturator | Static EQ retains finite floating-point headroom; Foldback is symmetric. Saturator type fades end at their exact sample endpoint across callback partitions. |
| Pitch Correct | Absolute C–B masks affect Custom only. Anti-aliased rate-normalized analysis covers the configured low-note range; incremental YIN and FFT work preserve the pitch algorithm's settings. |
| Piano / Guitar / Drums / Chorus | Fractional components and Ensemble secondary LFOs advance continuously. Corrected drum metal partials fade near Nyquist. |
| Synth / Guitar | Prepared one-pole coefficients preserve their 48 kHz reference time constants. |
| Preamp | Internal bypass returns latency-aligned dry audio; oversized callbacks are processed in bounded chunks. |

Corrected pitch analysis uses a 22.05–32 kHz stream and 2048-sample window
(64–93 ms), plus up to one analysis hop of distributed decision work (about
23 ms). Reported audio alignment latency is unchanged. The bundled Stretch
fine-FFT opt-in is documented beside the [vendor patch](../thirdparty/signalsmith/OPENSTUDIO-PATCHES.md).
This detector delay and the measured small-buffer/high-rate deadline failures
remain relevant; see [qualification limits](testing.md#retained-audio-qualification-and-limits).

Signal-preserving fixes apply independently: Delay, Chorus and Saturator prepare
all IIR orders off the callback; drum CC123 releases one-shots while CC120 remains
panic; export bounds include feedback, filter ringing, manual delays and drum
decay. Articulated Drums disables Kit and Hi-hat Tightness, which belong to its
Legacy voice engine. Conservative tail declarations can include silence.

Standalone Gate and the uncoloured Clean compressor preserve finite wet-path
headroom instead of hard-clipping at a fixed 2.5 peak (about +7.96 dBFS). This
applies to active processing, not just bypass: Gate Range 0 and Clean Ratio 1:1,
Makeup 0 must retain the input after startup settling and reported latency.
The embedded NAM gate and Legacy/coloured compressor paths retain their prior
bounds, including outgoing coloured/noise blends. No parameters, state schemas,
gain envelopes or latency changed.

The October 22 Debug `dynamics-audit` reproduced 32 failing high-level cases
before the correction and passed all 64 afterward: four rates, mono/stereo and
0.125/1/3/8-peak inputs. Clean's maximum unity error was zero; Gate's was below
0.00000048. All 32 normal-level summaries and the existing 64 Clean RMS transfer
rows were unchanged. Separate Gate onset/expansion, external-key and 42 non-Reverb
baseline checks, including 360 control/rate/block/channel cases, passed. These
are deterministic contracts, not an audition or clearance of the retained Reverb,
pitch/CPU and hardware qualification limits in [testing](testing.md#retained-audio-qualification-and-limits).

## Standalone Reverb state and processing

The 41 types use 13 DSP families. Per-type banks keep edits when browsing;
**Load voice preset** recalls one complete authored profile and **Load voiced
collection** installs all 41 banks. Both use ordinary complete-state Undo.
Eight historical voices remain available. Width, Wet, Dry, Output and Processing
are shared, so the collection does not reproduce every individual profile's
shared settings. User presets retain priority over same-name generated entries.

| Shared choice | New instance / missing old field | Behavior |
| --- | --- | --- |
| Output | 0 dB / 0 dB | -60 to +12 dB after complete mix/ducking, including retained tails and convolution auxiliary returns; independent of Mix Lock. |
| Return level | Calibrated / Original | Fixed wet-readout trims outside feedback. Legacy Room/Hall/Chamber/Plate compatibility engines and custom IR levels remain unchanged. |
| Processing | Original / Original | Refined uses settled motion-off integer taps in eligible digital engines and a signed wet-output FIR in Studio Plate/Cloud. It deliberately changes frequency coloration. |
| Controls | Corrected / Legacy | Append-only index 1089; per-sample 20 ms Wet/Dry ramps, bounded Spatial modulation and reference-rate damping. Historical factory voices keep Legacy; Voiced profiles select Corrected. |
| Shimmer pitch scheduling | Original / Original | Spread preserves the 120 ms window/30 ms hop and adds one pitched-path hop; Voiced Shimmer/collection opt in. |
| Vowel broadband body | 0 / 0 | A ramped wet feedforward bed beneath the formants; dry and feedback are unchanged. Voiced Vowel/collection opt in. |

All choices survive projects, presets, portable files, Compare and Undo without
a schema/DSP version bump. NAM Rack is excluded. Historical Legacy Wet/Early
routing remains: Early can be audible at Wet zero. Plate input colour and
Positioned room's spatial direct path can also change the dry signal, so compare
wet residuals against each voice's own Wet-zero render.

`BuiltInReverbDamping.h` maps poles during configure with
`p(Fs) = p(48000)^(48000/Fs)`, preserving an exact 48 kHz branch and explicit
bypasses. Tone ramps are 50 ms. Vintage/Retro era conversion remains separate.
This preserves a filter time constant, not identical near-Nyquist spectra or a
measured broadband RT60. Voiced Shimmer sends pitched Input into the long tank
once; saved Tank/Both routes retain recirculation losses and nominal Decay.
Shaped Duration displays 25–2000 ms while retaining normalized storage; Shimmer
Amount resets to its bank's 50% default, and Bloom Length has no effect at zero
Diffusion.

Spread uses existing incremental FFT stages and deterministic role offsets.
Live scheduling changes prime at most one silent sample per real input sample
before warmup and a 20 ms fade. Steady Spread/Input suspends the unused tank pitch
pair; Tank/Both selection refills it for about 300 ms plus 64 samples before a
50 ms route fade, keeping Input audible during warmup. Both banks stay allocated.
Transitions involving Original temporarily retain its unsplit spectral work.

Masked compatibility engines sleep only after complete zero-weight coverage for
at least 50 ms with an unchanged routing fingerprint. Routing/publication changes
invalidate that proof; wakeup invalidates hidden history rather than replaying it.
Dedicated/draining engines keep their transitions, Legacy selectors and embedded
NAM keep their paths. Settings caches skip exactly unchanged configuration work;
muted Spring histories remain running to preserve later count changes.

Individual Voiced profiles use fixed Output trims from 0 to -13 dB, targeting
3 dB sample-peak headroom on the shared guitar at Dry70/Wet100; the collection
uses one -14 dB trim. Output changes dry and wet together. These are reference
choices, not automatic gain control or arbitrary-source/Hold headroom guarantees.
Continued-input Infinite Hold can reach internal/output clamps; finite-output
and release passes do not establish unclipped indefinite Hold. Current evidence,
reproduction commands and unresolved listening/device limits belong in
[testing](testing.md#standalone-reverb-qualification).

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
