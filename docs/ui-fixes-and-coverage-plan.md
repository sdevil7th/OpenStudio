# UI fixes and app-wide coverage plan

Latest follow-up: [revision 7 native verification](linux-native-followup-2026-10-01.md)
passes Ubuntu QA upgrade, installed save/reopen and MIDI interactions. The Debug
harness ownership leak is corrected and diagnostic failures now fail qualification.
Live Audient DAW signal verification and native Windows/macOS remain open.


Date: 2026-10-01. Status: **confirmed fixes implemented in the checkout; app-wide
and platform qualification in progress**. See the
[implementation and evidence checkpoint](ui-fix-verification-2026-10-01.md).
Based on the [Linux UI audit](linux-ui-audit-2026-10-01.md).

## What the audit establishes

The audit sampled 35 surfaces, two viewport sizes, two browser engines and selected
installed-app workflows on Ubuntu 22.04. Many checks only exercised an initial,
empty or loading state. Its 214 passing browser tests are a baseline, not proof
that every feature or platform works. Five confirmed defects and one native MIDI
investigation remain open.

Exhaustively testing every possible combination of projects, plugins, devices,
input sequences and operating-system settings is not feasible. The target is
traceable coverage of **every supported feature and UI surface**, with explicit
required states, workflows, platform evidence and remaining gaps. A screenshot
of a dialog is not a functional pass for that dialog's feature.

## Implementation sequence and regression protection

Use small, independently reviewable changes. First reproduce each confirmed
failure in a focused regression test, then implement its fix and prove the test
passes without weakening its assertion. Preserve the existing working-tree
changes. Record the tested source revision, patch/artifact identity and platform.
Do not combine this work with framework, JUCE, DSP or dependency upgrades.

### 1. UI-01: preserve project state and native routing — highest priority

- Inventory supported persisted track fields against the Track type, default
  factory, actual editing actions, serializer, validator, restore logic and native
  bridge. Classify ephemeral state explicitly; do not serialize entire live store
  objects or automatically persist every new field.
- Preserve width, master send, hardware output mapping, playback offset, phase,
  channel count, sends, notes, waveform zoom, folder state and takes/active take.
  Confirm field semantics using valid fixtures built through real actions.
- Supply backward-compatible defaults for genuinely absent legacy fields without
  replacing valid `false` or zero values. No schema bump unless an actual format
  change requires it and migration/round-trip coverage is present.
- Restore the native state as well as displayed values. Create destination tracks
  before reconstructing send/folder relationships; validate graph references and
  report failed native restoration rather than claiming complete success.
  Preserve existing project-load queuing, plugin state and dirty-state contracts.
- Keep edits undoable through existing actions/commands. Restoration must not add
  spurious user edits or erase the persisted history unexpectedly.

Required tests: save→load→save semantic parity of non-default values; current and
real previously shipped project fixtures; save-as, backup/recovery and portable
project paths; folder/take selection; plugin/instrument and automation state;
missing devices and assets; failed writes, concurrent edits/saves and dirty flags.
Use temporary copies, never overwrite the user's originals during qualification.

Native acceptance: configure routes, save, close, reopen the installed app and
verify controls **and backend routing**. Use deterministic audio fixtures to verify
send/phase/width/channel behavior where supported. Exchange fixture projects
between Linux, Windows and macOS, preserving portable content and reporting
unavailable platform-specific devices/plugins. Bytes omitted by an older save
cannot be recovered by this fix; retain backups and document that limitation.

### 2. UI-05: reject malformed MIDI safely at the load boundary

- Extend existing MIDI event validation using the actual supported event schemas:
  required finite timestamps, supported event types, note/channel/value ranges,
  durations where used, and collection limits. Include CC and pitch-bend data.
- Preserve valid legacy representations through explicit, fixture-backed
  normalization. Do not invent a migration from the audit's accidental `time`
  field without evidence that a shipped format used it.
- Validate before project teardown or backend mutation. On invalid input, give a
  useful error and preserve the open project, selection, undo history and dirty
  state. Do not silently drop bad events and report a clean load.

Required tests: the audited missing-timestamp case, null/wrong-type/non-finite
values, boundary values, empty and valid event arrays, known legacy files and
bounded generated malformed inputs. Check valid MIDI import→edit→save→reopen,
note Delete/Undo and playback scheduling. Native rejection must leave an already
open unsaved project usable on all supported OS families.

