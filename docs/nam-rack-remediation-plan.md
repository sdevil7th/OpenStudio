# NAM Rack DSP, TONE3000, and Preset UX Remediation Plan

Last updated: 2026-08-12

This is the implementation tracker for the NAM Rack pedalboard, signal-chain,
TONE3000 library, preset-navigation, and preset-manager work. A box is marked
complete only after the corresponding automated gate passes. Subjective sound
quality is never marked complete from metrics alone; the final pedal-tone gate
requires musician audition.

## Status legend

- `[x]` implemented and its listed automated gate passed
- `[~]` in progress
- `[ ]` pending
- `[!]` blocked on an external decision or manual/subjective verification

## Non-negotiable safety rails

- Preserve the working post-NAM EQ, chorus, delay, and reverb signal path and
  serialized state.
- NAM Rack is pre-release: preserve user controls, model/IR resources, and
  transactional recovery, but do not preserve or expose rejected pedal/effect
  algorithms. Old or missing DSP markers are migration inputs only; every
  successful restore normalizes to the one current implementation and
  persistent user presets are rewritten atomically. This rule applies to every
  unreleased rack component, not only Precision Drive and Distortion.
- Keep file I/O, allocation, model loading, and unbounded work off the audio
  thread. Do not add a blocking audio-thread lock.
- Test real live-input topology (`L = guitar`, `R = silence`) as well as stereo;
  a duplicated stereo DI cannot detect the current routing failure.
- Do not claim that a pedal sounds natural, analog, or equivalent to a
  commercial product until the exact artifact has been auditioned and approved.
- Remote TONE3000 search results remain session-memory-only unless TONE3000
  explicitly approves persistent catalog caching. Installed/local models and
  user presets may be cached normally.

Earlier V1-V5 compatibility entries below are retained only as a chronological
engineering record. They are superseded by the current-only pre-release rule
above and must not be interpreted as supported runtime or recall choices.

## Phase 0 - Code audit and implementation design

- [x] Trace the complete live NAM Rack route from track input through the final
  safety guard.
- [x] Audit every pre-NAM stage for silence invariance, mono/stereo behavior,
  hidden gain, calibration, and state interactions.
- [x] Audit Precision Drive and Distortion transfer functions, filters,
  compensation, oversampling, defaults, and factory presets.
- [x] Audit Pedal NAM placement and calibration. It is processed serially before
  Amp NAM despite stale documentation describing it as migration-only state.
- [x] Audit the NAM regression/audition fixtures.
- [x] Audit TONE3000 search, cache, architecture filters, pagination, and API
  constraints.
- [x] Audit preset load feedback, active identity, arrow navigation, and manager
  layout.
- [x] Create this tracked plan before implementation changes.

### Confirmed pre-remediation audit findings

At task start, the active route and defects were:

The active rack route is:

```text
track pre-FX automation / channel EQ
  -> input FX / instrument / track FX
  -> NAM Rack input trim and input mode
  -> gate
  -> compressor
  -> pre-amp tape echo
  -> octaver
  -> shared 2x nonlinear island: Precision Drive -> Distortion
  -> optional Pedal NAM
  -> amp Gain / Boost / Voice
  -> Amp or Full-Rig NAM
  -> post-NAM tone stack
  -> cabinet IR/shaping when required
  -> reorderable EQ / modulation / delay / reverb
  -> output trim / final linked safety guard
```

The pedal issues are related but not identical:

- Precision Drive is confirmed to generate a biased output from exact silence.
  On an `L = guitar, R = silence` route, that makes the mono-NAM folding helper
  treat both channels as active and reduces the real guitar contribution by
  approximately 6.02 dB while adding the bias. This is a correctness defect.
- Distortion uses the same biased front-end idea. Its post-clip high-pass rejects
  steady DC, but engage/parameter transients can still make the silent channel
  nonzero and alter the mono fold. It needs the same invariant regression.
- Gate, Compressor, and Octaver are zero-in/zero-out and do not share the
  confirmed DC defect. Compressor Volume has an asymmetric contract (positive
  values are wet makeup; negative values attenuate the complete parallel path),
  which is unintuitive and must be versioned if changed. The rectifier Octaver
  can sound synthetic, but that is a topology/quality issue, not this routing bug.
- Tape Echo intentionally creates stereo before the amp. Its active mix uses a
  crossfade law, so the default mix attenuates the dry attack before NAM. This can
  make the source feel farther away or wrapped even though it is not a DC bug.
- Pedal NAM is correctly located before Amp NAM and has metadata/override dBu
  calibration. With an L-only source, a partial Pedal-NAM mix creates wet signal
  on both channels but dry signal on one; the next mono Amp NAM fold attenuates
  only the dry contribution. That routing contract must be made explicit.
- The embedded native drives operate on arbitrary host dBFS before the NAM
  calibration stage. Their default mappings add substantial pre-gain, heavy
  blanket auto-compensation, fixed high/low cuts, and almost/full wet mixes.
  Amp Gain instead acts directly at the calibrated model input, which explains
  why it currently feels more predictable.
- The current drive audition harness does not test Distortion: both scenarios
  enable Precision Drive and one changes a retired parameter. Its DI is also
  duplicated into L/R, hiding the live mono-input defect.
- Post-NAM chorus, delay, and reverb are not implicated by this audit and remain
  protected regression surfaces.

## Phase 1 - Correctness: silence, mono routing, and truthful regression

### Tests first

