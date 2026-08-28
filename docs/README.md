# OpenStudio Documentation

OpenStudio keeps documentation task-oriented and close to the code. The goal is
the same pattern used by mature open-source libraries: a small navigation page,
stable guides by subject, executable examples, and one short roadmap instead of
date-stamped implementation diaries.

## Start here

- [User manual](USER_MANUAL.md) — install, configure, record, edit, mix, and export.
- [Implemented features](implemented_features.md) — current feature inventory and caveats.
- [NAM Rack](nam-rack.md) — Guitar/Bass capture workflow, multi-capture selection, DSP/state contract, TONE3000 integration, and release acceptance.
- [Keyboard and mouse profiles](input-profiles.md) — built-in DAW profiles, independent keyboard/mouse selection, scoped bindings, and custom profile import/export.
- [MIDI editor](midi-editor.md) — supported editing contract and manual acceptance.
- [NAM and audio QA](testing.md) — deterministic checks and manual release acceptance.
- [Release roadmap](roadmap.md) — only work that is still open or deliberately deferred.
- [Release runbook](release-runbook.md) — packaging and publication.
- [Release smoke checklist](release-smoke-checklist.md) — final build acceptance.
- [Runtime dependency contract](runtime-dependency-contract.md) — optional runtimes and models.
- [Lua API](API.md) — scripting reference.

## Documentation rules

1. Document the current product, not the history of how it was reached.
2. Put user workflows before implementation detail.
3. Keep runnable commands beside the behavior they verify.
4. Mark audio evidence as `pass`, `fail`, `diagnostic_only`, or
   `not_asserted`.
5. Never claim subjective tone, naturalness, or commercial-product parity from
   automated metrics.
6. Keep dated investigations in Git history or an issue tracker after their
   decisions have been folded into a stable guide.
7. Prefer links to authoritative source files over copied code.
8. Update the guide and test in the same change when a public contract changes.

Detailed research that remains useful for pitch rendering is consolidated in
`pitch_renderer_research_notes.md`. It is technical reference material, not an
active release plan.
