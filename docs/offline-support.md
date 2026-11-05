# Offline support and export inspection

Unreleased development work added after app commit `f45637be`. The support companion
is packaged separately for Windows, macOS and Linux. It adds no collectors, timers,
threads, buffers, callbacks, uploads, or logging to the running DAW. Ordinary
0.1.09 candidate builds also compile out callback timing profiling, trace storage,
ARA callback timing/log formatting and per-block ARA debug-state updates.
Essential engine scheduling, meters and existing fault handling remain; this is
not a claim that those engine operations cost zero. Missing timing is reported as
unavailable, never as zero failures. See [candidate qualification](certification-0.1.09.md).
No release containing this work has been published here.

**Close OpenStudio before running support tools. Keep it closed until the operation
finishes, then close the support window before reopening the DAW.** The tools check
for OpenStudio and its workers once at entry and refuse to proceed if found, or if
process enumeration fails. They cannot prevent another process from launching the
DAW later, and cannot recognize a renamed executable. They do use CPU, memory and
disk while explicitly running. They never silently start a diagnostic render.

## Open the installed companion

Close OpenStudio first, then use the launcher for your platform:

| Platform | Launcher |
| --- | --- |
| Windows installer / MSIX | **OpenStudio Support** in the Start menu. A portable folder also has `OpenStudioSupport.exe`. |
| macOS | Drag both **OpenStudio.app** and **OpenStudio Support.app** from the DMG into the same Applications folder. Open **OpenStudio Support** in Finder. The small launcher uses the matching support runtime inside OpenStudio.app, so app updates replace that runtime too. Intel and Apple silicon runtimes are both included. |
| Linux DEB / RPM | **OpenStudio Support** in the desktop application menu. No login item or service is installed. |
| Linux AppImage | Extract the `with-support.tar.gz` download in a file manager. Open the separate **OpenStudioSupport-…AppImage** after closing the DAW AppImage. Both launchers are independent. |

1. Open the companion explicitly.
2. Leave **Collect existing evidence** selected, describe what happened, and click
   **Run selected operation**. You can instead inspect an existing audio/MIDI export.
3. Click **Open output folder** and review its files. Dumps are excluded unless
   explicitly selected; they contain unredacted process memory.
4. Choose **Create reviewed ZIP**, tick the review confirmation, and run it.
   Click **Open output folder** and attach the ZIP to your support request yourself.
5. Close the support window before reopening OpenStudio.

Users install no Python, Node.js, libraries, or terminal tools. The companion
bundles its interpreter, Tk window, audio decoder and a bounded JavaScript engine
containing the app's MIDI serializer. Nothing is registered to run at login,
DAW startup, recording, export, crash or shutdown. Installation space increases;
normal DAW execution loads none of this payload. Native crash capture remains;
the Windows crash helper waits on events during normal use. Automatic periodic
UI-hang monitoring is disabled in ordinary builds. Its final-Quit watchdog starts
only after Quit is committed. Explicitly launching Support does consume resources.

## Developer source launch

From the source checkout, using Python 3.11 or newer:

```sh
python tools/openstudio-support.py
```

This opens a separate window with four operations: **Collect existing evidence**,
**Inspect audio export**, **Inspect MIDI export**, and **Create reviewed ZIP**.
Tk is required for the window. The command-line operations below do not need Tk.
Choose a **new** output directory for each report. Existing reports, projects,
media and ZIPs are never overwritten.

Collection and MIDI structure inspection use the Python standard library. Audio
inspection needs NumPy and SoundFile; install them in a separate environment,
not the application's AI/audio runtime:

```sh
python -m venv .venv-support
.venv-support/Scripts/python -m pip install -r tools/support-requirements.txt
.venv-support/Scripts/python tools/openstudio-support.py
```

On macOS/Linux use `.venv-support/bin/python` instead. MIDI comparison with a saved
project also needs Node.js and the checkout's existing frontend dependencies
(`npm --prefix frontend ci` if not installed). It loads the actual clip serializer
in a short-lived Node process: no browser, listening server, plugin, or audio device
is opened. Serializer source hashes are included so later code changes are visible.