- [x] Add a deterministic current-engine zero-input probe for Precision only,
  Distortion only, and both together, including enabled-before-prepare and
  engage-on-silence. Retired and missing serialized markers must render the
  same centered current circuit.
- [x] Require finite current-engine output and per-channel maximum absolute output
  `<= 1e-7`.
- [x] Add a real `L = DI, R = silence` route probe through native drives and a
  mono NAM fixture; compare against the explicit mono reference after latency.
- [x] Assert that Precision audition enables only Precision and Distortion
  audition enables only Distortion.
- [x] Assert that the two audition scenarios no longer render the same DSP path.
- [x] Record and preserve rack latency across the P0 correctness patch.

### Implementation

- [x] Center the embedded NAM Rack nonlinear transfer so `f(0) = 0` while
  retaining asymmetric curvature. The one current Rack circuit owns this
  contract; standalone Saturator remains a separate processor.
- [x] Do not solve the defect only with a DC blocker: switching transients could
  still trigger the sample-peak mono heuristic.
- [x] Keep the stateful symmetric diode solver unbiased until a genuine
  asymmetric diode model is implemented.
- [x] Correct the Distortion audition branch and controls.
- [x] Rename the misleading `Stereo Sum` mode to describe its actual
  stereo/automatic-fold behavior.
- [ ] Prefer explicit single-input route metadata for mono selection. Do not
  force every new rack to mono until genuine stereo inserts are covered. The
  current block-wide signal-presence inference can change classification when a
  callback straddles the first right-channel Tape repeat.
- [x] Fix partial Pedal-NAM dry/wet routing so a following mono Amp NAM preserves
  the intended dry-to-wet balance for a steady single-guitar block in V3. A
  Tape-active, Pedal-Mix=0, mono-Amp fixture is latency-aligned transparent;
  explicit route provenance remains the robust pending endpoint above.
- [x] Update stale Pedal-NAM routing documentation after behavior is verified.

### Phase 1 gate

- [x] Debug C++ build passes with zero new warnings.
- [x] NAM Rack headless regression passes.
- [x] NAM Rack DI headless regression passes with both a deterministic generated
  mono DI and the official CC0 wrapper. The wrapper now pins the FreePats GitHub
  release URL and published SHA-256 after the former host URL was retired.
- [x] Clean-guitar headless regression passes.
- [x] Existing post-NAM EQ/modulation/delay/reverb behavioral regression cases
  pass. No frozen bit-for-bit post-NAM golden is claimed.

## Phase 2 - Calibrated gain staging and predictable pedal controls

- [x] Define and document the native pedal analog reference level at the rack
  boundary (host dBFS to pedal operating level and back).
- [x] Add level-sweep probes around the defined reference to catch premature
  clipping, over-compensation, and discontinuities.
- [x] Give Drive, Level, Tone/Bright, Attack/Tight, and Mix one explicit audible
  contract; remove or redesign hidden blanket drive auto-compensation so Level
  can genuinely push the following amp.
- [x] Treat saved `namEffectsDspVersion` and embedded-Reverb engine markers as
  migration inputs only. Every complete NAM Rack restore selects effects schema
  V7 and embedded Reverb V4; no production audio branch recalls a rejected Rack
  implementation.
- [x] Canonicalize binary, project, tone, portable, compare, preset, automation,
  and nested snapshot state. Preserve explicit audible controls and NAM/IR
  resources, fill newly introduced controls with current defaults, remove
  retired controls, and leave complete non-NAM built-in bundles unaffected.
- [x] Apply this current-only contract to Compressor, Tape Echo, Poly Octaver,
  Precision Drive, Distortion, Pedal NAM routing, Chorus/Modulator, Delay, and
  embedded Rack Reverb. Standalone built-in processors keep their own state
  compatibility and cannot select an embedded Rack engine.
- [x] Extend calibration regression to Pedal NAM metadata, override, state
  round-trip, missing-calibration warning, and dual-NAM chaining.
- [ ] Retune factory presets only after the calibrated controls pass deterministic
  gates. Remove accidental double attenuation and over-filtering.
- [x] Warn truthfully when Precision + Distortion + Pedal NAM are stacked; do not
  silently disable user state.

### Phase 2 gate

- [x] All Phase 1 gates still pass.
- [x] Bypass/off parity, zero input, finite output, state round-trip, and block
  partition invariance pass at 44.1, 48, and 96 kHz.
- [x] Objective gain staging is `pass`; alias spectra and tone comparisons are
  recorded as `diagnostic_only`.
- [!] Musician audition of clean boost, edge-of-breakup, mid-boost, and high-gain
  cases is required before pedal realism can be marked complete.

## Phase 3 - Other pre-NAM pedal behavior

- [x] Change Tape Echo's pre-amp Mix contract so increasing wet level does not
  unintentionally remove the direct attack, while retaining its intended stereo
  repeats and bypass/tail behavior. Old state is migrated to this one current
  contract rather than selecting an old audio branch.
- [x] Make Compressor Volume behavior symmetric and explicit (wet makeup versus
  stage output); old state is migrated to the current output-stage contract.
- [x] Add silence, L-only, stereo, partition, engage/disengage, and tail tests for
  Gate, Compressor, Tape Echo, and Octaver.
- [x] Make moving Tape Mod callback-partition invariant by feeding the raw target
  into the current scoped 40 ms child morph. The same current head morph governs
  explicit Tape Time response; serialized markers cannot revive the rejected
  block-endpoint path.
