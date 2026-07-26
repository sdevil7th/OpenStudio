# NAM and Audio QA

OpenStudio separates deterministic engineering evidence from listening
judgment. Every result must be reported as:

- `pass` — a deterministic requirement succeeded.
- `fail` — a deterministic requirement failed.
- `diagnostic_only` — useful measurement that is not a release guarantee.
- `not_asserted` — requires a person to audition or inspect the exact build.

## Fast release checks

From `frontend/`:

```bash
npm test
npx tsc --noEmit
npm run build
```

From the repository root:

```powershell
cmake --build build --config Debug
powershell -ExecutionPolicy Bypass -File tools/run-clean-guitar-headless-regression.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File tools/run-nam-rack-di-headless-regression.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File tools/run-nam-rack-headless-regression.ps1 -SkipBuild
```

Before a release:

```powershell
cmake --build build --config Release
python build.py prod
```

The three PowerShell regressions are intentionally headless. They must not open
an OpenStudio window. `tools/nam-rack-visual-harness.mjs` is retained for
targeted browser/layout capture; generated screenshots and reports are ignored.

## What automation may prove

- A1/A2 fixture loading and invalid-model rejection.
- Finite, bounded processing and expected relative pitch requests.
- Prepared model/IR swaps and stale-request rejection.
- Sample-rate conversion and callback-partition invariance.
- Fixed reported latency and dry-path alignment.
- Project, preset, A/B, order, calibration, and automation identity round trips.
- Preview Use/Cancel rollback.
- Missing-asset recovery and durable download identity.
- TONE3000 session-state transitions with deterministic mocks.
- Output-file creation and explicit render-route state.

CPU percentages, spectra, formant estimates, and fixture-specific deadline
measurements are `diagnostic_only`.

## What automation may not prove

The following remain `not_asserted` until the user auditions the exact artifact:

- naturalness, realism, commercial-product sonic parity, or "better tone";
- pick response, palm-muted tightness, chord separation, sustain, or noise feel;
- click-free perception during power/model/cabinet changes;
- tuner feel on a real decaying guitar;
- chorus width, mono compatibility, delay feel, reverb density, or shimmer
  musicality;
- absence of real-device crackle across interfaces and drivers.

## TONE3000 first-user acceptance

Run this with a clean OS user or after removing only OpenStudio's saved
TONE3000 session:

1. Install the release candidate and open the NAM Rack.
2. Select Connect TONE3000.
3. Confirm the default browser opens the official TONE3000 page.
4. Create a new account or sign in as a first-time OpenStudio user.
5. Confirm the browser success page returns control to the app without copying
   a token or entering developer settings.
6. Search separately for A1 and A2; confirm combined results are bounded,
   paginated, attributed, and responsive to rate limits.
7. Open a tone detail, install one amp/full-rig capture, and press Use.
8. Install one permitted cabinet IR and confirm it becomes audible only where
   the selected capture needs an external cabinet.
9. Restart OpenStudio and confirm the account and installed assets restore.
10. Force or wait for token refresh and repeat a search/download.
11. Delete one downloaded asset, reopen the project, and verify recovery and
    supported re-download.
12. Cancel an in-flight or preview operation and confirm the prior rack remains
    unchanged.

Record the app version, OS, account state, model/IR IDs, result for each step,
and screenshots of any failure. Do not include tokens or the publishable key in
the report.

## Manual audio matrix

Use a clean DI, the user's normal interface, and at least one A1 and one A2
capture:

- 44.1, 48, and 96 kHz where the device supports them;
- 32, 64, 128, 256, and 512-sample buffers where stable;
- mono and stereo track paths;
- amp-only capture plus IR and full-rig capture with external Cab bypassed;
- each native pedal alone and representative combinations;
- model, cabinet, preset, A/B, and bypass transitions;
- live playback and offline render of the same phrase.

Report objective invariants separately from the user's listening verdict.
