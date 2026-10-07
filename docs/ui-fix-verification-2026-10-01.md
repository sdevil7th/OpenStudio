# UI fixes and verification — 2026-10-01

Status: implemented in the working checkout and installed as revision 7 in the
Ubuntu 22.04 QA VM; **not published and not complete app/platform qualification**.
The [native follow-up](linux-native-followup-2026-10-01.md) records newer installed,
MIDI and shutdown results; the evidence below describes the preceding test stage. This follows the
[audit](linux-ui-audit-2026-10-01.md) and
[implementation/coverage plan](ui-fixes-and-coverage-plan.md).

## Implemented changes

| Finding | Change | Verification boundary |
| --- | --- | --- |
| UI-01 project data loss | Persist routing, sends, notes, waveform zoom, folder flags/membership, takes/active take, record-safe and spectral-view state. Normalize absent legacy routing fields. Restore native routes after destination tracks exist; report rejection and retain dirty state. | Real store save/load/save and bridge-call ordering covered. Requalification of the newly installed package, cross-OS fixture exchange and hardware routing remains open. |
| UI-05 malformed MIDI | Validate event timestamps/types, note/CC/value ranges, CC lane time and quantize backups before project teardown. Preserve current project and history on rejection. | Valid MIDI boundaries and invalid fixtures tested. This does not imply every conceivable malformed format is covered. |
| UI-02 Audio Settings | Use the shared modal's focus trap, naming and close-key policy. | Focus cycling, Escape, remapped close, background insertion and device-switching regressions. |
| UI-03 Plugin Browser | Add Headless UI dialog containment while retaining the browser action scope and supporting configured dialog/browser close commands. Embedded browser mode remains a panel. | Browser local/text commands, keyboard closure and actual system-WebKitGTK dialog interaction checked. |
| UI-04 scaled controls | Wrap toolbar/transport groups; keep track-header controls aligned at the top with scrolling when their fixed-height lane is too small. | Essential controls and track-name hit testing at 800×600 and 1280×800, 150% app fonts. OS fractional scaling remains separate. |

The wider testing found that trapping focus alone did not stop Ctrl+T from
inserting a track behind a dialog. DOM keyboard payloads now retain modal
ownership; global dispatch limits them to local registered actions and transport.
Text editing, close-key remapping and non-modal insertion remain covered, including
explicit Linux/Windows/macOS modifier mappings. These are not native Windows/macOS
execution results.

Project files keep the existing format version. The change cannot recover fields
already omitted from older saved files; existing backups should be retained.
No DSP, JUCE or dependency upgrade was included.

## Verification evidence

Evidence is local under `output/ui-fixes/`; logs and screenshots are gitignored.
The final evidence manifest identifies files, hashes and source state.

- **Pass:** 2,332 frontend unit tests, including the new project/MIDI and modal
  shortcut regressions. Original failure logs are retained alongside passing logs.
- **Pass:** frontend production build (notice check, TypeScript, Vite) and CMake
  Debug build. Bundler chunk-size and ineffective-dynamic-import warnings remain
  recorded; they were not suppressed. Generated frontend assets are synchronized
  to the Debug app.
- **Pass:** all 228 browser tests in Chromium and WebKit (zero failures/skips in
  the final run), plus a final 60-test rerun of affected screens and adjacent
  workflows. These runs overlap. Logs: `full-browser-final.log/json` and
  `affected-final.log/json`. The focused rerun includes the last track-header
  adjustment; do not treat earlier captures as proof of that final layout.
- **Pass:** 44 system WebKitGTK 2.52.6 checks using actual X11 pointer/keyboard
  events against built frontend assets: faders, single-step Undo, Audio Settings,
  Plugin Browser focus containment, default closure and blocked Ctrl+T insertion.
  This harness uses a mock audio bridge.
