# OpenStudio Release Smoke Checklist

Use this checklist for every release candidate before publishing installers, manifests, or appcasts.

## Local RC Gate

- Run `./tools/run-windows-rc.ps1 -Version <candidate-version>` before pushing any release tag.
- Do not tag a release until the local Windows RC installer path has been validated successfully in both normal startup and `--ui-safe-mode`.

## Windows

- Install `OpenStudio-Setup-x64.exe` on a clean machine or VM.
- Confirm the installer provisions or repairs WebView2 Runtime and VC++ Redistributable before offering `Launch OpenStudio`.
- Confirm the installer shows which step it is on while copying files, installing VC++, installing WebView2, and validating shell startup.
- Confirm the installed app launches without a frontend dev server running.
- Confirm the installed app does not show a full black window.
- Confirm `webui`, `effects`, `scripts`, `models`, and `ffmpeg.exe` are present in the installed app directory.
- Confirm `prereqs/windows/MicrosoftEdgeWebView2RuntimeInstallerX64.exe` and `prereqs/windows/vc_redist.x64.exe` are present in the installed app directory.
- Confirm `%APPDATA%\OpenStudio\logs\OpenStudio_Startup.log` is created on first launch.
- Confirm the startup log reports `Embedded browser backend supported: Yes`.
- Confirm the startup self-test passes before launch is offered.
- Confirm the startup log records `Frontend startup state: boot-ready`.
- Confirm a missing `basic_pitch_nmp.onnx` model does not block the base app shell from launching.
- Confirm `OpenStudio.exe --ui-safe-mode` renders the safe startup UI visibly.
- If startup fails, run `./tools/inspect-installed-windows-app.ps1` on the test machine and archive the generated report.
- Open a blank project and confirm audio devices enumerate successfully.
- Create an audio track, arm it, and confirm monitoring works.
- Import an audio file and confirm waveform peaks appear.
- Save a new project as `.osproj`.
- Open the saved `.osproj` by double-clicking it in Explorer.
- Open a legacy `.s13` project and confirm it loads.
- Open the mixer, add a built-in OpenStudio effect, and confirm audio still passes.
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
- Confirm the app launches offline without a frontend dev server.
- Confirm runtime assets are bundled inside the app resources.
- Confirm the app bundle startup self-test passes.
- Confirm the startup log reports the packaged frontend and shell-critical startup assets as present.
- Confirm the unsigned DMG mounts and the app launches after the documented Gatekeeper override flow (`right-click > Open`, then allow in Privacy & Security if needed).
- If startup is forced to fail, confirm the startup doctor/fallback identifies the failure branch and shows the log/safe-mode recovery path.
- Open a blank project and confirm audio device setup works.
- Import audio, edit, and export a short render.
- Save a new `.osproj` project and reopen it manually from Finder.
- Open a legacy `.s13` project and confirm it loads.
- Confirm the base app bundle does not include a bundled `python/` runtime folder.
- Open Stem Separation and confirm it offers `Install AI Tools` when the optional runtime is missing.
- Click the toolbar AI Tools button and confirm the optional setup stays in the background with visible toolbar progress and no UI freeze.
- Trigger `Check for Updates...` and confirm the stable manifest request succeeds.
- Validate update behavior from the previous public version to the candidate build.

## Updater And Release Metadata

- Confirm `releases/latest.json` and `releases/stable/latest.json` match.
- Confirm `OpenStudio-checksums.txt` matches the published binaries.
- Confirm `appcast/windows-stable.xml` points to the published Windows installer.
- Confirm `appcast/macos-stable.xml` points to the published macOS DMG.
- Confirm Netlify serves updater files with the intended cache headers.
- Confirm GitHub Release asset URLs resolve before publishing the appcast bundle.
- Run `./tools/validate-published-release.ps1 -MetadataDir dist/release-metadata -Channel stable -ReleaseSiteUrl https://openstudio.org.in -ValidateRedirects` after deploy and confirm it passes.

## Launch Sign-Off

- Confirm release notes are final.
- Confirm known issues are documented.
- Confirm support contact details are published.
- Confirm rollback instructions are ready if the update feed needs to be reverted.
