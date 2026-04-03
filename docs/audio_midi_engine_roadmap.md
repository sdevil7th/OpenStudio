# Audio/MIDI Engine Roadmap

## Summary
Implement this in phases so we fix correctness first, then complete plugin-format and low-latency MIDI support, then add the 64-bit hybrid engine without destabilizing the current app. The first shippable milestone is a repo-backed fix for live MIDI keyboard input, instrument-track rendering, MIDI clip playback, and offline/render parity. Later phases complete CLAP/VST3i behavior and add an opt-in hybrid 64-bit processing mode with guarded rollout.

## Phase Plan
### Phase 1: MIDI/Instrument Bugfixes and Correctness
Status: In progress. Core engine work is implemented; live keyboard/render validation is still pending.
- Replace the current placeholder live-MIDI path with an enqueue-only design; no instrument/plugin processing outside the audio thread.
- Add per-track live MIDI intake so hardware MIDI, virtual keyboard input, and future MIDI clip playback all enter the same track-owned event path.
- In the real-time audio callback, build each track's block `MidiBuffer` before track processing.
- Process the loaded instrument plugin inside the real-time track path for `Instrument` tracks, before post-instrument audio FX.
- Process the loaded instrument plugin in offline render, freeze, bounce, and stem/export paths so live playback and render use the same signal flow.
- Ensure transport stop, loop wrap, track mute/solo, record-arm changes, and monitor-off events flush pending note-offs safely.
- Keep current float audio behavior unchanged for non-MIDI tracks.
- Acceptance for this phase: a user can load a VST3i, arm/monitor the track, play a MIDI keyboard, hear sound in real time, record MIDI, and get matching offline render output.

### Phase 2: Full MIDI Track and Clip Playback Implementation
Status: Partially implemented. Track MIDI scheduling/sync is in place; loop/punch hardening and downstream/plugin MIDI routing still need completion.
- Introduce an engine-side MIDI clip scheduler that converts stored clip note/CC events into per-block sample-offset MIDI events.
- Merge three MIDI sources per track in the audio thread: scheduled clip events, queued live input, and UI-generated input.
- Add proper loop handling, seek handling, punch-in/out behavior, and overdub-safe note state tracking.
- Route MIDI-only tracks to hardware MIDI output and instrument tracks to instrument plugins; do not silently drop MIDI on either path.
- Make plugin MIDI output a first-class path: capture plugin-produced MIDI from instrument/MIDI effects and route it either to hardware output or downstream MIDI targets.
- Preserve existing frontend clip models and NativeBridge calls where possible; add backend-only scheduling first, then tighten JS/native contract only if needed.
- Acceptance for this phase: MIDI clips play back sample-aligned, overdub records correctly, loop playback does not hang notes, and MIDI-only tracks can drive external hardware.

### Phase 3: VST3i and CLAP Completion
Status: Partially implemented. CLAP JUCE MIDI bridging and capability probing exist; transport/playhead parity and full browser/runtime parity are still pending.
- Keep VST3 hosting as the primary reference path and make instrument-track processing identical for VST3 effects, VST3 instruments, and CLAP instruments.
- Complete CLAP event bridging by translating JUCE MIDI events into CLAP note/parameter events with intra-block sample offsets.
- Implement CLAP output-event handling so CLAP plugins that emit MIDI/events are not treated as no-op outputs.
- Pass transport/playhead timing into CLAP processing just as VST3 plugins already receive playhead state.
- Detect plugin capabilities up front: instrument, MIDI effect, audio effect, MIDI output, double-precision support, bus layouts.
- Classify plugins in the browser using actual capabilities so instrument-only and MIDI-effect-only flows are correct.
- Acceptance for this phase: at least one VST3i and one CLAP instrument both work for live keyboard input, MIDI clip playback, editor open/state restore, and offline render.

### Phase 4: Ultra-Low-Latency MIDI Architecture
Status: Partially implemented. The MIDI input callback path is lock-free, the real-time callback now runs from immutable processing snapshots instead of the main graph try-lock, busy-track contention can now fall back to the last safe processed block instead of hard-dropping immediately, and busy master/monitor chains now reuse the last safe processed output instead of forcing silence; deeper end-to-end hardening and validation are still pending.
- Remove blocking locks from the hot MIDI path; use preallocated per-device lock-free queues for inbound MIDI and a separate queue for UI/virtual-keyboard MIDI.
- Timestamp input events on arrival and convert them to audio-block sample offsets when draining into the audio thread.
- Add per-track note-state tables and overflow counters so dropped/late events are observable and recoverable.
- Keep all queue draining, event merging, and note-off recovery allocation-free on the audio thread.
- Reduce avoidable callback stalls around graph edits by isolating MIDI delivery from graph-management locks.
- Add a diagnostics view/API for queue overflow count, late-event count, max events per block, and current buffer size.
- Acceptance for this phase: stable live keyboard play at 32/64/128 sample buffers with no hung notes, no callback-time locking in the MIDI path, and measurable lower worst-case input-to-sound jitter.

