# OpenStudio Roadmap

This public roadmap describes product direction, not fixed delivery dates or a
promise that every exploratory item will ship. Current capabilities and caveats
live in [Implemented features](implemented_features.md); release qualification
lives in [Testing](testing.md) and the
[Release smoke checklist](release-smoke-checklist.md).

## Now: release quality

- Complete release qualification for the NAM Rack and optional TONE3000
  workflow, including multi-capture selection, Guitar/Bass profiles, project and
  preset recovery, accessibility, and real-interface listening tests.
- Keep Windows, macOS, and Linux installation, startup, updates, and optional AI Tools
  setup reliable on clean systems.
- Preserve old projects and presets while strengthening audio-thread safety,
  deterministic state migration, and failure recovery.

## Next: DAW foundations

- Finish the remaining MIDI playback, routing, note-lifecycle, hardware-output,
  and plug-in-generated MIDI workflows across live playback and offline render.
- Bring CLAP instrument/event handling and state restoration to the same
  product standard as the reference VST3 path.
- Unify menus and contextual commands around the action registry so shortcuts,
  enablement, undo, and visible actions remain consistent.
- Complete and test the render/export options that OpenStudio advertises,
  including presets, queue behavior, metadata, failure cleanup, and project
  round trips.
- Improve project-wide media, FX, track/group, navigation, and floating-window
  management.

## Exploring

- An optional local DAW assistant that selects a model appropriate for the
  user's hardware, keeps project context local and bounded, previews every
  mutating action, and uses OpenStudio's normal undo-aware commands.
- Wider hybrid-precision processing where it produces measurable value without
  compromising plug-in compatibility or the default float32 workflow.
- More portable tone/library workflows, including cross-device metadata and
  safe shared-asset management.
- Future pitch-rendering or restoration research when a materially stronger,
  testable approach becomes available.
- A native extension SDK if demand justifies a stable ABI and long-term
  compatibility commitment; Lua and JSFX remain the supported extension paths
  today.

## Product guardrails

- OpenStudio will not bundle third-party NAM captures or cabinet IRs without
  clear redistribution permission.
- Automated measurements will not be presented as proof of subjective tone,
  naturalness, or commercial-product parity.
- Experimental controls will not be exposed as working product features before
  their complete signal path, persistence, and tests exist.
- Retired NAM Rack controls and misleading decorative routing will not return
  without a new product decision and full QA.
