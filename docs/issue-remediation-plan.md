# Recording, timeline, and editing remediation plan

Started 28 October 2026 against `e8f9a65a`. Scope: the supplied issue list and the source/browser findings recorded in `output/issue-review-2026-10-28.md`. Preserve the original user project; use isolated fixtures or copies for validation.

## Staff review and workflow follow-up — 4 November 2026

**Status: implemented and qualified to the limits below on 4 November 2026.**
The four correctness findings and mixer/MIDI/gesture follow-ups now have production
changes and permanent regressions. See [the implementation report](workflow-review-qualification.md)
for exact test results and remaining work. Review evidence and the original three
failing reproductions are in `output/staff-review-nov04/`. The fresh supplied-project
recording still fails strict eight-sample timing; this is not an all-issues-closed
claim. The following checklist records the agreed implementation and acceptance scope.

### 1. Preserve MIDI identity when joining

- First reproduce the reported missing menu item using actual Ctrl+clicks on
  separate MIDI clips, followed by right-click on a selected clip. Verify the
  loaded frontend and active mouse/keyboard profiles, selection before/after
  right-click, and whether the MIDI or background menu opens. Include clip-body
  and edge hit targets. The current source includes Join for every MIDI menu,
  disabling it for invalid selections; the reason it was absent in the user's
  session is not yet established. Do not substitute store-seeded selection or
  source-string assertions for this interaction regression.
- Promote the two failing overlap/mute reproductions into permanent regression
  tests before changing the join. Preserve note-on/off pairing, channel, release
  velocity, expression and mute identity when independent clips become one clip.
- Carry any new optional pair identity through copy, split, trim, loop expansion,
  stretch, project validation and save/load. Old clips without identity must keep
  their current interpretation. Verify migration/round-trip behavior before any
  schema change; do not add a schema bump merely for an optional field.
- Retain the command's same-track/unlocked requirements, materialize the visible
  source windows, preserve gaps, and keep the operation one Undo step. If a case
  cannot be preserved, reject it before mutation with a specific explanation.
- Keep **Join Selected MIDI Clips** in the clip menu and Command Palette. Show
  the selected count and a useful disabled reason for mixed media, different
  tracks, locked items or frozen tracks. Display the actual profile binding.

Acceptance: nested same-key notes with both audible and mixed mute states,
different channels, source offsets, loops, gaps, CC/expression, note releases,
Undo/Redo, save/reopen and native event scheduling preserve the intended content.

### 2. Make selected MIDI export discoverable and consistent

- Extract a typed shared export action used by the menu and existing
  **Export Selected MIDI Clips...** palette command. Avoid duplicating the
  serializer and tempo-map calculations in Timeline.
- On right-clicking an already selected clip, retain the selection. For multiple
  selected MIDI clips show **Export Selected MIDI Clips (N)...** prominently;
  keep an explicitly named **Export This MIDI Clip...** alternative. Right-click
  on an unselected clip should follow the existing selection rules.
- Produce one `.mid` file without requiring a join or altering the arrangement.
  Preserve each source track as a MIDI track within that file, preserve gaps and
  relative positions, and start the earliest selected clip at file time zero.
  Preserve channels, visible trims/loops, tempo-map/time-signature metadata and
  the existing rule that MIDI processing is applied once. State mute semantics
  clearly. Snapshot the export selection and timing together before the dialog.
- Distinguish clip selection from time selection; selected-clip export exports
  the selected clips' visible contents, without silently cropping to a blue range.

Acceptance: actual context-menu multi-selection exports every selected clip and
no unselected clip; single-file/multiple-track readback, controller ordering,
tempo changes, mixed selections, mute cases, dialog cancellation and project
changes are covered. Verify the supplied project's selected MIDI and independent
SMF parsing; report receiving-DAW normalization separately.

### 3. Repair mixer resize ownership and simplify its appearance

- Use a subtle resize affordance within the existing single header row, with a
  generous hit target and no extra row or broad persistent colored strip. Keep
  title, pop-out and close targets distinct. Use Tailwind and theme tokens.
- A pointer resize must not permanently activate the mixer context or focus the
  separator. Capture the prior editing context before parent capture handlers
  can replace it; prevent those handlers from claiming the resize interaction.
- Use temporary ownership only for the active drag/Escape cancellation. Release
  pointer capture and temporary shortcut ownership on drop, Escape, cancellation,
  capture loss, window blur and unmount. Restore the previous live editing owner
  after pointer completion without stealing focus from a subsequently chosen
  control. Remove actual focus/context ownership, not just its highlight.
- Preserve intentional keyboard access through Tab, arrows, Home/End and a
  visible focus indicator. Pointer completion and keyboard navigation should have
  distinct, documented focus behavior. Persist only committed sizes.

Acceptance: after a pointer drop the handle is not the active element/shortcut
owner; arrows no longer resize it, and Timeline or Piano Roll shortcuts return
to the previous editor. Cover both editors, repeated drags, Escape, loss of
capture, closing/detaching, small windows, keyboard resizing and size persistence.

### 4. Fix silence semantics and asynchronous job correctness

- Define one fader-floor/silence conversion shared across track/master static
  gain, automation and offline rendering. Keep persisted data finite and make
  the existing `-inf` representation agree with actual zero gain. Test existing
  project values and levels immediately above the floor before changing behavior.
- Revalidate the project rate immediately before publishing an imported rate
  copy. Reuse a typed validity predicate across polling and final publication;
  choose an explicit original-file fallback or a bounded retry when the rate
  changed. Promote the failing completion-before-poll test into the normal suite.
- Move the source-replacement transaction into checked TypeScript with typed
  options/results; preserve the serialized queue, source compare-and-swap,
  project epoch, mute handling, stale-result reconciliation and Undo guarantees.
- Give tempo analysis native request IDs and cooperative cancellation. Cancel
  on Stop Analysis, modal close, target/project replacement and shutdown; skip
  obsolete queued work. Bound the analysis queue and keep interactive waveform
  requests from waiting behind obsolete analyses. Measure service latency rather
  than claiming an unmeasured hardware-performance improvement.
- Name audio-copy jobs by clip/track and make all jobs accessible for cancellation
  instead of exposing only three indistinguishable rate labels.

Acceptance: nonzero PCM produces exact silence at the silence setting in both
realtime-size and offline paths; adjacent numeric levels retain expected gains.
Test rate changes, cancellation, clip removal, project replacement, rapid
Undo/Redo and native failures. Repeated Analyze/Cancel must retire work and leave
waveform requests responsive; verify shutdown/lifetime safety.

### 5. Explain timeline gestures and finish targeted quality work

- Preserve existing mouse-profile/custom mappings. In the OpenStudio Windows
  defaults, Ctrl+drag on empty timeline space creates an editing time selection;
  Ctrl+drag on a clip body copies it; Ctrl+click toggles clip selection; plain
  background drag selects clips with a rectangle. Ctrl+Shift+drag slips content.
- Add concise feedback while gesturing, such as **Time selection** with range
  and duration, **Copy clips**, or **Slip contents**, derived from the resolved
  action. Make the blue time-selection range visually distinguishable from
  selected clip outlines and expose its clear/select-clips/loop actions.
- Clarify persistent MIDI **Slip +N s** labels as source offsets; they are not
  evidence of an active drag. Use clearer wording/tooltips where space permits.
- Move ordinary tooltip/static viewport presentation to Tailwind and use existing
  theme tokens. Retain component CSS for runtime geometry and artwork. Check
  responsive placement, focus, hit targets and tooltip clipping in a real browser.
- Measure the existing bundle warnings before changing module boundaries. Extract
  new regression scaffolding into focused translation units first; evaluate a
  separate qualification target sharing production code as a distinct build
  change. Provide a separate unoptimized diagnostic configuration if introduced,
  while keeping the measured realtime/default Debug optimization behavior.
- Update the app manual, shortcut/mouse reference and relevant website guides
  after behavior is implemented and verified. Mark development-only behavior
  accurately; do not publish or release as part of this plan.

### 6. Qualify the completed changes

- Run permanent regression tests for each change, then the full frontend suite,
  frontend/e2e type checks, dependency notices, frontend build, native offline
  regression suite and CMake Debug build. Check Release runtime readiness when
  native/window/build changes affect that path; compilation alone is insufficient.
- Browser tests must exercise real selection, menus, keyboard routing, pointer
  completion and DOM focus/context state, not only CSS or mocked success flags.
  Include actual-project layout and selected-MIDI export workflows.
