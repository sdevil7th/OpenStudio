# OpenStudio Release Smoke Checklist

Use this checklist for every release candidate before publishing installers, manifests, or appcasts.

## Local RC Gate

- Run `./tools/run-windows-rc.ps1 -Version <candidate-version>` before pushing any release tag.
- Do not tag a release until the local Windows RC installer path has been validated successfully in both normal startup and `--ui-safe-mode`.
- Treat `--startup-self-test` as dependency/asset preflight only. It does not
  replace a visible `boot-ready` result from the packaged frontend.
- A Debug pass is not a Windows Release pass. Run the lifecycle checks against
  the installed Release executable.

## Window Lifecycle Matrix

Run this matrix from the packaged app while audio is active. Repeat close/reopen,
rapid-close-during-load, sleep/wake, and a second cold launch on each real-machine
release-candidate platform.

| Window role | Required lifecycle | Success signal |
|---|---|---|
| Main shell | Cold launch, close, relaunch | `boot-ready` and responsive UI |
| Detached Mixer | Detach/open, close, reopen | `boot-ready`; audio continues |
| Detached MIDI editor | Detach, dock/close, reopen; repeat with two different MIDI sessions | `boot-ready`; the correct session returns |
| Built-in effect editor | Open, close during load, reopen | `boot-ready`; controls and audio recover |
| Third-party plug-in editor | Open, close, reopen at least one available native editor | Native editor paints; audio continues without a blank or hung window |

## Windows

- Install `OpenStudio-Setup-x64.exe` on a clean machine or VM.
- Repeat the installed Release check on real Windows 10 and Windows 11 standard-user machines; include one machine with Controlled Folder Access or comparable endpoint policy when available.
- Confirm the installer provisions or repairs WebView2 Runtime and VC++ Redistributable before offering `Launch OpenStudio`.
- Confirm the installer shows which step it is on while copying files, installing VC++, installing WebView2, and validating shell startup.
- Confirm the installed app launches without a frontend dev server running.
- Confirm the installed app does not show a full black window.
- Confirm `webui`, `effects`, `scripts`, `models`, and the checksum-pinned
  `ffmpeg.exe` are present in the installed app directory.
- Confirm `licenses/FFmpeg-COPYING.GPLv3.txt` and
  `licenses/FFmpeg-PROVENANCE.json` are present, and confirm the matching
  complete corresponding-source distribution is available before publication.
- Confirm the checksum-validated YSFX/WDL, dr_libs, stb, CLAP, Signalsmith,
  ARA, and Basic Pitch notices are present under `licenses/`. Also confirm the
  notices copied from the pinned NAMCore/Eigen source and, when enabled, the
  provenance-verified ONNX Runtime installation are present.
- Confirm `prereqs/windows/MicrosoftEdgeWebView2RuntimeInstallerX64.exe` and `prereqs/windows/vc_redist.x64.exe` are present in the installed app directory.
- Confirm `%APPDATA%\OpenStudio\logs\OpenStudio_Startup.log` is created on first launch.
- Confirm the startup log reports `Embedded browser backend supported: Yes`.
- Confirm the startup self-test passes before launch is offered.
- Confirm the startup log records `Frontend startup state: boot-ready`.
- Confirm preflight and every WebView2 role use
  `%APPDATA%\OpenStudio\WebView2UserData`, outside the protected installation
  directory, and confirm the blank-window watchdog remains active.
- Confirm a missing `basic_pitch_nmp.onnx` model does not block the base app shell from launching.
- Confirm `OpenStudio.exe --ui-safe-mode` renders the safe startup UI visibly.
- If startup fails, run `./tools/inspect-installed-windows-app.ps1` on the test machine and archive the generated report.
- Open a blank project and confirm audio devices enumerate successfully.
- On a real audio interface, switch input/output device, sample rate, and buffer
  size; then monitor, record, play, export, sleep/wake, and relaunch.
- Create an audio track, arm it, and confirm monitoring works.
- Import an audio file and confirm waveform peaks appear.
- Save a new project as `.osproj`.
- Open the saved `.osproj` by double-clicking it in Explorer.
- Open a legacy `.s13` project and confirm it loads.
- Open the mixer, add a built-in OpenStudio effect, and confirm audio still passes.
- Scan, open, close, and reopen at least one available VST3 editor and one CLAP
  editor while audio is active.
- Confirm the base install does not include a bundled `python/` runtime folder.
- Open Stem Separation and confirm it shows the `Install AI Tools` CTA when the optional runtime is missing.
- Click the toolbar AI Tools button beside Settings and confirm it opens the same install/help path.
- Click the toolbar AI Tools button on a clean machine and confirm:
  - a lightweight popup appears immediately
  - progress appears around the toolbar AI button
  - the main app stays responsive while optional dependencies download/install in the background
  - closing the stem modal does not cancel the background job
- Run a short export and confirm the output file is written.
- Trigger `Check for Updates...` and confirm the manifest request succeeds.
- Validate update behavior from the previous public version to the candidate build.
- Confirm uninstall removes the app cleanly.

## macOS

- Install the `.dmg` output on a clean machine.
- Exercise the packaged app on real Apple Silicon and Intel Macs, including the
  oldest supported macOS on at least one machine; hosted runners and a universal
  slice check do not replace this gate.
