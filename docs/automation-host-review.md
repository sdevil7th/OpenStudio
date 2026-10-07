# Automation and plugin state

This guide describes the development source checkout, not an existing installer.
It consolidates the September host review and October FX/automation audit and
checkpoint. User workflows belong in the [manual](USER_MANUAL.md); executable
checks belong in [testing](testing.md#free-plugin-processing-and-editor-checks).
Plugin DSP/editor contracts live in [free plugins](free-plugins.md), window and
device contracts in [runtime hardening](runtime-hardening.md), and open work in
the [roadmap](roadmap.md).

## Supported targets and identity

| Target | Contract |
| --- | --- |
| Track/master | Volume, pan, width/mute where supported, and separate volume Trim |
| Instrument/bus pre-FX | Volume, pan and width |
| MIDI/instrument | Velocity, pitch bend, channel pressure and MIDI CC |
| Sends | Level, pan, mute and level Trim; identities use escaped destination IDs |
| Input/track FX and dedicated instrument | Eligible host-exposed parameters; removal/reorder/Undo preserve ownership |
| Master/monitor FX | Persistent instance UUIDs and plugin fingerprints; monitoring remains outside export |
| Built-in FX and NAM | Eligible scalar, toggle and choice controls from the native schema |
| JSFX/CLAP | Numeric/choice sliders and SDK parameter identities; supported change notifications refresh metadata |

File/model/IR loading, calibration, presets, MIDI mapping, prepared
latency/topology settings, inactive configuration banks and read-only meters are
not scalar envelope targets. Realtime Pitch Correct FX automation is separate
from graphical pitch editing, which renders clip audio and has its own history.
Free instruments use the track-FX route on MIDI tracks; the fallback instrument
has its own parameter contract.

Saved lanes retain native labels, ranges, units, choices and meaning metadata.
Compatible SDK identity changes rebind to the current parameter index. Missing or
incompatible targets retain inert points rather than controlling a different
parameter. Explicit CLAP reference clearing retires the old generation, including
queued MIDI Learn updates; Undo cannot revive that runtime generation. Legacy
documents without saved identity retain their documented index fallback. An
isolated plugin's parameter-contract change requires a worker reload.

Vendor controls must be exposed or assigned by the plugin. AmpliTube's assignable
slots do not establish automation for every internal amp/pedal knob. Loaded
Kontakt libraries and Komplete Kontrol nested controls depend on their mappings.
Optional isolation rejects layouts beyond its 32-channel/16-bus-per-direction
IPC capacity; this affects installed Kontakt 7/8 layouts, while ordinary hosting
remains available. JSFX scripts must publish edit intent with `slider_automate()`.

## Writing, reading and history

- Visibility and Read are independent. Explicit lane Read enables its owner gate;
  Write enables Read, and disabling Write retains Read. An empty lane does not
  reset the manual value. Populated Read curves reclaim manual edits.
- Continuous curves use linear interpolation; discrete controls hold the previous
  value until their next point. Manual discrete edits snap to known choices.
- Touch owns the control until release, with optional 100 ms–5 s return to its
  continuous curve. Explicit begin/end takes precedence over the 180 ms fallback
  for value-only notifications. Native echoes cannot end a held frontend gesture.
- Touch/Latch uses Touch for main volume and Latch for other controls. Cross-Over
  latches after release and punches out when a second touch crosses the original
  curve. These behaviors do not claim complete Cubase or Pro Tools parity.
- Range Trim/Fill and bounded thinning are stopped-transport edits with a visual
  preview, preserved boundary values and one Undo. Realtime dB Trim is separate;
  manual, after-pass and stopped on-exit coalescing retain one Undo. Failed
  coalescing preserves both curves.
- Audible Preview holds eligible non-MIDI controls. Cancel restores normal
  playback/manual state; Capture is temporary, and stopped range Commit is one
  Undo. Punch writes only previewed controls without changing ordinary Write arm.
- AutoJoin remembers the actual native stop position for latched controls and
  schedules up to 128 held values when playback restarts earlier. Touch, changed
  curves/targets, protection changes and project replacement invalidate joins.
  A loop must contain the join point. Remembered joins and live Preview values
  are temporary; the enabled preference and coalescing policy are saved.
- Write to start/end fills controls already writing within the current pass.
  The writer uses one epoch clock. Stop records the held value at native stop
  time even if there is no final animation frame.

Native capture queues are bounded. Supported VST3/CLAP SDK sample offsets and
isolated event packets are retained; ordinary GUI gestures use estimated timing.
Callbacks publish realtime-safe data; frontend events are built off the audio
thread. Stop halts native audio/recording immediately and drains final main or
detached editor writes, with a bounded warning path.

Every async mutation must recheck project/session ownership after bridge waits.
Stage edits cannot mutate or install snapshots into a replacement project.
Structural send changes preserve live envelopes and unrelated level/pan/Trim
gestures; only removed destinations belong to that command's lane history.
Rejected changes create neither history nor mute automation. Delayed Pause/Stop
responses cannot close a newer write session.

## State, recovery and export

Saving requires fresh processor/instrument state, stable slot identity and native
readback where needed. Snapshot failures cannot overwrite the previous document.
Automation Safe retains its own SDK/meaning contracts even without an envelope,
across track/input/instrument/master/monitor scopes. Changed protection blocks
restore and Save.

Unavailable FX retain opaque state, order, envelopes, Safe and MIDI mappings.
Stopped Retry and stage Undo restore processors, resolve fresh SDK bindings and
then resume Read. Incompatible protection rolls back and rebinds the current
stage; failed rollback blocks Save. State/preset recall invalidates Read caches
without recording recall notifications. The pinned JUCE VST3 patch preserves
host-normalized values alongside vendor state; legacy opaque state still loads.
No persistence schema or DSP version was bumped for this work.

Project reads serialize begin/chunk/release around one native immutable snapshot.
Chunks are bounded to 8,192 characters and preserve Unicode boundaries. Explicit
read errors stop before project replacement; older backends retain their legacy
contract. JUCE calls preserve the receiver and use monotonic request IDs.
Native long-operation timeout policy covers hosted insertion/state/preparation
and Freeze without weakening ordinary read deadlines.

Export and Freeze provide an advancing offline playhead at the output sample
rate with integrated tempo-map musical position, and restore the live clock on
exit. Hosted state/setup/reset run on the message thread; audio rendering remains
on its worker. Neither correct clocks nor restored parameters prove identical
vendor audio across cold and repeated exports.

## UI ownership

Portal dialogs must stop pointer propagation at their roots without cancelling
normal control actions. Sortable track headers also reject targets outside their
own DOM. This prevents FX dragging from sorting the underlying track; cancelled
drags clear their pending source. Envelope Manager rejects stale parameter fetches
and refreshes on topology changes. Its bounded list separates visibility, Read
and protection controls and keeps advanced writing tools collapsible.

Shared editor control utilities live in `PluginEditorControls.ts`; processor
artwork remains in its own stylesheet. Typed CSS variables carry runtime geometry.
Control styling must not depend on importing another processor's scene.

## Qualification limits

Automated results establish only their asserted routing/state/timing/geometry
invariants. Sound quality and commercial-product parity remain **not_asserted**.
Use real played signal before/during/after an edit; the local guitar fixture's
first two bars contain a quiet lead-in and cannot prove an audible effect.

| Open qualification | Current evidence and next step |
| --- | --- |
| Native played-guitar Punch/AutoJoin | **fail / needs diagnosis**: the latest October 6 job timed out three times after `change_preview`. An earlier 49-check gain run passed, but static exports and frontend tests do not clear the later failure. Collect native/UI responsiveness and Preview queue evidence before another writing run; the repeated approach was stopped under AGENTS.md. |
| AmpliTube cold/repeated export | Repeat parity remains **unresolved**; the latest wet comparison differed by about 0.595 dB at 5.5–6.5 s. Direct SDK/state-order/overlay and preroll diagnostics did not establish parity. Waveform comparisons are **diagnostic_only**, not vendor-fault evidence. Continue with the user's working preset in a copied project; no sleep, sacrificial render or relaxed threshold is a fix. |
| Long-session project recovery | Serialized chunk reads fix a definite overlap race. The original intermittent copied-project restore failure remains **unconfirmed** after subsequent passing runs. |
| Physical vendor controls | Loaded Kontakt/Komplete content, every vendor assignment, CLAP GUI capture, isolated-editor foreground shortcut focus and sustained loop/recording AutoJoin remain **not_asserted**. |
| Platform/device/release | Installed Windows Release, clean install/update/rollback, device sleep/wake, mixed DPI, macOS/Linux and signing/reputation acceptance require the release checklist. Debug readiness is not installed-release qualification. |

Historical raw reports and private audio remain under ignored `output/review/`.
The superseded audit/checkpoint text is preserved locally under
`output/review/pr-readiness-archive/`; do not publish private projects, vendor
presets or WAVs. Keep current validation with the PR and run logs rather than
appending another dated implementation diary. A release still requires reviewed
version-specific notes and all applicable [smoke gates](release-smoke-checklist.md).
