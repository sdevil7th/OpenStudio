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
npm run test:e2e
```

From the repository root:

```powershell
cmake --build build --config Debug
powershell -ExecutionPolicy Bypass -File tools/run-clean-guitar-headless-regression.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File tools/run-nam-rack-di-headless-regression.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File tools/run-nam-rack-headless-regression.ps1 -SkipBuild
```

The full NAM Rack matrix defaults to a 360-second timeout. It currently takes
about three minutes in a Debug build; use `-TimeoutSeconds` only when a slower
CI runner needs additional margin, not to conceal a hung regression.

Before a release:

```powershell
cmake --build build --config Release
python build.py prod
```

The three PowerShell regressions are intentionally headless. They must not open
an OpenStudio window. `tools/nam-rack-visual-harness.mjs` is retained for
targeted browser/layout capture; generated screenshots and reports are ignored.

## Frontend visual and interaction QA

Every resizable frontend surface must be checked at its supported compact,
normal, and large widths; at compact and normal heights; and at representative
HiDPI/Windows display scaling. The release gate is behavioral and geometric:

- no horizontal page overflow, accidental host gutter, clipped control, or
  overlapping visual/hit target;
- labels wrap or truncate deliberately, focus remains visible, and accessible
  names and pointer/keyboard targets remain intact;
- browser geometry and screenshot checks cover the rendered result, while
  interaction tests cover scrolling, focus, keyboard use, and control travel;
- `npx tsc --noEmit`, the frontend tests, the Vite production build, and the
  packaged Debug WebView assets all use the same current source.

Exact CSS text is not a visual oracle. Tests may enforce global architecture
rules such as the absence of runtime styles and `!important`, but layout
acceptance must inspect the real rendered surface.

## Audio signal-chain triage

Pitch, playback, and render artifacts must be localized before DSP tuning.

- Live: route resolution -> `PlaybackEngine` read/mix -> `TrackProcessor` ->
  sends/sidechain -> master/monitor FX -> gain/pan/mono -> meters -> device.
- Render: render `PlaybackEngine` snapshot -> `TrackProcessor` -> master FX and
  gain -> writer.

Set `OPENSTUDIO_AUDIO_CHAIN_DEBUG=1` to write a debug packet beside a render,
or set `OPENSTUDIO_AUDIO_CHAIN_DEBUG_DIR` to choose the directory. The packet
contains `render_chain_report.json`, `playback_output.wav`,
`track_post_processing.wav`, `master_pre_fx.wav`, `master_post_fx.wav`, and
`writer_input.wav`. `OPENSTUDIO_AUDIO_CHAIN_DEBUG_MAX_SEC` bounds capture time
and defaults to 12 seconds.

Find the first dirty stage: source/routing/read conversion when playback is
already dirty; processor state, bypass, default EQ/gain, and denormals when the
track/master stage first changes; alignment, format conversion, dither, block,
and tail handling when only writer input/output is dirty; callback deadlines,
resizes, lock misses, IPC/timer pressure, and preview cleanup when only live
playback is dirty. A clean render rules out WebView IPC and live-device
underruns as the render artifact's cause. Do not close a noise issue until the
first dirty stage is identified, deterministic checks pass, and the exact
artifact is auditioned.

## Reference-comparison capture protocol

Use the same 10-15 second dry DI for both systems, including sustained chords,
single notes, palm-muted transients, decay, and silence. Record the exact preset
and controls, sample rate, buffer, input peak, output loudness, and mono/stereo
route. Capture wet-only output where possible and loudness-match with LUFS/RMS
before judging tone. Test a real `L = guitar, R = silence` route separately
from duplicated stereo input so lane faults cannot hide.

Reference files are QA oracles only and production must never read or depend on
them. Change one audible issue per iteration. Spectral and level measurements
remain `diagnostic_only`; perceived similarity and transition quality remain
`not_asserted` until a person approves the exact artifacts.

## What automation may prove

- A1/A2 fixture loading and invalid-model rejection.
- Finite, bounded processing and expected relative pitch requests.
- Prepared model/IR swaps and stale-request rejection.
- Sample-rate conversion and callback-partition invariance.
- Fixed reported latency and dry-path alignment.
- Project, preset, A/B, order, calibration, and automation identity round trips.
- Preview Use/Cancel rollback.
- Multi-capture pack collapse/hydration, exact child identity (including
  URL-only/model-ID-zero cases), selection without publication, preview
  supersession, Use, replace, bypass, and unload state transitions.
- Missing-asset recovery and durable download identity.
- TONE3000 session-state transitions with deterministic mocks.
- Output-file creation and explicit render-route state.

CPU percentages, spectra, formant estimates, and fixture-specific deadline
measurements are `diagnostic_only`.

## Guitar/Bass instrument-profile release matrix

The automated gate must cover all of the following before merging:

1. Missing, legacy, out-of-range, NaN, and infinite profile state canonicalizes
   to Guitar; a valid Bass value survives project, user-preset, import/export,
   and Compare A/B round trips. The instrument selector is intentionally not a
   user-automatable parameter; separate DSP stress tests exercise live profile
   switches across callback boundaries.
2. Switching Guitar -> Bass -> Guitar does not change any stored visible value,
   model/capture path, cabinet IR path, calibration value, or explicit cutoff.
3. EQ Boost centres/labels, Octaver tracking, both nonlinear pedals, Amp wrapper
   and tone stack, Graphic EQ low band, modulation direct path, Delay repeat
   filtering, and non-legacy Reverb low decay exercise their intended profile
   mapping with finite bounded output.
4. The live switch is deterministic across fixed and uneven callback partitions,
   remains bounded at the exact transition samples, and latches one coherent
   profile for a complete audio callback during concurrent UI publication.
   Octaver coverage spans 44.1, 48, and 96 kHz.
5. Catalog and installed-library views filter only explicitly incompatible
   metadata, keep untagged/shared captures, and pin an already-active opposite-
   tagged capture without unloading or replacing it.
6. Changing away from an instrument-specific factory template clears only the
   stale template identity/baseline. Shared templates and user presets retain
   their normal dirty-state behavior.

The final musician audition uses clean Guitar and five-string Bass DI fixtures.
For each instrument, enable one stage at a time, then the complete chain; toggle
the profile during sustained notes, palm mutes, silence, modulation, Delay and
Reverb tails; load/change/remove, bypass/re-enable, and replace captures and IRs;
save and recall multiple presets; restart the app; and repeat at small and normal
device buffers. Record
the rack output while switching and inspect/listen for clicks, dropouts, stale
audio, DC steps, unexpected repeat/tail resurrection, and noise-floor changes.
Those listening outcomes remain `not_asserted` until a person approves the exact
release artifact.

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
7. Open a tone pack that declares multiple captures. Confirm the pack appears
   once, its count is correct, and **View Captures** exposes every hydrated
   child with its architecture and RAW/CAB-embedded topology.
8. Select child A and confirm selection alone leaves the current audible model
   unchanged. Audition A, switch directly to audition child B, then Stop and
   confirm the complete pre-preview baseline returns.
9. Audition child A again and choose **Use**. Confirm the nameplate, exact child
   identity, source attribution, amp/cab topology, and saved metadata all refer
   to A rather than the pack sentinel or first child by accident.
10. Reopen the picker and Use child B to replace A. If B embeds a cabinet,
    confirm the external Cab is bypassed without deleting its prior IR; return
    to an amp-only child and confirm the normal Cab workflow resumes.
11. Bypass and re-enable the Amp slot without losing B, then Unload and confirm
    the slot is empty. Reload B, save the project/tone, restart OpenStudio, and
    confirm the exact child and enabled state restore.
12. Start another preview and Cancel it; confirm the restored state includes
    capture, Cab, power, and mix values. Repeat while a prior request is still
    preparing and confirm a stale completion cannot overwrite the newer choice.
13. Install one permitted cabinet IR and confirm it becomes audible only where
    the selected capture needs an external cabinet.
14. Force or wait for token refresh and repeat a search/download.
15. Delete one downloaded child asset, reopen the project, and verify Locate,
    Replace, Bypass, and supported Re-download recovery without disabling the
    rest of the rack.

The deterministic frontend/unit suite separately covers pack-sentinel/model-ID-zero
and URL-only child identities when the live catalog does not expose such a
record during the acceptance run.

Record the app version, OS, account state, model/IR IDs, result for each step,
and screenshots of any failure. Do not include tokens or the publishable key in
the report.

## Manual audio matrix

Use clean Guitar and five-string Bass DIs, the user's normal interface, and at
least one A1 and one A2 capture:

- 44.1, 48, and 96 kHz where the device supports them;
- 32, 64, 128, 256, and 512-sample buffers where stable;
- mono and stereo track paths;
- amp-only capture plus IR and full-rig capture with external Cab bypassed;
- each native pedal alone and representative combinations;
- selection-only, audition/stop, audition-to-audition, Use, model replacement,
  cabinet, preset, A/B, bypass/re-enable, unload, and missing-asset transitions;
- live playback and offline render of the same phrase.

Report objective invariants separately from the user's listening verdict.

## Optional AI-generation acceptance

When ACE-Step or Stable Audio generation changes, manually exercise ACE prompt
and lyrics generation plus variation, inpaint, and continuation; then exercise
Stable Audio setup/license acknowledgement, prompt generation, variation,
inpaint, and continuation with a valid local snapshot. Generated WAVs must
import at the intended positions, play, persist through save/reopen, and undo
as one user action. A missing optional model/runtime must not block base-app
startup.