- **Pass:** native Linux Debug startup/runtime-path checks, 42 window-lifecycle
  assertions and 36 render/export checks. Debug used the development frontend
  during that native run; it is not an installed Release qualification.
  Audio quality is **not_asserted**.
- **Captured:** 139/140 browser surface combinations across 35 surfaces, two sizes
  and two engines, now with populated clip/MIDI fixtures. WebKit 1280 and Chromium
  800 contact-sheet review plus focused scaled screenshots supplement assertions.
  Capturing a screen does not pass its underlying feature or all tab/state variants.
  The bulk captures precede the last track-header adjustment; its final evidence
  is `scaled-track-header-800.png`, the focused browser run and the final GTK run.

An intermediate full run had 227 passes and one WebKit NAM source-drawer close
failure. The isolated reproduction passed without a NAM production change.
Keep that observation visible; the root cause was not established. A subsequent
full run and focused rerun verify the completed changes. Do not merge the counts
from overlapping runs into a larger unique-coverage claim.

The extended GTK harness initially chose the monitor-FX inline picker rather than
the full Plugin Browser; this was a test-entry-point error. The corrected test
opens the browser through Insert → Virtual Instrument on New Track and passes.

## App-wide testing started, with explicit gaps

[`ui-coverage-inventory.json`](ui-coverage-inventory.json) inventories **176 declared
features and 138 component/window source files**. Empty coverage entries are
untested, not passes. The inventory gate rejects missing/new/removed membership
until reconciled with `python3 tools/check-ui-coverage-inventory.py --update` and
reviewed. It does not prove that every state of a component was discovered.
Runtime discovery also enumerated **462 registered commands** into
`output/ui-fixes/registered-actions.json`; command execution is not implied.
Six component entries now link narrowly scoped passing scenarios; their other
states and platform combinations remain untested.

The maintained `tools/run-ui-surface-audit.mjs` reproduces the 35-surface capture
matrix and records browser errors, focus, geometry and command membership. Start
Vite separately and pass `--output <fresh-directory>`; `--url` and
`--webkit-executable` are optional. Expand this inventory with tabs, context menus,
native-only windows and complete workflows using the required dimensions in the
coverage plan. The added CI inventory check and UI regressions have not yet run
on GitHub.

Remaining at the end of the original run (see the native follow-up for items
partially closed since then):

1. Installed-candidate project round trips, actual Windows WebView2/macOS WKWebView
   behavior and the full Ubuntu/Debian/Mint/Fedora release matrix.
2. UI-06 native MIDI pointer/focus/pop-out investigation. Browser note Delete/Undo
   passes and native lifecycle creates MIDI windows, but neither proves the exact
   formerly observed pointer-driven native workflow is corrected.
3. Chromium's broad piano-roll capture still hits `Resulting promise was garbage
   collected`; dedicated MIDI behavior tests pass. The capture path was not
   repeatedly retried or counted as a product pass/failure.
4. Native Debug shutdown logged 42 leaked `DynamicObject` instances and a JUCE
   leak-detector assertion after the window harness. Its lifecycle report passes,
   but the shutdown diagnostic needs investigation; compilation is not proof of
   leak-free shutdown.
5. Live Audient recording/monitoring, listening, reconnect/suspend, third-party
   plugin interoperability, optional AI inference, screen-reader operation,
   Wayland/fractional-scale/multi-monitor workflows and exhaustive feature-state
   coverage. Existing release-plan failures and gates are not closed by this work.

The user can test the updated Debug checkout with `python build.py dev --run`;
no pre-running server is required. A new release-gated revision 7 package is now in Downloads and installed in the
QA VM; the physical host still has revision 5. See the native follow-up.


## Synthetic-source follow-up — 2026-10-01

See [synthetic audio verification](synthetic-audio-verification-2026-10-01.md)
for the generated clips, realtime stereo defect and revision 8 fix, native
recording/playback/export evidence, picker corrections and remaining gates.
This supersedes the older candidate number for this checkpoint, not its limits.
