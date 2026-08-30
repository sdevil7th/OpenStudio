# OpenStudio Release Runbook

## What this repo now provides

- Windows installer packaging via `packaging/windows/OpenStudio.iss`
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
12. If signing is enabled, the packaging helper now verifies the Authenticode signature on both `OpenStudio.exe` and `OpenStudio-Setup-x64.exe`.

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

The Windows installer now also registers `.osproj` as the primary project extension and keeps `.s13` associated for legacy project open support.
The default base app no longer bundles the optional stem-separation Python runtime; users install AI Tools later from inside OpenStudio when they need stem separation.

## Secrets expected by GitHub Actions

For the current release path, `OPENSTUDIO_WEBSITE_DISPATCH_TOKEN` must be set
directly as a GitHub Actions secret because the publish job intentionally does
not receive Doppler credentials. `DOPPLER_TOKEN` is an optional bootstrap for
the allowlisted build/signing values used inside their specific build steps; it
does not replace the website dispatch secret. Signing/notarization secrets stay
optional unless you decide to enable trusted distribution later.

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
