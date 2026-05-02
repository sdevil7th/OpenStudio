# PR Footprint Cleanup - 2026-05-01

## Keep

- Source, frontend, docs, tools, and test fixture files that are part of active feature work or regression coverage.
- AI runtime installer/configuration files such as `tools/install_ai_tools.py`, `tools/prepare-ai-runtime.ps1`, runtime install-plan JSON files, `tools/openstudio_ace_runner.py`, and the lightweight `tools/openstudio_ace_backend` bridge sources.
- Pitch regression scripts and fixtures needed to reproduce the pitch-renderer work.

## Ignore Or Remove

- `tmp_pitch_runs/` generated pitch regression runs. Pre-cleanup status showed 2951 untracked files in this directory.
- `tools/openstudio_ace_backend/vendor_runtime/` downloaded/generated ACE/Comfy runtime payloads. Pre-cleanup status showed 429 untracked files in this directory. The installer/probe code reconstructs this runtime from the pinned runtime plan and cache; it should not be committed.
- Generated pitch regression WAV/PNG/JSONL reports under `tests/fixtures/pitch-regression`.
- Local debug capture output under `pitch_debug_captures/`.

## Needs Review

- Untracked source/docs/frontend/test files outside the generated buckets are not deleted here. They appear to be intentional feature or regression work and should be reviewed by feature owner before commit.
- Tracked modified files remain untouched by this cleanup pass.

## Actions

- Added `.gitignore` coverage for generated pitch runs, pitch debug captures, generated report media, and the ACE vendor runtime payload.
- Removed generated local runtime/run folders from the working tree after verifying they were inside the repository root.