- Use an isolated copy of `songi hobe naki.osproj`. Verify original-file hash,
  save/reopen, audio renders and selected MIDI round trips. Re-run recording and
  plain/Control/Shift/Alt scrolling and zooming with Audient ASIO at **8 samples**;
  record actual device settings. A larger buffer is not an acceptance substitute.
- First run tests that need no continuous signal. Non-silent continuity/listening
  checks require an actual signal; coordinate only that remaining physical step.
  Keep callback tracing disabled for acceptance and use a separate trace run if
  diagnosis is needed. Compare controlled repeated runs and distinguish engine
  deadlines, host/driver xruns, file invariants and physical UI latency.
- Report pass/fail/diagnostic_only/not_asserted per gate. Retain unresolved timing
  failures even if the recording file and UI checks pass. Before a manual-testing
  handoff, refresh Debug/webui assets and stop only task-owned servers/browsers;
  `python build.py dev --run` must need no pre-running server.

## Music-input follow-up — 4 November 2026

The user supplied streaming music to Analogue 1. The 191.446833-second eight-sample take passes all 27 recording/file checks, while strict host/engine timing remains fail. The user confirmed the quiet passage in the source; reference-free signal checks remain diagnostic rather than listening or electrical acceptance.

The sustained-wheel test exposed live waveform polling being suspended throughout gestures. Implement bounded progress during gestures, retain source-correct in-flight data across viewport changes, preserve Stop/new-take rejection and rotate armed tracks for fairness. The focused scheduler checks, 3,115-test frontend suite and 21 distinct browser cases pass; Debug and Release assets have been rebuilt. A separate native eight-sample follow-up verifies live peak requests during all four wheel modes and saving/reopening the existing music take. Detailed results and remaining timing/continuity limits are in the [coverage matrix](issue-coverage-matrix.md#4-november-music-input-recording-and-live-preview-follow-up).

## Four-step completion pass — 2 November 2026

The user authorized all four follow-up steps and deferred continuous physical input. This work keeps the original song unchanged and uses actual Audient ASIO 48 kHz / 8 samples; a larger buffer is not an acceptance substitute.

1. **Attribute audio tails and remove a measured callback cost.** The new synchronized Windows trace has zero lost events. Of 132 observed recording deadline misses, 79 overlap more than 10 µs of DPC/ISR work, two overlap more than 10 µs off CPU, and 52 retain residual wall time above budget (overlapping sets; residual includes instrumentation/unobserved work). Symbolized samples identify repeated track-ID hashing. Track continuity keys are now prepared with the realtime snapshot, with eight-frame PCM/seek parity coverage. Strict zero-miss acceptance is still required separately; neither this trace nor a pass on file invariants establishes audible continuity.
2. **Repair the traced first-scroll stall and publication races.** Native scroll events share the pending frame update with horizontal wheel navigation instead of publishing stale horizontal positions synchronously. Project loading yields during long track batches. MIDI note pairing now indexes release events instead of scanning the entire event list for each onset, preserving source-order consumption, channel compatibility and equal-time ordering. The cold native recording/scroll trace falls from a 55.865 ms longest script task to 14.586 ms, with no task above 16 ms in that post-change capture. This is a diagnostic comparison, not physical-input-to-presentation acceptance.
3. **Qualify Debug and Release, longer recording and reopening.** Both configurations completed the same initial 415-wheel sequence at eight samples. Release then saved a 30-minute 59.384-second take with 89,250,448 exact mono frames and passed all 27 file/session checks. Its 2,658 host overruns / 2,565 engine deadline misses still fail strict timing. The song ends around 410 seconds, so the rest is a lighter playback workload. Memory/file growth and minimization/recovery were observed; these are not a leak-free or audio-continuity certification. This long run exposed crowded minimum-zoom ruler labels. Shared density-aware ruler/grid spacing now fixes that display without changing snap intervals, with denominator-aware musical alignment and browser geometry coverage. A separate final Release run reopens the long take and records again with this view change; the long run predates only this final ruler/grid change. Known-signal continuity and electrical timing remain deferred.
4. **Complete the actual REAPER import/export round trip.** REAPER 7.19 imported both MIDI tracks and the tempo map, then exported type-1 SMF at 9,600 PPQ. Notes, exact note times, track separation, tempo/meter and final controller values at each tick pass. Lossless interchange fails: REAPER removes 27 intermediate controller events and reorders simultaneous controller/note events, changing controller state at 284 note starts. Keep original event order in OpenStudio; do not silently move notes/controllers to disguise the external normalization.

Software qualification: 3,114 frontend tests across 265 files, 20 focused browser cases, 416 native checks and 74 actual-project checks pass. The browser count combines 18 cases from the main batch and the two actual-project cases rerun with the required project path; the original batch's skips are not counted as passes. All five full-song renders and the SMF match the previous deterministic outputs; normalized project/backend MIDI payloads remain exactly equal after the indexing change. Frontend, warning-free Debug/Release and local website builds completed. Final hardware outcomes are recorded in the [coverage matrix](issue-coverage-matrix.md), with pass/fail/diagnostic-only boundaries retained.

All four investigation/implementation/test steps have been carried out. **Overall acceptance remains open:** zero-miss eight-sample timing and complete native input-to-presentation responsiveness are not established, and the external REAPER round trip changes same-time controller ordering. These are not blocked by the deferred physical input. The next audio change needs a controlled post-fix capture isolating the remaining application execution tails from interrupt/scheduling interference; do not change the buffer size, add hidden monitoring delay, or suppress counters to obtain a pass. Known-signal/listening/electrical tests, unavailable TD-17 performance and a physical Explorer drop are separate outstanding qualification items.

## Eight-sample follow-up — 2 November 2026

User authorized completing the remaining work without waiting for continuous input.
Keep Audient ASIO at 48 kHz / 8 samples and preserve the original project.

1. Capture the current native recording/wheel baseline, with timing instrumentation explicitly labelled diagnostic.
2. Remove repeated source-map resolution for unchanged clips/preview segments and filesystem queries from corrected-source playback. Protect resource lifetime across replacement, eviction, clear/reload and cached-key restoration; verify exact PCM and steady lookup reuse.
3. Build Debug, run native regressions and the actual-project render/export checks. Compare full-song exports against the accepted numerical reference.
4. Repeat native recording with tracing disabled, plain/Ctrl/Shift/Alt wheel input, post-zoom menu/trim interaction, and visible waveform/MIDI checks. Retain timing failures instead of inferring audible dropout or changing the buffer requirement.
5. Complete available MIDI interchange and physical interaction checks. Electrical alignment, physical MIDI performance with the unavailable TD-17, and known-signal continuity remain explicitly separate.

QA inventory: source replacement/preview/reload PCM; 8-sample route throughout recording; saved take duration and original-clip preservation; writer/read/device error counters; wheel routing/anchors and visible waveform/MIDI geometry; menu response after zoom; recording start/stop/restart; source-export parity and external MIDI round trip. Explore rapid direction/modifier changes and stop/restart after a deep zoom. No full-session smoothness or listening claim follows from isolated browser timings.

**Outcome:** steps 1–3 completed. Step 4 uncovered and fixed an additional menu-focus/zoom-routing defect, now covered by unit, browser and native checks; recording stop/restart and source-backed geometry pass. Strict eight-frame deadlines and complete presentation acceptance still fail/remain unverified. Step 5 establishes native REAPER import note/controller-state parity, not a full current-export round trip. See the [dated coverage results](issue-coverage-matrix.md#2-november-follow-up-input-independent-work). Do not broaden unrelated DSP changes or relax buffer/telemetry gates to turn these findings into a pass. The next performance change needs attribution of the remaining long callbacks and plain-scroll stalls; a known input separately qualifies continuity.

## Research-backed follow-up — 31 October 2026

**Status: editing/source fixes and bounded waveform delivery implemented; native eight-sample acceptance remains in progress.** The [coverage matrix](issue-coverage-matrix.md) tracks all 23 original issue paragraphs. Earlier results below retain their recorded-build scope.

### Implementation evidence — 31 October 2026

- The three permanent reproduction cases now pass. Crossfades use persistent group identity and actual owners; reapply replaces the affected closure, split reconciles membership, copies fork their groups, and the editor exposes removal from a single member. Linked unselected partners are listed before applying. Removal covers the listed connected groups together. Manual gains and fades are preserved.
- Muted conversion commits the source document without audible publication. Active replacement rechecks current project/source/mute state inside and after the serialized transaction; stale native completion reconciles to current intent. Undo/Redo changes document intent synchronously and queues publication. Read-only tempo analysis and preview accept a validated source descriptor, including a muted clip absent from native playback.
- Completed waveform requests prioritize visible rows, limit bridge concurrency to four and pending work to 128, discard obsolete queued views/generations, and batch cache publication per animation frame. A browser regression exposed and fixed old-generation requests blocking their replacements. Recording preview cadence is unchanged.
- Preview-segment boundary scratch is reserved when publishing segments, never in the callback. The eight-frame regression exercises 40 distinct segments (more than the old 64-boundary reserve), checks their count, PCM parity and unchanged callback reserve counters.
- Optional callback traces retain every measured miss plus regular samples, raw QPC boundaries and honest engine/caller timing scope. The analyzer reports regular samples separately to avoid bias from retaining all misses. This is diagnostic instrumentation, not a claim that scheduling overruns have been eliminated.
- **pass:** [3,106 frontend tests](../output/shared-project-qualification/implementation-full-frontend-final.json), [405 native checks](../output/shared-project-qualification/implementation-native-current/render_export_regression_result.json), [16 recording/shared-project browser cases](../output/shared-project-qualification/implementation-project-browser-final.log), [32 additional browser workflows including eight WebKit cases](../output/shared-project-qualification/implementation-workflow-final.log), six trace-analyzer tests, current frontend build and warning-free CMake Debug build. The native tempo-preview browser case uses the actual generated WAV payload and now runs rather than skipping.
- **pass:** [supplied-project native qualification](../output/shared-project-qualification/implementation-project/project_qualification_result.json), including five full renders. The original project is preserved. The separate instant-mock load diagnostic still reports a React nesting warning; the macrotask/native-like mock and source-geometry run do not. This warning is not silently counted as a clean-console pass.
- **diagnostic_only:** the [native 156.879-second recording/400-wheel session](../output/shared-project-qualification/implementation-native-loaded/interaction/analysis.json) ran at 48 kHz / eight frames with optional tracing enabled. All four wheel modes had 100 browser-trusted events. Compositor evidence is retained, but browser injection added substantial pre-dispatch delay; a separate Windows wheel sample had 2.8 ms event-to-listener delay. These observations do not establish three-run presentation acceptance. CPU accounting includes WebView child processes.
- **pass, subsequent recording invariants:** the user supplied Analogue 1 signal. A trace-disabled 178.621167-second mono take at 48 kHz / eight frames passes all 27 file/session checks, including exact frame count and zero reported writer overflow. Strict host timing still fails; audio-source reference comparison, electrical placement and user listening remain **not_asserted**. See [the latest recording and scheduling evidence](issue-coverage-matrix.md#analogue-1-and-synchronized-windows-trace).
- **follow-up from synchronized ETW:** the approved current-build Windows trace has no lost events and exposes Debug CRT heap-lock acquisition while destroying non-owning audio views. `HeapBlock` now skips destruction/release calls only when its data pointer is null, with exact-context dependency verification. The installed SDK implementation and matching trace stacks support this targeted change. Three patch tests pass; post-change native and hardware qualification remains pending. Microsoft documents the null-pointer no-op contract for [`_free_dbg`](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/free-dbg).

### Evidence and scope

The [review probes](../output/shared-project-qualification/review-20261031-probes.json) reproduce three defects, with an unmuted-conversion control passing. The [existing targeted suite](../output/shared-project-qualification/review-20261031-existing-tests.json) passes 180/180. Thus the missing cases need permanent regressions, not another unchanged run of the passing suite.

| Work item | Established problem | Relevant implementation |
|---|---|---|
| Crossfade reapplication | Applying A+B, then A+B+C retains both groups. With A=[0,6], B=[2,8], C=[4,10], the linear gain sum at t=5 is 0.8125 instead of 1. | `timelineEnhancements.ts` filters only the selection-derived group ID; `clipCrossfades.ts` multiplies retained layers. |
| Crossfade lifecycle | Splitting generates new clip IDs but retains the old group metadata. Reconstructing a group ID from the new selection makes removal fail. | `clipEditing.ts`, `clipCrossfades.ts`, `CrossfadeEditor.tsx`. Copy/duplicate/delete variants require investigation; they are not additional reproduced defects yet. |
| Muted source conversion | A muted clip is absent from the native playback publication; source replacement expects an existing native clip and rejects the completed conversion. | `audioConversion.ts`, `clips.ts`, `PlaybackEngine.cpp`. Source inspection also shows tempo/preview lookup depending on native playback membership; verify that related case. |
| Eight-sample recording | The final trace-disabled 48 kHz / 8-frame run records +1,001 independent host deadline misses over 176.191 observed seconds, despite passing file/session invariants. | `AudioEngine.cpp`, `PlaybackEngine.cpp`, `TrackProcessor.cpp`, `AudioRecorder.cpp`, `RealtimeCallbackTrace.h`, JUCE/ASIO callback boundary. |
| Native responsiveness | The user experienced delayed scrolling. Four native plain-wheel observations per run and host-process-only CPU measurements cannot qualify all modifier gestures or WebView presentation. | `Timeline.tsx`, waveform delivery/cache, store subscriptions, native bridge and WebView child processes. |

The three editing defects are controlled reproductions, not claims that the untouched supplied song already contains those edit states. Preserve `C:\Users\srvds\Music\mick records\songi hobe naki.osproj`; use separate project/media output directories. Its recorded SHA256 is `C4C8140DF666A15D52A56D065D1B6390B0136BAE9DFDCE35822323018D68EE81`.

### Research and design decisions

These are OpenStudio design recommendations inferred from primary documentation and the local evidence, not claims about other DAWs' internal data structures.

- **Keep crossfades editable independently of manual volume.** Live documents clip fades separately from automation; Cubase permits removal through a selected participating event. Retain OpenStudio's separate gain layers, expose existing groups from any member, and keep Shift+X. Stable group identity is our implementation choice. [Ableton Live 12 Arrangement](https://www.ableton.com/en/manual/arrangement-view/), [Cubase 15 removal](https://www.steinberg.help/r/cubase-artist/15.0/en/cubase_nuendo/topics/fades_crossfades_and_envelopes/fades_crossfades_removing_t.html).
- **Resolve overlapping transitions together.** Ardour explicitly handles arbitrary layered overlaps. Its fade guidance distinguishes correlated material from uncorrelated material. Reuse OpenStudio's ownership/handoff planner; replace affected prior groups atomically instead of multiplying an obsolete plan by a new one. Preserve existing curve defaults. Equal gain and equal power have different mathematical contracts and neither guarantees constant perceived loudness for arbitrary phase relationships. [Ardour fades and crossfades](https://manual.ardour.org/editing-and-arranging/create-region-fades-and-crossfades/).
- **Separate source edits from playback activation.** Region/source editing is non-destructive in Ardour. For OpenStudio, the project document should identify a muted clip's source; active playback membership should determine whether it sounds. Keep the existing background converter and immutable source files. Different-rate output is not expected to be bit-identical to the original. [Ardour regions](https://manual.ardour.org/working-with-regions/), [Ableton audio fact sheet](https://www.ableton.com/en/manual/audio-fact-sheet/).
- **Optimize callback tails with measured attribution.** At 48 kHz, 8 frames allow 166.667 microseconds per callback, about 6,000 callbacks/second. Callback guidance excludes allocation, I/O and potentially blocking operations; Windows scheduling analysis distinguishes execution, ready time and DPC/ISR interference. The captured audio thread already had MMCSS priority 25, so registration is not a missing fix. [PortAudio callback guidance](https://files.portaudio.com/docs/v19-doxydocs/writing_a_callback.html), [Microsoft CPU analysis](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/cpu-analysis), [MMCSS](https://learn.microsoft.com/en-us/windows/win32/procthread/multimedia-class-scheduler-service).
- **Measure what the user sees.** WebView2 has separate browser/renderer/GPU processes. Browser frame traces distinguish fully presented, partial and dropped frames; rAF completion is insufficient. INP excludes scrolling and zooming, so wheel latency requires explicit event-to-presentation measurement. [WebView2 performance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance), [Chrome frame analysis](https://developer.chrome.com/docs/devtools/performance/reference), [INP scope](https://web.dev/articles/inp).
- **Separate recording placement from monitoring latency.** A correct waveform coordinate does not prove physical input/output alignment. Driver-error compensation adjusts recorded placement, not live monitoring delay. Measure both with a known signal and the actual route before changing compensation. [Ableton latency explanation](https://help.ableton.com/hc/en-us/articles/360010545559-How-Latency-Works), [recording alignment](https://help.ableton.com/hc/en-us/articles/19450890686876-Recordings-are-out-of-sync).

### Ordered implementation plan

#### 0. Establish permanent failures and a reproducible baseline

- Move the retained probe cases into `frontend/src/__tests__/clipCrossfades.test.ts` and `audioConversion.test.ts`. Keep the native-membership-aware mock and unmuted control. Record the failing behavior before edits.
- Freeze the project copy, media references, executable/dist/PDB hashes, device route, 48 kHz / 8 samples, viewport/DPI, plugin state and gesture sequence. Save pre-change callback and native UI distributions with the same workload used after changes.
- Keep trace-on diagnosis separate from trace-off acceptance. Verify that selected input actually contains a nonzero test signal before undertaking long recording qualification. The earlier all-zero take cannot qualify signal continuity.

#### 1. Repair crossfade identity and group lifecycle together

**Files:** `frontend/src/utils/clipCrossfades.ts`, `store/actions/timelineEnhancements.ts`, `store/actions/clipEditing.ts`, relevant duplicate/paste actions, `components/CrossfadeEditor.tsx`, `utils/projectValidation.ts`.

- Use a persistent opaque group ID in the existing `CrossfadeLayer.id` field. Selection is an operation input, not identity. Resolve actual group owners from the clips carrying that ID, including legacy IDs, and maintain member references centrally.
- On reapply, compute the closure of affected existing groups. Replace their generated layers in one command and rebuild the intended handoff across the affected clips. Preserve unrelated groups and all manual fades/gain envelopes. Never recover manual gain by dividing by the previous generated curve: zero-gain sections make that unsafe.
- If the operation includes unselected partners, show the affected clips in the existing editor before applying. A fully selected, unambiguous group keeps the direct shortcut workflow. Removal is available from any member, including a surviving split fragment or orphan; the editor identifies which group will be removed when several are present.
- Split preserves the evaluated gain exactly, using existing window/offset behavior, while atomically replacing membership references throughout the group. Copying a complete group creates a new identity and remapped members. A partial copy keeps its evaluated fade but has independent, discoverable/removable provenance; it must not edit the original group. Cover track duplication and clipboard import too.
- Trim, move and deletion preserve existing audible curve semantics by default; update references and keep residual layers removable. Reapplying explicitly recomputes handoffs. Do not silently renormalize old projects on load.
- Capture the whole affected set in one Undo/Redo transaction. Read legacy groups without changing their coefficients. Prefer the existing persistence shape; any required shape change needs old-project, portable state and Compare round trips before a schema bump.

**Exit checks:** both crossfade probes pass; linear handoff gain sum is 1 within the existing envelope approximation tolerance (1e-4); paired equal-power curves meet their squared-gain contract. Repeating unchanged settings adds neither attenuation nor an Undo entry. Split preserves rendered output; removal leaves only original manual gain/fades. Test expanded/reduced/partial selections, contained/coincident/nested/chained overlaps, trim/untrim, move, split on a boundary, copy/paste, duplicate, delete, locked members, save/reopen, Undo/Redo, and native playback/export envelope parity. Curve contracts do not assert subjective loudness.

#### 2. Make source replacement independent of mute state

**Files:** `frontend/src/store/actions/audioConversion.ts`, `clips.ts`, `services/NativeBridge.ts`, `Source/PlaybackEngine.cpp`, `AudioEngine.cpp`, `ClipPreviewData.cpp`.

- Keep one serialized source-publication transaction with explicit outcomes for an active native clip, an intentionally absent muted clip, cancellation, stale source/project and genuine failure. Do not turn every failed native replacement into success or briefly unmute the clip.
- Resolve current mute/publication state inside the existing queue. Validate project epoch, clip existence and expected source revision immediately before committing; recheck after asynchronous native work. If mute/unmute or another edit races the operation, reconcile the native publication to the latest desired document state before completing. Avoid recursively awaiting another task on the same queue.
- For a muted clip, update the document's source without publishing audible playback. Later unmute publishes the converted source. For an active clip, retain prepared-reader replacement and expected-source checks. Conversion failure leaves the original source and a clear retryable error.
- Make source Undo/Redo replay through the same serialized desired-state path. Preserve timing, mute, pitch provenance, fades and unrelated concurrent changes. Define rollback/history behavior for replay failure so the Undo label never claims a source change that did not occur.
- Give read-only analysis/preview an immutable, validated source descriptor derived from the project, with project/source generation guards. Verify muted tempo analysis and explicit preview through it. A user-requested audition is separate from unmuting the timeline. Prefer this narrow change over keeping all muted clips/readers active in the engine.

**Exit checks:** muted and unmuted conversion both pass; no transient audible publication for mute; source hash preserved; converted rate/channel/duration correct; unmute plays the new file. Cover mute/unmute during conversion, rapid Undo/Redo, cancel, delete, replacement, project load, stale completions, cache reuse, missing file, import-policy conversion and two clips sharing one source. Add a native integration test: the mock alone cannot qualify this boundary. Check conversion quality against documented signal fixtures and audition separately.

#### 3. Attribute and reduce the remaining eight-sample deadline misses

**Files:** `Source/AudioEngine.cpp`, `RealtimeCallbackTrace.h`, `PlaybackEngine.cpp`, `TrackProcessor.cpp`, `AudioRecorder.cpp`, prepared state declarations and existing native regression harnesses. Inspect the pinned JUCE ASIO/device-manager path before considering a dependency patch.

- Correlate callback sequence, QPC interval, thread/process identity and phase with ETW context switches, ready time, DPC/ISR and matching symbols. Include work before/after the current engine timer and distinguish host callback work from the complete ASIO entry/exit interval. Raw thread-cycle counts are not milliseconds.
- Capture deadline-missing callbacks explicitly; sampling only every sixteenth stage can miss the events being explained. Use a bounded preallocated trace buffer, visible dropped-event counts and deferred draining. Measure instrumentation cost and rerun acceptance with tracing off.
- Audit remaining callback allocation, locking and fixed cost. One concrete source candidate is `reusableChunkBoundaries.reserve(...)` when rendered-preview segment count exceeds prepared capacity. Prepare capacity/spans on the control side and exercise this path with allocation detection. This is an audit target, not an established cause in the user's project.
- Use attributed profiles to select the next optimization: repeated string/hash lookups, per-track dispatch/diagnostic atomics, coincident reader-window refills, or an outer JUCE/device lock. Prebind immutable render handles and use safe off-thread retirement only if lookup/publication costs warrant it. Preserve prepared PDC/EQ parity, reader continuity and FIFO correctness. Make one measured change at a time.
- Maintain the actual 8-frame monitoring path. Larger device blocks, hidden extra monitoring buffers, suppressed counters, global real-time priority/affinity tweaks or relaxed acceptance thresholds do not resolve this task. Preserve existing Debug optimization and validate Release separately without conflating the two.

**Exit checks:** native audio invariants and exports retain their expected parity; trace-off runs meet the existing strict host deadline gate and zero reader/FIFO/device-error deltas. Report callback p50/p95/p99/max, missed-deadline count and longest run as well as average CPU. Driver xruns remain **unsupported** when the API reports -1. If the gate still fails, keep it failed and use the newly attributed cause for the next change; do not label it a driver fault from arrival gaps alone.

#### 4. Bound waveform work and qualify native input response

**Files:** `frontend/src/components/Timeline.tsx`, waveform cache/request helpers, `services/NativeBridge.ts`, relevant store selectors and `Source/MainComponent.cpp` delivery paths.

- Profile trusted plain/Ctrl/Alt/Shift wheel input from receipt through JS, React/Konva, layout/drawing and frame presentation, during record start and sustained recording. Include native host plus WebView browser/renderer/GPU CPU and memory. Compare cold and warm caches separately at the same viewport/DPI.
- Prioritize currently visible rows and source ranges over playhead lookahead. Inspect the current all-track prefetch loop; bound queued/in-flight work, cancel obsolete queued generations and reject stale completions without disturbing newer ownership. Pause speculative work under interactive backlog; existing peak data stays visible until valid replacement arrives.
- If measurements confirm completion bursts, batch cache publication per frame and bound decoding work. Measure actual decoded/object heap cost in addition to the logical cache-byte budget. Keep packed Float32 transfer, canonical tiles and exact trimmed edges.
- Keep wheel handlers small; preserve accumulated deltas, cursor anchors, follow suppression and final gesture state when coalescing updates. Maintain shallow subscriptions and isolated meter/recording updates. Do not hide latency by further lowering the live-preview update rate.

**Exit checks:** at least three identical runs with 100 trusted events per wheel/modifier mode, including sustained gestures, mixed packets, deep scrolling, cold-cache transitions and immediate menu/trim actions afterwards. Proposed project acceptance targets: event-to-first-correct-presentation p95 <=50 ms, p99 <=100 ms; active warm-gesture frame intervals p95 <=2 display periods and p99 <=3; no warm interaction stall >100 ms. Record all outliers, dropped/partial frames and cold-loading response separately. These are chosen product targets, not vendor standards or a 60 fps guarantee. If presentation cannot be measured, retain **diagnostic_only** rather than substituting rAF timings.

#### 5. Requalify the complete original workflow on the supplied song

- Run the focused regressions after each change; once stable, run the full frontend suite, `npm run build`, relevant real-browser workflows, a fresh warning-free CMake Debug build, native regression/project checks and full-song/stem render comparisons. Preserve exact hashes only where processing is expected to be unchanged; new SRC/fade processing needs its own numerical contract. Check packaged main/detached WebView readiness for any Release configuration being evaluated.
- At **48 kHz / 8 samples**, run three 2–3 minute recording/gesture sessions, then a 30-minute session once the short sessions pass. Use the supplied project copy, non-silent known input and recorded route details. Cross the 120-second preview boundary, seek/stop/restart in separately labelled phases, verify saved PCM/header/clip frame counts and stop-tail drainage, and reopen the saved copy. Evaluate audible continuity separately from host deadline counters.
- Use a known transient/sequence to compare displayed source coordinates, rendered samples and captured hardware placement against the metronome. Distinguish calibrated round-trip offset, drift and missing/repeated segments. Analog loopback is not a bit-exact oracle. Never route a test output into its own monitored feedback path.
- Revisit every original matrix row: tempo menu/audio/MIDI/half-double ambiguity; waveform trim/zoom edges; live MIDI thumbnails; mixer entry/resize; crop release; insertion/mono-stereo/media compatibility; ruler; all wheel modes; shortcuts/docs; MIDI drag/join/export; hover; full mixdown. Add crossfade and muted-source scenarios to a disposable project variant, since the original song does not exercise all edit states.
- Tempo estimates need an independently annotated beat grid and phase/half-double review; retain explicit ambiguity and audition controls instead of claiming exact musical intent from confidence scores. For MIDI interchange, export/reimport representative song clips in an available external DAW and compare note timing, channels, CC, tempo/meter and duration.
- Exercise real Explorer drops and an available physical MIDI route when possible. The unavailable TD-17 and the computer-use cross-window restriction remain separate qualification limits; simulated input does not certify either boundary. Request a specific physical action only if available tools cannot perform it, explaining the precise limitation.
- Update the manual and corresponding website guides for changed public behavior, then the 23-item matrix with artifact paths, exact builds and **pass / fail / diagnostic_only / not_asserted**. No blanket completion while a strict gate fails. Audition of the exact new audio artifacts remains separate from deterministic tests.
- Before a manual handoff, build current frontend assets and CMake Debug, stop Codex-started servers/harnesses, verify port 5183 is free, and confirm that `python build.py dev --run` needs no pre-running server.

### Dependencies and stop conditions

Steps 1 and 2 require the permanent failures from step 0. Steps 3 and 4 need a matched baseline and converge before final project qualification; a measured UI workload may affect audio scheduling, so qualify them together. Each change must preserve unrelated working-tree edits. Existing ETW evidence is already available; administrator access is not currently a blocker to planning or the deterministic fixes. A new system trace is requested only if the required correlation cannot be obtained from existing evidence and normal process tracing.

The unresolved engineering question is which callback/queue activity accounts for the remaining tails, not whether a larger buffer works. Do not repeat unchanged failed hardware experiments indefinitely: follow the repository's three-attempt rule and explain any concrete external-access requirement. Physical signal/routing, unavailable MIDI hardware and subjective audition can limit acceptance, but they do not block the code corrections or the software regression work above.

## Previous acceptance record (before the 31 October review)

Measurement correction: historical `audioDeviceXRunCount` values come from JUCE AudioDeviceManager, which adds its host load-measurer count to any supported driver count. They are not driver-only ASIO signals. Historical captures cannot be split retrospectively; native callback deadline misses remain an independent measurement. The user reports reliable eight-sample operation with the same Audient setup in another DAW. Follow-up work therefore profiles OpenStudio's fixed callback costs and recording handoff rather than substituting a larger buffer.

**Final software and recording/file checks at 48 kHz / eight samples pass; the strict host-deadline gate still fails. Native UI timings remain diagnostic. The work is not accepted as universally smooth or "all fixed."** A larger ASIO buffer cannot satisfy the user's eight-sample requirement.

- **pass: latest frontend:** [261 files / 3,088 tests](../output/shared-project-qualification/final-packed-frontend-tests.log), production/e2e TypeScript, the production frontend build and both Chromium [packed-waveform cases](../frontend/e2e/packed-waveform-tiles.spec.ts). Eighteen focused waveform/recording-preview checks also pass. The [frontend-stage verification manifest](../output/shared-project-qualification/packed-waveform-ui-verification.json) records the completed commands, times, dist hashes and Playwright last-run snapshot; passing browser cases did not retain failure-only screenshots/traces. The new browser cases use a mocked native backend and cover stable shared tiles, source-ready invalidation, zoom and rejected stale responses without releasing a newer request. The [earlier 38 workflow cases, 30 Chromium + 8 WebKit](../output/shared-project-qualification/final-workflow-regression.log), and [three MIDI-device availability cases](../output/shared-project-qualification/midi-device-availability-browser.log) retain their recorded-build scope. Saved input/output names remain visible with checking, unavailable or unverified status rather than silently changing routes. Vite retains large-chunk and ineffective-dynamic-import warnings; no TypeScript or dependency-notice errors remain.
- **pass: final critical browser qualification:** [17 relevant Chromium cases](../output/shared-project-qualification/final-critical-browser-verification.json): 13 recording-zoom cases, three shared-project/load/deep-scroll cases and the source-geometry/trim/insertion/DPI case. The [fresh actual-project report](../output/playwright/shared-project-qualification/report.json) contains **44 explicit checks** using the real 31-track / 33-audio-clip / 9-MIDI-clip project; its original SHA256 remains unchanged, with no page errors or React warnings in that geometry run. The first targeted run passed [16 cases](../output/shared-project-qualification/final-critical-browser-regression.log) and exposed one stale test assertion requiring prefix growth. A fixture-only correction now checks fetched/drawn expanded-viewport coverage, complete bounded tile reuse and no duplicate transfer; the [isolated source-geometry rerun passes](../output/shared-project-qualification/final-source-geometry-regression.log). Production sources/assets were unchanged. E2E TypeScript passes. Earlier 45-check/profile evidence is preserved [separately](../output/shared-project-qualification/browser-before-final-critical-20261028_1815/shared-project-qualification/report.json); native audio calls remain mocked in these browser fixtures.
- **diagnostic_only:** [isolated Timeline measurements](../output/playwright/shared-project-qualification/recording-performance.json) use the real project and peak data with simulated live transport/native delivery. Steady recording and five settled zooms are approximately 16.7-16.8 ms p95/p99; wheel p95 is approximately 33 ms, with a Shift p99 of 83.3 ms. Menus paint in 12.9-41.1 ms. Cold zoom transitions reach about 83 ms p95 / 150 ms p99. Both live previews and continuous MIDI polling are verified; these numbers do not establish whole-app/native WebView 60 fps or audio deadline acceptance.
- **pass: final native regression and project checks:** [399/399 named, unique objective controls](../output/shared-project-qualification/optimized-debug/20261028_173242_audited-verified/render_export_regression_result.json), including six packed-waveform and seven cache-generation/ownership controls; [74/74 fresh project checks](../output/shared-project-qualification/native-audited-verified/project_qualification_result.json); and [all five identical full export hashes](../output/shared-project-qualification/audited-render-hash-parity.json). The intermediate 386/392-check runs are superseded, including the corrected packed-check IDs. The [latest realtime parity](../output/shared-project-qualification/audited-realtime-self-test.json) passes; earlier [whole-song reference](../output/shared-project-qualification/independent-master-eight-verified.json) and [27 stem-window comparisons](../output/shared-project-qualification/independent-stem-eight-verified.json) retain their original artifact scope; no subjective sound acceptance follows from these file checks.
- **pass: actual native packed-waveform integration:** [the read-only native WebView check](../output/shared-project-qualification/native-ui-after-performance/packed-native-integration.json) calls the public packed/legacy endpoints and loaded public NativeBridge instance. Stereo 32- and 64-peak responses have correct dimensions and exact decoded Float32 parity, with no fallback warning. It changes no transport/project state and does not establish how every historical UI request was routed.
- **pass: measured small-block implementation controls; diagnostic_only: timing:** prepared PDC retains JUCE Linear's arithmetic, warm history and transition behavior, with [2,984 production-helper parity blocks / 763,976 channel samples](../output/shared-project-qualification/c8/20261028_154918_verified/integer-pdc-benchmark.json). Its 31-track/eight-frame zero-delay median changes from 8.3 to 6.2 microseconds. The embedded-EQ dry shortcut preserves the existing peak calculation and falls back for power/mode transitions, draft/spectrum requests and unsupported layouts; 36,912 parity blocks and 186,000 measured fast dispatches pass. That run's full-disabled/guarded medians are 6.0/1.3 microseconds per 31-track batch. These microbenchmarks do not establish hardware deadline acceptance. The recorder's prepared single-producer FIFO now hands PCM to a polling disk client without a per-block disk-thread wake or mutex. Its five-millisecond empty poll affects disk service only: monitoring and live peak publication retain the eight-frame producer path. The recorder registry still uses a nonblocking try-lock; the whole recorder is not claimed lock-free. Stop drains accepted partial tails, and failed disk writes report acknowledged frame counts.
- **pass: final eight-sample session/file invariants; fail: strict host timing:** [the final trace-disabled native capture](../output/shared-project-qualification/native-ui-after-performance/measurement/recording-analysis.json) observes **176.191 seconds of continuous recording without a detected seek**, with the Audient route at **48 kHz / eight samples** throughout. The saved stereo PCM16 take is **8,505,104 frames / 177.1896667 seconds**, starts at **0**, has exact saved-clip/header frame counts and a peak sidecar, and preserves all original clip IDs/core properties. Reader/cache/continuity, recording-FIFO/write-lock, device restart/error and non-finite-output deltas are zero. The recording-only independent host deadline count nevertheless increases by **1,001**, and JUCE combined/derived-host overload counts by **1,091**; start-through-stop totals have a different scope. Driver-only telemetry is **-1 / unsupported**. The final physical-input PCM is **all zero**, so known-signal recording continuity, listening and electrical timing remain **not_asserted**. The user's no-glitch observation applies only to the earlier ETW baseline. The [151.922-second FIFO capture](../output/shared-project-qualification/native-ui-fifo-eight-capture/analysis.json) and its virtual-MIDI event checks are previous-build evidence, not this audio-only run; TD-17 remains unavailable. Eight-sample host timing remains a failed engineering gate, not proof of audible dropouts or a driver-only fault.
- **diagnostic_only: paired callback profiling:** [the preceding opt-in profile](../output/shared-project-qualification/callback-profile-before-analysis.json) pairs stage timings with callback outcomes. Raw QueryThreadCycleTime counts are not CPU milliseconds or proof of descheduling; clock frequency, processor migration and measurement overhead remain relevant. The latest acceptance capture above disables that trace. Arrival-gap heuristics alone do not fail the gate, and the remaining cause is not assigned solely to the driver or Windows.
- **not_asserted: physical Explorer drop:** [the actual attempt](../output/shared-project-qualification/physical-explorer-drop.json) is rejected by the computer-use API's cross-window endpoint check. The temporary topmost experiment did not overcome that restriction and was removed; no physical import is claimed from the passing simulated handlers.
- **pass:** [the targeted input-documentation validator](../output/shared-project-qualification/input-doc-contracts.json) checks eight app/website documents; [nine stale-contract fixture tests](../output/shared-project-qualification/input-doc-contract-tests.log) also pass. This covers selected default key/label/provenance contracts, not every profile, custom binding or translation.

The [coverage matrix](issue-coverage-matrix.md) retains item-specific limits. Eight-sample host timing remains a failed engineering acceptance gate; physical Explorer drops, sustained physical MIDI recording, electrical timing, external-DAW MIDI interchange and subjective acceptance remain separate. The user has confirmed reliable eight-sample operation with the same Audient setup in another DAW. That answer informed the measured PDC/EQ/recording-handoff work; it does not establish the remaining OpenStudio overrun cause. Further retries must respect the repository's repeated-failure rule and use new evidence. Completed viewport/browser and objective native checks are no longer pending.

### ETW-directed follow-up and remaining gates

The user reports **no audible glitches in the original eight-sample ETW baseline**, but slow UI and delayed scrolling. Its matching take is 55.858 seconds. This listening observation applies only to that session, not later builds or electrical timing. The [ETW follow-up](../output/shared-project-qualification/etw-follow-up.md) and [phase analysis](../output/shared-project-qualification/etw-analysis/phase-analysis.json) preserve the trace identity, recording boundaries, zero lost events, successful MMCSS/observed priority 25 and scheduler-coverage limits. DPC/ISR time and normal driver waits are separated; the trace does not identify individual engine misses or prove a sole operating-system/driver cause.

1. **Implemented; linked code verified:** consistent Windows Debug host optimization and nonincremental linking prevent shared helpers being selected from `/Od` objects. [Before](../output/shared-project-qualification/etw-symbols/comdat-origin-before.json)/[after](../output/shared-project-qualification/etw-symbols/comdat-origin-after.json) PDB/disassembly evidence verifies the bounds, sample and UTF-8 helper bodies. Symbols, `_DEBUG`, assertions and Debug CRT remain; WebView retains `/O1`. Release configuration is unchanged. The final 399 objective controls, 74 project checks and five export hashes above pass; [microbenchmarks](../output/shared-project-qualification/etw-symbols/optimized-debug-benchmark-comparison.json) remain **diagnostic_only**.
2. **Implemented; frontend checks pass:** canonical 4,096-peak tiles eliminate growing-prefix replacements and share interior data across prefetch/render and trim ranges. Boundary-specific tiles retain native exact trim aggregates. Versioned lossless Float32LE/base64 responses prepare cache lookup, edge reads and packing off the message thread; legacy calls remain compatible. Strict format, dimension, length, byte-order and finite-value validation surfaces failures or valid legacy fallback. Cache generation invalidation and the 32 MB source-cache budget remain. Native packed round-trip, clipped-edge and partial-tail controls pass in the final 399-check run above. The [eight-tile benchmark](../output/shared-project-qualification/optimized-debug/20261028_171319_packed-verified/packed-waveform-benchmark.json) records 379.8747 ms / 1,770,272 bytes for legacy numeric JSON, 70.8206 ms / 700,200 bytes for packed completion JSON and 5.8691 ms of worker packing. These are **diagnostic_only** serialization costs, not native UI/hardware acceptance.
3. **Implemented; seven native controls pass:** generation/ownership guards protect native cache loading, edge publication, queued work and completion/retirement against invalidation and rebuild. An old sidecar load or completion can no longer replace or retire a newer native source generation. Deterministic delayed-load, queued-generation and ownership-race controls pass in the final 399-check run.
4. **Completed with separate outcomes:** final native regressions, 74 actual-project checks and five export hashes pass. The final trace-disabled eight-sample capture passes saved-file/session invariants over 176.191 observed seconds but still fails the strict host deadline budget (+1,001 independent misses; +1,091 JUCE host counts); silent input prevents a known-signal/listening/electrical claim. The [baseline](../output/shared-project-qualification/native-ui-before-performance/measurement/analysis.json) and [post-change](../output/shared-project-qualification/native-ui-after-performance/measurement/analysis.json) observers each contain only four trusted plain-wheel events. The baseline click/seek differs from the final continuous recording. rAF/canvas CPU timings remain **diagnostic_only**, not presentation/paint proof, complete modifier-zoom acceptance or a smoothness/60 fps guarantee. [The final Debug build](../output/shared-project-qualification/final-fixture-debug-build.log) has zero compiler warnings and copies the current dist (index SHA256 starts `EDE4B35F`).

The [native UI comparison](../output/shared-project-qualification/native-ui-after-performance/ui-comparison.json) uses the same 1,280 x 800 viewport and DPR 1.5, but only four trusted plain-wheel samples per run. It describes timeline-layer draw p95 of 0.5 to 0.1 ms and native-process CPU median of 3.636% to 0.976%; the latter excludes separate WebView renderer processes. Sampled wheel-response distributions are similar and do not establish latency improvement. The baseline click/seek and reader underruns confound audio A/B interpretation. These figures remain **diagnostic_only**, not paint/60 fps proof or a universal smoothness claim.

## Implementation stages

The [resumed 31 October acceptance record](issue-coverage-matrix.md#resumed-qualification-31-october)
records the current 410 native checks, clean 74-check project run, unchanged five export hashes,
and complete 179.7235-second native recording with 400 wheel events at eight samples.
The file/session invariants pass; 772 engine deadline misses leave strict timing acceptance open.
Input was effectively silent. Do not promote the implementation checklist to hardware or listening acceptance.
The latest targeted optimization retains exact JUCE delay-line parity while avoiding repeated per-sample
buffer lookups; the preceding trace establishes the separate empty-heap-release issue and remaining interruption costs.

1. **Export reliability.** Give offline source reading an explicit non-realtime policy with bounded memory, complete reads, cancellation and surfaced errors. Preserve clip envelopes, fade curves, active state and track playback offsets in offline renders. Add a regression that exceeds the full-decode threshold. Correct MIDI export tempo and meter information.
2. **Waveform and gesture correctness.** Use exact sample/time coordinates at fractional zoom and large scroll offsets. Track cache coverage, retain real peaks during interaction, and aggregate all source bins belonging to a pixel. Correct final partial peak aggregates and clipped edge bins. Freeze clip gestures at mouse release before asynchronous backend work.
3. **Recording performance.** Stabilize MIDI thumbnail pitch coordinates, incrementally cache paired notes, bound visible drawing work by viewport, and retain the bounded recording-peak scheduler. Validate zoom/scroll during simulated long recording and inspect native qualification counters rather than inferring CPU load from UI jitter.
4. **Drop and import consistency.** Share destination semantics for internal/external drops, including between-track insertion and a truthful ghost preview. Keep MIDI/audio track compatibility. Configure new tracks from probed source channels, preserving existing track layout and undoing the entire import/move atomically.
5. **Editing and mixer workflows.** Add selected-audio crossfade and same-track MIDI join actions, accessible context-menu entries and conflict-checked shortcuts. Expose crossfade editing. Add numeric dB entry, a persisted accessible mixer resize separator, note-hover information, and a ruler range lane that leaves bar labels legible.
6. **Tempo detection and documentation.** Add asynchronous audio/MIDI tempo analysis with confidence, half/double alternatives, beat-offset preview and explicit project-tempo application. Retain imported MIDI tempo metadata; report ambiguous inference honestly. Update app/website guides and stale shortcut labels, marking source-checkout behavior as development work.

## Execution and ownership

- Native backend: offline source policy, render parity, peak-cache edges, native MIDI interchange, tempo analysis.
- Store/actions: undo-aware clip commands, import channel configuration, export/tempo bridge contracts.
- Timeline: source/sample projection, waveform cache/rendering, recording thumbnails, gesture termination, drop previews and context menus.
- UI: mixer editing/resizing, Piano Roll tooltip, tempo analysis presentation, documentation integration.

Changes remain targeted. Reuse action/profile registries, existing command-manager transactions, native async jobs and lower-zone layout conventions. Do not change persistence schemas without old-project round-trip coverage. Keep analysis, decoding and allocation away from the realtime audio thread.

## Validation gates

- Add regressions for the reproduced 374 px waveform gap and trim mutation after mouse release with delayed native synchronization.
- Cover shared-source cache expansion, partial edge bins, fractional zoom, large source offsets, resized viewports and retained peaks during interaction.
- Cover MIDI historical-note stability and viewport-bounded drawing, single/multiple drag previews, insertion target geometry and one-step undo.
- Cover join/crossfade/mono import/tempo mutations through undo and redo; test MIDI trim/loop/CC and tempo/meter round trips.
- Run focused tests while implementing, then `npm run build` and the relevant Chromium browser integration tests. Check focus, names, hit targets, overflow and pane clamps in a real browser.
- Build `cmake --build build --config Debug` after the frontend production build so copied fallback assets are current. Run appropriate headless native regressions against that fresh executable, with long-source coverage.
- Use a copy of the user's project for any project-level export validation. Do not claim subjective audio quality from metrics or synthetic fixtures. Report `pass`, `fail`, `diagnostic_only`, and `not_asserted` separately.
- Close Codex browsers/dev servers and verify port 5183 is free before handoff. The user must only need `python build.py dev --run`.

## Progress

## Completion pass requested by the user

The completion-pass production implementation now includes general/contained/multiple-overlap crossfades with editable handoffs and Undo, high-quality cancellable project-rate copies plus an optional import policy that preserve originals, and multisection tempo analysis with source/click audition. Mixed-track divider insertion retains one new row per selected source row and compatible media types. Integration and migration checks precede final qualification. Native sustained recording qualification uses paced project PCM, concurrent preview queries and the 120-second preview boundary. The real-project browser qualification profiles idle, record-start, steady recording and modifier-wheel phases with bounded IPC assertions. Later measured PDC/EQ and disk-FIFO changes preserve their objective parity controls, and saved missing MIDI routes now display honestly. These software runs do not stand in for electrical loopback or subjective listening. The latest trace-disabled eight-sample native capture still fails host timing, as recorded above; earlier counts below are historical.

The original checklist records the first implementation/qualification pass; it does not mark every completion-pass hardware or subjective acceptance check as complete.

- [x] Review issues, inspect project metadata, and reproduce waveform/trim defects.
- [x] Record the implementation sequence and acceptance criteria.
- [x] Complete and validate native export fixes.
- [x] Complete and validate waveform/gesture/recording fixes.
- [x] Complete and validate drop/import and clip editing actions.
- [x] Complete and validate mixer, ruler, hover and tempo UI.
- [x] Update app and website documentation.
- [x] Complete frontend/native builds, regressions and cleanup.

## Implementation and verification record

- Waveform projection uses exact source sample coordinates; cache entries track requested coverage, bounded memory and source invalidation generations. Real cached peaks remain available during gestures, clipped edge aggregates exclude removed audio, and partial final aggregates are retained. Static waveform artwork is reused during recording redraws.
- Released gestures stop accepting previews while native synchronization is pending. Divider drop targets have hysteresis; inserted tracks and movements share one undo transaction. Native-event drop fixtures cover 100/150/200% scaling and sequential multi-file placement. These are simulated native events, not an Explorer-to-WebView hardware qualification.
- MIDI recording thumbnails use a stable full pitch band, incremental channel-aware note pairing and visible note blocks. Completed thumbnails derive pitch range independently from sampling. Same-length edits invalidate the note index.
- New OpenStudio timeline shortcuts: Ctrl/Cmd+J joins selected same-track MIDI clips; Shift+X crossfades selected audio clips. Vendor profiles leave these new actions unassigned. General crossfades now cover contained, same-edge, coincident, nested and multiple overlaps through independent gain layers, with editable handoff lengths/curves and one Undo. Manual fades/envelopes remain intact; the expanded editor browser case passes in the final 38-case run.
- Mixer numeric edits use one volume transaction and preserve untouched numeric precision. Mixer height is persisted and accessible by pointer/keyboard. Piano Roll note information uses an imperative hover overlay.
- Tempo analysis is explicit and asynchronous. Audio uses adaptive spectral whitening and multiband onset evidence across up to three audible sections, with at most 60 seconds of spectral work in total. MIDI prefers retained source metadata, otherwise compares repeated beat grids across the selected notes. Both retain an independent fixed listener preference rather than using project tempo as an answer prior. Range selection, editable BPM, half/double/triplet candidates, section spread, tapping and beat-interval counting support correction. Four/eight-second dry source + click or simple MIDI-guide + click auditions support phase/grouping edits and cancellation without moving transport. Preview excludes track/master FX; guide tones do not reproduce the instrument. The diagram shows beat spacing, not a detected downbeat. Apply changes base BPM with Undo; existing tempo markers and absolute clip positions remain.
- Optional project-rate copies use a bounded band-limited worker conversion to float WAV with progress/Cancel, source identity guards and Undo/Redo. Project import policy can prepare copies inside the original import transaction; cancellation/failure falls back to the original source. The normal import default preserves original sample rates. Playback performs ratio conversion and export uses its selected output rate; subjective conversion quality is not inferred from rate/file tests. The inactive export quality dropdown was removed.
- MIDI export carries tempo-map/meter information, including clip-relative rebasing. Source tempo metadata survives import and follows time-stretch scaling. Native-rate audio originals remain intact.
- Application manual, feature inventory and relevant website guides describe development behavior after base commit `e8f9a65a`; no release or publication is implied.

Earlier first-pass checks: frontend production build; 255 frontend unit-test files / 3,030 tests; 14 recording/source-geometry Chromium tests, plus the mixer/hover/tempo browser cases and existing ruler/copy integration. The existing inline-copy integration had one transient failure during simultaneous browser runs sharing an artifact directory; its isolated rerun passed. Subsequent browser runs use separate output directories.

That first-pass Debug build completed with **zero compiler warnings**, and its packaged frontend matched `frontend/dist`. The first-pass expanded headless suite passed **280/280 checks**, including long-source reads, missing-source policies, clip state parity, track trim/polarity, exact trim/tail extrema, channel adaptation, stereo FX preservation, MIDI tempo/meter round trips, known-tempo clicks, silence and unmetered noise. It retained zero opened devices, device starts, callbacks and callback registrations throughout.

The first native run passed 278/280: its MIDI timing oracle assumed the wrong PPQ despite a correct exported file, and the noise fixture exposed an insufficient short-clip regularity gate. The corrected oracle checks file PPQ and an independent seconds round trip; the detector now requires duration-dependent regularity evidence. Both checks pass in the final fresh executable.

Website build and zero-warning lint passed. The full website suite initially passed 239/240 with one stale local release-metadata checksum failure. The supported refresh fetched and validated published v0.1.08 inputs; the affected test file then passed all three checks. No release metadata was fabricated, gate bypassed or site published.

For that earlier implementation pass, **pass** covered its build, objective native gates, frontend suite and browser checks. **diagnostic_only** covered confidence/phase on real music and extrapolation from fixtures. **not_asserted** covered subjective sound quality and the then-unqualified actual-project/hardware route. The current acceptance record above supersedes that earlier evidence boundary. Audio tempo analysis is constant-tempo estimation over at most 60 seconds, not a full tempo-map/downbeat detector.

Final evidence: `output/remediation-native-result.json`, `output/remediation-native-regression.log`, `output/remediation-debug-build.log`, `output/remediation-frontend-build.log`, `output/remediation-frontend-tests.log`, and `output/playwright/remediation-final-browser`. Website evidence is in `../openstudio-website/output/review/issue-ui-*.log`.

At that earlier handoff, task-owned browsers/servers were closed and ports 5183/5190 were checked clear. The original user project was not edited. Current native build/copy and device acceptance are separate gates above; a final manual-testing handoff must refresh Debug assets and clear task-owned servers. Its single command remains `python build.py dev --run`, with no pre-running server required.

## Earlier actual supplied-project qualification follow-up

The initial handoff did not load/render the shared song. The later qualification corrected that gap using a byte-identical copy and the genuine frontend loader/serialization. Results and remaining limits are tracked item by item in [the coverage matrix](issue-coverage-matrix.md).

The actual project passed 74 native checks and 44 source-backed browser checks. Repeated full-length 48/44.1 kHz WAVs are PCM-identical, saved-format MP3 is valid, and all 12,720 exported MIDI events retain identity/timing within one tick. An independent raw-source whole-song mix passes with maximum error 8.943e-8, 4,213 windows and no missing audio; 27 independent selected stem-window comparisons also pass. The project and source metadata remained unchanged.

This deeper comparison found and corrected an additional recorded-source endpoint omission plus floating-point render-clock drift. Its generic suite passed 289/289, and that Debug build was warning-free with matching packaged frontend assets. Long silent lead-ins selected an audible analysis window. These counts predate the current completion pass; real-song tempo confidence remains diagnostic, and hardware performance/listening acceptance are not inferred from these artifacts. See `output/shared-project-qualification/summary.json` for those exact artifacts.

## Earlier completion-pass UI/tempo evidence

- **pass:** 28 focused tests for shared profiled range controls, MIDI pulse estimation, phase/tap/count math and isolated audition lifecycle; production and e2e TypeScript checks.
- **pass:** three Chromium tempo-dialog workflows after the final source-only and profiled-slider changes, including delayed analysis/preview cancellation, target changes, native source guards, range forwarding, source-only tapping, explicit one-Undo Apply, and unchanged transport. Artifact directory: `output/playwright/tempo-final-tests`. Native audio calls and audio output are mocked in these workflow tests.
- **pass:** the actual native dry-preview RFC4648 payload matches the saved float WAV byte for byte. Chromium decodes its 48 kHz/stereo/96,000 frames with zero sample error. Real OfflineAudioContext rendering through the production audition player preserves the bounded source gain within 6.71e-9; click residual occurs only in independently calculated click windows, with zero pre-roll/outside-window residual. No speaker output or subjective quality is asserted. This boundary check exposed and corrected a frontend signature-guard mismatch: native `sourceOffsetSeconds` is the retained clip origin, and `rangeStartSeconds` is validated separately. Four Chromium cases (actual decode plus the three modal workflows strengthened with a nonzero preview start) pass; e2e TypeScript passes. Evidence: `output/playwright/native-tempo-preview/report.json` and `output/playwright/native-tempo-preview-tests`.
- **diagnostic_only:** `tools/qualify-midi-tempo.mjs` evaluated all nine actual MIDI clips without passing configured project BPM to the estimator. Eight produced 153.98–154.04 BPM and one rejected insufficient repeated evidence. This is not intended-beat-unit or external interchange acceptance. Evidence: `output/tempo-research/midi-project-report.json`.
- **pass, recorded binary:** the objective native suite passes **333/333** with `claimLevel=objective_only` and subjective quality `not_asserted`. It remains device-free. Exact artifact: `output/shared-project-qualification/prepared-recording-regression/20261028_111217_eight-sample-optimizations/render_export_regression_result.json`.
- **pass:** the fresh realtime self-test preserves exact serial/worker audio across 96 blocks of 1/8/16 samples, all graph eligibility/invalidation contracts, and 450 eight-sample automation cases covering data, modes, touch/latch, force-read and interpolation. A 31-track/6,000-batch eligibility discovery microbenchmark preserves all results; its timing is `diagnostic_only`, not a hardware deadline proof. Artifact: `output/shared-project-qualification/eight-sample-realtime-self-test.json`.
- **pass:** six MIDI thumbnail-index tests, including exact dense 50,000-note sampled-query parity with bounded cloned output, held/channel notes, append closure, edits and boundaries. This does not establish sustained physical MIDI recording acceptance.
- **pass:** viewport-stage actual-project geometry and deep-scroll clip/fade/marquee/Undo checks, plus track/MIDI automation, modifier routing, recording cancellation and source-cache/drop integration in the final browser runs linked above. These tests use mocked native boundaries.
- **historical fail/pending:** this earlier eight-sample capture failed timing despite start 0. The final implementation now has the separate 399-check and latest native capture evidence above; current strict host timing still fails. Full native UI/plugin workload and physical Explorer drops remain separate. Independent whole-song/stem checks retain their exact artifact scope and do not constitute subjective listening acceptance.

## Native retry and remaining acceptance

The required route remains **48 kHz / eight ASIO samples**, approximately **0.1667 ms per callback**. The final trace-disabled native capture saves 177.1896667 seconds with **fresh-start placement pass at 0** and passes file/session invariants. Its 176.191-second observed continuous recording interval still adds **1,001 independent host deadline misses and 1,091 JUCE host counts**, so the strict timing gate fails. Silent physical input leaves listening/electrical acceptance unasserted. A 256-sample diagnostic cannot replace it. Driver-only reporting is unsupported on this route; combined JUCE counts and arrival-gap heuristics must not be relabeled as physical driver/audio loss.

Raw-input-only capture, tiny-block/empty-graph dispatch, clip indexing, sample-rate playback, prepared PDC, guarded embedded-EQ and the disk FIFO now have the separate objective parity and 386-check evidence linked above. Their native eight-sample host-timing acceptance remains **fail**. The earlier 333/346-check artifacts predate later paths and must not be presented as their validation. The recorded PDC/EQ microbenchmark savings and nonzero captured PCM do not establish physical input identity, electrical alignment, usable held-note timing or subjective sound quality.

The viewport Timeline integration is **verified in the final browser runs**: native DOM scroll extent remains full-height while canvases use the visible height and world-coordinate offsets. Recording repaint state has its own layer; muted hatching and sampled MIDI output are bounded. Deep-scroll clip/fade/marquee and atomic Undo pass. Track/MIDI automation, ruler/modifier recovery, source-window expansion and simulated drop coordinates pass in their own fixtures. The representative actual-project profile retains both live previews and continuous MIDI polling. Its timings remain isolated headless-browser diagnostics with a simulated live native boundary, not a native hardware or whole-app 60 fps claim.

Physical Explorer drag/drop, sustained physical MIDI recording, electrical loopback/round-trip placement, external-DAW MIDI interchange and user audition of exact artifacts remain explicit boundaries. The targeted cross-repository shortcut documentation validator passes its recorded scope. Append subsequent native results with their exact artifacts rather than replacing these historical measurements with an unsupported "all fixed" statement.
