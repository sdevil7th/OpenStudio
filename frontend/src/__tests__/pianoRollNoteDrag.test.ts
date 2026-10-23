import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandManager } from "../store/commands";
import { createDefaultTrack, type MIDIEvent, useDAWStore } from "../store/useDAWStore";
import { noteIdFor, parseMIDINotePairs, rebuildMIDIEventsForNotes } from "../utils/midiNotes";
import {
  buildMidiNoteDragCopy,
  getMidiNoteMoveDeltas,
  getMidiNoteShiftSelection,
  hasMidiNoteDragStarted,
  type MidiNoteDragModifiers,
} from "../utils/pianoRollNoteDrag";

const clipId = "drag-clip";
const trackId = "drag-track";
const originalState = useDAWStore.getState();
const events: MIDIEvent[] = [
  { type: "noteOn", timestamp: 0.137, note: 2, velocity: 97, channel: 3, probability: 0.7 },
  { type: "noteOff", timestamp: 0.537, note: 2, velocity: 48, channel: 3 },
  { type: "noteOn", timestamp: 1.273, note: 124, velocity: 76, muted: true },
  { type: "noteOff", timestamp: 1.473, note: 124, velocity: 36, muted: true },
  { type: "pitchBend", timestamp: 0.2, value: 9000, channel: 3 },
];
const ids = [noteIdFor(clipId, 0.137, 2), noteIdFor(clipId, 1.273, 124)];

function movedEvents(source: MIDIEvent[], noteIds: string[], deltaTime: number, deltaNote: number, modifiers: MidiNoteDragModifiers) {
  const selected = parseMIDINotePairs(source, clipId).filter((note) => noteIds.includes(note.id));
  const delta = getMidiNoteMoveDeltas(selected, deltaTime, deltaNote, modifiers);
  return rebuildMIDIEventsForNotes(source, clipId, noteIds, (note) => ({
    ...note,
    startTime: note.startTime + delta.deltaTime,
    noteNumber: note.noteNumber + delta.deltaNote,
  }));
}

beforeEach(() => {
  commandManager.clear();
  const track = createDefaultTrack(trackId, "Drag MIDI", "#4361ee", "midi", []);
  track.midiClips = [{ id: clipId, name: "Notes", startTime: 0, duration: 4, sourceLength: 4, color: "#4361ee", events }];
  useDAWStore.setState({
    tracks: [track], selectedNoteIds: ids, globalLocked: false,
    lockSettings: { ...originalState.lockSettings, items: false },
    isModified: false, canUndo: false, canRedo: false,
  });
});

afterEach(() => {
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("MIDI note-body drag constraints", () => {
  it.each([{ ctrlKey: true }, { metaKey: true }])("keeps exact pitches while time moves without quantizing for %o", (modifiers) => {
    const next = parseMIDINotePairs(movedEvents(events, ids, 0.113, 7, modifiers).events, clipId);
    expect(next.map((note) => note.noteNumber)).toEqual([2, 124]);
    expect(next[0].startTime).toBeCloseTo(0.25, 12);
    expect(next[1].startTime).toBeCloseTo(1.386, 12);
    expect(next.map((note) => note.velocity)).toEqual([97, 76]);
    expect(next.map((note) => note.releaseVelocity)).toEqual([48, 36]);
    expect(next[0].channel).toBe(3);
    expect(next[0].probability).toBe(0.7);
    expect(next[1].muted).toBe(true);
    expect(next.map((note) => note.duration)).toEqual(expect.arrayContaining([expect.closeTo(0.4, 12), expect.closeTo(0.2, 12)]));
  });

  it("preserves exact unsnapped starts on Shift-drag and bounds the entire pitch group", () => {
    const next = parseMIDINotePairs(movedEvents(events, ids, 0.7, 20, { shiftKey: true }).events, clipId);
    expect(next.map((note) => note.startTime)).toEqual([0.137, 1.273]);
    expect(next.map((note) => note.noteNumber)).toEqual([5, 127]);
    expect(next[1].noteNumber - next[0].noteNumber).toBe(122);
  });

  it("clamps one shared time delta at zero and one pitch delta at the bottom", () => {
    const next = parseMIDINotePairs(movedEvents(events, ids, -3, -20, {}).events, clipId);
    expect(next[0].startTime).toBe(0);
    expect(next[1].startTime).toBeCloseTo(1.136, 12);
    expect(next.map((note) => note.noteNumber)).toEqual([0, 122]);
  });

  it("holds both axes when both constraints are held", () => {
    expect(getMidiNoteMoveDeltas(parseMIDINotePairs(events, clipId), 1, 5, { ctrlKey: true, shiftKey: true }))
      .toEqual({ deltaTime: 0, deltaNote: 0 });
  });

  it("distinguishes Shift-click from Shift-drag without removing an existing selected group", () => {
    expect(getMidiNoteShiftSelection(ids, ids[0])).toEqual({ clickSelection: [ids[1]], dragSelection: ids });
    expect(getMidiNoteShiftSelection(ids, "new-note")).toEqual({ clickSelection: [...ids, "new-note"], dragSelection: [...ids, "new-note"] });
    expect(hasMidiNoteDragStarted(40, 80, 42, 82)).toBe(false);
    expect(hasMidiNoteDragStarted(40, 80, 40, 85)).toBe(true);
  });

  it("commits an entire constrained note movement as one reversible action", () => {
    const next = movedEvents(events, ids, 0.211, 12, { ctrlKey: true }).events;
    useDAWStore.getState().previewMIDIClipEvents(trackId, clipId, next);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    useDAWStore.getState().commitMIDIClipEvents(trackId, clipId, events, next, "Move MIDI notes");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].midiClips[0].events).toEqual([...events].sort((a, b) => a.timestamp - b.timestamp));
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].midiClips[0].events).toEqual(next);
  });

  it("keeps Alt-copy's trailing offset and combines copy plus constrained movement into one Undo", () => {
    const copy = buildMidiNoteDragCopy(events, clipId, ids)!;
    const copiedNotes = parseMIDINotePairs(copy.events, clipId).filter((note) => copy.noteIds.includes(note.id));
    expect(copiedNotes[0].startTime).toBeCloseTo(1.473, 12);
    expect(copiedNotes[1].startTime).toBeCloseTo(2.609, 12);
    const next = movedEvents(copy.events, copy.noteIds, 0.123, -8, { ctrlKey: true }).events;
    useDAWStore.getState().previewMIDIClipEvents(trackId, clipId, next);
    useDAWStore.getState().commitMIDIClipEvents(trackId, clipId, events, next, "Copy MIDI notes");
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(parseMIDINotePairs(next, clipId).map((note) => note.noteNumber)).toEqual([2, 124, 2, 124]);
    useDAWStore.getState().undo();
    expect(parseMIDINotePairs(useDAWStore.getState().tracks[0].midiClips[0].events, clipId)).toHaveLength(2);
    expect(events).toHaveLength(5);
  });
});