### 3. UI-02/UI-03: contain modal focus without breaking other input

- Prefer migrating Audio Settings and Plugin Browser to the existing
  `components/ui/Modal` contract rather than adding separate global key handlers.
  Review its existing Headless UI focus behavior, modal event guards and
  `modalShortcutScope` before reuse; preserve component-specific Apply/Cancel,
  scanning and device-switching behavior.
- Ensure accessible names, initial focus, Tab/Shift+Tab containment, background
  isolation and focus restoration. Respect configured `modal.close` bindings:
  default Escape should close; remapped/unassigned bindings must retain their
  documented behavior. Only the topmost dialog should handle closure.
- Test nested menus/selects, text editing, native file choosers and child plugin
  windows. Closing/cancelling them must not close the parent unintentionally or
  leave the main app inert. Preserve intentional modal-local shortcuts and the
  documented transport policy; background editing commands must not leak through.
- Inventory other custom modal implementations. Migrate only after identifying
  their semantics and testing them, not via an unreviewed global replacement.

Required tests: reproduce Add Track behind Audio Settings and prove it cannot
happen; exercise both dialogs with pointer, Tab/Shift+Tab, Enter, Escape, alternate
close bindings, Ctrl/Command text shortcuts, disabled/busy/error states and repeated
open/close. Assert actual focus and resulting state, not CSS strings. Rerun shared
dialog, onboarding, command-palette, input-profile and audio-settings regressions.

### 4. UI-04: keep controls reachable at supported sizes and font scales

- Inspect MainToolbar, TransportBar and their resizable hosts. Provide deliberate
  wrapping or accessible overflow menus for secondary actions; keep essential
  transport actions reachable. Avoid shrinking text below the user's preference.
- Use existing layout conventions and component-owned styles. Avoid global CSS
  overrides, runtime stylesheet strings, `!important`, or browser-specific fixes
  unless reproduced engine behavior requires a narrowly scoped fallback.
- Preserve vertical fader direction, slider keyboard/wheel behavior, focus rings,
  pan semantics, canvas coordinates and drag targets while changing layout.

Required tests: 800×600, 1280×800 and a larger window; app font sizes 100%, 125%,
150% plus supported endpoints; representative docked/hidden/detached panels,
long names, all shipped themes and dense projects. Verify hit testing, focus
visibility, labels, truncation/tooltips, scroll reachability and absence of overlap.
Scroll containers may overflow; essential controls must remain usable.
Test desktop scale factors separately from app font size and browser DPR.

### 5. UI-06: isolate native MIDI behavior before proposing its fix

Record the actual pointer target, focused element, active shortcut context,
selected note/track IDs, bridge request and detached window's `boot-ready` signal.
Distinguish an application defect from coordinate-automation error. Reproduce in
the installed Linux package; compare a native Windows/macOS run where available.
Do not change shortcut routing based solely on screenshots or mocked bridge calls.

Acceptance: correct note selection/Delete/Undo without track mutation; detach,
edit, close, reopen and redock; multiple editor sessions; plugin-window focus;
main-window shutdown with editors open. Keep native WebView option, startup
watchdog and teardown contracts intact. This remains an investigation, not a
sixth confirmed defect with a predetermined fix.

## How to cover the app systematically

### Build a maintained inventory, then exercise workflows

Create a machine-readable coverage inventory anchored in
`docs/implemented_features.md`, the manual, action registry, menus, context menus,
App/detached-window composition and native-only plugin/script editors. Actions
alone miss controls; component files alone miss workflows. Give each feature and
surface a stable ID, entry points, expected behavior, required state/input cases,
test references and per-platform results. Include placeholders explicitly as
non-functional UI rather than treating them as working features.

Start with the audit matrix and expand to every tab, menu, editor, context menu,
native dialog and detached window. Cover:

