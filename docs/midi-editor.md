# MIDI Editor

OpenStudio's MIDI editor combines arrange-view MIDI items with a docked piano
roll, controller lanes, instrument routing, source-window editing, and
project/export serialization.

## Current contract

- MIDI and instrument tracks share the main timeline with audio tracks.
- Clip move, resize, loop, slip, split, copy, duplicate, delete, mute, lock,
  repeat, and compatible cross-track operations are undoable.
- The piano roll supports draw, erase, move, resize, split, glue, mute,
  audition, range selection, multi-item reference editing, and note inspector
  changes.
- Controller editing covers velocity, note-off velocity, probability,
  variance, pitch bend, CC, 14-bit CC, program/bank select, channel pressure,
  poly pressure, curves, transforms, and lane management where exposed.
- Project save/reload, backend synchronization, playback scheduling, render,
  freeze, and MIDI export preserve supported event metadata.

## Grid, snap, and quantize contract

- The arrange view and docked piano roll use one project-persisted Snap toggle,
  Snap Type, Grid Type, active Quantize Preset, and custom preset collection.
- Grid choices include Bar, Beat, straight, triplet, dotted, and time values;
  Use Quantize resolves through the active preset, while Adapt to Zoom selects
  a readable musical subdivision. Visual grid-line thinning must not change the
  actual edit/snap interval.
- Snap types cover Grid, Grid Relative, Events, Shuffle, Cursor, and their
  supported combinations. MIDI draw, move, resize, split, and ruler gestures
  use the selected grid when Snap is enabled; Ctrl/Command temporarily permits
  off-grid placement.
- Quantize applies the active preset to starts, ends, both, or note length and
  supports strength, swing/groove, tuplets, catch/safe ranges, roughness, and
  moving controllers. Length Quantize may use an explicit value or Quantize
  Link, and factory/custom preset save, rename, remove, restore, and project
  recall preserve the selected workflow.

Automated browser/native coverage is `pass` for those deterministic contracts.
Overall workflow parity remains `partial` until a musician completes the manual
REAPER/Cubase-style acceptance below.

## Manual acceptance

- [ ] Arrange a multi-item MIDI passage using move, loop, slip, split,
  cross-track copy, and undo/redo without losing source context.
- [ ] Edit notes and multiple controller lanes in the docked editor without
  accidental tool/selection changes.
- [ ] Confirm note, CC, pitch-bend, pressure, program, and bank data sound and
  export as displayed.
- [ ] Save, close, reopen, and render a combined MIDI/instrument project.
- [ ] Compare the complete interaction flow with the intended REAPER arrange
  and Cubase Key Editor references and record concrete remaining gaps.
- [ ] In a browser/WebView interaction run, verify Snap on, Ctrl/Command-drag
  off-grid placement, draw/resize/split on the selected grid, quantize with the
  active preset, and Length Quantize with both a fixed value and Quantize Link.

Implementation history and old screenshot-by-screenshot matrices belong in Git
history. New behavior should be documented here with its test or manual
acceptance criterion.
