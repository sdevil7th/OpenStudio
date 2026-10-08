# Native Linux follow-up — 2026-10-01

This closes specific Linux checks, not full app qualification. Source is
`9b8f219d52faebe0c26699a9ac2848523ad01575` plus the uncommitted qualification
changes. The physical host still has **0.1.04-5** installed. The disposable
Ubuntu 22.04 GNOME/X11 VM was upgraded from **0.1.04-6 to 0.1.04-7**, without
uninstalling. Nothing was published.

## Candidate and verification

Local installer: `~/Downloads/OpenStudio-0.1.04-7-ubuntu-22.04-amd64.deb`.
SHA256: `19f9d9602bc1edadb9efa864dd1f24f4282f652431293981b6db0fe584164c98`.
The native executable was rebuilt in the Ubuntu 22.04 baseline; all 142 packaged
frontend files match `frontend/dist`. Release notes were reviewed and validated.
APT upgrade passed; this does not resolve App Center's “already installed” display.

- **Pass:** installed startup and runtime-path checks, 42 native window lifecycle
  assertions, 35 render/export checks, and the Ubuntu 22.04 ABI/glibc 2.35 gate.
  The 36th render check, Windows-only isolated-plugin parity, is **not_asserted**,
  as is subjective audio quality.
- **Pass:** actual installed save → reopen → save. A fresh save timestamp proves
  that the serializer ran. All 15 sentinel fields survive, including routing,
  disabled/zero-level sends, notes, folder membership, take/active-take data,
  record-safe and spectral display state. Three tracks and MIDI events survive.
  The reopened native routing dialog shows the expected controls. This does not
  establish hardware output/send audibility or cross-OS project exchange.
- **Pass:** opening a malformed MIDI fixture leaves the original valid document
  active. Saving afterward updates the original project, retains valid events,
  and leaves the malformed fixture unchanged. The transient error toast was not
  captured reliably; no screenshot is claimed as proof of its wording.
- **Pass:** native MIDI Pop Out, Dock, and note Select All/Delete/Undo in both
  docked and detached editors. Screenshots show note count 1 → 0 → 1 while tracks
  remain present. This does not qualify every piano-roll tool or resize behavior.
- **Pass:** installed Audio Settings focus remains inside after a 12-Tab cycle,
  Escape closes it, and Ctrl+T insertion is blocked;
  the saved project still has exactly the three original tracks.

The old MIDI automation used instantaneous mouse movement/press/release. It
reproduced the apparent Pop Out failure; allowing pointer movement to settle and
holding the button for 120–150 ms opens the actual native window. The corrected
pointer runs pass without a MIDI production-code change. The earlier UI-06
observation is not sufficient evidence of a product defect. Screenshots alone
also confused the editor's cursor/start readout with clip position; saved MIDI
clip startTime remains zero.

## Shutdown correction

The lifecycle test's `shared_ptr<std::function<void()>>` captured itself, retaining
all 42 check objects. Its callback now captures a weak reference; each pending
timer owns the next invocation. The Debug rebuild and lifecycle retest pass all
42 checks, with no previous DynamicObject leak or JUCE assertion in the logs.
This fixes test-runner ownership, not an assertion that the entire app has no leaks.

`tools/run-linux-qualification.py` now fails qualification on JUCE leaked-object
or assertion diagnostics even if the executable exits zero and its JSON report
says success. The original failing log fails this gate; the corrected Debug and
installed Release logs pass. Thirteen Python qualification/packaging/ABI tests
pass. The new tooling test is included in Verify CI; it has not run remotely.

## Audient: partial evidence, still open

The user connected a live source to input 1. A 20-second direct ALSA capture at
48 kHz captures all 12 physical channels: input 1 peak **0.2525 (about −12 dBFS)**,
RMS 0.064; input 2 remains near its noise floor. This establishes a working Linux
hardware input, not the full DAW recording/monitoring path.

The candidate's native AudioRecorder probe opens at 44.1/48 kHz, writes valid
files and reports zero xruns, but these later captures have very low levels.
Actual GUI recording also creates and saves a mono clip: the installed revision 5
using default ALSA/PipeWire recorded about 48 seconds, and a clean direct-Audient
launch of the revision 7 build recorded about 29 seconds at 48 kHz. Both are very
quiet. Whether the source stayed active during those captures is awaiting user
confirmation; **live DAW input fidelity and monitoring remain not_asserted**.
The revision 7 physical-host run used the built candidate, not an installed
revision 7 package. No monitoring or recorded-audio playback was enabled.

Two attempts to switch revision 5 from active PipeWire/default ALSA to direct
Audient access returned **“no channels”** and restored the old settings. `/proc`
and device-owner checks show PipeWire holding the capture/playback device at
that point. A clean direct-device launch succeeds. The ownership conflict is a
likely explanation, not a fully established fix. Do not mark seamless driver
switching qualified. Prior settings were backed up and restored after the test.

Live listening, latency, physical reconnect and suspend/resume are still open.

## Windows/macOS and evidence boundaries

No native Windows/macOS host is connected, and the repository reports zero
self-hosted Actions runners. Existing hosted CI definitions do not execute the
current uncommitted checkout automatically. Browser modifier emulation and the
Linux results above are not native Windows/macOS evidence. Those platform gates
remain open, along with the other-distribution revision-7 matrix and the broader
feature inventory in `docs/ui-coverage-inventory.json`.

Local evidence is under `output/ui-fixes/installed-revision7/`,
`output/ui-fixes/native-debug-leak-fixed/`, `output/ui-fixes/audient-live/`, and
`output/linux-ui-broad-audit/native/rev7-*.png`. The artifact and round-trip JSON
reports record hashes and assertions. Original failed automation captures remain
available; do not treat their filenames as test verdicts.


## Synthetic-source follow-up — 2026-10-01

See [synthetic audio verification](synthetic-audio-verification-2026-10-01.md)
for the generated clips, realtime stereo defect and revision 8 fix, native
recording/playback/export evidence, picker corrections and remaining gates.
This supersedes the older candidate number for this checkpoint, not its limits.