- [x] Keep the current Octaver topology unless an isolated before/after artifact
  and acceptance target justify replacing it. Its synthetic character is
  `not_asserted`, not a confirmed routing defect.
- [x] Confirm that removing the Pedal module clears every native drive state that
  the UI says it removes, including Distortion.

### Phase 3 gate

- [x] All Phase 1 and 2 deterministic gates still pass.
- [x] Fresh/reset Gate, Compressor, Tape Echo, Octaver, and embedded drives
  produce zero from exact silence; expected Tape tails after prior excitation
  are tested separately. Recognized old/missing markers render through the same
  current implementation and cannot restore an old silence signature.
- [x] Bypass and tail transitions contain no non-finite samples or unexpected
  direct-path level step.
- [!] Other-pedal naturalness remains subject to musician audition.

### 2026-08-12 musician-audition follow-up

- [x] Replace the interim V1-V5 recall policy with one current pre-release Rack.
  Compressor, Tape Echo, Poly Octaver, Precision Drive, Distortion, Pedal NAM
  routing, Chorus/Modulator, Delay, and embedded Reverb no longer select DSP
  from saved markers. Project, tone, binary, portable, compare, automation, and
  preset state migrate controls/resources instead of reviving rejected algorithms.
- [x] Migrate persistent NAM Rack user presets atomically and idempotently.
  Preserve explicit controls and model/IR identity, map the former default
  Precision Volume `0 dB` to the current `+9 dB` default, leave corrupt files
  untouched, never let a stale same-name `.s13preset` overwrite the authoritative
  `.ospreset`, and never overwrite runtime factory originals. Retired
  `precisionDriveMode` values and automation lanes are consumed and removed.
- [x] Make the exact `Best clean!` bypass/current Precision/current Distortion
  full-chain renders the sole accepted native-drive audition set. Historical
  circuit artifacts are provenance only. Objective routing/safety can pass;
  perceived drive, heaviness, and commercial-reference similarity remain
  `not_asserted` until the user auditions those current artifacts.

- [!] Distortion subjective acceptance failed twice: the rejected implementations
  were perceived as simple drives rather than forceful distortion. The only
  current pre-release engine now contains the clean-room modern-heavy replacement
  below, but tonal completion still requires a new musician audition.
- [x] Replace the Distortion voice with a deliberately
  contrasting multi-stage topology: a pre-distortion Weight high-pass, three
  zero-centred nonlinear cells with filtering between cells, Heavy/Extreme/
  Crunch density ranges, the stateful diode output stage, a true clean/wet Mix,
  and one exact post-topology Level law. The design is informed by the published
  Heavy/Heavy Menace behavior and is not a proprietary circuit clone. Rejected
  pre-release pedal algorithms are migration history, not recall choices.
- [x] Replace Precision with the current feedback-split asymmetric overdrive and
  correct live engage so one shared-island fade owns a settled
  bypass-to-wet transition instead of multiplying a 60 ms island fade by an
  80 ms pedal fade. Attack shapes the boosted feedback band before clipping,
  Bright sets post-cell bandwidth, Volume is exact post-circuit gain, and the
  migrated/new default is `+9 dB` so a clean Amp NAM receives a useful push.
- [x] Add deterministic live-processing contrast diagnostics for harmonic
  density/mode ordering, Drive sweep, Weight behavior, exact Level scaling,
  DC/finite safety, stereo-channel independence, callback partitioning, live
  transition continuity, following-Amp activity, and fixed latency.
  Existing shared-island/alias regressions remain green. Musician approval of
  clean, rhythm, and saturated-lead artifacts remains `[!]` / `not_asserted`.
- [x] Keep ordinary current high-gain output out of the rack-end emergency knee with
  a fixed `-2.5 dB` circuit-output calibration. The hot Drive sweep now peaks at
  `1.44362` before the guard with zero guard hits; the separate user Level law
  remains exact (`+6 dB` normalized error `7.45e-9`).
- [x] Clear native-drive history at a complete bypass without a capacity-size
  audio-thread reset. Both inner stages use bounded state resets and the shared
  IIR oversampler drains incrementally through preallocated scratch. Precision
  -> Distortion and Distortion -> Precision fresh-reference errors are exactly
  `0` after the completed bypass.
- [!] Octaver subjective acceptance failed. The current monophonic
  zero-crossing/rectifier topology is audibly synthetic and is no longer an
  accepted production voice despite passing safety and routing invariants.
- [x] Replace it with a real pitch-shifting design (polyphonic quality mode, or a
  clearly labelled low-latency monophonic mode) with a centred dry anchor,
  coherent stereo voice rendering, mono compatibility, and reported latency.
  V4 now uses independent L/R instances of a fixed-state 6:1 multirate ERB-PS2
  topology: 21-tap /3 plus 15-tap /2 decimation, 80 complex bands at `Fs/6`,
  phase-scaled +/-1 octave voices, and 25-tap /2 plus 33-tap /3 reconstruction.
  Its six-sample scheduling state is callback-partition invariant. Objective
  safety/frequency/performance work is complete; musician approval remains
  `[!]` / `not_asserted`.
