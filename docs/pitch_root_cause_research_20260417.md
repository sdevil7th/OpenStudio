# Pitch Root-Cause Research 2026-04-17

## Summary
This pass was meant to answer three bounded questions:

1. Why are the two remaining product issues still happening?
2. Is there a fast local ML/external-style restoration path available now?
3. Is a clean-sheet `engine-v3` DSP reset credible enough to continue immediately?

The answers are:

- The failures are primarily architectural, not just tuning-related.
- No materially stronger local ML restorer is available in this environment right now.
- The first `engine-v3` feasibility probe does not justify immediate build-out.

Baseline remains:

- kept renderer: `pitch_only_adaptive_selector`
- frozen comparison-only challenger: `pitch_only_engine_v2_program`

## Top Causes
| Rank | Cause | Confidence | Evidence | Likely fixes |
| --- | --- | --- | --- | --- |
| 1 | Transition ownership and boundary timing drift | high | Hard-case adaptive boundary timing stays high even after correction (`18.92 ms` boundary max; `18.92 ms` transient max), and frozen engine-v2 still collapses on hard-case entry (`entry mel 7.017`). | Own entry and exit as a transition pair instead of as per-note local patches; move shell/core alignment earlier at note entry instead of relying on late correction; only benchmark architectures that separate transient shell from voiced core before pitch rendering |
| 2 | Mixed transient and first-voiced-cycle content is still being handled by one renderer family | medium | Adaptive correction improves some easy windows but hard-case transient metrics stay elevated (`pitchTest` transient entry/exit max `1.614 / 6.723`), and engine-v2 still fails with transient bypass enabled. | Use a true shell/core/residual decomposition before note-change rendering; treat the first voiced cycles as their own ownership zone; prefer learned restoration or a clean-sheet transition renderer over more local handoff tuning |
| 3 | Current formant preservation is too weak and too local to survive hard transitions | high | Formant drift remains in the adaptive path even after correction (`pitchOrg` formant mean `0.364`; `pitchTest` formant mean `0.071`), while engine-v2 keeps spectral envelope correction on but still loses the hard case (`formant drift 0.062`, `entry mel 7.017`). | Use an explicitly conditioned source-filter or learned restoration stage instead of a light cepstral patch; keep pitch exactness in the carrier and repair timbre only inside the affected transition region; only continue DSP work if the new architecture bakes formant handling into the core renderer |

## Key Evidence
- Original vs reference hard case:
  - boundary timing `39.833 ms`
  - formant drift `0.528`
- Adaptive best hard-case transient means:
  - entry `1.598`
  - exit `6.543`
  - timing max `18.917 ms`
- Adaptive best hard-case formant mean drift:
  - `0.071`
- Frozen engine-v2 hard-case run:
  - entry mel `7.017`
  - onset artifact `4.000`
  - formant drift `0.062`

Primary artifact files:

- root-cause run:
  - `D:\test projects\os tests\runs\20260417_012542_pitch_root_cause_research\pitch_root_cause_research.md`
  - `D:\test projects\os tests\runs\20260417_012542_pitch_root_cause_research\pitch_root_cause_research.json`
- ML benchmark:
  - `D:\test projects\os tests\runs\20260417_003355_pitch_ml_benchmark\pitch_ml_benchmark_summary.md`
- engine-v3 feasibility:
  - `D:\test projects\os tests\runs\20260417_003355_engine_v3_feasibility\pitch_engine_v3_feasibility_summary.md`

## ML Benchmark Verdict
Local ML restoration is blocked for now.

Environment result:

- verdict: `blocked_no_stronger_restorer`
- runtime ready: `true`
- selected backend: `cuda`

Candidate check:

- `voicefixer`: not installed
- `demucs`: not installed
- `audio_separator`: available, but not note-local restoration
- `proxy_ml_restore_v1`: explicitly excluded and already rejected

Meaning:

- do not reopen `FAM-ML-RESTORATION` locally on another proxy
- the next ML step is to source a genuinely stronger restorer or benchmark an outside/licensed path

## Engine-v3 Feasibility Verdict
The first `V3-1` decomposition probe says `stop`, not `continue`.

Results:

| Case | Decomposition score | Verdict |
| --- | ---: | --- |
| `pitchOrg_plus4` | `0.511` | `stop` |
| `pitchTest_plus4` | `0.505` | `stop` |

Interpretation:

- the first shell/core/residual split heuristic is not yet stronger than the current adaptive carrier
- there is no evidence yet that an immediate `engine-v3` build-out would avoid repeating the `engine-v2` failure pattern

Meaning:

- do not start a long `engine-v3` branch from this decomposition probe alone
- only reopen `engine-v3` if we define a materially stronger decomposition and transition-pair ownership model first

## Decision
Current best action order is:

1. Keep `pitch_only_adaptive_selector` as the working editor.
2. Stop local ML retries until a stronger restorer is actually available.
3. Do not expand `engine-v3` from the current feasibility probe.
4. If we want the fastest chance of a real audible improvement, benchmark an external/licensed or materially stronger ML restorer next.
5. If we want a new in-house DSP engine later, begin with a better decomposition/transition design doc first, not another immediate renderer branch.

## What This Research Changed
This pass closes the main uncertainty from the earlier tuning program:

- the problem is not mainly unresolved because we missed one more STFT or crossfade tweak
- the problem remains because the current family does not own the transition pair strongly enough, still mixes transient and first voiced cycles too early, and only preserves formants with a weak local correction

That means the next step should be bounded and evidence-led, not another open-ended renderer tuning loop.
