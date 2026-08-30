import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type MIDICCEvent,
  type MIDIClip,
  type MIDIEvent,
  useDAWStore,
} from "../store/useDAWStore";
import { noteIdFor } from "../utils/midiNotes";

const originalState = useDAWStore.getState();
const TRACK_ID = "midi-lock-track";
const CLIP_ID = "midi-lock-clip";
const firstNoteId = noteIdFor(CLIP_ID, 0.25, 60);
const secondNoteId = noteIdFor(CLIP_ID, 1, 64);

const originalEvents: MIDIEvent[] = [
  { type: "noteOn", timestamp: 0.25, note: 60, velocity: 90 },
  { type: "noteOff", timestamp: 0.75, note: 60, velocity: 0 },
  { type: "noteOn", timestamp: 1, note: 64, velocity: 84 },
  { type: "noteOff", timestamp: 1.5, note: 64, velocity: 0 },
];
const originalCCEvents: MIDICCEvent[] = [{ cc: 1, time: 0.5, value: 64 }];

type StoreState = ReturnType<typeof useDAWStore.getState>;
type MutationCase = readonly [string, (state: StoreState) => unknown];

function seedEditableMidiTarget(lock: "global" | "items" | "clip" | "frozen") {
  const clip: MIDIClip = {
    id: CLIP_ID,
    name: "Lock target",
    startTime: 0,
    duration: 4,
    sourceLength: 4,
    loopLength: 4,
    events: originalEvents.map((event) => ({ ...event })),
    ccEvents: originalCCEvents.map((event) => ({ ...event })),
    quantizeBackup: {
      events: originalEvents.map((event) => ({ ...event })),
      ccEvents: originalCCEvents.map((event) => ({ ...event })),
    },
    color: "#4361ee",
    locked: lock === "clip",
  };
  const track = createDefaultTrack(TRACK_ID, "MIDI Lock", "#4361ee", "midi", []);
  track.midiClips = [clip];
  track.frozen = lock === "frozen";

  useDAWStore.setState((state) => ({
    tracks: [track],
    selectedTrackId: TRACK_ID,
    selectedTrackIds: [TRACK_ID],
    selectedClipId: CLIP_ID,
    selectedClipIds: [CLIP_ID],
    selectedNoteIds: [firstNoteId, secondNoteId],
    pianoRollTrackId: TRACK_ID,
    pianoRollClipId: CLIP_ID,
    midiEditRange: {
      startTime: 0,
      endTime: 2,
      minNote: 0,
      maxNote: 127,
      includeCC: true,
    },
    midiNoteClipboard: {
      notes: [{ startTime: 0, noteNumber: 67, duration: 0.5, velocity: 88 }],
      sourceTrackId: TRACK_ID,
      sourceClipId: CLIP_ID,
      isCut: false,
    },
    midiRangeClipboard: {
      rangeLength: 1,
      notes: [{ startTime: 0, noteNumber: 67, duration: 0.5, velocity: 88 }],
      ccEvents: [{ cc: 1, time: 0.25, value: 90 }],
      sourceTrackId: TRACK_ID,
      sourceClipId: CLIP_ID,
      isCut: false,
    },
    globalLocked: lock === "global",
    lockSettings: { ...state.lockSettings, items: lock === "items" },
    isModified: false,
    canUndo: false,
    canRedo: false,
  } as Partial<StoreState>));
}

function mutationSnapshot() {
  const state = useDAWStore.getState();
  return JSON.stringify({
    tracks: state.tracks,
    selectedNoteIds: state.selectedNoteIds,
    midiNoteClipboard: state.midiNoteClipboard,
    midiRangeClipboard: state.midiRangeClipboard,
    isModified: state.isModified,
  });
}

const changedEvents: MIDIEvent[] = [
  { type: "noteOn", timestamp: 0.5, note: 72, velocity: 100 },
  { type: "noteOff", timestamp: 1, note: 72, velocity: 0 },
];
const changedCC: MIDICCEvent[] = [{ cc: 1, time: 0.75, value: 100 }];