- [x] Treat standard NAM captures as mono 1-in/1-out. The backend now exposes
  explicit `Auto / Single NAM`, `Mono Input 1 / Single NAM`, and
  `Stereo / Dual NAM` modes. A 1x1 capture is prepared and atomically published
  with two fully independent L/R graph and streaming states; native 2x2 models
  run once. Live mode entry uses a bounded fade/prime/fade handoff. A failed
  replacement cannot disturb an active pair; on a first load, failure of only
  the optional right graph retains the prepared primary for legacy single-NAM
  routing and exposes an unavailable-Dual warning instead of breaking model
  loading. Dual callbacks stage both lane results and retain both matched dry
  blocks until the pair succeeds, so a runtime fault raised inside either graph
  commits dry on both channels in that callback. A summed single-model route is
  never labelled Stereo.
- [x] Complete the combined Debug build and full NAM regression for the dual
  wrapper after the concurrently added Octaver/presentation sources compile;
  then record current Release 48 kHz / 8-sample single-versus-dual timing as
  `diagnostic_only` and leave subjective width to musician audition. Debug and
  Release objective suites are green. Two final-tree 48 kHz / 8-sample repeats
  measured Single-NAM average/p99/p99.9 `63.83/123.5/419.8 us` and
  `60.07/102.1/359.1 us`, with 34/19 misses, and Dual NAM
  `109.42/302.5/458.5 us` and `108.99/221.9/482.4 us`, with 75/66 misses,
  against the `166.67 us` deadline in 4096 calls. Average cost is within budget,
  but the tail is not reliable enough to claim 8-sample safety. These are
  scheduler-sensitive diagnostics, not an ASIO guarantee.
- [x] Add a mono-to-spatial post-cab early Room and optional Doubler with unity
  close-cab anchoring, low-frequency centring, algebraic mono cancellation,
  transient protection, finite recovery, and deterministic multi-rate tests.
  Preserve real stereo input through every stereo-safe stage. Dual mic/IR lane
  selection and explicit hardware-route provenance remain later extensions,
  not hidden claims of this first Cabinet Space implementation.
- [x] Match the Cabinet Space engineering gates to the published product/repo
  contracts: stereo-capable component routing (GENOME), a millisecond-spread
  mono doubler plus independent stereo-input mode (Neural DSP), multi-cab/mic/
  room presentation (AmpliTube), and transient-protected frequency-dependent
  decorrelation (the DAFx open-source StereoWidener). The implementation uses
  no proprietary impulse responses or copied product DSP.
- [!] Run the final perceptual acceptance as a level-matched, randomized
  multi-stimulus comparison following ITU-R BS.1534 principles: hidden bypass
  reference, deliberately narrow anchor, mono/stereo DI material, headphones
  and +/-30-degree loudspeakers, and separate ratings for centre solidity, pick
  clarity, externalisation, width, colouration, and mono collapse. This cannot
  be automated or marked complete without musician listeners.
- [x] Keep Dual NAM optional at very low buffers: Single NAM and Stereo/Dual NAM
  remain explicit routing choices, and the complete rack reports their cost
  separately.
- [!] Prove real-driver 8-sample stability on the target system. Three current
  Release headless runs at 48 kHz / 8 samples measured complete Single-NAM rack
  average/p99/p99.9 `56.51/75.5/91.3 us`, `59.69/98.3/340.2 us`, and
  `58.50/92.4/353.0 us`, with `0/29/18` deadline misses in 4096 calls. Complete
  Dual-NAM measured `100.12/120.2/142.5 us`, `104.24/300.9/404.3 us`, and
  `103.79/160.0/436.9 us`, with `0/62/37` misses against a `166.67 us`
  deadline. Processing remained valid with no resize, oversize, lock, model, or
  safety fallback, but scheduler-sensitive tails mean neither topology can be
  promised glitch-free from this headless benchmark. A target ASIO soak remains
  required.

## Phase 4 - Nonlinear quality and NAM performance modes

Phase 4 is intentionally deferred: the rack remains on its existing shared 2x
nonlinear island, no Full-model default change was made, and Release low-buffer
benchmarks plus musician audition are still required.

- [ ] Add an optional 4x shared nonlinear island only with maximum-size buffers
  allocated off the audio thread and fixed, correctly reported latency.
- [ ] Cover 2x/4x bypass alignment, toggles, smoothing/gate timing, 44.1/48/96
  kHz, 64/127/512 sample blocks, mono/stereo, and partition invariance.
- [ ] Benchmark Release at 32/64-sample device buffers before considering 4x as
  a default. Spectral alias measurements are `diagnostic_only`.
- [ ] Benchmark A1/A2 Economy versus Full model size at low buffers. Do not make
  Full the default until deadline/CPU regressions pass.
- [ ] Keep cabinet and post-NAM effects unchanged during this phase; evaluate the
  cabinet/room presentation separately if pedal corrections do not close the
  perceived in-room gap.

## Phase 5 - TONE3000 search, filters, cache, and infinite browsing

### Search correctness

- [x] Split draft query from committed query and issue one remote search after a
  400 ms debounce.
- [x] Make Enter/search-button flush the same request immediately without a
  second delayed request.
- [x] Capture an immutable search key (query, architecture, category/gear, tab,
  sort, and page size) for every request.
- [x] Invalidate the current generation synchronously whenever search intent
  changes. A delayed A1 response must never overwrite A2 state, rows, status, or
  busy state.
- [x] Default non-empty text searches to the API's relevance/best-match sort;
  retain Trending for an empty browse.

### Session/cache behavior

- [x] Share in-flight library/search promises and session-memory LRU entries
  across Explorer remounts.
- [x] Render a fresh cached result immediately without a blocking skeleton;
  stale content may remain visible during a background refresh.