- Confirm the app launches offline without a frontend dev server.
- Confirm runtime assets are bundled inside the app resources.
- Confirm the app bundle startup self-test passes.
- Confirm the startup log reports the packaged frontend and shell-critical startup assets as present.
- Starting with a freshly browser-downloaded DMG, record `xattr -p com.apple.quarantine <dmg>` and the exact Gatekeeper result before changing the artifact.
- Confirm the unsigned DMG mounts and the app launches after Apple's per-app Gatekeeper override flow (attempt launch, then **Privacy & Security > Open Anyway**). Do not remove quarantine before this check.
- Run the native-window lifecycle smoke test against the packaged app and require `boot-ready` from main, Mixer, MIDI, and built-in editor views across close/reopen cycles.
- If signing/notarization credentials are enabled, require `codesign --verify --deep --strict`, `spctl` acceptance, and a successful first launch with quarantine intact.
- If startup is forced to fail, confirm the startup doctor/fallback identifies the failure branch and shows the log/safe-mode recovery path.
- Open a blank project and confirm audio device setup works.
- With a real CoreAudio interface, switch input/output device, sample rate, and
  buffer size; grant microphone access, then monitor, record, play, render,
  sleep/wake, and relaunch.
- Scan, open, close, and reopen available VST3, CLAP, and AU editors while audio
  is active.
- Import audio, edit, and export a short render.
- Confirm WAV/AIFF/FLAC work without FFmpeg. Then install a system `ffmpeg` on
  `PATH` and confirm an MP3/OGG conversion succeeds; the app bundle itself must
  not contain an unpinned `ffmpeg` binary.
- Save a new `.osproj` project and reopen it manually from Finder.
- Open a legacy `.s13` project and confirm it loads.
- Confirm the base app bundle does not include a bundled `python/` runtime folder.
- Open Stem Separation and confirm it offers `Install AI Tools` when the optional runtime is missing.
- Click the toolbar AI Tools button and confirm the optional setup stays in the background with visible toolbar progress and no UI freeze.
- Trigger `Check for Updates...` and confirm the stable manifest request succeeds.
- Validate update behavior from the previous public version to the candidate build.

## Linux

- Validate both the raw Release output and the extracted AppImage payload with
  `tools/validate-runtime-bundle.ps1 -Platform linux -ExpectedVersion <version>
  -EnforceLeanBundle`.
- Confirm `OpenStudio.version` exists and exactly matches the candidate version;
  a missing, empty, or mismatched manifest is a release failure.
- Run `--startup-self-test` under `xvfb-run`, then launch the AppImage visibly on
  an x86-64 desktop and confirm the frontend reaches `boot-ready`.
- Confirm no FFmpeg binary is bundled. Test one FFmpeg-backed operation both
  without `ffmpeg` on `PATH` (actionable failure) and with the supported system
  package installed (successful operation).
- Test local NAM loading without a keyring. When TONE3000 sign-in is enabled,
  also test token persistence with `secret-tool` and an active Secret Service.

## Updater And Release Metadata

- Confirm `releases/latest.json` and `releases/stable/latest.json` match.
- Confirm `releases/ai-runtime/latest.json` and `releases/ai-runtime/stable/latest.json` match when AI runtime metadata is part of the release.
- Confirm the GitHub Release contains the uniquely named metadata assets:
  - `OpenStudio-release-latest.json`
  - `OpenStudio-release-stable-latest.json`
  - `OpenStudio-ai-runtime-latest.json`
  - `OpenStudio-ai-runtime-stable-latest.json`
  - `OpenStudio-appcast-windows-stable.xml`
  - `OpenStudio-appcast-macos-stable.xml`
  - `OpenStudio-appcast-linux-stable.xml`
- Confirm `OpenStudio-checksums.txt` matches the published binaries.
- Confirm `appcast/windows-stable.xml` points to the published Windows installer.
- Confirm `appcast/macos-stable.xml` points to the published macOS DMG.
- Confirm AI runtime metadata points to the published GitHub AI runtime assets with the correct SHA-256 and size.
- Confirm the website repo deploy has completed before validating `openstudio.org.in`.
- Confirm the public metadata and appcast URLs on `openstudio.org.in` no longer return the SPA HTML shell.
- Confirm `https://openstudio.org.in/releases/ai-runtime/latest.json` and `https://openstudio.org.in/releases/ai-runtime/stable/latest.json` are live and uncached.
- Confirm `https://openstudio.org.in/download/ai-runtime/windows/latest`, `https://openstudio.org.in/download/ai-runtime/macos/latest`, and `https://openstudio.org.in/download/ai-runtime/linux/latest` redirect cleanly if those convenience endpoints are enabled.
- Run `./tools/validate-published-release.ps1 -MetadataDir dist/release-metadata -Channel stable -ReleaseSiteUrl https://openstudio.org.in -ValidateRedirects` after deploy and confirm it passes.

## Launch Sign-Off

- Confirm release notes are final.
- Confirm known issues are documented.
- Confirm support contact details are published.
- Confirm rollback instructions are ready if the update feed needs to be reverted.
- Record signing/notarization state separately from first-launch reputation.
  A valid signature alone is not proof of SmartScreen reputation or Gatekeeper
  acceptance.