## Developer command-line collection

```sh
python tools/openstudio-support.py collect --output output/support-review
```

Automatic discovery checks the platform's existing OpenStudio diagnostic locations.
On Windows this includes the actual Documents known folder, including relocation,
and `%APPDATA%/OpenStudio/logs`. Use `--log-dir "path"` (repeatable) to replace the
default locations, for example when collecting a startup log beside an executable.
Only exact known startup/debug/crash/hang/plugin-scan filenames and allowlisted
settings files are read, without recursion. The added `plugin_scan_debug.txt`
preserves scanner failures. Structured snapshots of `PluginList.xml`,
`PluginSearchPaths.xml`, `PluginBlacklist.txt`, `PluginScanDeadMansPedal.txt` and
`PluginHosting.json` retain plugin inventory, versions, paths after redaction,
blacklist/unfinished-scan entries and isolation choices. Only selected device-type,
rate, buffer and channel-mask fields from `audio_device_settings.xml` are included.
Plugin state, arbitrary XML fields and device names are excluded. No plugin is loaded,
scanned or executed. Settings describe collection time, not the original incident.
Use `--route-report "mix_render_route_report.json"` to select existing render reports
and `--description "What happened and what I expected"` to supply context.

The output contains `summary.txt`, `report.json`, explicitly selected evidence and
`manifest.json` with checksums. Current OS/CPU-count information is labelled
**at collection time**, not evidence of conditions during an earlier incident.
Logs may span sessions and builds; their contents are not automatically assigned
to a particular incident. Missing evidence is `not_asserted`, not a successful check.
Original filenames, sizes, modification times and tail truncation are recorded;
modification time is not treated as the time of an incident.

The window also offers optional **App executable**, **Symbol archive** and
**OS crash report** fields. The installed app is found beside the frozen companion
or in its enclosing macOS app when possible. Separate AppImages cannot inspect an
unmounted sibling image: use an extracted app executable to identify its payload.
Source launches and other portable layouts can also select the app explicitly.
Equivalent developer flags are `--app`, `--symbols` and repeatable `--crash-report`.
OS reports must be existing `.ips`, `.crash`, `.txt`, `.log` or `.json` files.
Support does not enable OS dumps, modify system settings, run a debugger, collect a
live process dump, or query unrelated system events. Text is redacted for review.

Windows dump module IDs are extracted even when **Include unredacted crash dumps**
is unticked; only module basenames and debug IDs are retained, not memory. This
metadata inspection is bounded to dumps of 512 MiB or less, and does not change the
32 MiB limit for copying a dump. Apple image UUIDs and explicit Linux build-ID
fields are recognized in selected OS report formats. Missing/unrecognized IDs stay
unavailable. The current installed binary has its own hash and debug identity and
is never silently assigned to an older crash. Matching IDs establish a debug-file
match, not a diagnosis or a trustworthy signature.

Privacy and bounds:

- Original audio, MIDI and project files are not bundled. No recursive directory
  collection, environment dump, process list, serial number or hostname is saved.
- Text filters replace known paths, names in structured fields, URLs, email
  addresses and common credential fields. **Redaction is best effort.** Free-form
  text can still contain private information. Read every file before sharing.
- Only the latest 512 KiB of each log is retained, with truncation disclosed.
- Settings and OS report identity parsing are bounded to 2 MiB; at most 90 evidence
  files are copied. XML entities/DTDs, symbolic-link files and special files are rejected.
- Dumps are excluded unless `--include-dumps` is explicitly selected. Included
  dumps are **unredacted memory** and can contain credentials or audio fragments.
  Each dump is limited to 32 MiB; the collection is limited to 128 MiB. Oversized
  or unreadable evidence is reported as unavailable, not silently treated as present.
