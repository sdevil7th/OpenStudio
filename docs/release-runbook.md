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

Use this flow instead:

1. Run the local Windows RC gate first:
   `./tools/run-windows-rc.ps1 -Version 1.0.0`
2. Confirm the installed Windows app launches visibly in both normal mode and `--ui-safe-mode`, and `%APPDATA%\OpenStudio\logs\OpenStudio_Startup.log` records `Frontend startup state: boot-ready`.
3. Push the release-ready commit(s) to GitHub.
4. Wait for `.github/workflows/verify.yml` to pass on that commit.
5. Push a version tag like `v0.0.2`.
6. Let `.github/workflows/release.yml` build Windows and macOS, publish the GitHub Release, attach the fixed-name assets, and then trigger the website repo so it can publish the public metadata and redirects.
7. Verify the published direct-download URLs:
   - `https://github.com/<org>/<repo>/releases/latest/download/OpenStudio-Setup-x64.exe`
   - `https://github.com/<org>/<repo>/releases/latest/download/OpenStudio-macOS.dmg`
   - `https://github.com/<org>/<repo>/releases/latest/download/OpenStudio-AI-Runtime-windows-x64.zip`
   - `https://github.com/<org>/<repo>/releases/latest/download/OpenStudio-AI-Runtime-macos-universal.zip`
8. Verify the website repo finishes its deploy and the public metadata/redirect URLs on `openstudio.org.in` return JSON/XML/302 responses instead of the SPA HTML shell.

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
- To install the pinned ASIO SDK locally, run:
  `powershell -ExecutionPolicy Bypass -File tools/setup-asio-sdk.ps1`
- To install the pinned Windows prerequisite installers locally, run:
  `powershell -ExecutionPolicy Bypass -File tools/setup-windows-prereqs.ps1`
- To include ONNX Runtime in the Windows GitHub Actions build, set the repository variable `OPENSTUDIO_SETUP_ONNXRUNTIME=true`.

## Dependency contract

OpenStudio now follows the policy documented in `docs/runtime-dependency-contract.md`.

- Hard launch prerequisites may block launch and must be provisioned or diagnosed clearly.
- Shell-critical startup assets must be present in every packaged runtime bundle.
- Bundled feature assets such as `basic_pitch_nmp.onnx` are validated for packaging quality but must not block base app launch.
- Optional feature prerequisites, including Python for AI tools, must never block base app launch.
- AI tools setup runs in the background and surfaces progress through the toolbar AI button plus a lightweight in-app popup.

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
3. Optional: install ONNX Runtime for polyphonic pitch detection: `powershell -ExecutionPolicy Bypass -File tools/setup-onnxruntime.ps1`
4. Build the app in a clean release directory: `cmake -S . -B build-release-windows -A x64 "-DOPENSTUDIO_APP_VERSION=1.0.0" "-DJUCE_ASIOSDK_PATH=thirdparty/asio" "-DOPENSTUDIO_REQUIRE_ASIO=ON" "-DOPENSTUDIO_ENABLE_EXTERNAL_PYTHON_AI_FALLBACK=OFF" -DFETCHCONTENT_UPDATES_DISCONNECTED=ON`
5. Build the release target: `cmake --build build-release-windows --config Release --target OpenStudio`
6. Validate the runtime bundle: `./tools/validate-runtime-bundle.ps1 -Platform windows -BundlePath build-release-windows/OpenStudio_artefacts/Release -ExpectedVersion 1.0.0 -EnforceLeanBundle`
   This now also validates staged Windows prerequisite installers when they are part of the runtime contract.
7. Package the installer: `./tools/package-windows-release.ps1 -Version 1.0.0 -SourceDir build-release-windows/OpenStudio_artefacts/Release`
   Optional signing: `./tools/package-windows-release.ps1 -Version 1.0.0 -CertificateFile C:\path\to\codesign.pfx -CertificatePassword <password>`
8. Prepare and package the Windows AI runtime archive:
   `./tools/prepare-ai-runtime.ps1 -Platform windows -RuntimeRoot build-ai-runtime/windows -PythonExecutable python -RequirementsFile tools/ai-runtime-requirements.txt -ExpectedRuntimeVersion 1.0.0`
   `./tools/package-ai-runtime.ps1 -Platform windows -RuntimeRoot build-ai-runtime/windows -OutputPath dist/ai-runtime/OpenStudio-AI-Runtime-windows-x64.zip -ExpectedRuntimeVersion 1.0.0`
