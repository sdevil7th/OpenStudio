# OpenStudio 0.0.14

Linux x64 CPU AI runtime hotfix, separate from the application version.
[Source comparison](https://github.com/sdevil7th/OpenStudio/compare/ai-runtime-v0.0.13...ai-runtime-linux-v0.0.14).
The runtime requirements are unchanged from 0.0.13. This tag records the Linux
preparation, archive and interpreter-validation changes used for this artifact.

## Highlights

- Uses relocatable Python 3.11.15, replacing Python 3.10.20 so the interpreter
  satisfies the current music-generation worker's Python 3.11/3.12 requirement.
- Contains the Linux x64 CPU runtime only. Windows and macOS archives remain at
  0.0.13. Model weights and the OpenStudio application are separate downloads.

## Fixes

- Linux packaging preserves standalone Python's relative links and includes the
  hidden runtime metadata needed by the in-app installer.
- Package validation rejects interpreters outside the generation worker's
  supported range instead of accepting stem imports alone.

## Verification

- Relocated archive validation passes, including dependency imports and runtime
  metadata. Extracted Python starts and imports its AI dependencies on Ubuntu
  22.04, 24.04 and 26.04 virtual machines.
- On the Ubuntu 26.04 host, this runtime executes ACE-Step generation, variation,
  inpainting and continuation with finite WAV output using existing cached
  weights and the development worker. These are functional checks; subjective
  audio quality is not asserted.

## Known Issues

- This download cannot fix older application installers or worker scripts.
  Current Linux AI installer and Basic Pitch fixes are in an unpublished
  application candidate and are not included in this runtime archive.
- GPU backends require a separate installation plan and compatible drivers.
  NVIDIA INT8, MiniMax and Stable Audio inference are not qualified by this
  Linux CPU release. Model licenses remain separate requirements.

## Upgrade Notes

- Use AI Tools Setup to repair/install the optional Linux runtime. Keep model
  caches and projects; no project-format migration is involved.
- A published runtime archive and a promoted website runtime manifest are
  distinct delivery steps. Check the website manifest before assuming an older
  installed application will download this version.