- [x] Preserve current filters, committed query, appended pages, and scroll
  position while the current application session remains open.
- [x] Keep installed-library state and the offline catalog globally coherent
  across per-flow views. Mutation generations supersede pre-mutation reads, and
  an amp/pedal/IR session switch cannot publish an older local refresh.
- [x] Serialize reinstall, update, favorite, and remove under one
  ownership-aware installed-library transaction. Disable every mutation surface
  while it is owned, and prevent an older completion from clearing a newer
  owner's busy state.
- [ ] Cache installed/local library metadata persistently and invalidate it on
  install, remove, or filesystem change.
- [!] Do not add persistent remote-catalog storage until the TONE3000 agreement
  explicitly permits it; otherwise use their hosted Select flow for that scope.

### Infinite browsing

- [x] Reuse page-based API cursors and stable ID deduplication for append.
- [x] Replace the mixed Prev/Next/Load-more UI with a viewport-edge infinite
  append sentinel plus an accessible Load More fallback.
- [ ] Add row windowing only if profiling long appended sessions shows it is
  necessary; viewport-triggered paging is complete, but DOM virtualization was
  intentionally not added without a measured rendering problem.
- [x] Permit only one request per page/key and do not speculative-prefetch under
  the service's search rate limit.
- [x] Retry a failed appended page in append mode without replacing the already
  accumulated pages.
- [x] Bind source-flow pagination observers to the current live request
  signature so a filter/query replacement cannot retain an older callback.

### Phase 5 gate

- [x] Fake-timer test: no call at 399 ms, exactly one at 400 ms, and Enter flushes
  without duplication.
- [x] Delayed-response epoch test: old A1 success/error/finally cannot modify A2.
- [x] Remount test: fresh cache causes no duplicate bridge call or skeleton;
  simultaneous consumers share one call.
- [x] Infinite append test: one page request, ID dedupe, correct end/error state,
  filter reset to page 1, and no observer loop.

## Phase 6 - Preset truth, working arrows, and professional manager

### Correctness and feedback

- [x] Replace split factory/user selection state with one canonical active preset
  identity: `none`, `factory(id)`, or `user(name)`.
- [x] Await and verify rack readback after a preset load. Commit the new active
  identity before another navigation action can resolve against stale state.
- [x] Drain queued UI-state persistence and coalesced parameter writes before
  snapshotting or loading a preset; abort if that drain cannot complete safely.
- [x] Mark exactly one row active with visible selection, `aria-current`, and a
  check; never leave an old factory tile active after loading a user preset.
- [x] Close the manager and show persistent success feedback after a verified
  load. On failure keep it open, preserve the prior identity, and show the error.
- [x] Make arrows cycle the verified active collection, expose the exact target
  name, and serialize rapid requests. From an empty/unsaved rack, Previous and
  Next now enter the last/first alphabetized saved full-rig preset respectively;
  a one-item collection becomes unavailable only after that preset is active.
  Factory Current Capture templates remain unavailable without an Amp Capture.
  If there is no saved rig to enter, an empty-rack arrow opens the Preset Library
  with a truthful next-step message instead of silently doing nothing.
- [x] Preserve a saved rig's verified identity when restoring its Amp Capture
  changes the rack from empty to populated. Only a direct unsaved Amp Capture
  transition with no authoritative native preset identity clears the selection,
  so the following arrow advances from the loaded rig instead of restarting.
- [x] Make Compare recall transactional: capture a complete authoritative
  rollback state before mutation, verify values/models/DSP version/order and
  identity after recall, and independently verify rollback after a false return,
  exception, or readback mismatch before reporting the prior rack as restored.

### Preset interaction gate

- [x] Add deterministic cache, resolver-sequencing, rollback-helper, and
  transaction source-wiring tests, including successive verified identities and
  the stale-target guard.
- [x] Test resolver Previous/Next wrap, empty-rack entry with two or one saved
  full-rig presets, active one-preset disable, no-amp factory-template filtering,
  Empty -> Alpha identity preservation -> Next -> Bravo, missing/renamed current
  preset, failure retention, factory/user identity switch, header update, and
  modal close-on-success wiring.
- [!] The connected in-app browser remains unavailable, so the newly corrected
  empty-rack arrow click path is covered deterministically but has not been
  clicked in the rendered WebView. Delayed native readback plus repeated-click
  ordering, focus behavior, and visual feedback still require a real app session.

### Manager redesign

- [x] Extract the manager into a scoped modal component instead of adding more
  absolute-layout overrides to the rack stylesheet.
- [x] Use a recall-first layout: collections, unified searchable preset list,
  details/metadata, and clear Cancel/Load footer.
- [x] Separate active, dirty, and favorite visuals. Move Save As to its dedicated
  flow and place rename/duplicate/export/delete in an overflow menu.
- [x] Add search autofocus, Escape/overlay busy locks, native button semantics,
  valid `aria-controls`, `aria-current`, status messaging, and responsive CSS.
- [x] Align the Preset Library with the rack's black/charcoal and warm amber/gold
  palette across selected, focus, status, tag, menu, and primary-action states;
  remove the prior blue/cyan accents and enforce AA contrast on representative
  normal-size text pairs with a deterministic theme regression.
- [!] Visually verify focus, keyboard actions, and layouts at 1280x720,
  1536x960, and 1920x1080 in a real WebView session.

## Phase 7 - Final integration and handoff

- [x] Run all focused frontend tests and `npx tsc --noEmit`; document any known
  pre-existing errors separately from new errors.
