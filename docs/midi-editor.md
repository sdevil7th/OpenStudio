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

Implementation history and old screenshot-by-screenshot matrices belong in Git
history. New behavior should be documented here with its test or manual
acceptance criterion.
