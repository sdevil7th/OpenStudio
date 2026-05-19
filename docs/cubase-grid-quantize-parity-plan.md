# Cubase-Style Global Grid, Snap, and MIDI Quantize Parity

## Summary
Implement Cubase-style parity for the global grid, snap behavior, MIDI editor snapping, and MIDI quantize workflow. This pass excludes audio warp/hitpoint quantize, groove extraction from audio, and backend DSP changes.

## Already Completed
- [x] Reviewed Steinberg Cubase 15 docs for Quantize Panel, Quantize Presets, Grid Type, Snap Grid, Snap Types, Key Editor Toolbar, and MIDI snap behavior.
- [x] Audited Studio13's current global snap, timeline grid, piano roll snap, and MIDI quantize implementation.

## Tracking Checklist
- [x] Create `docs/cubase-grid-quantize-parity-plan.md` with this checklist.
- [x] Add shared grid/quantize preset model and interval resolver.
- [x] Persist new snap/grid/quantize state in store and project save/load.
- [x] Add header toolbar visual controls.
- [x] Update View menu and Preferences grid controls.
- [x] Refactor timeline snapping and grid rendering to use shared resolver.
- [x] Refactor piano roll snapping and grid rendering to use shared resolver.
- [x] Implement MIDI Ctrl snap-bypass and resolve duplicate-drag conflict.
- [x] Replace MIDI Quantize dialog with Cubase-style Quantize Panel.
- [x] Add Length Quantize and Quantize Link behavior for MIDI editor/step input.
- [x] Implement custom quantize preset save/rename/remove/restore factory.
- [x] Add tests and mark checklist items done as each passes.

## Implemented Visual Changes
- [x] Main header toolbar now shows Snap, Snap Type, Grid Type, Quantize Preset, Apply Quantize, and Quantize Panel controls.
- [x] Piano roll toolbar now mirrors the Cubase-style Snap, Snap Type, Grid Type, Quantize Preset, Apply, Quantize Panel, and Length Quantize controls.
- [x] Piano roll status strip displays the active resolved grid label instead of the old fixed `0.25 beat` snap readout.
- [x] MIDI Quantize dialog is now a Quantize Panel-style grid with Preset, Mode, Grid Type, Soft Quantize, Tuplet, Swing, Groove, Catch Range, Safe Range, Rough Quantize, Length Quantize, Move Controllers, Auto Apply, Reset, and Apply controls.

## Test Plan
- [x] Unit-test straight, triplet, dotted, Bar/Beat, Use Quantize, and Adapt to Zoom interval resolution.
- [x] Unit-test Snap Type behavior for grid, relative grid, cursor, event, and combined snap candidates.
- [ ] Add MIDI editor interaction coverage for Snap on, Ctrl-drag off-grid placement, draw/resize/split using selected grid, quantize using current preset, and Length Quantize.
- [x] Run `npx tsc --noEmit` and targeted frontend tests; note known pre-existing TypeScript errors separately if still present.