- [x] Build `frontend/dist` and complete the CMake Debug build so
  `python build.py dev --run` needs no pre-running server.
- [x] Run the complete NAM Rack/DI/clean-guitar regression suite.
- [x] Verify no Codex-started process owns port 5183.
- [!] Complete musician audition and native UI visual/interaction checks.
- [x] Update this document with final `pass`, `fail`, `diagnostic_only`, and
  `not_asserted` results and exact artifact paths.

## Research-informed design direction

The implementation target is not to copy a competitor's proprietary code. The
relevant common architecture is a calibrated, topology-aware drive placed before
the amp model, followed by a high-quality cabinet/microphone stage and post-amp
space effects. NAM itself models the captured system but does not correct an
arbitrary host input level or make a generic waveshaper behave like a complete
pedal circuit. Products built around NAM commonly keep drives before the amp
model; the important differentiators are explicit level calibration, stable mono
routing, realistic frequency-dependent nonlinear stages, adequate anti-aliasing,
and coherent cabinet/room presentation. Those are the criteria used by the
phases above.

## Change log

- 2026-08-11: Completed the read-only signal-chain, pedal, TONE3000, and preset
  audits; created the plan before implementation.
- 2026-08-11: Pedal-module removal now disables both Precision Drive and
  Distortion before clearing Pedal NAM; the focused preset transaction suite
  passes (18/18).
- 2026-08-11: Phase 1 zero-input, L-only/mono-NAM, steady partial
  Pedal-NAM, and truthful Precision/Distortion audition corrections passed the
  Debug build, NAM Rack regression, generated-DI regression, and clean-guitar
  regression. That historical compatibility policy was subsequently retired;
  all saved markers now render through the centered current transfer. Objective
  status is `pass`; pedal realism remains `not_asserted`.
- 2026-08-11: Repaired the official DI wrapper's moved FreePats archive URL,
  filename, extraction folder, and checksum. Its complete objective gate now
  passes; subjective quality remains `not_asserted`.
- 2026-08-11: Phase 5 search correctness landed with a 400 ms draft/commit
  debounce, immediate flush, immutable request snapshots, best-match text
  search, and stale epoch rejection. Combined focused frontend tests pass
  (47/47); remote-cache and infinite-scroll work remains pending.
- 2026-08-11: Phase 5 session caching and infinite append landed. Fresh session
  remounts reuse cached rows and shared in-flight work without a blocking
  overlay; per-flow filters, appended pages, and scroll are restored. Prev/Next
  pagination was replaced by an observer plus accessible Load More fallback.
  TypeScript, the focused cache/append suite (16/16), and the full frontend suite
  (406/406) pass. Remote TONE3000 content remains memory-only.
- 2026-08-11: Phase 2 calibrated native-drive work passed the Debug build,
  full NAM Rack gate, clean-guitar gate, and CC0 DI gate. New racks use a
  documented +12 dBu native-pedal reference; embedded hidden Drive compensation
  is removed, measured fixed topology trims preserve the baseline, and signed
  Level is applied once after each complete pedal. Historical comparison WAVs
  are provenance only; serialized markers now select the same current circuit.
  Objective status is `pass`; Precision/Distortion tone remains `not_asserted`
  until musician audition.
- 2026-08-11: Phase 3 and the persistence follow-up passed the zero-warning
  Debug build and complete objective suite. Current Tape Echo keeps
  unity dry while Echo Level scales only repeats; prepared, reset, and
  live-engage direct errors and the measured 3:1 wet-send scaling error were
  exactly `0`. Moving Mod is exercised and partition invariant (maximum
  fixed/uneven error `3.7439e-7`, moving-versus-static difference `0.0453677`)
  with a first-32-sample dezipper ratio of `0.00800250`. Historical marker
  comparisons are now migration-invariance probes, not selectable DSP. No
  frozen historical PCM golden is claimed. Compressor Output measured `+6/-6 dB`
  deltas of `6.0000003/6.0000005 dB`, maximum scaled-waveform error `1.87e-9`,
  and post-drain re-engage error `0`; every retired marker renders the same
  lifecycle. Current native drives produce exactly zero from silence. Portable
  effects marker migration, partial omission, complete legacy NAM migration, rollback, and
  a complete non-NAM bundle all pass. A fixed-partition Tape-active,
  Pedal-Mix=0, mono-Amp comparison is latency-aligned with error `0`; explicit
  route metadata and the crossing-block heuristic remain pending. Post-NAM
  behavioral gates remain green without a bit-golden claim. Objective status is
  `pass`; other-pedal naturalness remains `not_asserted`. Exact results:
  `tmp_nam_rack_runs/20260811_173728_phase3-compat-final/nam_rack_regression_result.json`,
  `tmp_clean_guitar_runs/20260811_173857_phase3-compat-final/clean_guitar_regression_result.json`,
  and
  `tmp_nam_rack_runs/20260811_173902_phase3-compat-final/nam_rack_di_regression_result.json`.
- 2026-08-11: Phase 6 now uses one persisted and verified factory/user preset
  identity, authoritative pre-load snapshots with full rollback, serialized
  navigation, explicit target labels, active-row feedback, and a 15-second
  session preset cache with in-flight deduplication. The recall-first preset
  manager is a scoped modal with explicit Load/Cancel/Refresh actions and
  accessible state wiring. TypeScript and the full frontend suite (417/417)
  pass. Rendered WebView clicks and visual QA remain a manual gate.