| Dimension | Required coverage |
| --- | --- |
| State | Empty and populated, selection/multi-selection, enabled/disabled, loading/busy, success/error, cancel/retry, unsaved/recovered |
| Input | Pointer, keyboard, text editing, wheel/trackpad, drag/drop, custom profiles, focus changes and applicable touch support |
| Layout | Minimum/normal/large windows, resizing, app font size, OS scale, long labels, themes, docking and multiple monitors |
| Editing | Add/change/delete, continuous edit grouping, Undo/Redo, save/reopen and recovery |
| Native integration | File choosers/import, devices, plugin editors, permissions, window creation/closing and actual backend effects |
| Accessibility | Names, roles, state, tab order, visible focus, keyboard-only operation and real screen-reader spot checks |

Build end-to-end journeys: create/import/record→edit→mix/route→save/reopen→export;
MIDI instrument→notes/automation→detach→save/reopen; plugins/presets; pitch editing;
clip launching; batch/region/DDP output; scripting; optional AI installation,
failure and successful inference. Exercise failure recovery with disposable data.
Every supported feature needs a behavioral case, not just a screenshot.

Use full coverage for critical data-preservation and known-failure boundaries.
Use pairwise combinations and risk-based exploratory sessions for the remaining
large state matrix, documenting what was sampled. Include large projects and
playback-active edits. Treat audio listening quality separately from UI evidence.

### Keep the coverage honest over time

Report surface inventory coverage, behavioral workflow coverage and native
platform coverage separately. A row is `pass`, `fail`, `untested` or `blocked`
for each declared environment; diagnostics and subjective audio remain separately
labelled. Never turn a skipped test or missing machine into a pass.

Check registered actions/surfaces against the inventory in CI; require review of
intentional exclusions and a coverage entry when features are added. Persist the
focused audit reproductions as maintained tests, not only ignored one-off scripts.
Retain failure traces, screenshots, native logs and artifact hashes. Review visual
baseline changes; do not regenerate them simply to make a failing test pass.

## Cross-platform qualification and release gates

| Layer | Gate |
| --- | --- |
| Change-local | Original failure reproduced before fix; focused unit/store/browser tests pass after it; review adjacent affected behavior |
| Integrated frontend | Full unit suite, production frontend build and complete applicable Chromium/WebKit suite; expand the current WebKit seven-spec allowlist to include new regressions and then remaining applicable specs |
| Native Linux | Installed candidate on Ubuntu, Debian, Mint and Fedora versions declared in the qualification plan; system WebKitGTK, actual desktop session and relevant X11/Wayland/scale combinations |
| Native Windows | Installed Release WebView2 app: project fidelity, dialogs/input/layout and native window workflows; Debug alone is insufficient |
| Native macOS | Packaged Release WKWebView app on supported OS/architectures, with Command shortcuts, focus and file/window behavior |
| Hardware/features | Actual audio/MIDI device and plugin workflow evidence; unavailable hardware stays untested; audio audition remains a separate gate |

The repository already defines Windows/macOS/Linux browser jobs and native
verification jobs. Reuse and extend them; job definitions are not evidence that a
new candidate passed. Playwright WebKit is not system WebKitGTK or WKWebView, and
Chromium is not the installed WebView2 host. Confirm exact supported OS versions
and package hashes in the release matrix rather than inventing compatibility.
Use matching browser identity/keyboard modifiers, and genuine native OS runs.

After the focused fixes pass, run `npm test`, `npm run build` and
`npm run test:e2e` from `frontend/`, plus affected native checks. Before a manual
handoff, complete the required CMake Debug build/copy and stop owned dev servers;
`python build.py dev --run` must need no pre-running server. Release qualification
uses separately built and installed Release artifacts with current frontend assets.

Do not publish a fix as platform-qualified until its required matrix passes.
Unavailable runners/hardware remain explicit release gaps. Do not waive a failure
as preexisting without separating and resolving its release impact. Review release
notes and run the required release-note gate before preparing a release; update
the app manual/website guides when public behavior changes. Keep installer,
provenance, update and store-publication gates from the Linux plan in force.

No test plan guarantees zero regressions. The acceptance criterion is concrete
evidence for each fix, preserved adjacent workflows, explicit platform results
and no unresolved release-blocking failures—not an assertion that all possible
UI behavior has been tested.


## Synthetic-source follow-up — 2026-10-01

See [synthetic audio verification](synthetic-audio-verification-2026-10-01.md)
for the generated clips, realtime stereo defect and revision 8 fix, native
recording/playback/export evidence, picker corrections and remaining gates.
This supersedes the older candidate number for this checkpoint, not its limits.