9. Generate updater metadata:
   `./tools/generate-release-metadata.ps1 -Version 1.0.0 -Channel stable -ReleasePageUrl https://github.com/<org>/<repo>/releases/tag/v1.0.0 -WindowsAssetPath dist/windows/OpenStudio-Setup-x64.exe -WindowsAssetUrl https://github.com/<org>/<repo>/releases/download/v1.0.0/OpenStudio-Setup-x64.exe -WindowsAiRuntimeAssetPath dist/ai-runtime/OpenStudio-AI-Runtime-windows-x64.zip -WindowsAiRuntimeAssetUrl https://github.com/<org>/<repo>/releases/download/v1.0.0/OpenStudio-AI-Runtime-windows-x64.zip -AiRuntimeVersion 1.0.0`
   Optional appcast fields: `-FullReleaseNotesUrl https://openstudio.org.in/releases/1.0.0 -WindowsInstallerArguments "/SP- /NOICONS"`
10. Validate the generated metadata:
   `./tools/validate-release-metadata.ps1 -MetadataDir dist/release-metadata -Channel stable -WindowsAssetPath dist/windows/OpenStudio-Setup-x64.exe -WindowsAiRuntimeAssetPath dist/ai-runtime/OpenStudio-AI-Runtime-windows-x64.zip`
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
   If `MACOS_CODESIGN_IDENTITY` is set, the script verifies both the app bundle and DMG with `codesign` and `spctl`. If notarization credentials are present, it also staples and validates the notarized DMG.
   For the zero-cost v1 path, leave those signing variables unset and ship the unsigned DMG with manual Gatekeeper override instructions on the download page.
5. Package the macOS AI runtime archive from your prepared macOS runtime root:
   `./tools/package-ai-runtime.ps1 -Platform macos -RuntimeRoot <macos-runtime-root> -OutputPath dist/ai-runtime/OpenStudio-AI-Runtime-macos-universal.zip -ExpectedRuntimeVersion 1.0.0`
6. Generate updater metadata with the DMG path and URL included.
   For Sparkle-ready appcasts, also pass `-MacEdSignature <signature>` and optionally `-MacMinimumSystemVersion 13.0`.
7. Validate the generated metadata:
   `./tools/validate-release-metadata.ps1 -MetadataDir dist/release-metadata -Channel stable -MacAssetPath dist/macos/OpenStudio-macOS.dmg -MacAiRuntimeAssetPath dist/ai-runtime/OpenStudio-AI-Runtime-macos-universal.zip`
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

For the current release path, the only non-signing secret required for public metadata publishing is the cross-repo website dispatch token. If you want Doppler-backed secret loading, add `DOPPLER_TOKEN` as the single bootstrap secret in GitHub Actions. The signing/notarization secrets below stay optional unless you decide to enable trusted distribution later.

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
- `OPENSTUDIO_WINDOWS_AI_RUNTIME_ROOT`
- `OPENSTUDIO_MACOS_AI_RUNTIME_ROOT`
- `OPENSTUDIO_WEBSITE_REPO`
- `OPENSTUDIO_WEBSITE_DISPATCH_EVENT_TYPE`

The default website repo target is `sdevil7th/OpenStudioWebsite`.
The default dispatch event type is `openstudio_release_published`.

GitHub-hosted Windows releases no longer require a pre-existing committed `tools/python`
tree. The release workflow now uses `actions/setup-python` with Python 3.12 on
`windows-latest` and prepares a fresh AI runtime automatically before packaging it. Set
`OPENSTUDIO_WINDOWS_AI_RUNTIME_ROOT` only if you want the workflow to reuse or overwrite a
specific runner-local path.

GitHub-hosted macOS releases no longer require a pre-existing committed `tools/python-macos`
tree. The release workflow now uses `actions/setup-python` with Python 3.10 on `macos-14`
and prepares a fresh AI runtime automatically before packaging it. Python 3.10 is pinned
there intentionally because the current `audio-separator` macOS dependency chain still
resolves through `diffq` wheels that are available for macOS CPython 3.10, while newer
macOS interpreters do not currently provide a compatible all-wheel path for the release
runtime-preparation step. Set
`OPENSTUDIO_MACOS_AI_RUNTIME_ROOT` only if you want the workflow to reuse or overwrite a
specific runner-local path.

Optional future additions:

- Sparkle/WinSparkle-specific signature generation
- Beta channel metadata publishing alongside the stable channel
