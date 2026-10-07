# Linux UI audit — 2026-10-01

**Result: additional defects found; Linux UI qualification remains open.** This
audit extends the earlier fader/pan checks. It does not implement the fixes below
or establish complete feature, accessibility, Windows parity, or release readiness.

## Scope and evidence

- Source checkout: `9b8f219d52faebe0c26699a9ac2848523ad01575` plus the existing
  uncommitted Linux qualification changes. No production source was changed by
  this audit. Browser probes use the current checkout and a mock native bridge.
- Existing frontend E2E suite: **214 passed, zero failed/skipped/flaky**, across
  Chromium and Playwright WebKit. Both projects use Linux browser identity.
  Passing these tests did not detect the new defects below.
- Visual inventory: 35 surfaces at 1280×800 and 800×600 in both engines;
  **139 of 140 captures completed**, followed by contact-sheet inspection and
  individual inspection of suspect layouts. The missing Chromium piano-roll
  capture is a harness failure, not a passed check. Populated clip/MIDI fixtures,
  pointer/keyboard probes and app-font scaling checks supplement the inventory.
- Installed application: Ubuntu 22.04 GNOME/X11 QA VM, native WebKitGTK
  `2.50.4-0ubuntu0.22.04.1`, package `0.1.04-6`, real X11 mouse/key events.
  Package SHA-256:
  `db6fb33deff512f362d2a5b85c287dd15d9bf737d28a267d2768ed1ae4e79a1c`.
  This is a disposable QA project and VM, not a test of the user's physical
  Audient input or a Windows installation.
- App font scale: 150%, browser device-pixel ratio 2, both viewport sizes in
  WebKit. This is **not** OS fractional scaling or a Wayland qualification.

Local screenshots, scripts, JSON results and logs are in
[`output/linux-ui-broad-audit/`](../output/linux-ui-broad-audit/).
`manifest.json` records their hashes. This output directory is gitignored; retain
it with the audit handoff. Paths below are relative to that directory.

## Confirmed defects

### UI-01 — P1: project save/reopen drops track state

**Failed in frontend round-trip probes and the installed app.** In Track Routing,
change stereo width and master send, add a send to another track, save, then reopen
the same project. The send disappears; width is blank and master send is unchecked
in the reopened native dialog. This is a release blocker involving project data,
not just appearance.

The serializer's explicit field list at
[`project.ts`](../frontend/src/store/actions/project.ts) omits `stereoWidth`,
`masterSendEnabled`, `outputStartChannel`, `outputChannelCount`,
`playbackOffsetMs`, `phaseInverted`, `trackChannelCount` and `sends`.
The round-trip probe reports save/load success despite those omissions.

An extended store-level probe also loses track notes, waveform zoom,
`parentFolderId`, takes and active-take selection. These additional fields are
confirmed through serialization, **not through native folder/comping workflows**.
The extended probe uses a correctly shaped send object; the first probe's send
fixture had incorrect level/enabled field names, which are not needed for the
omission finding.

Evidence: `extended-roundtrip.json`, `extended-roundtrip.mjs`,
`native/17-routing-configured.png`, `native/19-routing-after-reopen.png`.

Fix acceptance: preserve all supported persisted track fields, supply compatible
defaults for older projects, and cover save/reopen plus audible routing separately.
Require a native project round trip and folder/take recovery checks before closure.

### UI-02 — P1: Audio Settings allows keyboard edits behind the dialog

**Failed in both browser engines; Escape failure also observed natively.** Open
Audio Settings and press Tab repeatedly. Focus leaves the dialog and enters the
workspace. In the focused WebKit reproduction, Tab reached **Add new audio track**;
Enter changed track count from one to two while Audio Settings remained open.
Escape does not close the dialog, and the dialog lacks dialog semantics.

Evidence: `interactions/results.json`, `modal-background.json`,
`settings-background-keyboard-edit.png`,
`native/06-audio-settings-escape-confirmed.png`.
Source: [`SettingsModal.tsx`](../frontend/src/components/SettingsModal.tsx).

Fix acceptance: initial focus, contained Tab/Shift+Tab, inert background, Escape
and focus restoration, accessible dialog name, plus no project/transport commands
reaching the obscured workspace.

### UI-03 — P2: Plugin Browser has the same modal keyboard gaps

**Failed in browser interaction checks.** Escape leaves Plugin Browser open;
Tab reaches background track controls. No dialog role is exposed. A background
mutation was not demonstrated for this dialog, so do not copy UI-02's mutation
claim to it.

Evidence: `interactions/results.json`, `extra/results.json`,
`modal-background.json`. Source:
[`PluginBrowser.tsx`](../frontend/src/components/PluginBrowser.tsx).
Use the same modal acceptance checks as UI-02 and inspect other custom dialogs
before treating a shared fix as complete.

### UI-04 — P2: larger app fonts push compact-window controls off-screen