const mutationCases: readonly MutationCase[] = [
  ["preview events", (s) => s.previewMIDIClipEvents(TRACK_ID, CLIP_ID, changedEvents)],
  ["commit events", (s) => s.commitMIDIClipEvents(TRACK_ID, CLIP_ID, originalEvents, changedEvents)],
  ["glue notes", (s) => s.glueSelectedMIDINotes(TRACK_ID, CLIP_ID, [firstNoteId, secondNoteId])],
  ["add note", (s) => s.addMIDINote(TRACK_ID, CLIP_ID, 2, 67, 0.5)],
  ["remove notes", (s) => s.removeMIDINotes(TRACK_ID, CLIP_ID, [firstNoteId])],
  ["move notes", (s) => s.moveMIDINotes(TRACK_ID, CLIP_ID, [firstNoteId], 0.25, 1)],
  ["resize note", (s) => s.resizeMIDINote(TRACK_ID, CLIP_ID, firstNoteId, 0.5, 1)],
  ["note velocity", (s) => s.updateMIDINoteVelocity(TRACK_ID, CLIP_ID, 0.25, 60, 32)],
  ["preview CC", (s) => s.updateMIDICCEvents(TRACK_ID, CLIP_ID, changedCC, { transient: true })],
  ["commit CC", (s) => s.commitMIDICCEvents(TRACK_ID, CLIP_ID, originalCCEvents, changedCC)],
  ["cut notes", (s) => s.cutSelectedMIDINotes(TRACK_ID, CLIP_ID)],
  ["cut range", (s) => s.cutMIDIRange(TRACK_ID, CLIP_ID)],
  ["delete range", (s) => s.deleteMIDIRange(TRACK_ID, CLIP_ID)],
  ["paste notes", (s) => s.pasteMIDINotes(TRACK_ID, CLIP_ID, 2)],
  ["paste range", (s) => s.pasteMIDIRange(TRACK_ID, CLIP_ID, 2)],
  ["duplicate notes", (s) => s.duplicateSelectedMIDINotes(TRACK_ID, CLIP_ID)],
  ["duplicate range", (s) => s.duplicateMIDIRange(TRACK_ID, CLIP_ID)],
  ["repeat selection", (s) => s.repeatMIDISelection(TRACK_ID, CLIP_ID)],
  ["quantize", (s) => s.quantizeSelectedMIDINotes(TRACK_ID, CLIP_ID, 0.5)],
  ["quantize last", (s) => s.quantizeSelectedMIDINotesUsingLast(TRACK_ID, CLIP_ID)],
  ["reset quantize", (s) => s.resetMIDIQuantize(TRACK_ID, CLIP_ID)],
  ["freeze quantize", (s) => s.freezeMIDIQuantize(TRACK_ID, CLIP_ID)],
  ["humanize", (s) => s.humanizeSelectedMIDINotes(TRACK_ID, CLIP_ID)],
  ["set velocity", (s) => s.setSelectedMIDINoteVelocity(TRACK_ID, CLIP_ID, 40)],
  ["scale velocity", (s) => s.scaleSelectedMIDINoteVelocity(TRACK_ID, CLIP_ID, 0.5)],
  ["randomize velocity", (s) => s.randomizeSelectedMIDINoteVelocity(TRACK_ID, CLIP_ID)],
  ["set length", (s) => s.setSelectedMIDINoteLength(TRACK_ID, CLIP_ID, 0.25)],
  ["legato", (s) => s.legatoSelectedMIDINotes(TRACK_ID, CLIP_ID)],
  ["reverse selection", (s) => s.reverseSelectedMIDINotes(TRACK_ID, CLIP_ID)],
  ["invert pitches", (s) => s.invertSelectedMIDINotePitches(TRACK_ID, CLIP_ID)],
  ["mirror pitches", (s) => s.mirrorSelectedMIDINotePitches(TRACK_ID, CLIP_ID, 62)],
  ["snap pitches", (s) => s.snapSelectedMIDINotesToScale(TRACK_ID, CLIP_ID, 0, "major")],
  ["mute notes", (s) => s.toggleSelectedMIDINoteMute(TRACK_ID, CLIP_ID, true)],
  ["insert chord", (s) => s.insertMIDIChord(TRACK_ID, CLIP_ID, 2, 60, "major")],
  ["crop to notes", (s) => s.cropMIDIClipToSelectedNotes(TRACK_ID, CLIP_ID)],
  ["transpose all", (s) => s.transposeMIDINotes(CLIP_ID, 2)],
  ["scale all velocity", (s) => s.scaleMIDINoteVelocity(CLIP_ID, 0.5)],
  ["reverse all", (s) => s.reverseMIDINotes(CLIP_ID)],
  ["invert all", (s) => s.invertMIDINotes(CLIP_ID)],
  ["note expression", (s) => s.setNoteExpression(CLIP_ID, firstNoteId, { pressure: 0.5 })],
] as const;

beforeEach(() => {
  commandManager.clear();
});

afterEach(() => {
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe.each(["global", "items", "clip", "frozen"] as const)("%s MIDI edit lock", (lock) => {
  it.each(mutationCases)("blocks %s without mutation or history", (_name, mutate) => {
    seedEditableMidiTarget(lock);
    const before = mutationSnapshot();

    mutate(useDAWStore.getState());

    expect(mutationSnapshot()).toBe(before);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});