- A ZIP is created only on request after review. It contains only manifest-listed,
  unchanged files. Neighbouring projects/media are never picked up.

After reviewing the folder:

```sh
python tools/openstudio-support.py bundle output/support-review --reviewed --output output/support.zip
```

Nothing is uploaded. Share the ZIP through your chosen support channel. If evidence
was changed after collection, bundling refuses it; collect a new report to establish
new checksums and review it again. Remove information at its source copy rather than
editing the original application logs.

## Inspect an audio export

```sh
python tools/openstudio-support.py audio "mix.wav" --route-report "mix_render_route_report.json" --output output/audio-review
```

The inspector streams the decoded audio in bounded blocks, checks RIFF/AIFF chunk
lengths independently where supported, checks frames and non-finite samples, and
reports duration, channels and rate. Other container validation relies on the
installed decoder and cannot prove that every truncated compressed stream is caught.
Raw PCM and unsupported formats are not guessed. Full-scale sample counts and
exact-silence lengths are **diagnostic_only**; they are not proof of audible distortion
or missing music.

The optional existing route report supplies requested settings, tracks, clips and
planned sample count. Lossless duration comparison allows one output frame for
rounding. Lossy codec-padding duration is **not_asserted**. Source-file existence is
checked only at collection time. Existing route reports have no output hash or
completion record, so their association with the chosen output is **not_asserted**.
A matching report or valid file cannot prove every track contributed audible sound.

For saved-project metadata comparison, add `--project "song.osproj"`. Advanced
source comparison is an explicit extra pass:

```sh
python tools/openstudio-support.py audio "mix.wav" --project "song.osproj" --route-report "mix_render_route_report.json" --reference --start 0 --pan-law linear --output output/source-review
```

This reuses the developer's independent neutral-mix reference. Choose the actual
export start and pan law. It supports a limited lossless, neutral audio master mix;
plugins, instruments, automation, normalization,
crossfades and other unsupported processing prevent a completeness claim. Do not
omit the route report: it is required to check scope, start and normalization. Unsupported
processing is **not_asserted**. A sample comparison concerns the supplied snapshot
and interpretation, not the original export-time state or subjective quality.

## Inspect a MIDI export

```sh
python tools/openstudio-support.py midi "song.mid" --output output/midi-structure
python tools/openstudio-support.py midi "song.mid" --project "song.osproj" --output output/midi-comparison
```

Supported files are synchronous Standard MIDI Files type 0/1 with PPQN timing.
Type 2 and SMPTE timing are **not_asserted**. Inputs are limited to 32 MiB and
250,000 parsed events. Structure inspection checks chunk boundaries, running status,
event data and end-of-track markers. It reports channel-event counts, tempo/meter,
other event types and diagnostic note pairing. Missing explicit note-offs do not
automatically prove a stuck note: sustain and all-notes-off can change interpretation.

With a project, current frontend preparation accounts for clip trimming, loops,
muted notes/clips and MIDI effects. Comparison checks ordered channel events,
channels, values, tempo, meter and musical track count; timing allows one SMF tick.
It is scoped to the supplied saved bytes and current serializer, not an unsaved
or older export-time state. Unknown source representations prevent a full claim.
Metadata/conductor-only tracks are separate from tracks containing channel events.
The tool does not certify playback sound in another DAW or instrument.

For **Export Selected MIDI Clips** or **Export This MIDI Clip**, supply each exact
saved clip ID using `--clip-id ID`. The scope and tempo map are rebased together:

```sh
python tools/openstudio-support.py midi "clip.mid" --project "song.osproj" --clip-id clip-id --output output/clip-review
```

In the support window, enter IDs separated by commas. A mismatched or missing ID is
reported as unverified. Legacy note-array projects must first be migrated using the
app's normal project loading/saving workflow; the inspector never rewrites them.

## Interpretation and developer checks