**Failed at 800×600 with 150% app font size in WebKit.** Main-toolbar Audio
Settings, AI and grid controls extend beyond the right edge; transport controls
also overflow. Audio Settings' right edge is approximately 1068 CSS pixels in an
800-pixel viewport. Screenshots show cropped controls and increased horizontal
scrolling in dialogs. This is a supported preference/layout combination, not an
unsupported tiny test viewport: the native minimum is 800×600.

Evidence: `scaled/800-workspace.png`, `scaled-confirmed/geometry.json` and its
ten screenshots; reproduction scripts `font-scale-audit.mjs` and
`font-scale-confirm.mjs`. Inspect toolbar sizing and the app-wide font scaling
in [`App.tsx`](../frontend/src/App.tsx).

Fix acceptance: all essential toolbar/transport actions remain reachable through
wrapping or deliberate overflow controls, with pointer and keyboard tests at both
sizes. Qualify actual desktop scaling separately.

### UI-05 — P2: malformed MIDI events pass validation and crash the frontend

**Failed in the installed app with an intentionally invalid QA fixture.** A MIDI
event lacking numeric `timestamp` was accepted during project loading; opening it
reached the application error boundary with an undefined `toFixed` error. The
initial fixture used `time` instead of `timestamp`. A corrected fixture built with
the real MIDI actions loaded successfully.

This is an input-validation defect, **not evidence that a normally saved valid
MIDI project crashes**. Event validation currently checks object shape without
validating required numeric event fields.

Evidence: `malformed-midi.osproj`, `native/12-project-loaded.png`,
`native/13-valid-project-loaded.png`.
Source: [`projectValidation.ts`](../frontend/src/utils/projectValidation.ts).

Fix acceptance: reject or explicitly migrate malformed event data before replacing
the current project; show an actionable error and preserve the open project.

## Native observations requiring investigation

### UI-06 — P1 investigation: MIDI interaction target and pop-out mismatch

**Follow-up:** revision 7 passes native Pop Out/Dock and docked/detached note
Delete/Undo with paced X11 input. The initial instantaneous-event harness could
misdirect clicks. See [native evidence](linux-native-followup-2026-10-01.md); the
original observations below do not establish a MIDI product defect.

The installed MIDI editor displayed a populated clip. Clicking Pop Out produced
no detached MIDI window in two attempts; window enumeration found none. Later,
clicking inside the visible note grid followed by Ctrl+A/Delete removed the tracks
rather than MIDI events; Undo restored them. This needs native input/focus
instrumentation before assigning a root cause or claiming a reproducible fix.
Coordinate-based desktop automation is a possible confounder.

The equivalent Linux-identity browser MIDI checks **pass**: context is
`piano_roll`, Delete removes events, Undo restores them, and tracks survive.
Browser Pop Out also invokes the expected native-bridge method, but the bridge is
mocked, so it cannot prove a native window appeared.

Evidence: `native/22-midi-editor-open.png`, `native/23-midi-popout.png`,
`native/24-midi-popout-settled.png`, `native-x11-windows.txt`,
`native/30-midi-notes-selected.png`, `native/31-midi-notes-deleted.png`,
`native/32-midi-notes-restored.png`, `midi-delete-linux.json`, `midi-popout.json`.

Acceptance: reproduce with native focus/context logging, confirm actual pointer
targets and successful boot of the detached WebView, then verify note edit,
Delete, Undo and close/reopen without unintended track mutations.

## Coverage matrix

**Checked** means only the scope stated in that cell. It does not mean every
control, state, error path or backend feature passed. Browser visual checks use
mock data. **Untested** means no new native feature qualification in this audit.

