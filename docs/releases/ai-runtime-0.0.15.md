# OpenStudio 0.0.15

Optional AI runtime candidate, separate from the OpenStudio application version.
Reviewed against the previous all-platform runtime tag and the later Linux
hotfix in [application release PR #27](https://github.com/sdevil7th/OpenStudio/pull/27).
[Previous runtime comparison](https://github.com/sdevil7th/OpenStudio/compare/ai-runtime-v0.0.13...c0995ea9dd8378cd425b4270a6a9b19b7ec00355).

## Highlights

- Prepare relocatable Windows x64, macOS Apple Silicon and Linux x64 archives
  with Python 3.11.15. Model weights and the application remain separate downloads.
- Keep Windows accelerator packages in the existing on-device installation
  plans rather than bundling GPU libraries in the lightweight Windows base.

## Fixes

- Replace the older Windows Python 3.10.20 base, which the current managed
  installer cannot upgrade and the Audio Generation worker rejects. Python
  3.11.15 satisfies the worker's interpreter requirement.
- Gate component builds on reviewed, exact-version notes and matching runtime
  tag identity. Bind a newly created runtime tag to the actual source commit,
  preserve the application's GitHub latest release, and validate cached macOS
  archives with the current interpreter and capability checks.
- Retain the Linux archive preparation and relocation fixes from runtime
  0.0.14. The application catalog may continue selecting that qualified Linux
  archive independently of the new Windows/macOS release.
- Current preparation diagnostics require complete cached ACE model snapshots
  and nonempty stem checkpoints/configuration. Linux preparation includes the
  gfx1151 ROCm installation plan; device-specific execution still needs qualification.

## Verification

- The local Windows base archive passed packaging and relocated archive
  validation with Python 3.11.15. It is approximately 47 MB and contains runtime
  metadata for version 0.0.15.
- Publication requires successful archive validation on all three hosted
  platforms. These checks cover runtime structure, interpreter compatibility
  and capability probes; they do not assert physical GPU inference or audio quality.

## Known Issues

- GPU execution, clean on-device package/model setup and generated-audio quality
  require separate hardware qualification. Satisfying the interpreter contract
  does not prove those workflows passed.
- macOS generic ACE Audio Generation remains constrained by the application's
  current CUDA/ROCm hardware policy. This archive does not enable unsupported
  macOS or Intel AI features, change model licenses or update older worker scripts.
- Existing managed Python 3.10 environments need repair or replacement; merely
  publishing this archive does not change an installed environment.

## Upgrade Notes

- Promote the verified runtime catalog only after the component release
  succeeds. For application 0.1.04, select the new Windows/macOS tag and retain
  the qualified Linux 0.0.14 override; keep projects and model caches.
- Use AI Tools Setup to repair/install the optional runtime. No application
  project-format migration is introduced by this runtime release.