Reports use **pass**, **fail**, **diagnostic_only**, and **not_asserted** for individual
checks. The overall report remains `diagnostic_only` unless a checked invariant
fails. Original content completeness and subjective audio quality remain
`not_asserted`. CLI exit 0 means the operation completed without a failed check,
not that all content was verified; 2 means a check failed; 1 means a prerequisite or
tool error prevented completion. Read the report, not just the exit code.

```sh
python -m unittest tools.test_openstudio_support -v
```

Tests use synthetic files and temporary folders, never audio devices or user media.
Production crash analysis also requires symbols/source maps matching the original
build. The mechanisms below preserve and match those files; they do not create a
missing JavaScript stack trace or reconstruct past resource pressure. Optional
diagnostic re-exports and new runtime telemetry are outside this
implementation; neither is enabled by installing or running these tools.

## Build identities and developer symbols

CMake writes `OpenStudio.build-identity.json` beside runtime assets after building.
It records the build version/configuration, source revision and dirty-state flag,
native debug IDs, pre-signing binary hashes and packaged JavaScript hashes. The DAW
never reads it. Build hosts need Python 3.11+; installed users still need no Python.
Signing, stripping or packaging can change the file hash while preserving debug IDs.
An identity match is therefore separate from a pre-signing byte match.

`build.py prod` and the release workflow archive symbols before signing/packaging:

```sh
python tools/build-symbols.py archive --app build/OpenStudio_artefacts/Release/OpenStudio.exe --build-dir build
```

Use `OpenStudio.app` on macOS or `OpenStudio` on Linux. The existing PowerShell
`archive-runtime-symbols.ps1` delegates to this cross-platform archiver. Each
`output/symbols/<native-sha256>` directory is immutable; mismatched or missing
symbols, stale frontend maps and changed binaries fail the archive operation.
Windows checks PE/PDB GUID plus age, macOS checks all Mach-O/dSYM UUIDs, and Linux
checks ELF/GNU build IDs against extracted debug files. Native binaries are retained
with their symbols. macOS also retains the dSYM bundle for standard Apple tools.

Frontend builds place hidden JavaScript maps and matching JavaScript in
`frontend/debug-symbols`, outside `dist`. Maps include source content; do not add
this directory or native symbols to installers. There is no `sourceMappingURL`
and no map code or collector in the app. CSS source mapping is not qualified.
Archives include a hash-checked frontend inventory; native symbol matching does
not assert that a supplied frontend error came from that JavaScript build.

Release CI retains separate `*-debug-symbols` Actions artifacts for up to 90 days,
subject to repository retention settings. They are not release attachments or
Store payloads, and Actions artifact access follows repository permissions.
Before a future release, retain the exact archive and source commit in the team's
long-term support storage; CI retention is not permanent. Rebuilding the same
version later is not a substitute. No release workflow was invoked for this work.

Ordinary builds also omit message-thread heartbeat/fault polling. Existing
failure-only recording/processor protection remains; pending fault counts are
flushed from control-side stop/shutdown paths. Explicit diagnostic builds can opt
into timing and ARA logs with `OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS=ON`, and incur
overhead. Release packaging rejects those builds. The removed normal UI-hang
watchdog means a freeze during a running session no longer automatically produces
a timed dump; crash capture and committed-final-Quit protection are separate.

## Packaging and qualification

After installing frontend dependencies, run:

```sh
python tools/build-support-tool.py --version <app-version> --output <fresh-build-folder> --stage <app-runtime-folder>
```
Use a Python 3.13 build host with Tk. The builder installs its isolated
`.venv-support` dependencies and bundles the current pure MIDI serializer. Node.js
and frontend dependencies are build/source-runner requirements only. The NativeBridge
is replaced by an unavailable stub in this offline bundle; it cannot contact the DAW.
On Windows/Linux, stage into `build/OpenStudio_artefacts/Release`. On macOS, stage
into `build/OpenStudio_artefacts/Release/OpenStudio.app`; a local build contains
the build host's architecture only. A universal distribution requires both native
builds and the separate Finder launcher, assembled by release CI. To assemble
downloaded native artifacts locally on macOS:

