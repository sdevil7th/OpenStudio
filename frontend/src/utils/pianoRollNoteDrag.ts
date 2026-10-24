import type { MIDIEvent } from "../store/useDAWStore";
import { noteIdFor, parseMIDINotePairs, sortMIDIEvents, type MIDINotePair } from "./midiNotes";

export const MIDI_NOTE_DRAG_THRESHOLD_PX = 5;

export interface MidiNoteDragModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function hasMidiNoteDragStarted(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= MIDI_NOTE_DRAG_THRESHOLD_PX;
}

/** Apply one bounded delta to the group so boundary hits preserve its spacing. */
export function getMidiNoteMoveDeltas(
  notes: readonly Pick<MIDINotePair, "startTime" | "noteNumber">[],
  deltaTime: number,
  deltaNote: number,
  modifiers: MidiNoteDragModifiers,
): { deltaTime: number; deltaNote: number } {
  if (notes.length === 0) return { deltaTime: 0, deltaNote: 0 };
  const earliest = Math.min(...notes.map((note) => note.startTime));
  const lowest = Math.min(...notes.map((note) => note.noteNumber));
  const highest = Math.max(...notes.map((note) => note.noteNumber));
  return {
    deltaTime: modifiers.shiftKey ? 0 : Math.max(-earliest, deltaTime),
    deltaNote: modifiers.ctrlKey || modifiers.metaKey
      ? 0
      : Math.max(-lowest, Math.min(127 - highest, deltaNote)),
  };
}

/** Shift-click toggles; Shift-drag keeps a selected group together. */
export function getMidiNoteShiftSelection(
  selectedIds: readonly string[],
  noteId: string,
): { clickSelection: string[]; dragSelection: string[] } {
  const alreadySelected = selectedIds.includes(noteId);
  return {
    clickSelection: alreadySelected
      ? selectedIds.filter((id) => id !== noteId)
      : [...selectedIds, noteId],
    dragSelection: alreadySelected ? [...selectedIds] : [...selectedIds, noteId],
  };
}

/** Match Alt-copy's trailing-group offset without creating a separate undo entry. */
export function buildMidiNoteDragCopy(
  events: MIDIEvent[],
  clipId: string,
  noteIds: readonly string[],
): { events: MIDIEvent[]; noteIds: string[] } | null {
  const selectedIds = new Set(noteIds);
  const notes = parseMIDINotePairs(events, clipId).filter((note) => selectedIds.has(note.id));
  if (notes.length === 0) return null;
  const span = Math.max(...notes.map((note) => note.startTime + note.duration))
    - Math.min(...notes.map((note) => note.startTime));
  const additions = notes.flatMap((note) => [
    { ...note.noteOn, timestamp: note.startTime + span },
    { ...note.noteOff, timestamp: note.startTime + span + note.duration },
  ]);
  return {
    events: sortMIDIEvents([...events, ...additions]),
    noteIds: notes.map((note) => noteIdFor(clipId, note.startTime + span, note.noteNumber)),
  };
}
