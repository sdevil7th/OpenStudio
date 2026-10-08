# Free-plugin baseline states

The 13 `legacy/*.state` files are JUCE ValueTree state captures from the
September 29, 2026 working tree based on app commit
`52cbd7c112477ba0c139f200159d8ccc545accac`, before the editor overhaul and the
Reverb recall repair. NAM Rack is excluded.

These are default processor-state fixtures, **not** golden audio, full projects,
portable packs, or an exhaustive preset library. Do not use their passing result
as permission to change a DSP version or old-project audio behavior.

Run `powershell -File tools/run-free-plugin-headless-regression.ps1` after a Debug
build. The runner opens no application window or audio device. It checks exact
state round trips, historical properties including child trees, finite stereo
output at 44.1/48/96 kHz, and mono Pitch Correct pointer safety with varying block
lengths. Missing fixtures fail; ordinary test runs never regenerate them.

The executable's explicit `--capture-fixtures` flag can capture missing files
into a separate directory when establishing a reviewed baseline. Existing files
are never overwritten. Audio equivalence and subjective quality remain
`not_asserted`.