```sh
python3 tools/assemble-macos-support.py --arm64 arm64/OpenStudioSupport.app --x86-64 x86_64/OpenStudioSupport.app --version <app-version> --output universal
ditto universal/OpenStudioSupport.app build/OpenStudio_artefacts/Release/OpenStudio.app/Contents/Helpers/OpenStudioSupport.app
ditto 'universal/OpenStudio Support.app' 'build/OpenStudio_artefacts/Release/OpenStudio Support.app'
```

`python build.py prod --version <version>` includes this build after its required
release-notes gate. Release CI builds and qualifies the native companions before signing.
Installer and Store packaging fail if its version/inventory is missing or mismatched.
The support executable is in the first-party signing allowlist; synchronize the
hosted SignPath `windows-payload` configuration with the repository before release.
The existing release-notes, signing and Store qualification gates still apply.

Developer checks (no DAW/audio device opened):

- `python -m unittest tools.test_openstudio_support -v`
- `python tools/validate-support-tool.py --bundle <runtime-folder> --version <version>`
- `python tools/test-packaged-support.py --bundle <runtime-folder>`

The packaged check launches the actual executable with a restricted PATH and no
external Python/Node invocation, constructs its window hidden, decodes synthetic audio, compares synthetic MIDI
with a saved project and exercises collection, redaction, review and ZIP creation.
That check alone does not qualify installation, OS trust or subjective audio quality.
No release or upload is performed by these checks.

The reusable `support-qualification.yml` workflow builds on Windows, Ubuntu 22.04,
Apple silicon and Intel macOS. macOS assembly retains two native runtimes behind
one universal launcher without requiring Rosetta. Release packaging signs
nested code from the inside out and includes the Finder launcher in the DMG.
Linux installers copy the private runtime and a separate desktop entry; RPM must
preserve frozen runtime bytes while retaining dependency scanning. The AppImage
bundle includes separate DAW and support AppImages without modifying the DAW launcher.

Tests use disposable identities and a dummy DAW where necessary. Windows tests run
production installer validation and the production support shortcut with the real
support payload; MSIX tests pack/unpack, register, activate via the Start menu app ID,
check package identity and unregister. Linux tests execute support after DEB/RPM
round trips and inside its companion AppImage. macOS tests mount a read-only DMG
and activate the Finder launcher. These are support-distribution tests; they do not
claim Store certification, notarization, clean-machine full-DAW readiness, hardware
recording performance or subjective audio quality. These tests isolate support
distribution; the complete candidate also changes the DAW and requires its separate
qualification. Existing release-note and signing gates remain mandatory.

### Recorded development qualification — 2026-11-04

[CI run 41841385666](https://github.com/sdevil7th/OpenStudio/actions/runs/41841385666)
passed all six jobs at commit `cf25a5e3665f1bd444214d871b2903a563863ba8` using
QA version `0.0.0`. Its artifacts contain the Windows payload, Linux payload and
companion AppImage, and the universal macOS helper plus Finder launcher.

| Platform | Verified scope |
| --- | --- |
| Windows | Seven installer fixture scenarios, real support installation/shortcut/uninstall, MSIX pack/unpack, registration, Start menu activation, package identity and cleanup. |
| macOS | Native Apple Silicon and Intel builds; universal architecture selection, strict code-signature verification, read-only DMG and Finder activation on both processor types. QA signatures are ad hoc. |
| Linux | Ubuntu 22.04 runtime, DEB/RPM payload round trips, desktop entry, companion AppImage and GLIBC 2.35 ceiling. RPM installation on Fedora is not asserted. |

Each native build passed 39 source checks and frozen executable tests covering GUI
construction, collection, privacy filtering, reviewed ZIP creation, audio decoding,
MIDI comparison and existing-output protection. No external Python/Node is available
on the frozen test's PATH. This qualification creates no published application
release and does not establish the separate release/hardware claims listed above.
