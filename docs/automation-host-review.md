# Automation and plugin state review — 2026-09-16

Development working tree based on `7f59cff`; not a release qualification. Windows Debug only. The user-requested vendor set is AmpliTube, Archetype Misha Mansoor, Archetype Nolly, One Kit Wonder Metal and Komplete Kontrol. NAM Rack is an OpenStudio built-in.

## Supported targets

| Target | Support in this checkout |
|---|---|
| Track | Volume, pan, width, mute, trim volume |
| Instrument/bus pre-FX | Volume, pan, width |
| MIDI/instrument | Velocity, pitch bend, channel pressure and MIDI CC |
| Input FX and track FX | Host-exposed automatable parameters; routes follow reorder and are removed with their plugin |
| Dedicated instrument slot | Host-exposed parameters, separate from track FX; recording and removal/undo included |
| Built-in FX / NAM Rack | Eligible continuous, toggle and enum DSP controls; nonlinear NAM mappings shared with its editor |
| Master | Volume and pan |

NAM model/IR files, calibration, presets and topology/configuration controls are not envelope targets. Master/monitor FX automation, JSFX slider envelopes and CLAP editor-event capture are outside the implemented path. Vendor controls that are not exposed to the host cannot be recorded as envelopes. Kontakt libraries require host-automation assignments where the library has not provided them; a loaded One Kit Wonder instrument was not exercised. Komplete Kontrol nested controls depend on its mappings.

## Corrected behavior

- Native JUCE parameter notifications reach the main project's automation writer, including parameter/gesture events forwarded from isolated workers. Parameter callbacks only publish atomics; UI event construction happens on the control thread. Native instrument slots have a distinct route identity.
- Built-in editor gestures, including detached NAM Rack editors, use the same writer. Short begin/value/end edits are recorded even between writer ticks. Automation passes remain undoable.
- Read does not reset an empty plugin lane or a control in Off/Write/active Touch. Populated Read curves reclaim manually edited knobs, including constant curves. Touch suppresses playback immediately in the native host before the frontend receives the gesture.
- Track and master Read can be armed before creating a lane. Enabling Write also enables Read; disabling Write retains Read. Cubase-profile F6 opens the envelope panel; Alt/Option+R and Alt/Option+W uniformly toggle all tracks. Master remains separately controlled. Existing custom profile/scope rules still apply.
- Saving requests fresh native plugin/instrument state. A missing FX identity fails the save instead of shifting the following slot's state. Instrument snapshot errors are no longer silently discarded. Plugin load/state-rejection errors appear in the project-open result.
- Stopped VST3 changes exposed a real persistence defect in vendor checks. A pinned, fail-closed JUCE patch flushes pending changes and includes host-normalized values keyed by stable VST3 ParamID alongside the vendor chunks. The optional snapshot is restored after the vendor state. Old chunks without this child still load. No project or NAM DSP schema version changed.
- Existing FX removal closes native editors synchronously before releasing their processors; detached built-in window teardown is covered by the window lifecycle harness. Instrument automation is also retired on removal/replacement and restored with undo.

## Verification scope

| Check | Result |
|---|---|
| Frontend suite | **pass** — 189 files, 2,314 tests |
| Browser automation/shortcut suites | **pass** — 14 tests; Cubase Alt+W, Alt+R and F6 also exercised through the visible DOM with a screenshot |
| Native runtime safety | **pass** — 240 checks, including NAM state and hosted/instrument automation |
| Isolated worker suite | **pass** — 35 headless checks, including parameter gestures and state without an audio packet |
| Native window lifecycle | **pass** — 42 checks; removal closes track/input/master/monitor built-in editors and cancels queued reopening |
| AmpliTube 5, Misha Mansoor X, Nolly X, Komplete Kontrol, Kontakt 8 | **pass** — 48 checks per vendor run, including changed host values in fresh track/input instances and legacy/current state compatibility |
| Extra isolated-editor exercise | **fail** — foreground-focus assertion; opening/closing the editor and worker survival passed. Native isolated-window shortcut focus remains unqualified |
| Builds | **pass** — frontend production assets and CMake Debug, no C++ warnings; packaged index matches `frontend/dist`; website guide TypeScript check passed |

The isolated editor exercise returned `openAck=1`, `visible=1`, `focus=0`, then `afterCloseVisible=0` in all three cycles. Evidence: `output/review/isolation-Debug-20260916-083937-68be36/result.json`. Do not treat the headless suite or main-window browser shortcuts as proof of foreground shortcut routing in a real isolated vendor editor. This needs an interactive check with the plugin clicked into focus.

Evidence is local under `output/automation-*-tests.log`, `output/review/` and `output/automation-panel.png`. Vendor checks instantiate fresh plugins, change one exposed normalized parameter, serialize, remove, recreate and restore in both input and track FX. They also load legacy opaque state with the optional snapshot removed. This is objective host/state verification, not a sweep of every vendor knob or a user project reopened in the visible app.

Native editor capture is delivered at control rate through the main WebView, not sample-accurate gesture capture. Value-only plugins use a short touch timeout. Minimized/hidden main-window automation and every vendor's custom GUI gestures are not qualified here. Cubase Cross-over and advanced fill/trim workflows are not implemented. One Kit Wonder content, loaded Komplete Kontrol instruments, macOS/Linux hosting, Release packaging and subjective audio quality are **not_asserted**.

## Local handoff

Run `python build.py dev --run`; the Debug build and packaged frontend have been refreshed. No pre-running server is required. Task-owned browsers/servers were stopped and port 5183 was free at handoff. For the outstanding focus check, use the Cubase profile, click into an isolated plugin editor, and verify the intended host shortcut is either consumed by that editor or forwarded according to the plugin-window focus rules. Save/reopen your actual instrument presets and One Kit Wonder kit for content-specific confirmation.

## Reference behavior

- [Steinberg Cubase automation shortcuts](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/key_commands/key_commands_automation_category_c.html).
- [Cubase Read/Write](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/automation/automation_writeread_automation_c.html) and [automation modes](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/automation/automation_automation_modes_c.html).
- [VST3 host/plugin parameter communication](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Communication.html) and [state persistence](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Persistence.html).
- [Kontakt host automation](https://docs.native-instruments.com/ni-tech-manuals/kontakt-manual/en/classic-view) and [Komplete Kontrol plug-in mappings](https://docs.native-instruments.com/ni-tech-manuals/komplete-kontrol-manual/en/using-plug-ins).
