# OpenStudio Roadmap

This public roadmap describes product direction, not fixed delivery dates or a
promise that every exploratory item will ship. Current capabilities and caveats
live in [Implemented features](implemented_features.md); release qualification
lives in [Testing](testing.md) and the
[Release smoke checklist](release-smoke-checklist.md).

## Now: release quality

- Qualify the implemented built-in suite editor and Convolution changes using the
  [editor maintenance and qualification gates](free-plugins.md#editor-maintenance-and-qualification).
  Design 03 is implemented in the working tree; review and qualification remain
  in progress. Verify Find-to-control navigation, primary controls in compact
  windows, useful wide overviews, exact adjustment and complete-state comparison.
  Retain every native parameter, contextual machine control, IR/MIDI/routing
  workflow and original automation identity. Qualify responsive geometry,
  Release callback cost and effect-specific audio laws separately; neither a
  screenshot nor a parameter inventory proves sound, CPU headroom or completion.
- Qualify the development-tree [standalone plugin changes](free-plugins.md)
  through exact-artifact listening, live audio/MIDI devices and supported
  platforms. [Retained evidence](testing.md#retained-audio-qualification-and-limits)
  includes Shimmer and Pitch Correct callback-deadline failures at demanding
  rates/buffers/instance counts and Original/Spread transition limits. Earlier
  continuing-input Infinite Hold saturation is retained as a reproduced
  baseline; the subsequent implementation passes all 16 bounded headroom
  fixtures on the final Release build. Indefinite accumulation and listening
  acceptance remain unasserted. Deterministic passes do not close the separate
  performance, device or listening limits.
- Complete release qualification for the NAM Rack and optional TONE3000
  workflow, including multi-capture selection, Guitar/Bass profiles, project and
  preset recovery, accessibility, and real-interface listening tests.
- Qualify Octaver Fuzz as part of the complete guitar rig: preserve independent
  octave tracking, raw clean blend and old-state fuzz-off recall; verify the
  shared interface calibration convention, then audition the expanded
  Octave/Fuzz/Drive/Distortion matrix through explicitly identified NAM amp and
  cabinet fixtures at conservative and stress settings. The working-tree
  531-case full-chain matrix passes structural checks; this is not listening
  acceptance. Keep exact native
  before/after float WAVs and resource/source hashes. The
  [October 23 Swollen Pickle reference review](testing.md#swollen-pickle-reference-fuzz-review-october-23-2026)
  implements moderate-gain refinement, an integrated Clean control and numerical
  corrections in downstream Distortion/Saturator; exact-artifact listening is
  still required. Use the
  [artist research and scope](nam-rack.md#full-rig-fuzz-qualification-october-18-2026)
  to guide one audible change at a time after baseline capture; no commercial
  replica or preferred tone is established by measurements. Follow the
  [NAM CPU and interaction contract](nam-rack.md#cpu-and-pedal-interaction-contract)
  for implemented sample-boundary Octaver retirement and coefficient caching,
  remaining two-Rack deadline limits, both recovered bass-preset scenarios and
  broader pedal coverage. The Audient 8-to-16 buffer transaction has passed a
  silent hardware test; that does not qualify a loaded two-track session.
  Qualify the implemented [multicore track executor](nam-rack.md#four-track-live-monitoring-acceptance-target)
  and address measured longest-track and wakeup bottlenecks. Persistent helpers
  scale with physical cores; isolated native-NAM audio tracks can run in
  parallel while hosted, MIDI/ARA and routed tracks retain serial processing.
  The conservative eligibility gate adds no device buffering. The required target is four recording,
  monitored NAM Racks at 16 samples and 4x Drive oversampling; 8 samples is a
  separate stretch target. Bounded Release probes show lower average callback
  costs, but four- and twelve-track cases still report missed or skipped work. The target
  remains **not met**; bounded ownership/recording tests and a low average CPU
  meter do not close the live deadline, recording-duration or listening gates.
  Keep measured results and exact test scope in
  [multicore qualification](testing.md#multicore-nam-live-qualification-october-23-2026).
- Keep Windows, macOS, and Linux installation, startup, updates, and optional AI Tools
  setup reliable on clean systems.
- Preserve old projects and presets while strengthening audio-thread safety,
  deterministic state migration, and failure recovery.
- Implement and qualify [AI generation memory and speed improvements](runtime-dependency-contract.md#remaining-implementation-plan-september-12-2026),
  extending the shared execution policy with qualified optional attention
  packages and platform testing. MiniMax measures actual input tokens, exposes
  selected precision, and stops unqualified INT8 requests before silently
  loading unquantized weights. Request-boundary CUDA cache cleanup is being
  requalified on the local Windows RTX 4080; the latest full-duration test
  stopped under system RAM pressure. Full cold/warm capacity and normal-worker
  validation remain pending, and the old local profile is not promoted to the
  updated worker. The user's earlier short-sample INT8 audition remains recorded.
  Unquantized partial residency and disk staging remain experimental. Warm
  worker reuse and generation/separation resource handoff are implemented.
  Both generation dialogs now expose request-specific memory estimates and
  available hardware headroom. Full-song ACE-Step and Stable Audio timings,
  bounded SAME decoding, and remaining listening/precision limits are recorded
  in [September 13 qualification](ai-generation-qualification-2026-09-13.md).
  Investigate the observed PCIe Gen 1 host link; the GPU is directly installed
  in the motherboard's top slot. Other hardware qualification remains pending.

## Next: DAW foundations

- Qualify the [automation contracts](automation-host-review.md) across platforms, vendor
  CLAP editors and physical vendor controls. Target routes, Safe, Touch return, range
  tools, realtime volume/send Trim, Preview/Capture/range Commit, realtime
  Punch/AutoJoin, write-to-start/end, manual/after-pass/on-exit Trim coalescing,
  Cross-Over/Touch-Latch, unavailable-FX recovery and dynamic JSFX/CLAP metadata
  handling are implemented in the development tree. Native/isolated VST3 and CLAP SDK
  offsets are retained where supplied; ordinary GUI timing remains estimated. The latest
  native Punch/AutoJoin writing run timed out after entering Preview; earlier gain
  checks do not clear that failure. Diagnose native/UI responsiveness and the Preview
  queue before repeating that run. Wider physical-control, loop/recording and
  cross-platform qualification remains pending.
- Resolve the installed AmpliTube 5 cold-instance offline-export discrepancy.
  Host-exposed parameters now survive export, but the first guitar render still differs
  from subsequent renders; passing native parameter checks do not establish render
  parity.
- Qualify project-read recovery under longer sessions. Concurrent chunked reads now
  serialize their snapshot lifetime and failed reads report explicit native errors
  before project replacement. The original intermittent copied-project restore failure
  remains unconfirmed despite passing subsequent native frontend runs.
- Qualify the implemented [built-in plugin suite](free-plugins.md), including
  exact-artifact listening, reference calibration, extreme controls and real
  device/Release/multi-DPI behavior. The guide retains named extension decisions
  for EQ, dynamics, Delay, alignment, pitch and instruments. Drum auxiliary sends,
  four-output convolution, prepared EQ MIDI recall, continuous alignment and the
  approved editors are implemented; they are not outstanding feature work.
- Complete [audio-device capability work](runtime-hardening.md#audio-device-configuration):
  rate-specific queries/hot-plug generations, explicit I/O masks, format/latency
  display, project-rate override and advanced scheduling/format controls.
- Qualify [native pitch ownership and workstation workflows](runtime-hardening.md#detached-pitch-session-ownership)
  across installed Windows, macOS and Linux. Complete real monitor/DPI transitions,
  sustained microphone capture, device loss/permissions and independent-clock
  measurements using the [acceptance matrix](testing.md#desktop-and-recording-acceptance).
- Finish the remaining MIDI playback, routing, note-lifecycle, hardware-output,
  and plug-in-generated MIDI workflows across live playback and offline render.
- Bring CLAP instrument/event handling and state restoration to the same
  product standard as the reference VST3 path.
- Unify menus and contextual commands around the action registry so shortcuts,
  enablement, undo, and visible actions remain consistent.
- Complete and test the render/export options that OpenStudio advertises,
  including presets, queue behavior, metadata, failure cleanup, and project
  round trips.
- Improve project-wide media, FX, track/group, navigation, and floating-window
  management.

## Exploring

- An optional local DAW assistant that selects a model appropriate for the
  user's hardware, keeps project context local and bounded, previews every
  mutating action, and uses OpenStudio's normal undo-aware commands.
- Wider hybrid-precision processing where it produces measurable value without
  compromising plug-in compatibility or the default float32 workflow.
- More portable tone/library workflows, including cross-device metadata and
  safe shared-asset management.
- Future pitch-rendering or restoration research when a materially stronger,
  testable approach becomes available.
- A native extension SDK if demand justifies a stable ABI and long-term
  compatibility commitment; Lua and JSFX remain the supported extension paths
  today.

## Product guardrails

- OpenStudio will not bundle third-party NAM captures or cabinet IRs without
  clear redistribution permission.
- Automated measurements will not be presented as proof of subjective tone,
  naturalness, or commercial-product parity.
- Experimental controls will not be exposed as working product features before
  their complete signal path, persistence, and tests exist.
- Retired NAM Rack controls and misleading decorative routing will not return
  without a new product decision and full QA.
