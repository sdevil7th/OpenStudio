# Release Roadmap

This file contains only open work. Completed implementation history belongs in
Git.

## Release gates

- [ ] Obtain written TONE3000 approval for the production OAuth, catalog,
  attribution, and download scope.
- [ ] Run the [fresh-account TONE3000 acceptance](testing.md#tone3000-first-user-acceptance)
  with the release candidate.
- [ ] Confirm `TONE3000_PUBLISHABLE_KEY` reaches every GitHub release job
  through the configured Doppler service token.
- [ ] Complete user guitar audition of the exact Debug/release candidate and
  record `pass`, `fail`, or `not_asserted` per listening item.
- [ ] Run a real screen-reader pass over the bitmap-backed NAM controls.
- [ ] Verify licenses and redistribution terms for every starter NAM capture
  and IR included in a release.
- [ ] Complete platform download/install smoke tests and checksum verification
  for every artifact advertised on the website.

## Pitch editor

The current production graphical path is the native VSF pitch-only renderer.
Deterministic pitch requests and render integrity are covered; naturalness,
formant quality, and difficult note boundaries remain listening decisions.

Reopen the experimental ML-restoration or clean-sheet engine families only when
a materially stronger restorer/decomposition is available. Do not revive the
rejected proxy path or treat diagnostic similarity scores as completion.

## Deliberately deferred

- Same-path asset fingerprints: add only if replacing a model/IR in place
  becomes a supported workflow.
- One-file portable tone bundles and shared-asset reference counting: required
  before offering destructive library cleanup, not before normal preset use.
- Event-driven tuner telemetry and smaller knob atlases: profile first.
- User-selectable 4x oversampling: expose only if measured value justifies its
  CPU/latency cost.
- Cross-device library export: move additional local library metadata native
  only when the product commits to that workflow.

## Retired product paths

Do not reintroduce these as visible features without a new product decision and
full QA:

- live rack Transpose;
- active Pedal NAM processing (legacy state is migration-only);
- Chaos as a separate mode (migrated to the dedicated Distortion pedal);
- Glitch and Doubler;
- decorative routing controls that imply unsupported topology.