| Area | Browser audit | Installed app audit |
| --- | --- | --- |
| Workspace, mixer, transport | Checked: both sizes/engines; existing control tests pass. Failed: 150% font layout | Checked: visible workspace, add track, Undo/Redo; no new audio qualification |
| Timeline | Checked: clip drag 1s→3s, Undo→1s, split produces two clips in both engines | Checked: valid project/clip display; full edit matrix untested |
| Audio Settings | Failed: focus, Escape, background mutation | Failed: Escape; device-operation retest untested |
| Project Settings | Checked: layout at both sizes; font-scale screenshots | Untested |
| Preferences | Checked: initial tab/layout and scaled capture; all tabs not exercised | Untested |
| Keyboard, Mouse & Trackpad | Checked: layout and existing profile tests | Untested |
| Render dialog | Checked: layout, existing planning/error tests; native output not asserted | Untested |
| Routing Matrix | Checked: fixture layout | Untested |
| Track Routing | Failed: save/load state persistence | Failed: width/master/send state after reopen |
| Channel EQ modal | Checked: layout in both engines | Untested: channel modal audio response |
| Plugin Browser | Failed: modal keyboard behavior | Checked: FX chain list and adding built-in EQ |
| Built-in EQ editor window | Not part of the 35-surface mock inventory | Checked: settled native editor renders; parameter/audio accuracy untested |
| Envelopes | Checked: dialog layout only | Untested |
| Clip Properties | Checked: empty and corrected populated fixture layout | Untested |
| Piano Roll | Checked: populated WebKit layout, Linux-identity note Delete/Undo in both engines; broad Chromium capture has harness errors | Needs investigation: UI-06 |
| Pitch Editor | Checked: panel layout, not audio quality | Checked: actual 220 Hz tone analysis displayed as A3; edits/render/audition untested |
| Virtual keyboard | Checked: layout with mixer; compact layout cramped | Untested: native MIDI input/output |
| Media Explorer | Checked: mock folder/file list layout | Untested: native import/OS drag-and-drop |
| Clip Launcher | Checked: empty slot/grid layout | Untested: launch/record performance |
| Markers/regions | Checked: empty panel layout | Untested: marker/region operations |
| Render Queue | Checked: empty layout and existing planning tests | Untested: real queued exports |
| Region Render Matrix | Checked: empty-state layout | Untested: region export |
| Batch Converter | Checked: empty dialog layout | Untested: conversion |
| Dynamic Split | Checked: dialog layout | Untested: detection/split output |
| Theme Editor | Checked: layout, scroll footer into view, Close | Checked: native window contents; theme round trips untested |
| Toolbar Editor | Checked: empty-state layout | Untested: customization persistence |
| Timecode | Checked: settings layout | Untested: sync/device operation |
| Script Editor | Checked: initial editor layout | Untested: script execution/native APIs |
| AI Tools Setup | Checked: unavailable-hardware/mock state layout | Untested: download/install/inference |
| Stem Separation | Checked: missing-runtime state layout | Untested: separation/audio quality |
| Help Reference | Checked: layout | Untested: complete content/link review |
| Getting Started | Checked: initial guide layout | Checked: first-run choices; all guide steps untested |
| Command Palette | Checked: layout and keyboard surface tests | Checked: search and opening requested panels |
| Clean Project | Checked: empty-state layout | Untested: destructive cleanup |
| Project Compare | Checked: loading shell only; comparison result untested | Untested |
| DDP Export | Checked: empty/no-project dialog layout | Untested: authored disc output |
| Undo History | Checked: panel layout; timeline Undo tested separately | Checked: track Undo/Redo, not complete history operations |
| Save/Open and malformed projects | Failed: UI-01 serialization | Checked: native chooser/valid load; failed UI-01 and UI-05 |

## Limits, excluded evidence and remaining work

- The broad inventory is a visual/reachability audit, not an exhaustive interaction
  matrix for every feature. No actual Windows installation was available for a
  matched native comparison; Chromium is not equivalent to Windows WebView2.
- Third-party plugin GUIs, live Audient recording, listening/latency, reconnect,
  suspend/resume, AI inference, native file drag-and-drop, multi-monitor sessions,
  Wayland, OS fractional scaling and screen-reader operation remain untested here.
  Audio quality is **not_asserted**. Pitch-analysis display is not proof of corrected
  audio quality.
- Accessibility-name/overflow inventories and an empty native AT-SPI subtree are
  **diagnostic_only**. They need control-level or screen-reader confirmation.
  Off-screen content in a working scroll container is not automatically a defect.
  Theme footer and mixer controls could be brought into view in browser checks.
- The native built-in EQ was initially white while loading, then rendered normally
  (`native/37-eq-settled.png`); this is not a confirmed persistent blank-window bug.
  A native minimum-size request left the window maximized, so screenshot 38 does
  not prove native 800×600 behavior.
- Root-level initial surface screenshots were taken before the startup overlay
  cleared; use `visible-surfaces/` instead. Initial MIDI/clip-property fixtures
  showed empty states; use `populated-surfaces/` and dedicated interaction probes
  for populated behavior. Chromium capture evaluation hit a garbage-collected
  promise in three attempts across the inventory/supplement; it is not counted as
  a product failure or a pass, and that capture path was not retried further.
- The earlier `midi-delete.json` WebKit Ctrl+A failure used a macOS browser
  identity. Use corrected `midi-delete-linux.json`. Native screenshots 26–29 came
  from a click outside the note grid and are not MIDI-defect evidence; the later
  observation is separately recorded with its coordinate-automation limitation.
- Standalone visual/modal probes use default browser identities; WebKit can
  display macOS shortcut labels there. Do not use those labels to assert Linux
  shortcut parity. The full E2E suite and dedicated MIDI shortcut retest explicitly
  use Linux identity; Tab/Enter/Escape modal findings do not depend on Control
  versus Command mapping.

Fix order: UI-01 project preservation; UI-02/UI-03 modal keyboard isolation;
instrument UI-06 native MIDI behavior; UI-04 responsive controls; UI-05 project
validation. Add focused regression coverage for the actual failures, repeat the
native checks, then continue the broader release gates in the
[Linux qualification plan](linux-installation-and-qualification-plan.md).