- 2026-08-11: The final frontend race audit added authoritative cache
  generations for installed/offline resources, source-flow session epochs, and
  append-mode error retry. Preset recall now drains pending UI/parameter writes;
  reapply honors canonical user/factory identity; the modal has one live status
  region and a locally rendered action lock; Favorites/Recent no longer leak all
  factory templates. Focused tests pass (54/54), the full frontend suite passes
  (417/417), and TypeScript passes.
- 2026-08-11: Final frontend transaction review made Compare recall
  rollback-safe, serialized all installed-library mutations, and bound the
  source-flow append observer to the active request signature. TypeScript and
  the production frontend build pass; focused final-audit tests pass (60/60),
  and the complete Vitest suite passes (425/425 across 55 files). The final
  CMake Debug build completed after `frontend/dist` was generated, with no new
  compiler diagnostics. Port 5183 is free. Connected-WebView clicks, visual QA,
  and subjective pedal tone remain `not_asserted`/manual gates.
- 2026-08-12: The Preset Library's isolated blue/cyan palette was replaced with
  the NAM Rack charcoal and warm amber/gold system. Theme regression, complete
  frontend Vitest (`432/432`), TypeScript, production frontend build, and CMake
  Debug packaging pass; rendered WebView inspection remains unavailable.
- 2026-08-12: Musician audition rejected the current Distortion contrast and
  Octaver quality. Their safety/calibration tests remain valid, but tonal status
  is reopened and tracked above alongside the optional dual-NAM/dual-cab stereo
  architecture. No pedal or routing DSP was changed in this review.
- 2026-08-12: Implemented the Distortion voice that later became the current-only
  circuit inside the existing
  fixed-latency shared 2x island. Its post-prepare regression measures a V4
  high-Drive harmonic-energy ratio of `0.133445` versus `0.0298694` for
  Precision Drive, a V4 upper-mid/low ratio of `2.58438` versus `1.07933` for
  its predecessor, exact normalized +/-6 dB Level errors below `3e-7`, zero
  right-channel leakage, zero fixed/uneven partition error, and unchanged
  three-sample island latency. Historical binary and portable state round-trip
  work was superseded by current-only V7/V4 canonicalization. The zero-warning Debug build and
  full NAM headless suite passed at
  `tmp_nam_rack_runs/20260812_020433_distortion-v4-portable-final/nam_rack_regression_result.json`.
  Objective status is `pass`; perceived distortion quality is `not_asserted`
  until musician audition.
- 2026-08-12: Implemented true-stereo wrapper routing for standard 1x1 NAM
  captures with separately constructed L/R DSP, resampler, FIFO, calibration,
  dry-delay, fault, and history state. Added explicit Auto/Single, Mono Input 1/
  Single, and Stereo/Dual modes, bounded live handoff, atomic pair publication,
  best-effort primary-only fallback, truthful capability UI, anti-phase/L-R/
  partition/state/failure tests, and post-cab Cabinet Space. The final Release
  NAM suite passed at
  `tmp_nam_rack_runs/20260812_032515_stereo-v4-multirate-release/nam_rack_regression_result.json`;
  perceived stereo externalisation remains `not_asserted`.
- 2026-08-12: Replaced V4's provisional full-rate Octaver with the bounded 6:1
  multirate/80-band ERB-PS2 implementation. The 44.1/48/96 kHz self-test passed
  exact bypass/silence/reset/partition/L-R and finite-recovery gates, target
  octave dominance, and at least 70 dB stop-band rejection. The isolated
  48 kHz/8-sample both-voice Release path measured p50 `2.9 us`, p99 `8.0 us`,
  and zero misses; subjective chord/transient quality remains `not_asserted`.
- 2026-08-12: Final Release clean-guitar and CC0 DI suites passed at
  `tmp_clean_guitar_runs/20260812_035157_stereo-v4-final-audit-fixes-release/clean_guitar_regression_result.json`
  and
  `tmp_nam_rack_runs/20260812_035158_stereo-v4-final-audit-fixes-release/nam_rack_di_regression_result.json`.
  The complete 8-sample full-rack diagnostic is recorded above; no real-device
  ASIO guarantee or musician quality claim is inferred from headless timing.
- 2026-08-12: Made dual-NAM callback failure atomic with preallocated lane and
  delayed-dry staging. A deterministic fake right-lane DSP now raises its fault
  from inside `process()` and emits non-finite output; the contract requires the
  callback to match a pair-wide delayed-dry reference with no asymmetric wet
  lane and no non-finite sample.
- 2026-08-12: Final audit fixes added explicit mono-input/stereo-output hosting,
  seeded output-only host channels from the valid mono source, and verified that
  a mono guitar can generate Cabinet Space side without reading poisoned host
  storage. Added a transactional preserve-settings `Upgrade DSP to V5` action
  for restored V1-V4 rigs, including authoritative readback and verified
  rollback. The final Debug and Release NAM suites passed at
  `tmp_nam_rack_runs/20260812_034712_stereo-v4-final-audit-fixes/nam_rack_regression_result.json`
  and
  `tmp_nam_rack_runs/20260812_035030_stereo-v4-final-audit-fixes-release-repeat/nam_rack_regression_result.json`.
  Frontend TypeScript, production build, and 451 tests passed. Subjective tone,
  perceived externalisation, and real-driver 8-sample stability remain
  `not_asserted`.