### Phase 5: 64-Bit Hybrid Engine
Status: Partially implemented. A processing-precision framework now exists with project persistence, track/plugin double-precision negotiation, sidechain-aware double processing, freeze/render MIDI parity, hybrid64 now reaching real-time and offline master/master-monitor processing more deeply where plugins support it, and per-plugin float fallback overrides are now exposed in the FX/monitoring UI for track/master/monitor chains; the full end-to-end double bus architecture is still not complete yet.
- Add an engine setting `processingPrecision: float32 | hybrid64`, persisted per application/session setting; default stays `float32` initially.
- Implement double-precision internal buses for track summing, sends, sidechains, master summing, and offline render when `hybrid64` is enabled.
- Negotiate plugin precision per instance: if a plugin supports double precision, process it in double; otherwise convert at the plugin boundary and continue internal summing in double.
- Keep media decode and hardware I/O compatible with current float paths while promoting internal summing to double in hybrid mode.
- Update automation, metering, PDC, sidechain routing, and normalization/render code so float and hybrid64 paths stay behaviorally aligned.
- Add a compatibility fallback so any plugin that misbehaves in double can be forced to float processing without disabling hybrid64 globally.
- Acceptance for this phase: hybrid64 renders null-close against float for ordinary sessions, improves precision in stress mixes/feedback-heavy cases, and does not change existing float32 session behavior unless the setting is enabled.

### Phase 6: Hardening, Compatibility, and Release Guardrails
Status: Partially implemented. Backend compatibility-matrix and engine-benchmark APIs now exist, benchmarks now cover multiple block sizes and include MIDI diagnostic context plus hybrid64-aware master processing, the release-guardrail runner now validates track/master/monitor fallback counters, compatibility-metadata completeness, and benchmark block coverage/finite values in one backend report, and an automated regression-suite runner plus repo-side runner script now exist; full regression coverage and strict release gating are still not complete.
- Add plugin regression coverage for mono/stereo instruments, sidechain FX, MIDI-only plugins, CLAP instruments, and float-only legacy plugins.
- Benchmark CPU and memory cost of `float32` vs `hybrid64` at 32/64/256 sample buffers and at realistic large-session track counts.
- Gate release on keyboard-smoke tests, offline-render parity tests, no-hung-note tests, and queue-overflow diagnostics staying clean under stress.
- Keep a rollback switch for `hybrid64` and for CLAP-MIDI output handling until the compatibility matrix is green.

## Important API and Interface Changes
- Backend engine additions:
  `enqueueLiveMidiEvent`, `enqueueUiMidiEvent`, `buildTrackMidiBlock`, `processInstrumentTrack`, `setProcessingPrecision`, `getMidiDiagnostics`, `getPluginCapabilities`.
- Track model additions:
  per-track live MIDI queue, per-track note-state cache, optional downstream MIDI target, optional per-plugin precision override.
- Native bridge additions:
  precision setting getter/setter, MIDI diagnostics getter, optional keyboard-test diagnostics endpoint, regression-suite runner endpoint.
- Plugin capability model:
  add booleans for `isInstrument`, `isMidiEffect`, `producesMidi`, `supportsDoublePrecision`, `pluginFormat`, and bus-layout summary.

## Test Plan
- Live keyboard test: load VST3i, arm + monitor, play notes/chords rapidly, stop transport, verify no hung notes.
- MIDI clip test: import/create clip with note-on/off and CC data, play, loop, seek, and render; verify live and render outputs match.
- Hardware MIDI test: use a MIDI-only track to drive an external device and verify note timing and note-off behavior.
- CLAP test: scan/load a CLAP instrument, open editor, play live MIDI, play MIDI clips, save/restore state, render offline.
- Latency test: run at 32/64/128 sample buffers and capture queue overflow, late-event count, and callback-stall metrics.
- Hybrid64 test: compare float32 vs hybrid64 CPU use, render parity, sidechain behavior, PDC correctness, and plugin fallback handling.

## Assumptions and Defaults
- Default shipping behavior remains `float32` until hybrid64 passes compatibility and performance validation.
- MIDI correctness takes priority over preserving the current placeholder monitor path; any non-audio-thread instrument triggering is removed.
- VST3 remains the most stable plugin path; CLAP reaches feature parity after the dedicated event-bridge phase, not before.
- Existing frontend track/clip models stay intact unless Phase 2 proves a contract change is required for sample-offset scheduling.
- The first user validation checkpoint is after Phase 1, using a physical MIDI keyboard on an instrument track before broader roadmap work continues.
