# OpenStudio development workflows

## Development

Run from the app repository root:

```sh
python build.py dev --run
```

The helper installs missing frontend dependencies, builds the frontend fallback
and Debug native app, starts Vite, waits for it to respond, and launches the app.
It cleans up its child processes on exit. Frontend source edits use Vite HMR;
C++ changes require a native rebuild.

For a deterministic dependency install and manual build:

```sh
npm --prefix frontend ci
npm --prefix frontend run build
cmake --build build --config Debug
```

CMake must already be configured; `python build.py dev` performs that setup.
On Windows the Debug executable is
`build/OpenStudio_artefacts/Debug/OpenStudio.exe`. Its packaged fallback is the
copied `webui` directory beside the executable.

## Manual testing handoff

The user-facing command remains `python build.py dev --run`. After frontend or
native changes, build the latest frontend and run
`cmake --build build --config Debug` before handing off a candidate. No
pre-running server should be required. Stop task-owned Vite/npm/browser harness
processes and do not leave a task-owned process on port 5183.

A Debug build is evidence for that configuration only. Release and installed
WebView startup are qualified separately; see the
[release smoke checklist](docs/release-smoke-checklist.md).

## Frontend checks

```sh
npm --prefix frontend run build
npm --prefix frontend test
```

The build runs dependency-notice validation, TypeScript and Vite. For app browser
flows, run from `frontend` after installing the browser dependencies required
by its Playwright configuration:

```sh
npx playwright install chromium
npm run test:e2e
```

These are the desktop app's frontend tests. The separate website repository has
its own build, browser and loading-performance checks. Browser automation is not
native audio, hardware or installed-package qualification; follow
[docs/testing.md](docs/testing.md) for those checks.

## Rebranding

The master, consumers and generation command are documented in
[docs/branding.md](docs/branding.md). After changing the master:

```sh
node tools/generate-icons.mjs
npm --prefix frontend run build
cmake --build build --config Debug
```

Rebuild the Release configuration before packaging a release. Native package
icons, frontend/browser icons, README images and website artwork have separate
consumers; follow the inventory and verify the candidate's visible icons.

## Production builds and releases

Production builds require reviewed notes in `docs/releases/<candidate-version>.md`:

```sh
python tools/validate-release-notes.py --version <candidate-version>
python build.py prod --version <candidate-version>
```

Replace the placeholder with the intended version. On Windows the executable is
under `build/OpenStudio_artefacts/Release/`; it ships with `webui`, runtime
libraries and supporting files. The frontend is copied into the package, not
embedded into a standalone executable. No Vite server is needed by the installed
app. A production build does not by itself create/publish every platform installer.

Follow [the release runbook](docs/release-runbook.md) for the Windows RC gate,
release notes, CI, runtime pinning, platform packaging and tag-driven publishing.
An app source push does not publish a release. AI runtime tags are separate;
rebuild them only when their inputs change. The website release dispatcher then
publishes the appcasts and manifests used by existing installations.

## macOS first launch

Follow [the release runbook](docs/release-runbook.md) and the installer notes for
the downloaded version. Verify its checksum, install to Applications, and use
**System Settings > Privacy & Security > Open Anyway** if macOS blocks an unsigned
build. Removing quarantine is a diagnostic action, not the normal installation
instruction or proof that a package is trustworthy.