- 2026-08-12: NAM effects DSP V5 replaced the rejected drive-like Distortion
  voice with the clean-room modern-heavy multi-cell network and corrected
  Precision's perceived-bypass engage law. Heavy/Extreme/Crunch ordering,
  pre-clip Weight behavior, exact Level, stereo isolation, silence, partition,
  three-sample latency, real-A1 OFF->ON at 8/128 samples and input modes 0/1/2,
  reversal continuity, and stale-free cross-pedal recall all pass. The hot
  Drive sweep and the CC0 V4/V5/Precision audition renders recorded zero rack
  guard hits. Debug and Release NAM, clean-guitar, and DI gates pass at
  `tmp_nam_rack_runs/20260812_182449_distortion-v5-debug-fix2/nam_rack_regression_result.json`,
  `tmp_nam_rack_runs/20260812_182815_distortion-v5-release-final/nam_rack_regression_result.json`,
  `tmp_nam_rack_runs/20260812_183024_distortion-v5-release-repeat/nam_rack_regression_result.json`,
  `tmp_clean_guitar_runs/20260812_182956_distortion-v5-release-final/clean_guitar_regression_result.json`,
  and
  `tmp_nam_rack_runs/20260812_183002_distortion-v5-release-final/nam_rack_di_regression_result.json`.
  Frontend TypeScript and all `455/455` tests pass. Heavy-Menace similarity and
  musical quality remain `not_asserted` until the musician auditions the exact
  V5 WAVs; the 2x/4x alias comparison remains `diagnostic_only`.
- 2026-08-12: Replaced the interim compatibility policy with the pre-release
  current-only contract. Native Precision and Distortion no longer select DSP
  from serialized versions; every production restore normalizes the complete
  NAM Rack to effects schema V7/Reverb V4, consumes retired pedal mode/state and
  automation keys, preserves explicit controls and model/IR resources, and
  atomically rewrites persistent user presets. Precision now uses the current
  feedback-split asymmetric circuit with exact `+9 dB` default Volume;
  Distortion uses the current modern-heavy multi-cell circuit. Debug and Release
  builds passed with the packaged frontend. The final Release objective suite is
  green at
  `tmp_nam_rack_runs/20260812_205727_current-only-drive-release-source-final/nam_rack_regression_result.json`;
  clean-guitar is green at
  `tmp_clean_guitar_runs/20260812_205121_current-only-drive-debug-final/clean_guitar_regression_result.json`;
  and the exact-provenance `Best clean!` current-only DI suite is green at
  `tmp_nam_rack_runs/20260812_205636_current-only-drive-di-exact-provenance-final/nam_rack_di_regression_result.json`.
  Frontend TypeScript, production build, and all `458/458` tests pass. The three
  loudness-matched audition WAVs in that DI directory are the sole accepted
  native-drive comparison set. Pedal tone, Heavy-Menace similarity, spatial
  naturalness, and real-driver 8-sample stability remain `not_asserted` until
  musician/device testing.
- 2026-08-12: Diagnosed the approved Distortion tone's idle artifact as
  deterministic amplification of nonzero pickup/interface noise, not a
  self-oscillator: the Heavy default has about `+75 dB` compound near-zero
  slope, and a seeded `-99.5 dBFS` noise floor reproduced about `-24.5 dBFS`
  broadband fizz while exact digital silence remained exactly zero. Added the
  stereo-linked `Dist Gate`, keyed before Precision Drive and applied after the
  complete Distortion circuit/Mix/Level so the open tone remains sample-exact.
  The `0.22` current default provides 6 dB hysteresis, 35 ms hold, fast reopen,
  and smooth closure without resetting the nonlinear state. Debug and Release
  objective suites pass at
  `tmp_nam_rack_runs/20260812_215230_distortion-idle-gate-debug-final/nam_rack_regression_result.json`
  and
  `tmp_nam_rack_runs/20260812_215717_distortion-idle-gate-release-final/nam_rack_regression_result.json`;
  the exact Best-clean current-circuit DI suite passes at
  `tmp_nam_rack_runs/20260812_215441_distortion-idle-gate-di-debug/nam_rack_di_regression_result.json`.
  The deterministic gate probe reports zero continuously-open PCM error, zero
  gate-added partition error, no idle reopen windows, a 1 ms reopen, unchanged
  three-sample latency, and no non-finite or safety-guard events. Perceived
  sustain, artifact removal on the user's interface, and gate feel remain
  `not_asserted` pending the musician's live audition.
- 2026-08-12: Extended the pre-release current-only contract across Compressor,
  Tape Echo, Stereo Poly Octaver, Pedal NAM routing, Chorus/Modulator, Delay,
  and embedded Rack Reverb as well as both native drives. Production Rack audio
  no longer reads a saved DSP selector: Compressor output, Tape smoothing/send,
  Poly Octaver, Chorus mix, Pedal NAM routing, and embedded Reverb are fixed to
  their approved implementations; Delay never had a versioned audio branch.
  The retired Octaver source was removed. Complete project/preset/snapshot
  migration now fills all current component defaults while preserving explicit
  controls and NAM/IR resources, removes retired controls, writes V7/Reverb V4,
  and atomically rewrites both native and XML-wrapped user presets. Standalone
  built-in processors retain their independent project-compatibility contracts
  and cannot select Rack DSP. The zero-warning Debug build, TypeScript, and the
  focused migration/preset suites (`55/55`) pass; subjective audio remains
  governed by the existing musician-audition gates.
