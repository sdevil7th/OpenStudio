# OpenStudio 0.0.16

Optional AI runtime candidate for application 0.1.04. The application, model
weights and device-specific accelerator packages remain separate downloads.
The [review in application PR #27](https://github.com/sdevil7th/OpenStudio/pull/27)
covers the [range since the last published all-platform runtime](https://github.com/sdevil7th/OpenStudio/compare/ai-runtime-v0.0.13...fb5eb2dfbe6995bec9ffedd980520e18165f78b7)
and the macOS preparation correction. The separate
[Linux 0.0.14 hotfix](https://github.com/sdevil7th/OpenStudio/compare/ai-runtime-v0.0.13...ai-runtime-linux-v0.0.14)
remains the selected Linux archive for this application candidate.

## Highlights

- Prepare portable Python 3.11.15 runtimes for Windows x64, macOS Apple Silicon
  and Linux x64. The Windows base stays lightweight, with accelerator packages
  installed through the existing on-device plans.
- Qualify macOS preparation and the relocated archive in PR CI before creating
  another component release. That smoke archive uses a test version and is
  retained as a CI artifact; it is not published to the app's runtime catalog.

## Fixes

- Replace the Windows Python 3.10.20 base, which the current managed installer
  does not upgrade and the Audio Generation worker rejects. Python 3.11.15
  satisfies the worker's interpreter contract.
- Allow the macOS stem-separation dependency to build from source when upstream
  has no Python 3.11 ARM wheel. The previous wheel-only requirement caused the
  [0.0.15 release attempt](https://github.com/sdevil7th/OpenStudio/actions/runs/37740042062)
  to stop before macOS archive packaging. Its tag remains unchanged and no
  runtime release was published from that failed attempt.
- Require exact-version reviewed notes, matching source/tag identity, validated
  archives and a final serialized publication check. Component publication
  preserves the application's GitHub latest release and does not overwrite
  existing assets. Cached macOS packages must pass current validation too.
- Retain Linux archive relocation, model-cache and stem-checkpoint readiness
  fixes. The Linux gfx1151 ROCm plan still requires device-specific qualification.

## Verification

- Windows Python 3.11.15 preparation and relocated archive validation passed in
  the preceding attempt. The local base archive is approximately 47 MB; those
  checks used 0.0.15 metadata and do not claim publication of version 0.0.16.
- Publishing 0.0.16 requires successful preparation, packaging and relocated
  archive validation on all three hosted platforms. These checks establish
  interpreter, layout and capability-probe invariants; GPU inference and audio
  quality need separate acceptance.

## Known Issues

- The downloadable macOS AI archive requires Apple Silicon and macOS 14 or
  later because its bundled numerical-library wheels target that OS range.
  This was already true of runtime 0.0.13; the base app's macOS 12 minimum
  does not establish compatibility of the managed AI archive on macOS 12/13.
- Physical GPU execution, clean on-device package/model installation and
  generated-audio quality remain separate hardware qualification. Interpreter
  compatibility alone does not establish those results.
- macOS generic ACE Audio Generation is still constrained by the current
  CUDA/ROCm hardware policy. This runtime does not enable Intel macOS AI
  support, change model licenses or replace older installed worker scripts.
- Existing managed Python 3.10 environments need repair or replacement;
  publishing a new archive does not migrate an installed environment.

## Upgrade Notes

- After successful component publication, select catalog version 0.0.16 and
  `ai-runtime-v0.0.16` for Windows/macOS. Keep `ai-runtime-linux-v0.0.14` for
  Linux. The application release later publishes the combined catalog; this
  component release does not publish the application or submit it to Store.
- Use AI Tools Setup to repair/install the optional runtime, preserving project
  files and model caches. No project or runtime-metadata schema migration is
  introduced by this component release.
