# OpenStudio Release Runbook

Microsoft Store package/submission automation and one-time enablement are documented
in [Store release automation](release-runbook.md#microsoft-store-release-automation). Once enabled, the Store
job runs after successful release publication, preserves the saved listing settings,
and submits the matching MSIX for certification. Do not bypass the initial Store
qualification, privacy publication, or restricted-capability approval.

Every application release requires reviewed notes in `docs/releases/<version>.md`.
Inspect the exact previous-tag to target-tag diff, explain user-visible changes,
separate known limitations from fixes, and include upgrade steps and a source link.
Run `python tools/validate-release-notes.py --version <version>` before packaging.
For cumulative release notes, review the main release PR and its included hotfixes;
the preceding tag may already contain the main features. Label the full-release
overview and the hotfix-only comparison clearly.
Missing notes, wrong versions and template text stop CI before the build jobs and
stop local preparation/metadata generation. The validated file is used for both
the GitHub release and update feeds. Never publish the template directly.

## What this repo now provides

- Windows installer packaging via `packaging/windows/OpenStudio.iss` (debug symbols, logs and dumps are excluded)
- macOS DMG packaging via `tools/package-macos-release.sh`
- A runtime dependency contract in `docs/runtime-dependency-contract.md`
- Release metadata generation via `tools/generate-release-metadata.ps1`
- Release metadata validation via `tools/validate-release-metadata.ps1`
- Release publish-asset staging via `tools/prepare-release-publish-assets.ps1`
- Published release validation via `tools/validate-published-release.ps1`
- Runtime bundle validation via `tools/validate-runtime-bundle.ps1`
- AI runtime archive packaging via `tools/package-ai-runtime.ps1`
- A tag-driven GitHub Actions workflow in `.github/workflows/release.yml`
- A release QA checklist in `docs/release-smoke-checklist.md`
- In-app update checks, verified downloads, and installation handoff documented in [App updates](USER_MANUAL.md#in-app-updates)

Before distributing a locally built Windows candidate, retain its matching binaries and symbols with `./tools/archive-runtime-symbols.ps1 -Configuration Release`. The ignored `output/symbols/` archive is for crash diagnosis and is not installer content.

## Branding before packaging

When the logo changes, follow [the branding inventory](branding.md): regenerate
icons from the approved master with `node tools/generate-icons.mjs`, build the
frontend, then rebuild the native configuration being packaged. JUCE native
icons use the 1024/16 px sources, Linux launchers use the 256 px source, and the
MSIX packager creates Store resources from the 1024 px source.

Check the installed window/taskbar/Dock/launcher icons and the menu-bar mark on
each release platform. A Debug build does not update a cached Release build or
an existing published installer. Coordinate the website favicon/social/Store
artwork separately; `RELEASE_SYNC.md` in the [website repository](https://github.com/sdevil7th/OpenStudioWebsite)
lists its deployment checks. The approved source and generated assets are listed
in `docs/branding.md`, not in ad hoc copies of the old SVG.

## Preferred public release path

For normal public releases, do not draft a GitHub release manually and do not upload installer assets by hand.

Default release model:

- Normal app releases reuse an already-published AI runtime release.
- Rebuild/publish AI runtimes only when runtime dependencies, packaging scripts, or runtime metadata actually changed.
- The app release workflow expects `OPENSTUDIO_AI_RUNTIME_RELEASE_TAG` and `OPENSTUDIO_AI_RUNTIME_VERSION` to point at a real runtime release, and it now fails early if that runtime release is missing.

Use this flow instead:

1. Run the local Windows RC gate first:
   `./tools/run-windows-rc.ps1 -Version 1.0.0`
2. Confirm the installed Windows app launches visibly in both normal mode and `--ui-safe-mode`, and `%APPDATA%\OpenStudio\logs\OpenStudio_Startup.log` records `Frontend startup state: boot-ready`.
3. Push the release-ready commit(s) to GitHub.
4. Wait for `.github/workflows/verify.yml` to pass on that commit.
5. Decide whether the AI runtime needs rebuilding:
   - If runtime inputs did not change, keep `OPENSTUDIO_AI_RUNTIME_RELEASE_TAG` and `OPENSTUDIO_AI_RUNTIME_VERSION` pinned to the latest known-good runtime release.
   - If runtime inputs changed, publish the runtime first with `.github/workflows/ai-runtime-release.yml`, then update those variables to the new runtime release tag/version.
6. Push a version tag like `v0.0.2`.
7. Let `.github/workflows/release.yml` build Windows, macOS, and Linux, reuse the pinned AI runtime release, publish the GitHub Release, attach the release assets, and then trigger the website repo so it can publish the public metadata and redirects.
8. Verify the published direct-download URLs:
   - `https://github.com/<org>/<repo>/releases/latest/download/OpenStudio-Setup-x64.exe`
   - `https://github.com/<org>/<repo>/releases/latest/download/OpenStudio-macOS.dmg`
   - `https://github.com/<org>/<repo>/releases/download/v<version>/OpenStudio-<version>-linux-x86_64.AppImage`
   - `https://github.com/<org>/<repo>/releases/download/<ai-runtime-tag>/OpenStudio-AI-Runtime-windows-base-x64.zip`
   - `https://github.com/<org>/<repo>/releases/download/<ai-runtime-tag>/OpenStudio-AI-Runtime-macos-arm64.zip`
   - `https://github.com/<org>/<repo>/releases/download/<ai-runtime-tag>/OpenStudio-AI-Runtime-linux-cpu-x64.zip`
9. Verify the website repo finishes its deploy and the public metadata/redirect URLs on `openstudio.org.in` return JSON/XML/302 responses instead of the SPA HTML shell.

The stable installer/runtime filenames are part of the public download contract. The website repo is now the only publisher of public metadata and redirects.

If a release page shows only GitHub's default source archives, treat that as a failed or bypassed automation run. Fix the workflow run or rerun the tag-based release path instead of changing website filenames.

## SDK and runtime policy

- `thirdparty/ARA_SDK` is vendored in the repo, pinned to the OpenStudio ARA host integration, and required for normal builds.
- `thirdparty/asio` stays out of git and is generated locally or in CI when Windows builds require ASIO.
- `thirdparty/onnxruntime` stays out of git and is generated locally when needed.
- `thirdparty/windows-prereqs` stays out of git and is generated locally or in CI when Windows installer builds need pinned WebView2 and VC++ prerequisite installers.
- Official Windows CI and release builds provision ASIO explicitly and fail early if the SDK is unavailable.
- Official Windows CI and release builds also provision the pinned Windows prerequisite installers used by the installer recovery flow.
- To install the pinned optional ONNX Runtime package locally, run:
  `powershell -ExecutionPolicy Bypass -File tools/setup-onnxruntime.ps1`
  The installer records and verifies the requested version, platform, archive
  digest, import library, runtime DLL, headers, and redistributed notices before
  reusing an existing local installation.
- To install the pinned ASIO SDK locally, run:
  `powershell -ExecutionPolicy Bypass -File tools/setup-asio-sdk.ps1`
- To install the pinned Windows prerequisite installers locally, run:
  `powershell -ExecutionPolicy Bypass -File tools/setup-windows-prereqs.ps1`
- Official Windows and Linux CI/release jobs provision the pinned ONNX Runtime
  and validate its redistributed license notices. The current macOS release job
  does not provision ONNX Runtime.
- Windows packages include the checksum-pinned OpenStudio FFmpeg runtime: the
  executable, its shared libraries, exact license texts, source lock, runtime
  manifest, and release provenance. macOS and Linux packages intentionally do
  not redistribute an unpinned FFmpeg binary and use an optional system
  `ffmpeg` on `PATH`.
- Windows setup, CMake configuration, and runtime validation fail if any pinned
  FFmpeg runtime, manifest, source-lock, license, or provenance file is absent
  or altered.
- Linux release automation extracts the completed AppImage and reruns the
  runtime-bundle contract against its packaged `usr/bin` payload.

## Dependency contract

OpenStudio now follows the policy documented in `docs/runtime-dependency-contract.md`.

- Hard launch prerequisites may block launch and must be provisioned or diagnosed clearly.
- Shell-critical startup assets must be present in every packaged runtime bundle.
- Bundled feature assets such as `basic_pitch_nmp.onnx` are validated for packaging quality but must not block base app launch.
- Optional feature prerequisites, including Python for AI tools, must never block base app launch.
- AI tools setup runs in the background and surfaces progress through the toolbar AI button plus a lightweight in-app popup.

## Release decision rules

- Do not publish a Windows artifact containing the bundled FFmpeg runtime unless
  its matching immutable complete corresponding-source asset is still
  available. `thirdparty/ffmpeg/runtime-lock.json` pins both assets and their
  digests; release automation downloads and verifies the source companion
  without relying on mutable repository variables.
- A runtime update must be made through `.github/workflows/ffmpeg-runtime.yml`.
  Update source/toolchain pins and patches, pass the real-Windows capability
  suite, publish a new immutable `ffmpeg-runtime-v*` release, and only then
  update `runtime-lock.json`. Never move or replace an existing runtime tag.
- A passing `--startup-self-test` proves dependency and asset preflight, not a
  rendered UI. The packaged main shell, detached Mixer, detached MIDI editor,
  and built-in effect editor must each report `boot-ready` through close/reopen
  cycles; native third-party editor lifecycle is checked separately.
- A Debug pass is not a Windows Release pass. The installed Release executable
  is the browser/window approval artifact.
- Preserve the browser startup watchdog and the shared writable
  `%APPDATA%\OpenStudio\WebView2UserData` configuration used by both WebView2
  preflight and construction.
- Upgrade JUCE only as an isolated dependency change. Require Debug and Release
  compilation plus audio-device, plug-in-host, window-lifecycle, and packaging
  gates. Realtime JUCE patches must fail closed if their expected upstream
  source context changes.
- Treat code signing, notarization, and download reputation as separate
  evidence. A signed Windows binary may still lack SmartScreen reputation, and
  a valid macOS signature is not a substitute for the intended notarization and
  Gatekeeper assessment.

Before publication, complete the real-machine matrix in
`docs/release-smoke-checklist.md`: Windows 10 and 11 standard-user installs,
Apple Silicon plus Intel macOS (including the oldest supported macOS), actual
audio-device reconfiguration/record/render/sleep-wake checks, and available
VST3/CLAP/AU editor lifecycle checks while audio is active.

## Local Windows release flow

For Microsoft Store MSIX packaging and installed qualification, follow
[Microsoft Store distribution](release-runbook.md#microsoft-store-distribution). Store MSIX artifacts are
separate from the direct-download EXE and must not be referenced by its updater
feed. Review the fixed WebView2 runtime and app-local VC++ security updates on
every Store release; package validation alone is not installed qualification.

For SignPath Foundation signing in GitHub Actions, follow
[Windows signing setup](release-runbook.md#windows-signing-with-signpath). Select `signpath` only after account
approval/configuration. The release job signs the app and crash reporter before
packaging, then signs the installer before release metadata is generated. An
enabled SignPath failure blocks publication. Local packaging does not submit
Foundation signing requests because they require verifiable GitHub build origin.

The local Windows RC gate is now the required no-surprises check before any push/tag for release:
`./tools/run-windows-rc.ps1 -Version 1.0.0`

That script intentionally stops before GitHub release publication, metadata generation, or Netlify deployment. Use it to prove that:
- the Release bundle is complete
- the installer packages locally
- Windows prerequisite installers are staged
- the bundled app passes `--startup-self-test`
- the installed app starts visibly on Windows
- safe startup mode works when needed
- the startup doctor logs a successful frontend boot
- the base app still launches without optional AI tooling/Python installed

If you want one command for the full guarded Windows path, use:
`./tools/run-release-preflight.ps1 -Version 1.0.0 -ReleasePageUrl https://github.com/<org>/<repo>/releases/tag/v1.0.0 -RepoSlug <org>/<repo>`

1. Build the frontend: `cd frontend && npm ci && npm run build`
2. Install the ASIO SDK when you want parity with the official Windows release path: `powershell -ExecutionPolicy Bypass -File tools/setup-asio-sdk.ps1`
3. Install ONNX Runtime for parity with the official Windows release and polyphonic pitch detection: `powershell -ExecutionPolicy Bypass -File tools/setup-onnxruntime.ps1`
4. Build the app in a clean release directory: `cmake -S . -B build-release-windows -A x64 "-DOPENSTUDIO_APP_VERSION=1.0.0" "-DJUCE_ASIOSDK_PATH=thirdparty/asio" "-DOPENSTUDIO_REQUIRE_ASIO=ON" "-DOPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK=OFF" -DFETCHCONTENT_UPDATES_DISCONNECTED=ON`
5. Build the release target: `cmake --build build-release-windows --config Release --target OpenStudio`
6. Validate the runtime bundle: `./tools/validate-runtime-bundle.ps1 -Platform windows -BundlePath build-release-windows/OpenStudio_artefacts/Release -ExpectedVersion 1.0.0 -EnforceLeanBundle`
   This now also validates staged Windows prerequisite installers when they are part of the runtime contract.
7. Package the installer: `./tools/package-windows-release.ps1 -Version 1.0.0 -SourceDir build-release-windows/OpenStudio_artefacts/Release`
   Optional signing: `./tools/package-windows-release.ps1 -Version 1.0.0 -CertificateFile C:\path\to\codesign.pfx -CertificatePassword <password>`
8. Prepare and package the Windows AI base runtime archive:
   `./tools/prepare-ai-runtime.ps1 -Platform windows -RuntimeRoot build-ai-runtime/windows-base -Architecture x64 -RequirementsFile tools/ai-runtime-requirements-windows-base.txt -RuntimeFamily windows-base-x64 -ExpectedRuntimeVersion 1.0.0 -StandaloneReleaseTag 20260325 -StandalonePythonVersion 3.10.20`
   `./tools/package-ai-runtime.ps1 -Platform windows -RuntimeRoot build-ai-runtime/windows-base -OutputPath dist/ai-runtime/OpenStudio-AI-Runtime-windows-base-x64.zip -ExpectedRuntimeVersion 1.0.0`
9. Generate updater metadata:
   `./tools/generate-release-metadata.ps1 -Version 1.0.0 -Channel stable -ReleasePageUrl https://github.com/<org>/<repo>/releases/tag/v1.0.0 -WindowsAssetPath dist/windows/OpenStudio-Setup-x64.exe -WindowsAssetUrl https://github.com/<org>/<repo>/releases/download/v1.0.0/OpenStudio-Setup-x64.exe -WindowsBaseAiRuntimeAssetPath dist/ai-runtime/OpenStudio-AI-Runtime-windows-base-x64.zip -WindowsBaseAiRuntimeAssetUrl https://github.com/<org>/<repo>/releases/download/<ai-runtime-tag>/OpenStudio-AI-Runtime-windows-base-x64.zip -WindowsCudaInstallPlanPath tools/ai-runtime-install-plan-windows-cuda.json -WindowsDirectmlInstallPlanPath tools/ai-runtime-install-plan-windows-directml.json -AiRuntimeVersion 1.0.0`
   Optional appcast fields: `-FullReleaseNotesUrl https://openstudio.org.in/releases/1.0.0 -WindowsInstallerArguments "/SP- /NOICONS"`
10. Validate the generated metadata:
   `./tools/validate-release-metadata.ps1 -MetadataDir dist/release-metadata -Channel stable -WindowsAssetPath dist/windows/OpenStudio-Setup-x64.exe -WindowsBaseAiRuntimeAssetPath dist/ai-runtime/OpenStudio-AI-Runtime-windows-base-x64.zip -WindowsCudaInstallPlanPath tools/ai-runtime-install-plan-windows-cuda.json -WindowsDirectmlInstallPlanPath tools/ai-runtime-install-plan-windows-directml.json`
11. Stage the uniquely named GitHub Release metadata assets:
   `./tools/prepare-release-publish-assets.ps1 -MetadataDir dist/release-metadata -OutputDir dist/release-publish-assets`
12. If certificate signing is enabled, the packaging helper signs and verifies `OpenStudio.exe`, `OpenStudioCrashReporter.exe` and `OpenStudio-Setup-x64.exe`. The SignPath workflow verifies product metadata, trusted signatures and timestamps before packaging/publishing.

## Local macOS release flow

If you want one command for the guarded macOS path, use:
`./tools/run-macos-release-preflight.ps1 -Version 1.0.0 -ReleasePageUrl https://github.com/<org>/<repo>/releases/tag/v1.0.0 -RepoSlug <org>/<repo>`

1. Build the frontend: `cd frontend && npm ci && npm run build`
2. Configure and build the release target with CMake in a clean directory, for example: `cmake -S . -B build-release-macos -DOPENSTUDIO_APP_VERSION="1.0.0" -DOPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK=OFF -DFETCHCONTENT_UPDATES_DISCONNECTED=ON`
3. Validate the app bundle: `./tools/validate-runtime-bundle.ps1 -Platform macos -BundlePath build-release-macos/<path-to-OpenStudio.app> -ExpectedVersion 1.0.0 -EnforceLeanBundle`
4. Package the DMG:
   `./tools/package-macos-release.sh build-release-macos/<path-to-OpenStudio.app> 1.0.0`
   If `MACOS_CODESIGN_IDENTITY` is set, the script verifies both the app bundle and DMG with `codesign`. If notarization credentials are present, it also staples and validates the notarized DMG and requires Gatekeeper (`spctl`) acceptance.
   For the zero-cost v1 path, leave those signing variables unset, publish the generated SHA-256 checksum, and document Apple's per-app **Privacy & Security > Open Anyway** flow. Recursive quarantine removal is a diagnostic fallback, not the normal installation path.
5. Prepare and package the macOS AI runtime archive for Apple Silicon:
   `./tools/prepare-ai-runtime.ps1 -Platform macos -RuntimeRoot build-ai-runtime/macos-arm64 -Architecture arm64 -RequirementsFile tools/ai-runtime-requirements-macos.txt -ExpectedRuntimeVersion 1.0.0 -StandaloneReleaseTag 20260325 -StandalonePythonVersion 3.10.20`
   `./tools/package-ai-runtime.ps1 -Platform macos -RuntimeRoot build-ai-runtime/macos-arm64 -OutputPath dist/ai-runtime/OpenStudio-AI-Runtime-macos-arm64.zip -ExpectedRuntimeVersion 1.0.0`
   Intel macOS AI runtime support is currently disabled because the pinned `audio-separator` dependency stack does not publish a satisfiable Intel macOS wheel set for the release path.
6. Generate updater metadata with the DMG path and URL included.
   For Sparkle-ready appcasts, also pass `-MacEdSignature <signature>` and optionally `-MacMinimumSystemVersion 12.0`.
7. Validate the generated metadata:
   `./tools/validate-release-metadata.ps1 -MetadataDir dist/release-metadata -Channel stable -MacAssetPath dist/macos/OpenStudio-macOS.dmg -MacArm64AiRuntimeAssetPath dist/ai-runtime/OpenStudio-AI-Runtime-macos-arm64.zip`
8. Stage the uniquely named GitHub Release metadata assets:
   `./tools/prepare-release-publish-assets.ps1 -MetadataDir dist/release-metadata -OutputDir dist/release-publish-assets`

## GitHub Release metadata assets

The desktop release workflow now uploads uniquely named metadata assets to GitHub Releases so the website repo can fetch them without basename collisions.

That publish-asset set contains:

- `OpenStudio-release-latest.json`
- `OpenStudio-release-stable-latest.json`
- `OpenStudio-ai-runtime-latest.json`
- `OpenStudio-ai-runtime-stable-latest.json`
- `OpenStudio-appcast-windows-stable.xml`
- `OpenStudio-appcast-macos-stable.xml`
- `OpenStudio-appcast-linux-stable.xml`
- `OpenStudio-checksums.txt`

The website repo should fetch those assets after the desktop release publishes, place them into its deploy-input area, and then deploy `openstudio.org.in`.

## Manual fallback

Use `tools/prepare-public-release.ps1` only when GitHub Actions is unavailable or you need an emergency manual release bundle.

That script is a fallback path for staging:
- GitHub release assets
- release metadata
- uniquely named website publish assets
- website deploy-input metadata

It is not the preferred day-to-day release flow now that the tag-driven GitHub workflow is the source of truth.

The Windows installer registers `.osproj` as the project extension. Retired file associations and formats are unsupported; see [current formats](USER_MANUAL.md#file-formats-and-upgrade-compatibility).
The default base app no longer bundles the optional stem-separation Python runtime; users install AI Tools later from inside OpenStudio when they need stem separation.

## Secrets expected by GitHub Actions

For the current release path, `OPENSTUDIO_WEBSITE_DISPATCH_TOKEN` must be set
directly as a GitHub Actions secret because the publish job intentionally does
not receive Doppler credentials. `DOPPLER_TOKEN` is an optional bootstrap for
the allowlisted build/signing values used inside their specific build steps; it
does not replace the website dispatch secret. Signing/notarization secrets stay
optional unless you decide to enable trusted distribution later.

SignPath uses a separate `SIGNPATH_API_TOKEN` GitHub secret and repository
variables documented in [Windows signing setup](release-runbook.md#windows-signing-with-signpath). Once
`OPENSTUDIO_WINDOWS_SIGNING_PROVIDER=signpath`, all SignPath configuration is
required and the Windows certificate secrets below are not used.

- `MACOS_CODESIGN_IDENTITY`
- `MACOS_CERTIFICATE_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `MACOS_KEYCHAIN_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_PASSWORD`
- `WINDOWS_CODESIGN_CERT_BASE64`
- `WINDOWS_CODESIGN_CERT_PASSWORD`
- `WINDOWS_CODESIGN_CERT_THUMBPRINT`
- `WINDOWS_TIMESTAMP_URL`
- `OPENSTUDIO_WEBSITE_DISPATCH_TOKEN`
- `DOPPLER_TOKEN`

Optional repository variables:

- `OPENSTUDIO_AI_RUNTIME_VERSION`
- `OPENSTUDIO_AI_RUNTIME_RELEASE_TAG`
- `OPENSTUDIO_AI_RUNTIME_STANDALONE_RELEASE_TAG`
- `OPENSTUDIO_AI_RUNTIME_STANDALONE_PYTHON_VERSION`
- `OPENSTUDIO_AI_RUNTIME_STANDALONE_FLAVOR`
- `OPENSTUDIO_WEBSITE_REPO`
- `OPENSTUDIO_WEBSITE_DISPATCH_EVENT_TYPE`

The default website repo target is `sdevil7th/OpenStudioWebsite`.
The default dispatch event type is `openstudio_release_published`.

GitHub-hosted Windows releases no longer require a pre-existing committed `tools/python`
tree. The release workflow now downloads a relocatable standalone Python runtime, layers the
pinned AI packages into it, validates that the packaged runtime is not a venv, and then
publishes the resulting archive.

GitHub-hosted macOS releases no longer require a pre-existing committed `tools/python-macos`
tree. The release workflow now builds the downloadable AI runtime for Apple Silicon (`arm64`)
from the same relocatable standalone Python source on GitHub-hosted macOS runners. Intel macOS
machines can still run the base app, but AI Tools remain unsupported there until the pinned
dependency stack publishes a satisfiable Intel macOS wheel set for release builds.

Optional future additions:

- Sparkle/WinSparkle-specific signature generation
- Beta channel metadata publishing alongside the stable channel


### macOS field-test qualification

`tools/package-macos-release.sh` retains the free unsigned path. For the planned
zero-cost identity experiment only, set `MACOS_CODESIGN_KIND=self-signed` with an
existing persistent `MACOS_CODESIGN_IDENTITY`. It disables timestamping, rejects
notarization credentials in this mode and emits `OpenStudio-macOS.signing.txt`
with the actual designated requirement. No certificate or trust-store change is
performed by this script. Reuse the same protected release key across versions;
do not ask users to install a trusted root. Self-signing is **not** Gatekeeper
acceptance and its TCC/Keychain continuity is unqualified until tested on macOS.
The default identity branch remains Developer ID when an identity is supplied.

Before publishing these field fixes, qualify the actual downloaded package on a
fresh macOS account: output-only first launch, first input consent, denial,
relaunch, same-key update, existing OpenStudio plugin settings, MIDI popout/Dock,
physical pinch, snapshot save/reopen, TONE3000 browser login/refresh and NAM
insertion in the reported monitoring route. Record macOS/app versions, selected
I/O pair, available buffer sizes and crash report if insertion still fails.
Do not advertise an 8-sample Core Audio setting unless that device reports it.
Windows prerequisite compilation is separate from clean-VM UAC/reboot/repair
qualification. Use the field-test plan for the complete evidence matrix.

## Microsoft Store distribution

MSIX is a separate full-trust Win32 distribution. Package identity selects Store
delivery; the direct EXE updater must not install over a Store package. Packaging
and development-registration checks do not establish Store certification, a
clean-machine installation, or an older-to-newer Store flight. Those remain
required release qualification. See the automation section below for enablement.

### Reserved identity

| Field | Value |
| --- | --- |
| Name | `SouravDas.OpenStudio` |
| Publisher | `CN=40F9D2C5-1757-4552-B213-B0651C58A9F5` |
| Publisher display name | `Sourav Das` |
| Package family | `SouravDas.OpenStudio_sqr0dv9eeh28p` |
| Store ID | `9N3MQ442VXGW` |

The package identity, not a build flag or writable file, selects Store package
delivery. This also applies to locally registered packages with this identity.
OpenStudio keeps its Check, Download, progress, cancellation and Install controls.
`StoreContext` is associated with the native HWND on the message thread, and async
callbacks return through the JUCE message queue with lifetime/generation guards.
Checks time out after 60 seconds. A successful automatic check is throttled to
once per session-day; Microsoft also applies its own check limits. The automatic
check preference does not change Windows' separate Store update settings.

Download calls `RequestDownloadStorePackageUpdatesAsync` without installation.
Install calls `RequestDownloadAndInstallStorePackageUpdatesAsync` after the same
stopped-transport and successful-save protections as the direct updater. Windows
may show consent UI and close the app during installation. OpenStudio does not
launch an EXE or issue its direct-installer quit handoff for this channel.
Failures and user cancellation allow retry. We do not display an invented target
version: the update-list API exposes installed package identity, not reliable
release notes or a target version. Store updates require submitting each MSIX
version to Partner Center; GitHub release publication alone does not update MSIX.

### Build a submission candidate

1. Build the production frontend and Release native app with the intended
   `OPENSTUDIO_APP_VERSION` using the existing release build/dependency setup.
   The release's TONE3000 publishable OAuth client ID must be configured; do not
   ship a build that requires users to obtain their own API key.
2. Run from the repository root, substituting the compiled three-part version
   followed by `.0` (Store reserves the fourth component):

   ```powershell
   ./tools/package-windows-store.ps1 -Version 0.1.1.0 -SourceDir build/OpenStudio_artefacts/Release
   ```

3. Inspect `dist/store/package-report.json`. The script uses the Windows SDK
   MakePri/MakeAppx tools, checks version metadata, validates the MSIX, unpacks
   it, and compares every staged file's SHA256 with the unpacked payload.
   It uses unique working directories and refuses to overwrite a previous MSIX.
4. Qualify the installed package before submitting it. Package validation and
   hash parity do not prove runtime compatibility or Microsoft certification.
5. Upload the `.msix` under the MSIX submission's Packages section. The artifact
   is intentionally unsigned for Microsoft to sign after certification. It is
   not a public sideload installer and should not replace the GitHub EXE asset.

The script accepts `-RuntimeCab`, `-VCRedistDir` and `-SdkBinDir` for controlled
build environments. Runtime downloads must match the committed SHA256 and have
a trusted Microsoft signature. Third-party binaries retain their own signatures.

### Dependencies and writable data

- VC++ Release DLLs come from Visual Studio's `VC/Redist/MSVC/.../x64/Microsoft.VC143.CRT`
  and are deployed beside the application. No VC++ installer or elevation is used.
  Universal CRT is supplied by the supported Windows 10/11 OS.
- The fixed WebView2 distribution is pinned in `packaging/msix/webview2-runtime.json`.
  All extracted runtime files are included. The app configures its process-local
  runtime path before JUCE availability probes or browser creation. Existing
  writable WebView user-data paths and detached-browser lifecycle are preserved.
- Bundling fixed WebView2 increases download/disk size. These bundled Microsoft
  components do not receive independent Evergreen/central CRT servicing. Review
  security updates and refresh the lock/CRT on every Store release, with an urgent
  release for relevant security fixes. Never scrape a floating runtime in CI.
- Prerequisite EXE installers, PDBs and downloaded Python/model caches are excluded.
  Bundled scripts, presets, effects, models, licenses and web UI are retained.
- Optional AI runtime installations continue to use writable user storage. They
  must be tested under actual package identity, including subprocess launches.
- Standard MSIX file/registry virtualization remains enabled. Test existing
  settings/auth visibility and uninstall behavior; do not promise that a direct
  installation's settings automatically transfer or that package-local caches
  survive uninstall. User-selected projects outside package data remain external.
- Audio-interface drivers remain installed by their vendors outside MSIX. The
  package does not attempt to install drivers.

### Installed qualification

Use a clean Windows 10 2004+ or Windows 11 test environment without Visual Studio,
VC++ Redistributable or Evergreen WebView2 to establish dependency independence.
Use a Store private flight for final Store-signed install/update qualification.
For local package-identity testing, Microsoft supports development registration:

```powershell
Add-AppxPackage -Register '<stage from package-report.json>\AppxManifest.xml'
```

This requires Windows Developer Mode and is a development registration, not proof
of a Store-signed installation. Do not change machine policy or install test-root
certificates automatically. Do not replace an existing installed Store package.

Launch by package AUMID (Start menu / IApplicationActivationManager), not by
double-clicking the staging EXE, and verify:

| Check | Required evidence |
| --- | --- |
| Store update routing | `--store-package-self-test <absolute report.json>` reports Store identity, unprepared transfer rejection, and deterministic updater regression |
| Store API query | `--store-update-query-self-test <absolute report.json>` invokes the real read-only Store API with a native owner window; development association errors are not upgrade success |
| In-app Store upgrade | Install an older version through a private Store flight, publish a newer package to that flight, check/download/cancel/retry/install inside OpenStudio, verify saved project and new package version |
| Shell and detached windows | Main, mixer, MIDI and plugin browsers reach `boot-ready`; close/reopen/quit safely |
| Audio and plugins | Enumerate ASIO/WASAPI/MIDI; record/play/export; scan/load external VST3/CLAP plugins and open editors |
| Projects | Save/reopen an external `.osproj`, file-association launch, media import, recovery and monitor snapshots |
| NAM | Browser login callback, credential persistence after restart, library/search/download and Monitor FX insertion |
| AI | Download runtime/model into user data, run helper, generate/separate audio and cancel safely |
| Upgrade/uninstall | Two Store package versions, external projects preserved, documented settings/cache behavior |
| Certification | Windows App Certification Kit report, then Partner Center certification |

Native headless regression metrics do not assert subjective audio quality. ASIO
hardware, live OAuth, clean-machine dependencies and Store updates require their
own evidence; record unexecuted checks as `not_asserted`.

### Listing and privacy

Answer **Yes** to access/collection/transmission of personal information. The app
accesses user audio (which can include identifiable voices), projects and paths;
optional TONE3000 integration handles account-linked tokens and network requests.
This answer is not a claim that recordings are uploaded to OpenStudio servers.
Microsoft Store policy 10.5.1 also explicitly requires privacy policies for
Win32 and Desktop Bridge products. No Google Analytics or Microsoft Clarity
integration was found in the app source audit; the owner reports these on the
website. Describe website analytics separately from the desktop application's
local processing and optional network features.

Publish a policy at a stable public URL covering the actual implementation:
local audio/project processing and storage, optional third-party authentication
and downloads, diagnostics/log contents and user-controlled sharing, retention
and deletion, third-party links, and a maintainer contact. Verify actual network
behavior before claiming no telemetry, no uploads or no third-party disclosure.
The website source was audited at `../openstudio-website` (OpenStudioWebsite).
Use **Yes → Provide privacy policy URL → https://openstudio.org.in/privacy**.
Verify the published privacy policy against the shipped implementation before submission; local website changes do not establish deployed behavior.

In Partner Center, prepare Pricing and availability (Free), Properties, Age
ratings, Store listings and certification notes. Explain that `runFullTrust` is
needed for the JUCE desktop audio engine, external plugin hosting and helper
processes; optional TONE3000 authentication is user initiated. Submit only when
the package and required qualification are ready.

### References

- [Microsoft MSIX submission checklist](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission)
- [In-app Store updates](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/package-updates-from-store)
- [Desktop HWND association](https://learn.microsoft.com/en-us/windows/uwp/monetize/in-app-purchases-and-trials#using-the-storecontext-class-with-the-desktop-bridge)
- [Manual package creation](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)
- [Desktop packaging requirements](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-prepare)
- [WebView2 runtime distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- [VC++ local deployment](https://learn.microsoft.com/en-us/cpp/windows/deployment-examples)
- [Privacy policy requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/support-info)

## Microsoft Store release automation

### Plan and scope

The owner requested automatic Store delivery after each OpenStudio release.
Implement it as a dependent job in the existing Release workflow, not a second
`release: published` listener (releases created with `GITHUB_TOKEN` do not reliably
trigger another workflow). Use the same source and Release binaries as the desktop
release. Submit only after the GitHub release job succeeds. Preserve the Store's
existing audience, publishing schedule, privacy URL, ratings, screenshots and
other listing settings. Publishing a GitHub release does not skip certification.

1. Validate a stable numeric version and exact-version release notes.
2. Build the MSIX from the Windows release payload using the existing pinned
   WebView2/CRT packaging checks; retain the MSIX as a workflow artifact.
3. Authenticate to the Store API using GitHub environment secrets.
4. Run authenticated read-only preflight: validate package identity, version,
   SHA256, and either the published baseline or the explicitly pinned initial draft.
5. Clone the last published submission, or adopt the configured initial draft;
   replace only the x64 desktop package and English release notes. Refuse to
   overwrite unrelated pending submissions. Keep the initial publishing hold.
6. Upload a ZIP containing the MSIX, commit for certification, and report status.
   Resume the same tagged/hash-bound submission on retry; never blindly retry
   an ambiguous create/commit request or delete a pending submission.
7. Test with fake HTTP/API responses and the actual local MSIX. Complete the
   initial Partner Center draft (including age ratings) and account setup before
   the first live submission. An older published package is not a prerequisite.

The Windows Release job always builds, validates and retains the
`microsoft-store-package` artifact. `OPENSTUDIO_STORE_ENABLED` controls only the
credentialed `submit-store` job. An MSIX packaging or offline validation failure still fails the Windows
release job, so a missing Store artifact cannot silently pass the release gate.

### First Store release from a tag

1. Merge the release and any release-preparation follow-up only after CI passes.
   Validate `docs/releases/<version>.md` on the final source, then push the stable
   version tag on that merged `main` revision.
2. Before tagging, review `packaging/msix/initial-submission.json`. It permits only
   draft `1152921505701841400`, tag `v0.1.03`, and replacement of the existing
   `0.0.1.0` package. The draft must have the approved artwork fully uploaded,
   age ratings and certification details completed, and publishing mode **Manual**.
   Do not publish the old package to establish a baseline.
3. With the GitHub environment configured and `OPENSTUDIO_STORE_ENABLED=true`,
   the `submit-store` job follows successful release publication. It downloads
   the same run's `microsoft-store-package` artifact and first runs `--preflight`:
   credentials are used only for authentication and Store GET requests. A failed
   preflight blocks the mutation step and retains a sanitized diagnostic report.
4. The subsequent `--submit` step revalidates current state, adopts only the pinned
   draft, preserves saved listing/artwork/audience/settings, replaces the package
   and English release notes, and commits it for certification. The initial draft
   is never deleted or recreated. Check the retained reports and Partner Center.
5. After certification, publish the qualified new version deliberately. The manual
   hold prevents certification from automatically making it public. Later tags
   use the normal published-baseline path; the initial pin cannot adopt other drafts.

The config is an explicit one-release opt-in, not permission to adopt arbitrary
pending submissions. The initial path requires exactly one uploaded x64 Desktop
package at the pinned old version, saved English artwork and no unfinished assets.
Retry markers bind the package hash, notes, config and preserved settings. A changed
artifact, draft, hold or listing stops the retry; investigate instead of removing
the marker or repinning blindly. After an ambiguous PUT/upload/commit failure,
rerun the failed job using the same artifact. Already committed submissions are
polled without another upload or commit. No path publishes an older version.

For a credentialed read-only check against a validated tagged artifact, use
`python tools/submit_store_release.py --version v0.1.02 --package-dir dist/store
--notes-file docs/releases/0.1.02.md --initial-submission-config
packaging/msix/initial-submission.json --preflight` (as one command).
Without `--preflight` or `--submit`, validation remains entirely offline. Credentials
stay in environment secrets; never pass them as arguments. Live preflight is not
evidence of certification, API update success, or Store-delivered installation.

### One-time enablement

This repository implements the automation; it cannot provision the owner's
Microsoft tenant or approve the initial Store listing. It stays inactive until:

1. Complete the initial Partner Center draft, including age ratings, approved
   artwork, `runFullTrust` explanation and manual publishing hold, and review the
   initial-submission pin above. The `0.0.1.0` candidate is not the public release.
2. Link a Microsoft Entra application to Partner Center, assign the required
   Manager role, and obtain tenant ID, client ID and client secret. See Microsoft's
   [API prerequisites](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services).
3. In GitHub repository Settings → Environments, create `microsoft-store`.
   Add environment secrets `MS_STORE_TENANT_ID`, `MS_STORE_CLIENT_ID`, and
   `MS_STORE_CLIENT_SECRET`. Add the secret directly in GitHub; never paste it in
   chat, commit it, or place it in workflow inputs. Rotate it before expiration.
4. After the code passes CI and merges and the selected package's release checks
   are complete, set repository Actions variable `OPENSTUDIO_STORE_ENABLED` to
   `true` before the release tag. The job's mandatory live preflight must pass
   before submission can mutate the draft. The app identity is fixed to Store ID
   `9N3MQ442VXGW` and the reserved publisher. Restrict the `microsoft-store`
   environment to `v*` tags; branch runs cannot access its credentials. The job
   also rejects a manually dispatched version that differs from its tag.
5. Push the normal stable release tag. The `submit-store` job follows `publish`.
   To require a human gate, configure required reviewers on the `microsoft-store`
   environment. With no reviewer gate, submission is automatic. The existing
   Partner Center publish mode remains authoritative after certification.

Once automation adopts the initial draft, make further updates through the API.
Do not edit an API-created pending submission in Partner Center: Microsoft warns
that mixing API and portal edits can invalidate it. If another submission is
pending, resolve it deliberately; automation leaves it intact and fails visibly.
On timeout/failure, the job records the submission ID and status without tokens
or SAS upload URLs. Rerun failed jobs to resume the same release artifact. A new
package with a different hash requires a new version, not an overwrite.

### Package-page warning

`runFullTrust` is required by this packaged Win32 DAW. It runs at the user's
normal medium-integrity level, not as administrator. Saving the package section
is safe; the warning requires an explanation/approval during certification.
Suggested explanation for the restricted-capability/Notes for certification field:

> OpenStudio is a JUCE-based Win32 digital audio workstation packaged as MSIX.
> It requires runFullTrust to run its native audio/MIDI engine, access user-selected
> project and audio files, host third-party audio plugins, and launch audio-processing
> and crash-reporting helper processes. The application runs as the signed-in user
> at medium integrity and does not require administrator elevation. Microsoft Store
> installations use Store APIs for application updates.

Keep Windows Desktop selected. Other device families are not qualified. The
AArch32 notice is unrelated to this x64 package. The separate future-device-family
checkbox controls future availability; the automation preserves your saved choice.


### Validation and activation limits

Run `python -m unittest tests.test_store_submission`,
`tools/test-windows-store-package.ps1` and the installed qualification above.
Offline/mock tests never establish live API submission, certification or delivery.
Only the existing en-us release notes and x64 Desktop package are replaced;
other architectures and listing settings remain unchanged. An accepted commit can
still be in preprocessing/certification. Check Partner Center's final result.
HTTP reports must exclude tokens, response bodies and SAS upload URLs. A new
artifact hash requires a new package version. The initial draft exception requires
the reviewed one-release config; subsequent releases require a published baseline.

## Windows signing with SignPath

Repository integration is implemented; SignPath Foundation enrollment, approval,
account configuration and a successful production signing run are not confirmed.
Adding this workflow does not sign existing downloads or establish SmartScreen
reputation. The existing certificate/unsigned path remains the default until the
repository owner activates SignPath.

### What the release workflow does

The GitHub-hosted Windows release job builds and tests OpenStudio, then:

1. Stages only `OpenStudio.exe` and `OpenStudioCrashReporter.exe` as a GitHub
   artifact. Third-party DLLs and prerequisite installers are not re-signed.
2. Submits that artifact to SignPath using the `windows-payload` configuration.
   It waits up to one hour for approval/completion and downloads the signed files.
3. Checks the product name, exact product version (ignoring Inno's trailing space padding), trusted Authenticode signature
   and timestamp of every returned file before replacing any package input.
4. Builds the Inno Setup installer using `-RequireSignedPayload`.
5. Submits the installer as another GitHub artifact using `windows-installer`,
   waits for its approval, and verifies/restores the signed installer.
6. Uploads the final installer to the existing `windows-release` artifact. The
   publish job generates checksums/update metadata from this signed installer.

Once selected, SignPath failure or missing configuration fails the release. There
is no fallback to unsigned output. Both signing requests need approval under the
Foundation policy. Monitor the action's signing-request links while the release
is running. A timeout fails the workflow; do not publish its intermediate artifacts.

The SignPath action is pinned to v2.3's commit, and its token is available only
to configuration validation and signing steps. The job grants `actions: read`
and `contents: read` for GitHub artifact/origin verification. It does not grant
repository write access. Normal Verify/PR builds do not request signing.

This covers the app, crash reporter and downloadable installer. Inno Setup's
generated uninstaller is not separately signed by this integration. Optional AI
runtime archives keep their existing separate release process.

### Owner setup needed before activation

1. Check your email/SignPath dashboard for an existing application. If there is
   none, apply at <https://signpath.org/apply.html> for the public repository
   <https://github.com/sdevil7th/OpenStudio> and website
   <https://openstudio.org.in>. The repository uses GNU AGPLv3 and has published
   Windows installers. Approval is discretionary; it is not implied by the license.
2. Review the [Foundation conditions](https://signpath.org/terms.html). Confirm
   eligibility of the actual bundled components, including JUCE/ASIO license
   choices and the Microsoft WebView2/VC++ redistributables under its system-library
   exception. Do not assume that an open-source top-level license settles all
   component or project requirements.
3. Confirm the authors, reviewers and signing approvers; enable MFA for their
   GitHub and SignPath accounts. Finalize [the signing policy draft](code-signing-policy.md),
   including a verified privacy-policy link, and link it from the website's home
   and download/release pages. The website is maintained outside this checkout.
4. In the approved SignPath organization, configure the project repository URL as
   `https://github.com/sdevil7th/OpenStudio`. Add the predefined **GitHub.com**
   Trusted Build System to the organization and link it to the project. Install
   the SignPath GitHub App if the account's source/build policy setup requires it.
5. Import these XML files as artifact configurations with the exact slugs below.
   They use a ZIP root because `actions/upload-artifact@v4` creates ZIP artifacts.
   The required `version` parameter restricts product metadata to this release.

   | Slug | Configuration |
   | --- | --- |
   | `windows-payload` | [windows-payload.xml](../packaging/signpath/windows-payload.xml) |
   | `windows-installer` | [windows-installer.xml](../packaging/signpath/windows-installer.xml) |

6. Configure a production signing policy with the Foundation certificate,
   authorized submitter and required human approvers. Restrict it to the intended
   repository/release workflow and release refs using the controls available in
   your account. A test/self-signed certificate will fail this release workflow's
   Windows trust checks; do not install a test root on the release runner.
7. In GitHub **Settings > Secrets and variables > Actions**, add:

   | Type | Name | Value |
   | --- | --- | --- |
   | Secret | `SIGNPATH_API_TOKEN` | Token for the authorized SignPath submitter |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | Organization ID from SignPath |
   | Variable | `SIGNPATH_PROJECT_SLUG` | Project slug from SignPath |
   | Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | Production signing-policy slug |
   | Variable | `OPENSTUDIO_WINDOWS_SIGNING_PROVIDER` | `signpath` (set this last) |

   Keep the API token in the secret store, not in chat, Git, or a repository
   variable. No Windows PFX/private key or Doppler signing secret is needed for
   this route. Configuration is deliberately explicit; partial setup cannot
   silently switch an enabled SignPath release back to certificate/unsigned mode.
8. Run a release from the committed workflow and approve both signing requests.
   Inspect the resulting installer and installed executables on Windows. Confirm
   the expected publisher, signature/timestamp and successful installation/launch.
   Signing does not promise an immediate SmartScreen reputation bypass.

### Validation

Run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-windows-signing.ps1`
on Windows. Verify CI also runs this test without SignPath credentials. It tests
the staging allowlist, missing helper, metadata mismatch, stale staging, real
unsigned-file rejection, missing timestamp, and rejection without partial restore.
Successful signature responses in unit tests are mocked; they are not evidence
of a live SignPath signing run.

When adding a first-party executable, add its product/version resource and extend
the appropriate XML configuration. Packaging and staging read their file lists
from those configurations. Import the reviewed updated configuration into
SignPath before releasing. Never use a blanket `**/*.dll` signing rule for
third-party runtime files.

## Publishing in-app updates


Use the existing [release runbook](release-runbook.md). Each release needs a
strictly newer application version and matching platform URLs, byte sizes and
SHA-256 checksums in the generated stable release manifest. Generate metadata
from the final packaged/signed files, then publish all assets together.

The updater first uses its configured website JSON/appcast feeds. Stable builds
also try the GitHub release manifest if those feeds fail:
`https://github.com/sdevil7th/OpenStudio/releases/latest/download/OpenStudio-release-stable-latest.json`.
The website feed should still be maintained for previously installed versions.

No updater account, new paid service, or SignPath activation is needed. The
optional SignPath integration can remain unconfigured. Unsigned releases can
still encounter operating-system trust warnings during installation.

These changes take effect once a release containing them is distributed. Users
on older builds need to install that release first; if their old update feed is
unavailable, they need to download it manually once.
