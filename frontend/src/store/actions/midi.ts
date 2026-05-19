// @ts-nocheck
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { getMIDIClipSourceLoopLength, syncTrackMIDIClipsToBackend } from "../../utils/midiClipSerialization";
import {
  MIDI_NOTE_MIN_DURATION as SHARED_MIDI_NOTE_MIN_DURATION,
  clampMIDINote as clampSharedMIDINote,
  clampMIDIVelocity as clampSharedMIDIVelocity,
  clipboardItemsFromPairs,
  eventsFromClipboardItems,
  noteIdFor as sharedNoteIdFor,
  parseMIDINotePairs,
  rebuildMIDIEventsForNotes,
  sortMIDIEvents as sortSharedMIDIEvents,
} from "../../utils/midiNotes";
import { calculateGridInterval, getQuantizePresetById, ticksToSeconds } from "../../utils/snapToGrid";

type SetFn = (...args: any[]) => void;
type GetFn = () => any;

const MIDI_SYNC_DEBOUNCE_MS = 120;
const MIDI_NOTE_MIN_DURATION = 0.01;
const midiSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function midiQuantizeSettingsFromPreset(state: any) {
  const preset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
  const tempo = state.transport?.tempo ?? 120;
  return {
    presetId: preset.id,
    gridSize: preset.gridSize,
    gridSeconds: calculateGridInterval(
      tempo,
      state.timeSignature ?? { numerator: 4, denominator: 4 },
      preset.gridSize,
      {
        quantizePreset: preset,
        quantizeGridSize: preset.gridSize,
        pixelsPerSecond: state.pixelsPerSecond,
      },
    ),
    strength: preset.strength,
    mode: "start",
    swing: preset.swing,
    groovePreset: preset.groovePreset,
    tupletDivisions: preset.tupletDivisions,
    catchRangeMs: ticksToSeconds(preset.catchRangeTicks, tempo) * 1000,
    safeRangeMs: ticksToSeconds(preset.safeRangeTicks, tempo) * 1000,
    randomizeMs: ticksToSeconds(preset.roughTicks, tempo) * 1000,
    moveControllers: preset.moveControllers,
  };
}

function cloneVisibleLanes(lanes: any[] = []) {
  return lanes.map((lane) => ({ ...lane }));
}

function makeMidiEditorSessionId(trackId: string, clipId: string) {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `midi-editor-${trackId}-${clipId}-${suffix}`;
}

function createMidiEditorSession(state: any, trackId: string, clipId: string, mode: "docked" | "windowed") {
  const now = Date.now();
  const clip = getClip(() => state, trackId, clipId);
  const clipStart = clip?.startTime ?? 0;
  const pps = Number.isFinite(state.pixelsPerSecond) ? state.pixelsPerSecond : 100;
  return {
    sessionId: makeMidiEditorSessionId(trackId, clipId),
    trackId,
    clipId,
    mode,
    selectedNoteIds: [],
    midiEditRange: null,
    editCursorTime: null,
    activeTool: "select",
    visibleLanes: cloneVisibleLanes(state.pianoRollVisibleLanes || []),
    activeLaneId: state.pianoRollActiveLaneId || "velocity",
    scrollY: 0,
    windowPixelsPerSecond: pps,
    windowScrollX: Math.max(0, clipStart * pps - 80),
    openedAt: now,
    updatedAt: now,
  };
}

function globalsFromMidiEditorSession(session: any) {
  return {
    showPianoRoll: session.mode === "docked",
    pianoRollTrackId: session.trackId,
    pianoRollClipId: session.clipId,
    selectedNoteIds: [...(session.selectedNoteIds || [])],
    midiEditRange: session.midiEditRange || null,
    pianoRollEditCursorTime: session.editCursorTime ?? null,
    activeMidiTool: session.activeTool || "select",
    pianoRollVisibleLanes: cloneVisibleLanes(session.visibleLanes || []),
    pianoRollActiveLaneId: session.activeLaneId || "velocity",
    activeMidiEditorSessionId: session.sessionId,
  };
}

function patchSessionInState(state: any, sessionId: string | null | undefined, patch: Record<string, any>) {
  if (!sessionId) return {};
  const now = Date.now();
  const sessions = (state.midiEditorSessions || []).map((session: any) =>
    session.sessionId === sessionId
      ? { ...session, ...patch, updatedAt: now }
      : session,
  );
  return { midiEditorSessions: sessions };
}

function patchActiveSessionFromGlobals(state: any, patch: Record<string, any> = {}) {
  const sessionId = state.activeMidiEditorSessionId;
  if (!sessionId) return {};
  return patchSessionInState(state, sessionId, {
    selectedNoteIds: [...(state.selectedNoteIds || [])],
    midiEditRange: state.midiEditRange || null,
    editCursorTime: state.pianoRollEditCursorTime ?? null,
    activeTool: state.activeMidiTool || "select",
    visibleLanes: cloneVisibleLanes(state.pianoRollVisibleLanes || []),
    activeLaneId: state.pianoRollActiveLaneId || "velocity",
    ...patch,
  });
}

function cloneEvents(events: any[] = []) {
  return events.map((event) => ({ ...event }));
}

function cloneCCEvents(events: any[] = []) {
  return events.map((event) => ({ ...event }));
}

function sortMIDIEvents(events: any[]) {
  return cloneEvents(events).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.type === b.type) return 0;
    return a.type === "noteOff" ? 1 : -1;
  });
}

function sortCCEvents(events: any[]) {
  return cloneCCEvents(events).sort((a, b) => a.time - b.time);
}

function clampMidiNote(note: number) {
  return Math.max(0, Math.min(127, Math.round(note)));
}

function clampVelocity(velocity: number) {
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

const MIDI_SCALE_DEFINITIONS: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

function normalizeScaleRoot(root: number) {
  return ((Math.round(Number(root) || 0) % 12) + 12) % 12;
}

function isMidiNoteInScale(noteNumber: number, scaleRoot: number, scaleType: string) {
  if (scaleType === "chromatic") return true;
  const intervals = MIDI_SCALE_DEFINITIONS[scaleType];
  if (!intervals) return true;
  const degree = ((clampMidiNote(noteNumber) % 12) - normalizeScaleRoot(scaleRoot) + 12) % 12;
  return intervals.includes(degree);
}

function snapMidiNoteToScale(noteNumber: number, scaleRoot: number, scaleType: string) {
  const note = clampMidiNote(noteNumber);
  if (scaleType === "chromatic" || isMidiNoteInScale(note, scaleRoot, scaleType)) return note;

  let bestNote = note;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate <= 127; candidate += 1) {
    if (!isMidiNoteInScale(candidate, scaleRoot, scaleType)) continue;
    const distance = Math.abs(candidate - note);
    if (distance < bestDistance || (distance === bestDistance && candidate > bestNote)) {
      bestNote = candidate;
      bestDistance = distance;
    }
  }
  return bestNote;
}

function buildDiatonicChordNotes(rootNote: number, scaleRoot: number, scaleType: string) {
  const root = snapMidiNoteToScale(rootNote, scaleRoot, scaleType);
  const scaleNotes: number[] = [];
  for (let candidate = root; candidate <= 127 && scaleNotes.length < 5; candidate += 1) {
    if (isMidiNoteInScale(candidate, scaleRoot, scaleType)) scaleNotes.push(candidate);
  }
  if (scaleNotes.length >= 5) {
    return [scaleNotes[0], scaleNotes[2], scaleNotes[4]];
  }
  return [root, clampMidiNote(root + 4), clampMidiNote(root + 7)];
}

function noteIdFor(clipId: string, timestamp: number, note: number) {
  return `${clipId}:${timestamp.toFixed(6)}:${note}`;
}

function parseNoteIdentity(noteId: string) {
  const parts = String(noteId).split(":");
  const note = Number.parseInt(parts[parts.length - 1], 10);
  const timestamp = Number.parseFloat(parts[parts.length - 2]);
  return Number.isFinite(timestamp) && Number.isFinite(note)
    ? { timestamp, note }
    : null;
}

function noteIdentityMatches(noteId: string, clipId: string, timestamp: number, note: number) {
  const parsed = parseNoteIdentity(noteId);
  if (!parsed) return false;
  return Math.abs(parsed.timestamp - timestamp) < 0.001 && parsed.note === note;
}

function parseNotePairs(events: any[], clipId: string) {
  const pairs: any[] = [];
  const usedNoteOffs = new Set<number>();

  for (let onIndex = 0; onIndex < events.length; onIndex += 1) {
    const noteOn = events[onIndex];
    if (noteOn.type !== "noteOn" || noteOn.note === undefined) continue;

    let offIndex = -1;
    for (let index = 0; index < events.length; index += 1) {
      const candidate = events[index];
      if (
        usedNoteOffs.has(index) ||
        candidate.type !== "noteOff" ||
        candidate.note !== noteOn.note ||
        candidate.timestamp <= noteOn.timestamp
      ) {
        continue;
      }

      if (offIndex === -1 || candidate.timestamp < events[offIndex].timestamp) {
        offIndex = index;
      }
    }

    if (offIndex === -1) continue;
    usedNoteOffs.add(offIndex);
    const noteOff = events[offIndex];
    pairs.push({
      id: noteIdFor(clipId, noteOn.timestamp, noteOn.note),
      onIndex,
      offIndex,
      noteOn,
      noteOff,
      noteNumber: noteOn.note,
      velocity: noteOn.velocity || 80,
      startTime: noteOn.timestamp,
      duration: Math.max(MIDI_NOTE_MIN_DURATION, noteOff.timestamp - noteOn.timestamp),
    });
  }

  return pairs;
}

function rebuildEventsForNotes(events: any[], clipId: string, noteIds: string[], transform: (pair: any) => any | null) {
  const selectedIds = new Set(noteIds);
  const consumed = new Set<number>();
  const additions: any[] = [];
  const nextIds: string[] = [];

  for (const pair of parseNotePairs(events, clipId)) {
    const selected = selectedIds.has(pair.id)
      || noteIds.some((id) => noteIdentityMatches(id, clipId, pair.startTime, pair.noteNumber));
    if (!selected) continue;

    consumed.add(pair.onIndex);
    consumed.add(pair.offIndex);

    const nextPair = transform(pair);
    if (!nextPair) continue;

    const nextStart = Math.max(0, nextPair.startTime);
    const nextDuration = Math.max(MIDI_NOTE_MIN_DURATION, nextPair.duration);
    const nextNote = clampMidiNote(nextPair.noteNumber);
    const nextVelocity = clampVelocity(nextPair.velocity ?? pair.velocity);

    additions.push(
      {
        ...pair.noteOn,
        timestamp: nextStart,
        type: "noteOn",
        note: nextNote,
        velocity: nextVelocity,
      },
      {
        ...pair.noteOff,
        timestamp: nextStart + nextDuration,
        type: "noteOff",
        note: nextNote,
        velocity: 0,
      },
    );
    nextIds.push(noteIdFor(clipId, nextStart, nextNote));
  }

  const retained = events.filter((_, index) => !consumed.has(index));
  return {
    events: sortMIDIEvents([...retained, ...additions]),
    nextIds,
  };
}

function getTrack(get: GetFn, trackId: string) {
  return get().tracks.find((track: any) => track.id === trackId);
}

function getClip(get: GetFn, trackId: string, clipId: string) {
  return getTrack(get, trackId)?.midiClips.find((clip: any) => clip.id === clipId);
}

function setClipPatch(set: SetFn, trackId: string, clipId: string, patch: any) {
  set((state: any) => ({
    tracks: state.tracks.map((track: any) =>
      track.id === trackId
        ? {
            ...track,
            midiClips: track.midiClips.map((clip: any) =>
              clip.id === clipId ? { ...clip, ...patch } : clip,
            ),
          }
        : track,
    ),
    isModified: true,
  }));
}

async function syncMIDITrackNow(get: GetFn, trackId: string) {
  const track = getTrack(get, trackId);
  if (!track || (track.type !== "midi" && track.type !== "instrument")) return;
  await syncTrackMIDIClipsToBackend(trackId, track.midiClips, track.midiEffects || []).catch(logBridgeError("midi sync"));
}

function scheduleMIDITrackSync(get: GetFn, trackId: string, debounce = true) {
  const existingTimer = midiSyncTimers.get(trackId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    midiSyncTimers.delete(trackId);
  }

  if (!debounce) {
    void syncMIDITrackNow(get, trackId);
    return;
  }

  const timer = setTimeout(() => {
    midiSyncTimers.delete(trackId);
    void syncMIDITrackNow(get, trackId);
  }, MIDI_SYNC_DEBOUNCE_MS);
  midiSyncTimers.set(trackId, timer);
}

function eventsChanged(a: any[], b: any[]) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function clipPatchChanged(a: any = {}, b: any = {}) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function getMIDIClipSourceLength(clip: any) {
  return getMIDIClipSourceLoopLength(clip);
}

function getMIDIClipContentEnd(events: any[] = [], ccEvents: any[] = []) {
  let end = 0;
  for (const event of events) {
    if (Number.isFinite(event.timestamp)) end = Math.max(end, event.timestamp);
  }
  for (const event of ccEvents) {
    if (Number.isFinite(event.time)) end = Math.max(end, event.time);
  }
  return end;
}

function buildMIDIClipSourceLengthPatches(clip: any, requiredEnd: number) {
  const currentSourceLength = getMIDIClipSourceLength(clip);
  const nextSourceLength = Math.max(MIDI_NOTE_MIN_DURATION, requiredEnd);
  if (!Number.isFinite(nextSourceLength) || nextSourceLength <= currentSourceLength + 0.000001) {
    return { oldPatch: {}, newPatch: {} };
  }

  const wasVisibleItemLooped = (clip.duration || 0) > currentSourceLength + 0.000001;
  const oldPatch = {
    loopLength: clip.loopLength,
    sourceLength: clip.sourceLength,
    duration: clip.duration,
  };
  const newPatch = {
    loopLength: nextSourceLength,
    sourceLength: nextSourceLength,
    duration: wasVisibleItemLooped ? clip.duration : Math.max(clip.duration || 0, nextSourceLength),
  };
  return { oldPatch, newPatch };
}

function pushEventsUndoCommand(
  set: SetFn,
  get: GetFn,
  trackId: string,
  clipId: string,
  oldEvents: any[],
  newEvents: any[],
  description: string,
  type: string,
  patches: { oldPatch?: any; newPatch?: any } = {},
) {
  const oldPatch = patches.oldPatch || {};
  const newPatch = patches.newPatch || {};
  if (!eventsChanged(oldEvents, newEvents) && !clipPatchChanged(oldPatch, newPatch)) return;

  commandManager.push({
    type,
    description,
    timestamp: Date.now(),
    execute: () => {
      setClipPatch(set, trackId, clipId, { ...newPatch, events: cloneEvents(newEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
    undo: () => {
      setClipPatch(set, trackId, clipId, { ...oldPatch, events: cloneEvents(oldEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
  });
  set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
}

function pushCCUndoCommand(
  set: SetFn,
  get: GetFn,
  trackId: string,
  clipId: string,
  oldCCEvents: any[],
  newCCEvents: any[],
  description: string,
  patches: { oldPatch?: any; newPatch?: any } = {},
) {
  const oldPatch = patches.oldPatch || {};
  const newPatch = patches.newPatch || {};
  if (!eventsChanged(oldCCEvents, newCCEvents) && !clipPatchChanged(oldPatch, newPatch)) return;

  commandManager.push({
    type: "midi_cc",
    description,
    timestamp: Date.now(),
    execute: () => {
      setClipPatch(set, trackId, clipId, { ...newPatch, ccEvents: cloneCCEvents(newCCEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
    undo: () => {
      setClipPatch(set, trackId, clipId, { ...oldPatch, ccEvents: cloneCCEvents(oldCCEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
  });
  set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
}

function selectedPairsForClip(get: GetFn, clipId: string, events: any[]) {
  const selectedIds = new Set(get().selectedNoteIds || []);
  return parseMIDINotePairs(events, clipId).filter((pair) => selectedIds.has(pair.id));
}

function applySelectedNoteTransform(
  set: SetFn,
  get: GetFn,
  trackId: string,
  clipId: string,
  description: string,
  type: string,
  transform: (pair: any, index: number, pairs: any[]) => any | null,
) {
  const clip = getClip(get, trackId, clipId);
  const selectedIds = get().selectedNoteIds || [];
  if (!clip || selectedIds.length === 0) return [];

  const oldEvents = cloneEvents(clip.events);
  const selectedPairs = selectedPairsForClip(get, clipId, oldEvents);
  if (selectedPairs.length === 0) return [];
  const pairIndexById = new Map(selectedPairs.map((pair, index) => [pair.id, index]));

  const result = rebuildMIDIEventsForNotes(oldEvents, clipId, selectedIds, (pair) => {
    const selectedIndex = pairIndexById.get(pair.id);
    if (selectedIndex === undefined) return pair;
    return transform(pair, selectedIndex, selectedPairs);
  });
  const patches = buildMIDIClipSourceLengthPatches(
    clip,
    getMIDIClipContentEnd(result.events, clip.ccEvents || []),
  );

  setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: result.events });
  set({ selectedNoteIds: result.nextIds });
  pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, result.events, description, type, patches);
  scheduleMIDITrackSync(get, trackId, true);
  return result.nextIds;
}

function getPianoRollPasteTime(get: GetFn, clip: any, explicitTime?: number) {
  const editLength = getMIDIClipSourceLength(clip);
  if (Number.isFinite(explicitTime)) {
    return Math.max(0, explicitTime as number);
  }
  const cursor = get().pianoRollEditCursorTime;
  if (Number.isFinite(cursor)) {
    return Math.max(0, cursor);
  }
  const transportTime = get().transport.currentTime - clip.startTime;
  return Math.max(0, Math.min(editLength, transportTime));
}

function normalizeMIDIEditRange(range: any, clipDuration: number) {
  if (!range) return null;
  const startTime = Math.max(0, Math.min(clipDuration, Math.min(range.startTime, range.endTime)));
  const endTime = Math.max(0, Math.min(clipDuration, Math.max(range.startTime, range.endTime)));
  if (endTime <= startTime) return null;
  return {
    startTime,
    endTime,
    minNote: Math.max(0, Math.min(127, Math.min(range.minNote, range.maxNote))),
    maxNote: Math.max(0, Math.min(127, Math.max(range.minNote, range.maxNote))),
    includeCC: range.includeCC !== false,
  };
}

function notePairsInRange(clip: any, clipId: string, range: any) {
  return parseMIDINotePairs(clip.events || [], clipId).filter((pair: any) => {
    const end = pair.startTime + pair.duration;
    return pair.noteNumber >= range.minNote
      && pair.noteNumber <= range.maxNote
      && end > range.startTime
      && pair.startTime < range.endTime;
  });
}

function rangeNoteClipboardItems(pairs: any[], range: any) {
  return pairs.map((pair) => {
    const clippedStart = Math.max(pair.startTime, range.startTime);
    const clippedEnd = Math.min(pair.startTime + pair.duration, range.endTime);
    return {
      noteNumber: pair.noteNumber,
      startTime: clippedStart - range.startTime,
      duration: Math.max(MIDI_NOTE_MIN_DURATION, clippedEnd - clippedStart),
      velocity: pair.velocity,
      pitchBend: pair.pitchBend,
      pressure: pair.pressure,
      slide: pair.slide,
      muted: pair.muted,
    };
  });
}

function rangeCCClipboardItems(clip: any, range: any) {
  if (!range.includeCC) return [];
  return (clip.ccEvents || [])
    .filter((event: any) => event.time >= range.startTime && event.time <= range.endTime)
    .map((event: any) => ({
      cc: event.cc,
      time: event.time - range.startTime,
      value: event.value,
    }));
}

function emptyMIDIRangeClipboard() {
  return {
    rangeLength: 0,
    notes: [],
    ccEvents: [],
    sourceTrackId: null,
    sourceClipId: null,
    isCut: false,
  };
}

function eventsFromRangeClipboard(clipId: string, clipboard: any, pasteTime: number, clipDuration: number) {
  return eventsFromClipboardItems(clipId, clipboard.notes || [], pasteTime, clipDuration);
}

function ccEventsFromRangeClipboard(clipboard: any, pasteTime: number, clipDuration: number) {
  return (clipboard.ccEvents || [])
    .map((event: any) => ({
      cc: event.cc,
      time: pasteTime + event.time,
      value: event.value,
    }))
    .filter((event: any) => event.time >= 0 && event.time <= clipDuration);
}

function pushMIDIClipEventsAndCCUndoCommand(
  set: SetFn,
  get: GetFn,
  trackId: string,
  clipId: string,
  oldEvents: any[],
  oldCCEvents: any[],
  newEvents: any[],
  newCCEvents: any[],
  oldSelectedNoteIds: string[],
  newSelectedNoteIds: string[],
  oldRange: any,
  newRange: any,
  oldRangeClipboard: any,
  newRangeClipboard: any,
  description: string,
  type: string,
  patches: { oldPatch?: any; newPatch?: any } = {},
) {
  const oldPatch = patches.oldPatch || {};
  const newPatch = patches.newPatch || {};
  commandManager.push({
    type,
    description,
    timestamp: Date.now(),
    execute: () => {
      setClipPatch(set, trackId, clipId, {
        ...newPatch,
        events: cloneEvents(newEvents),
        ccEvents: cloneCCEvents(newCCEvents),
      });
      set({
        selectedNoteIds: newSelectedNoteIds,
        midiEditRange: newRange,
        midiRangeClipboard: newRangeClipboard,
      });
      scheduleMIDITrackSync(get, trackId, true);
    },
    undo: () => {
      setClipPatch(set, trackId, clipId, {
        ...oldPatch,
        events: cloneEvents(oldEvents),
        ccEvents: cloneCCEvents(oldCCEvents),
      });
      set({
        selectedNoteIds: oldSelectedNoteIds,
        midiEditRange: oldRange,
        midiRangeClipboard: oldRangeClipboard,
      });
      scheduleMIDITrackSync(get, trackId, true);
    },
  });
  set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
}

export const midiActions = (set: SetFn, get: GetFn) => ({
    openMidiEditorForClip: (trackId, clipId) => {
      const state = get();
      const existing = (state.midiEditorSessions || []).find(
        (session: any) => session.trackId === trackId && session.clipId === clipId,
      );
      if (existing) {
        set(existing.mode === "docked"
          ? {
              ...globalsFromMidiEditorSession(existing),
              showPianoRoll: true,
              dockedMidiEditorSessionId: existing.sessionId,
            }
          : {
              activeMidiEditorSessionId: existing.sessionId,
              detachedPanels: (state.detachedPanels || []).includes("midiEditor")
                ? state.detachedPanels
                : [...(state.detachedPanels || []), "midiEditor"],
            });
        return existing.sessionId;
      }

      const mode = (state.midiEditorSessions || []).length === 0 ? "docked" : "windowed";
      const session = createMidiEditorSession(state, trackId, clipId, mode);
      const sessions = [...(state.midiEditorSessions || []), session];
      set(mode === "docked"
        ? {
            midiEditorSessions: sessions,
            activeMidiEditorSessionId: session.sessionId,
            dockedMidiEditorSessionId: session.sessionId,
            ...globalsFromMidiEditorSession(session),
            showPianoRoll: true,
          }
        : {
            midiEditorSessions: sessions,
            activeMidiEditorSessionId: session.sessionId,
            dockedMidiEditorSessionId: state.dockedMidiEditorSessionId,
            detachedPanels: (state.detachedPanels || []).includes("midiEditor")
              ? state.detachedPanels
              : [...(state.detachedPanels || []), "midiEditor"],
          });
      return session.sessionId;
    },

    openPianoRoll: (trackId, clipId) =>
      get().openMidiEditorForClip(trackId, clipId),

    closePianoRoll: () => {
      const state = get();
      const dockedId = state.dockedMidiEditorSessionId;
      if (dockedId) {
        get().closeMidiEditorSession(dockedId);
        return;
      }
      set({ showPianoRoll: false, pianoRollTrackId: null, pianoRollClipId: null, selectedNoteIds: [], midiEditRange: null, pianoRollEditCursorTime: null });
    },

    focusMidiEditorSession: (sessionId) => {
      const state = get();
      const session = (state.midiEditorSessions || []).find((candidate: any) => candidate.sessionId === sessionId);
      if (!session) return;
      set({
        ...globalsFromMidiEditorSession(session),
        showPianoRoll: session.mode === "docked",
        dockedMidiEditorSessionId: session.mode === "docked" ? session.sessionId : state.dockedMidiEditorSessionId,
      });
    },

    closeMidiEditorSession: (sessionId) => {
      const state = get();
      const remaining = (state.midiEditorSessions || []).filter((session: any) => session.sessionId !== sessionId);
      const dockedId = state.dockedMidiEditorSessionId === sessionId ? null : state.dockedMidiEditorSessionId;
      const activeId = state.activeMidiEditorSessionId === sessionId
        ? (dockedId || remaining[0]?.sessionId || null)
        : state.activeMidiEditorSessionId;
      const active = remaining.find((session: any) => session.sessionId === activeId);
      set({
        midiEditorSessions: remaining,
        activeMidiEditorSessionId: activeId,
        dockedMidiEditorSessionId: dockedId,
        detachedPanels: remaining.some((session: any) => session.mode === "windowed")
          ? state.detachedPanels
          : (state.detachedPanels || []).filter((id: string) => id !== "midiEditor"),
        ...(active ? globalsFromMidiEditorSession(active) : {
          showPianoRoll: false,
          pianoRollTrackId: null,
          pianoRollClipId: null,
          selectedNoteIds: [],
          midiEditRange: null,
          pianoRollEditCursorTime: null,
        }),
        showPianoRoll: Boolean(dockedId),
      });
    },

    dockMidiEditorSession: (sessionId) => {
      const state = get();
      const target = (state.midiEditorSessions || []).find((session: any) => session.sessionId === sessionId);
      if (!target) return;
      const sessions = (state.midiEditorSessions || [])
        .filter((session: any) => session.sessionId === sessionId || session.sessionId !== state.dockedMidiEditorSessionId)
        .map((session: any) =>
          session.sessionId === sessionId
            ? { ...session, mode: "docked", updatedAt: Date.now() }
            : session,
        );
      const docked = sessions.find((session: any) => session.sessionId === sessionId);
      set({
        midiEditorSessions: sessions,
        activeMidiEditorSessionId: sessionId,
        dockedMidiEditorSessionId: sessionId,
        detachedPanels: sessions.some((session: any) => session.mode === "windowed")
          ? state.detachedPanels
          : (state.detachedPanels || []).filter((id: string) => id !== "midiEditor"),
        ...(docked ? globalsFromMidiEditorSession(docked) : {}),
        showPianoRoll: true,
      });
    },

    popOutMidiEditorSession: (sessionId) =>
      set((state: any) => {
        const sessions = (state.midiEditorSessions || []).map((session: any) =>
          session.sessionId === sessionId
            ? { ...session, mode: "windowed", updatedAt: Date.now() }
            : session,
        );
        const active = sessions.find((session: any) => session.sessionId === sessionId);
        return {
          midiEditorSessions: sessions,
          activeMidiEditorSessionId: sessionId,
          dockedMidiEditorSessionId: state.dockedMidiEditorSessionId === sessionId ? null : state.dockedMidiEditorSessionId,
          detachedPanels: (state.detachedPanels || []).includes("midiEditor")
            ? state.detachedPanels
            : [...(state.detachedPanels || []), "midiEditor"],
          ...(active ? globalsFromMidiEditorSession(active) : {}),
          showPianoRoll: state.dockedMidiEditorSessionId === sessionId ? false : state.showPianoRoll,
        };
      }),

    updateMidiEditorSession: (sessionId, patch) =>
      set((state: any) => patchSessionInState(state, sessionId, patch)),

    syncActiveMidiEditorSessionFromGlobals: (patch = {}) =>
      set((state: any) => patchActiveSessionFromGlobals(state, patch)),

    setSelectedNoteIds: (ids) =>
      set((state: any) => ({
        selectedNoteIds: Array.from(new Set(ids)),
        midiEditRange: null,
        ...patchActiveSessionFromGlobals(
          { ...state, selectedNoteIds: Array.from(new Set(ids)), midiEditRange: null },
          { selectedNoteIds: Array.from(new Set(ids)), midiEditRange: null },
        ),
      })),

    setMIDIEditRange: (range) => {
      const { pianoRollTrackId, pianoRollClipId } = get();
      const clip = pianoRollTrackId && pianoRollClipId
        ? getClip(get, pianoRollTrackId, pianoRollClipId)
        : null;
      const normalized = clip
        ? normalizeMIDIEditRange(range, getMIDIClipSourceLength(clip))
        : range;
      set((state: any) => ({
        midiEditRange: normalized,
        ...patchActiveSessionFromGlobals({ ...state, midiEditRange: normalized }, { midiEditRange: normalized }),
      }));
    },

    clearMIDIEditRange: () =>
      set((state: any) => ({
        midiEditRange: null,
        ...patchActiveSessionFromGlobals({ ...state, midiEditRange: null }, { midiEditRange: null }),
      })),

    setActiveMidiTool: (tool) =>
      set((state: any) => ({
        activeMidiTool: tool,
        ...patchActiveSessionFromGlobals({ ...state, activeMidiTool: tool }, { activeTool: tool }),
      })),

    setPianoRollVisibleLanes: (lanes) =>
      set((state: any) => {
        const nextLanes = Array.isArray(lanes)
          ? lanes.filter((lane) => lane && lane.id).map((lane) => ({ ...lane }))
          : [];
        return {
          pianoRollVisibleLanes: nextLanes,
          ...patchActiveSessionFromGlobals({ ...state, pianoRollVisibleLanes: nextLanes }, { visibleLanes: nextLanes }),
        };
      }),

    setPianoRollActiveLane: (laneId) =>
      set((state: any) => ({
        pianoRollActiveLaneId: laneId,
        ...patchActiveSessionFromGlobals({ ...state, pianoRollActiveLaneId: laneId }, { activeLaneId: laneId }),
      })),

    updatePianoRollVisibleLane: (laneId, patch) =>
      set((state) => {
        const nextLanes = (state.pianoRollVisibleLanes || []).map((lane) =>
          lane.id === laneId ? { ...lane, ...patch, id: lane.id } : lane,
        );
        return {
          pianoRollVisibleLanes: nextLanes,
          ...patchActiveSessionFromGlobals({ ...state, pianoRollVisibleLanes: nextLanes }, { visibleLanes: nextLanes }),
        };
      }),

    addPianoRollVisibleLane: (lane) => {
      const laneId = lane.id || `lane-${Date.now()}`;
      set((state) => {
        const nextLanes = [
          ...(state.pianoRollVisibleLanes || []),
          { ...lane, id: laneId },
        ];
        return {
          pianoRollVisibleLanes: nextLanes,
          pianoRollActiveLaneId: laneId,
          ...patchActiveSessionFromGlobals(
            { ...state, pianoRollVisibleLanes: nextLanes, pianoRollActiveLaneId: laneId },
            { visibleLanes: nextLanes, activeLaneId: laneId },
          ),
        };
      });
    },

    removePianoRollVisibleLane: (laneId) =>
      set((state) => {
        const remaining = (state.pianoRollVisibleLanes || []).filter((lane) => lane.id !== laneId);
        const nextActiveLaneId = state.pianoRollActiveLaneId === laneId
          ? (remaining[0]?.id || "velocity")
          : state.pianoRollActiveLaneId;
        return {
          pianoRollVisibleLanes: remaining,
          pianoRollActiveLaneId: nextActiveLaneId,
          ...patchActiveSessionFromGlobals(
            { ...state, pianoRollVisibleLanes: remaining, pianoRollActiveLaneId: nextActiveLaneId },
            { visibleLanes: remaining, activeLaneId: nextActiveLaneId },
          ),
        };
      }),

    setPianoRollEditCursorTime: (time) =>
      set((state: any) => {
        const nextTime = Number.isFinite(time) ? Math.max(0, time) : null;
        return {
          pianoRollEditCursorTime: nextTime,
          ...patchActiveSessionFromGlobals({ ...state, pianoRollEditCursorTime: nextTime }, { editCursorTime: nextTime }),
        };
      }),

    setPianoRollInsertVelocity: (velocity) =>
      set({ pianoRollInsertVelocity: Math.max(1, Math.min(127, Math.round(velocity || 1))) }),

    setPianoRollAuditionEnabled: (enabled) =>
      set({ pianoRollAuditionEnabled: Boolean(enabled) }),

    selectAllMIDINotes: () => {
      const { pianoRollTrackId, pianoRollClipId } = get();
      if (!pianoRollTrackId || !pianoRollClipId) return;
      const clip = getClip(get, pianoRollTrackId, pianoRollClipId);
      if (!clip) return;
      set({ selectedNoteIds: parseMIDINotePairs(clip.events, pianoRollClipId).map((pair) => pair.id) });
    },

    syncMIDITrackToBackend: async (trackId, options = {}) => {
      if (options.debounce === false) {
        await syncMIDITrackNow(get, trackId);
        return;
      }
      scheduleMIDITrackSync(get, trackId, true);
    },

    addMIDIClip: (trackId, startTime, duration = 4) => {
      const clipId = crypto.randomUUID();
      const track = get().tracks.find((t) => t.id === trackId);
      const clipColor = track?.color || "#4361ee";

      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                midiClips: [
                  ...t.midiClips,
                  {
                    id: clipId,
                    name: `MIDI Clip ${t.midiClips.length + 1}`,
                    startTime,
                    duration,
                    offset: 0,
                    sourceStart: 0,
                    sourceLength: duration,
                    loopEnabled: true,
                    loopOffset: 0,
                    loopLength: duration,
                    events: [],
                    ccEvents: [],
                    color: clipColor,
                  },
                ],
              }
            : t
        ),
        isModified: true,
      }));
      scheduleMIDITrackSync(get, trackId, false);

      return clipId;
    },

    previewMIDIClipEvents: (trackId, clipId, events) => {
      const sortedEvents = sortMIDIEvents(events);
      setClipPatch(set, trackId, clipId, { events: sortedEvents });
      scheduleMIDITrackSync(get, trackId, true);
    },

    commitMIDIClipEvents: (trackId, clipId, oldEvents, newEvents, description = "Edit MIDI notes") => {
      const clip = getClip(get, trackId, clipId);
      const sortedOld = sortMIDIEvents(oldEvents);
      const sortedNew = sortMIDIEvents(newEvents);
      const requiredEnd = getMIDIClipContentEnd(sortedNew, clip?.ccEvents || []);
      const patches = clip ? buildMIDIClipSourceLengthPatches(clip, requiredEnd) : { oldPatch: {}, newPatch: {} };
      setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: sortedNew });
      pushEventsUndoCommand(set, get, trackId, clipId, sortedOld, sortedNew, description, "midi_notes_edit", patches);
      scheduleMIDITrackSync(get, trackId, true);
    },

    addMIDINote: (trackId, clipId, startTime, noteNumber, duration, velocity = 80) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return "";

      const note = clampMidiNote(noteNumber);
      const start = Math.max(0, startTime);
      const safeDuration = Math.max(MIDI_NOTE_MIN_DURATION, duration);
      const oldEvents = cloneEvents(clip.events);
      const newEvents = sortMIDIEvents([
        ...oldEvents,
        { timestamp: start, type: "noteOn", note, velocity: clampVelocity(velocity) },
        { timestamp: start + safeDuration, type: "noteOff", note, velocity: 0 },
      ]);
      const patches = buildMIDIClipSourceLengthPatches(
        clip,
        getMIDIClipContentEnd(newEvents, clip.ccEvents || []),
      );

      setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: newEvents });
      pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, "Add MIDI note", "midi_note_add", patches);
      scheduleMIDITrackSync(get, trackId, true);
      return noteIdFor(clipId, start, note);
    },

    removeMIDINotes: (trackId, clipId, noteIds) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip || noteIds.length === 0) return [];

      const oldEvents = cloneEvents(clip.events);
      const { events: newEvents } = rebuildEventsForNotes(oldEvents, clipId, noteIds, () => null);
      setClipPatch(set, trackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, "Delete MIDI notes", "midi_note_delete");
      scheduleMIDITrackSync(get, trackId, true);
      return [];
    },

    moveMIDINotes: (trackId, clipId, noteIds, deltaTime, deltaNote) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip || noteIds.length === 0) return [];

      const oldEvents = cloneEvents(clip.events);
      const { events: newEvents, nextIds } = rebuildEventsForNotes(oldEvents, clipId, noteIds, (pair) => {
        const duration = Math.max(MIDI_NOTE_MIN_DURATION, pair.duration);
        return {
          ...pair,
          startTime: Math.max(0, pair.startTime + deltaTime),
          noteNumber: clampMidiNote(pair.noteNumber + deltaNote),
          duration,
        };
      });
      const patches = buildMIDIClipSourceLengthPatches(
        clip,
        getMIDIClipContentEnd(newEvents, clip.ccEvents || []),
      );

      setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: newEvents });
      pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, "Move MIDI notes", "midi_note_move", patches);
      scheduleMIDITrackSync(get, trackId, true);
      return nextIds;
    },

    resizeMIDINote: (trackId, clipId, noteId, startTime, duration) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return [];

      const oldEvents = cloneEvents(clip.events);
      const nextStart = Math.max(0, startTime);
      const nextDuration = Math.max(MIDI_NOTE_MIN_DURATION, duration);
      const { events: newEvents, nextIds } = rebuildEventsForNotes(oldEvents, clipId, [noteId], (pair) => ({
        ...pair,
        startTime: nextStart,
        duration: nextDuration,
      }));
      const patches = buildMIDIClipSourceLengthPatches(
        clip,
        getMIDIClipContentEnd(newEvents, clip.ccEvents || []),
      );

      setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: newEvents });
      pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, "Resize MIDI note", "midi_note_resize", patches);
      scheduleMIDITrackSync(get, trackId, true);
      return nextIds;
    },

    updateMIDINoteVelocity: (trackId, clipId, noteTimestamp, noteNumber, velocity, options = {}) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return;

      const noteId = noteIdFor(clipId, noteTimestamp, noteNumber);
      const oldEvents = cloneEvents(options.oldEvents || clip.events);
      const currentEvents = cloneEvents(clip.events);
      const { events: newEvents } = rebuildEventsForNotes(currentEvents, clipId, [noteId], (pair) => ({
        ...pair,
        velocity: clampVelocity(velocity),
      }));

      setClipPatch(set, trackId, clipId, { events: newEvents });
      if (!options.transient) {
        pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, `Set velocity to ${clampVelocity(velocity)}`, "midi_velocity");
      }
      scheduleMIDITrackSync(get, trackId, true);
    },

    updateMIDICCEvents: (trackId, clipId, newCCEvents, options = {}) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return;

      const oldCCEvents = sortCCEvents(options.oldCCEvents || clip.ccEvents || []);
      const sortedNewCCEvents = sortCCEvents(newCCEvents);
      if (options.transient) {
        setClipPatch(set, trackId, clipId, { ccEvents: sortedNewCCEvents });
        scheduleMIDITrackSync(get, trackId, true);
        return;
      }

      const patches = buildMIDIClipSourceLengthPatches(
        clip,
        getMIDIClipContentEnd(clip.events || [], sortedNewCCEvents),
      );
      setClipPatch(set, trackId, clipId, { ...patches.newPatch, ccEvents: sortedNewCCEvents });
      pushCCUndoCommand(set, get, trackId, clipId, oldCCEvents, sortedNewCCEvents, options.description || "Update MIDI CC events", patches);
      scheduleMIDITrackSync(get, trackId, true);
    },

    commitMIDICCEvents: (trackId, clipId, oldCCEvents, newCCEvents, description = "Update MIDI CC events") => {
      const clip = getClip(get, trackId, clipId);
      const sortedOld = sortCCEvents(oldCCEvents);
      const sortedNew = sortCCEvents(newCCEvents);
      const patches = clip
        ? buildMIDIClipSourceLengthPatches(clip, getMIDIClipContentEnd(clip.events || [], sortedNew))
        : { oldPatch: {}, newPatch: {} };
      setClipPatch(set, trackId, clipId, { ...patches.newPatch, ccEvents: sortedNew });
      pushCCUndoCommand(set, get, trackId, clipId, sortedOld, sortedNew, description, patches);
      scheduleMIDITrackSync(get, trackId, true);
    },

    copySelectedMIDINotes: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return;
      const selected = selectedPairsForClip(get, clipId, clip.events);
      if (selected.length === 0) return;
      set({
        midiNoteClipboard: {
          notes: clipboardItemsFromPairs(selected),
          sourceTrackId: trackId,
          sourceClipId: clipId,
          isCut: false,
        },
      });
    },

    cutSelectedMIDINotes: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return;
      const selected = selectedPairsForClip(get, clipId, clip.events);
      if (selected.length === 0) return;
      set({
        midiNoteClipboard: {
          notes: clipboardItemsFromPairs(selected),
          sourceTrackId: trackId,
          sourceClipId: clipId,
          isCut: true,
        },
      });
      get().removeMIDINotes(trackId, clipId, selected.map((pair: any) => pair.id));
      set({ selectedNoteIds: [] });
    },

    copyMIDIRange: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const range = normalizeMIDIEditRange(get().midiEditRange, clip ? getMIDIClipSourceLength(clip) : 0);
      if (!clip || !range) return;
      const pairs = notePairsInRange(clip, clipId, range);
      set({
        midiRangeClipboard: {
          rangeLength: range.endTime - range.startTime,
          notes: rangeNoteClipboardItems(pairs, range),
          ccEvents: rangeCCClipboardItems(clip, range),
          sourceTrackId: trackId,
          sourceClipId: clipId,
          isCut: false,
        },
      });
    },

    cutMIDIRange: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const range = normalizeMIDIEditRange(get().midiEditRange, clip ? getMIDIClipSourceLength(clip) : 0);
      if (!clip || !range) return;

      const oldEvents = cloneEvents(clip.events);
      const oldCCEvents = cloneCCEvents(clip.ccEvents || []);
      const oldSelectedNoteIds = [...(get().selectedNoteIds || [])];
      const oldRange = get().midiEditRange;
      const oldRangeClipboard = get().midiRangeClipboard;
      const pairs = notePairsInRange(clip, clipId, range);
      const clipboard = {
        rangeLength: range.endTime - range.startTime,
        notes: rangeNoteClipboardItems(pairs, range),
        ccEvents: rangeCCClipboardItems(clip, range),
        sourceTrackId: trackId,
        sourceClipId: clipId,
        isCut: true,
      };
      const ids = pairs.map((pair: any) => pair.id);
      const { events: newEvents } = rebuildMIDIEventsForNotes(oldEvents, clipId, ids, () => null);
      const newCCEvents = range.includeCC
        ? oldCCEvents.filter((event: any) => event.time < range.startTime || event.time > range.endTime)
        : oldCCEvents;

      setClipPatch(set, trackId, clipId, { events: newEvents, ccEvents: newCCEvents });
      set({
        selectedNoteIds: [],
        midiRangeClipboard: clipboard,
      });
      pushMIDIClipEventsAndCCUndoCommand(
        set,
        get,
        trackId,
        clipId,
        oldEvents,
        oldCCEvents,
        newEvents,
        newCCEvents,
        oldSelectedNoteIds,
        [],
        oldRange,
        range,
        oldRangeClipboard,
        clipboard,
        "Cut MIDI range",
        "midi_range_cut",
      );
      scheduleMIDITrackSync(get, trackId, true);
    },

    deleteMIDIRange: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const range = normalizeMIDIEditRange(get().midiEditRange, clip ? getMIDIClipSourceLength(clip) : 0);
      if (!clip || !range) return;

      const oldEvents = cloneEvents(clip.events);
      const oldCCEvents = cloneCCEvents(clip.ccEvents || []);
      const oldSelectedNoteIds = [...(get().selectedNoteIds || [])];
      const oldRange = get().midiEditRange;
      const oldRangeClipboard = get().midiRangeClipboard;
      const pairs = notePairsInRange(clip, clipId, range);
      const ids = pairs.map((pair: any) => pair.id);
      const { events: newEvents } = rebuildMIDIEventsForNotes(oldEvents, clipId, ids, () => null);
      const newCCEvents = range.includeCC
        ? oldCCEvents.filter((event: any) => event.time < range.startTime || event.time > range.endTime)
        : oldCCEvents;

      setClipPatch(set, trackId, clipId, { events: newEvents, ccEvents: newCCEvents });
      set({ selectedNoteIds: [] });
      pushMIDIClipEventsAndCCUndoCommand(
        set,
        get,
        trackId,
        clipId,
        oldEvents,
        oldCCEvents,
        newEvents,
        newCCEvents,
        oldSelectedNoteIds,
        [],
        oldRange,
        range,
        oldRangeClipboard,
        oldRangeClipboard,
        "Delete MIDI range",
        "midi_range_delete",
      );
      scheduleMIDITrackSync(get, trackId, true);
    },

    pasteMIDINotes: (trackId, clipId, pasteTime) => {
      const clip = getClip(get, trackId, clipId);
      const clipboard = get().midiNoteClipboard;
      if (!clip || !clipboard?.notes?.length) return [];

      const oldEvents = cloneEvents(clip.events);
      const start = getPianoRollPasteTime(get, clip, pasteTime);
      const clipboardEnd = Math.max(
        0,
        ...clipboard.notes.map((note: any) => (note.startTime || 0) + Math.max(MIDI_NOTE_MIN_DURATION, note.duration || 0)),
      );
      const pasteTargetLength = Math.max(getMIDIClipSourceLength(clip), start + clipboardEnd);
      const pasted = eventsFromClipboardItems(clipId, clipboard.notes, start, pasteTargetLength);
      const newEvents = sortSharedMIDIEvents([...oldEvents, ...pasted.events]);
      const oldClipboard = clipboard;
      const newClipboard = clipboard.isCut
        ? { notes: [], sourceTrackId: null, sourceClipId: null, isCut: false }
        : clipboard;
      const patches = buildMIDIClipSourceLengthPatches(
        clip,
        getMIDIClipContentEnd(newEvents, clip.ccEvents || []),
      );

      setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: newEvents });
      set({ selectedNoteIds: pasted.ids, midiNoteClipboard: newClipboard });
      commandManager.push({
        type: "midi_note_paste",
        description: "Paste MIDI notes",
        timestamp: Date.now(),
        execute: () => {
          setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: cloneEvents(newEvents) });
          set({ selectedNoteIds: pasted.ids, midiNoteClipboard: newClipboard });
          scheduleMIDITrackSync(get, trackId, true);
        },
        undo: () => {
          setClipPatch(set, trackId, clipId, { ...patches.oldPatch, events: cloneEvents(oldEvents) });
          set({ selectedNoteIds: [], midiNoteClipboard: oldClipboard });
          scheduleMIDITrackSync(get, trackId, true);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      scheduleMIDITrackSync(get, trackId, true);
      return pasted.ids;
    },

    pasteMIDIRange: (trackId, clipId, pasteTime) => {
      const clip = getClip(get, trackId, clipId);
      const clipboard = get().midiRangeClipboard;
      if (!clip || !clipboard?.rangeLength) return [];

      const oldEvents = cloneEvents(clip.events);
      const oldCCEvents = cloneCCEvents(clip.ccEvents || []);
      const oldSelectedNoteIds = [...(get().selectedNoteIds || [])];
      const oldRange = get().midiEditRange;
      const oldRangeClipboard = clipboard;
      const start = getPianoRollPasteTime(get, clip, pasteTime);
      const pasteTargetLength = Math.max(getMIDIClipSourceLength(clip), start + clipboard.rangeLength);
      const pasted = eventsFromRangeClipboard(clipId, clipboard, start, pasteTargetLength);
      const pastedCCEvents = ccEventsFromRangeClipboard(clipboard, start, pasteTargetLength);
      const newEvents = sortSharedMIDIEvents([...oldEvents, ...pasted.events]);
      const newCCEvents = sortCCEvents([...oldCCEvents, ...pastedCCEvents]);
      const newRange = normalizeMIDIEditRange({
        startTime: start,
        endTime: start + clipboard.rangeLength,
        minNote: 0,
        maxNote: 127,
        includeCC: true,
      }, pasteTargetLength);
      const newClipboard = clipboard.isCut ? emptyMIDIRangeClipboard() : clipboard;
      const patches = buildMIDIClipSourceLengthPatches(
        clip,
        getMIDIClipContentEnd(newEvents, newCCEvents),
      );

      setClipPatch(set, trackId, clipId, { ...patches.newPatch, events: newEvents, ccEvents: newCCEvents });
      set({
        selectedNoteIds: pasted.ids,
        midiEditRange: newRange,
        midiRangeClipboard: newClipboard,
      });
      pushMIDIClipEventsAndCCUndoCommand(
        set,
        get,
        trackId,
        clipId,
        oldEvents,
        oldCCEvents,
        newEvents,
        newCCEvents,
        oldSelectedNoteIds,
        pasted.ids,
        oldRange,
        newRange,
        oldRangeClipboard,
        newClipboard,
        "Paste MIDI range",
        "midi_range_paste",
        patches,
      );
      scheduleMIDITrackSync(get, trackId, true);
      return pasted.ids;
    },

    duplicateSelectedMIDINotes: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events) : [];
      if (!clip || selected.length === 0) return [];
      const earliest = Math.min(...selected.map((pair: any) => pair.startTime));
      const latestEnd = Math.max(...selected.map((pair: any) => pair.startTime + pair.duration));
      set({
        midiNoteClipboard: {
          notes: clipboardItemsFromPairs(selected),
          sourceTrackId: trackId,
          sourceClipId: clipId,
          isCut: false,
        },
        pianoRollEditCursorTime: latestEnd,
      });
      return get().pasteMIDINotes(trackId, clipId, latestEnd);
    },

    duplicateMIDIRange: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const range = normalizeMIDIEditRange(get().midiEditRange, clip ? getMIDIClipSourceLength(clip) : 0);
      if (!clip || !range) return [];
      get().copyMIDIRange(trackId, clipId);
      return get().pasteMIDIRange(trackId, clipId, range.endTime);
    },

    repeatMIDISelection: (trackId, clipId) => {
      if (get().midiEditRange) {
        return get().duplicateMIDIRange(trackId, clipId);
      }
      return get().duplicateSelectedMIDINotes(trackId, clipId);
    },

    invertMIDISelection: (clipId) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const allIds = parseMIDINotePairs(clip.events, clipId).map((pair) => pair.id);
      const selected = new Set(get().selectedNoteIds || []);
      set({ selectedNoteIds: allIds.filter((id) => !selected.has(id)) });
    },

    selectMIDINotesByPitch: (clipId, noteNumber) => {
      const { pianoRollTrackId, selectedNoteIds } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const pairs = parseMIDINotePairs(clip.events, clipId);
      const selectedPairs = pairs.filter((pair) => selectedNoteIds.includes(pair.id));
      const targetPitch = noteNumber ?? selectedPairs[0]?.noteNumber;
      if (targetPitch === undefined) return;
      set({ selectedNoteIds: pairs.filter((pair) => pair.noteNumber === targetPitch).map((pair) => pair.id) });
    },

    selectMIDINotesInRange: (clipId, range, mode = "replace") => {
      const { pianoRollTrackId, selectedNoteIds } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const hits = parseMIDINotePairs(clip.events, clipId)
        .filter((pair) => {
          const end = pair.startTime + pair.duration;
          return end >= range.startTime
            && pair.startTime <= range.endTime
            && pair.noteNumber >= range.minNote
            && pair.noteNumber <= range.maxNote;
        })
        .map((pair) => pair.id);
      if (mode === "add") {
        set({ selectedNoteIds: Array.from(new Set([...selectedNoteIds, ...hits])) });
      } else if (mode === "toggle") {
        const next = new Set(selectedNoteIds);
        for (const id of hits) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        set({ selectedNoteIds: Array.from(next) });
      } else {
        set({ selectedNoteIds: hits });
      }
    },

    quantizeSelectedMIDINotes: (trackId, clipId, gridSeconds, strength = 1, options = {}) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return [];
      const requestedSelectedIds = get().selectedNoteIds || [];

      const oldEvents = cloneEvents(clip.events);
      const oldCCEvents = cloneCCEvents(clip.ccEvents || []);
      const allNoteIds = parseMIDINotePairs(oldEvents)
        .map((pair) => sharedNoteIdFor(clipId, pair.startTime, pair.noteNumber));
      const selectedIds = requestedSelectedIds.length > 0 ? requestedSelectedIds : allNoteIds;
      if (selectedIds.length === 0) return [];
      const oldSelectedNoteIds = [...requestedSelectedIds];
      const oldRange = get().midiEditRange;
      const oldRangeClipboard = get().midiRangeClipboard;
      const selectedIdSet = new Set(selectedIds);
      const selectedPairs = parseMIDINotePairs(oldEvents, clipId).filter((pair) => selectedIdSet.has(pair.id));
      if (selectedPairs.length === 0) return [];

      const baseGrid = Math.max(SHARED_MIDI_NOTE_MIN_DURATION, gridSeconds || 0.25);
      const gridOrigin = Number.isFinite(clip.startTime) ? Math.max(0, clip.startTime) : 0;
      const tupletDivisions = Number.isFinite(options.tupletDivisions)
        ? Math.max(1, Math.round(options.tupletDivisions))
        : 1;
      const grid = tupletDivisions > 1
        ? Math.max(SHARED_MIDI_NOTE_MIN_DURATION, (baseGrid * 2) / tupletDivisions)
        : baseGrid;
      const normalizedStrength = Math.max(0, Math.min(1, strength));
      const mode = options.mode || "start";
      const swing = Math.max(-1, Math.min(1, options.swing || 0));
      const groovePreset = options.groovePreset || "straight";
      const catchRange = Math.max(0, options.catchRangeSeconds || (options.catchRangeMs || 0) / 1000 || 0);
      const safeRange = Math.max(0, options.safeRangeSeconds || (options.safeRangeMs || 0) / 1000 || 0);
      const randomize = Math.max(0, options.randomizeSeconds || (options.randomizeMs || 0) / 1000 || 0);
      const fixedLength = Number.isFinite(options.fixedLength) && options.fixedLength > 0
        ? Math.max(SHARED_MIDI_NOTE_MIN_DURATION, options.fixedLength)
        : null;
      const moveControllers = options.moveControllers !== false;
      const snapGridPoint = (index: number) => {
        const swingDelay = Math.abs(index % 2) === 1 ? swing * grid * 0.5 : 0;
        const step = ((index % 4) + 4) % 4;
        let grooveOffset = 0;
        if (groovePreset === "swingLight" && Math.abs(index % 2) === 1) grooveOffset = grid * 0.16;
        else if (groovePreset === "swingHeavy" && Math.abs(index % 2) === 1) grooveOffset = grid * 0.28;
        else if (groovePreset === "laidBack16") grooveOffset = [0, 0.035, 0.012, 0.045][step] * grid;
        else if (groovePreset === "push16") grooveOffset = [0, -0.025, 0, -0.035][step] * grid;
        return Math.max(0, index * grid + swingDelay + grooveOffset);
      };
      const snapToGridWithSwing = (time: number) => {
        const projectTime = time + gridOrigin;
        const center = Math.round(projectTime / grid);
        let best = snapGridPoint(center);
        let bestDistance = Math.abs(projectTime - best);
        for (let index = center - 3; index <= center + 3; index += 1) {
          const candidate = snapGridPoint(index);
          const distance = Math.abs(projectTime - candidate);
          if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
        return Math.max(0, best - gridOrigin);
      };
      const applyStrengthAndRandomness = (original: number, target: number) => {
        const shifted = original + (target - original) * normalizedStrength;
        const rough = randomize > 0 ? (Math.random() * 2 - 1) * randomize : 0;
        return Math.max(0, shifted + rough);
      };
      const quantizeTime = (original: number) => {
        const target = snapToGridWithSwing(original);
        const distance = Math.abs(original - target);
        if (safeRange > 0 && distance <= safeRange) return original;
        if (catchRange > 0 && distance > catchRange) return original;
        return applyStrengthAndRandomness(original, target);
      };
      const moveRanges: Array<{ start: number; end: number; delta: number }> = [];
      const result = rebuildMIDIEventsForNotes(oldEvents, clipId, selectedIds, (pair) => {
        const originalStart = pair.startTime;
        const originalEnd = pair.startTime + pair.duration;
        let nextStart = originalStart;
        let nextEnd = originalEnd;

        const quantizeStarts = mode === "start" || mode === "starts" || mode === "both" || mode === "startsAndEnds";
        const quantizeEnds = mode === "end" || mode === "ends" || mode === "both" || mode === "startsAndEnds";

        if (quantizeStarts) {
          nextStart = quantizeTime(originalStart);
        }

        if (quantizeEnds) {
          nextEnd = quantizeTime(originalEnd);
        }

        if (mode === "length" || mode === "fixedLength") {
          const targetLength = fixedLength ?? Math.max(SHARED_MIDI_NOTE_MIN_DURATION, Math.round(pair.duration / grid) * grid);
          nextEnd = nextStart + Math.max(SHARED_MIDI_NOTE_MIN_DURATION, pair.duration + (targetLength - pair.duration) * normalizedStrength);
        } else if (fixedLength !== null) {
          nextEnd = nextStart + fixedLength;
        } else if (quantizeStarts && !quantizeEnds) {
          nextEnd = nextStart + pair.duration;
        }

        if (nextEnd <= nextStart + SHARED_MIDI_NOTE_MIN_DURATION) {
          nextEnd = nextStart + SHARED_MIDI_NOTE_MIN_DURATION;
        }

        moveRanges.push({
          start: originalStart,
          end: originalEnd,
          delta: nextStart - originalStart,
        });
        return { ...pair, startTime: nextStart, duration: nextEnd - nextStart };
      });

      const clipDuration = getMIDIClipSourceLength(clip);
      const controllerDeltaAt = (time: number) => {
        const candidates = moveRanges.filter((range) =>
          Math.abs(range.delta) > 0.000001 &&
          time >= range.start &&
          time <= range.end,
        );
        if (candidates.length === 0) return 0;
        candidates.sort((a, b) => Math.abs(time - a.start) - Math.abs(time - b.start));
        return candidates[0].delta;
      };
      const movedEvents = sortMIDIEvents(result.events.map((event: any) => {
        if (!moveControllers || event.type === "noteOn" || event.type === "noteOff") return event;
        const delta = controllerDeltaAt(event.timestamp);
        return delta === 0
          ? event
          : { ...event, timestamp: Math.max(0, Math.min(clipDuration, event.timestamp + delta)) };
      }));
      const movedCCEvents = sortCCEvents(oldCCEvents.map((event: any) => {
        if (!moveControllers) return event;
        const delta = controllerDeltaAt(event.time);
        return delta === 0
          ? event
          : { ...event, time: Math.max(0, Math.min(clipDuration, event.time + delta)) };
      }));
      const patches = buildMIDIClipSourceLengthPatches(
        clip,
        getMIDIClipContentEnd(movedEvents, movedCCEvents),
      );
      const oldQuantizeBackup = clip.quantizeBackup
        ? {
            events: cloneEvents(clip.quantizeBackup.events),
            ccEvents: cloneCCEvents(clip.quantizeBackup.ccEvents || []),
          }
        : undefined;
      const nextQuantizeBackup = oldQuantizeBackup || {
        events: cloneEvents(oldEvents),
        ccEvents: cloneCCEvents(oldCCEvents),
      };
      const quantizePatches = {
        oldPatch: { ...patches.oldPatch, quantizeBackup: oldQuantizeBackup },
        newPatch: { ...patches.newPatch, quantizeBackup: nextQuantizeBackup },
      };

      setClipPatch(set, trackId, clipId, { ...quantizePatches.newPatch, events: movedEvents, ccEvents: movedCCEvents });
      set({
        selectedNoteIds: result.nextIds,
        lastMIDIQuantizeSettings: {
          presetId: options.presetId,
          gridSize: options.gridSize,
          gridSeconds: baseGrid,
          strength: normalizedStrength,
          mode,
          swing,
          groovePreset,
          tupletDivisions,
          catchRangeMs: catchRange * 1000,
          safeRangeMs: safeRange * 1000,
          randomizeMs: randomize * 1000,
          fixedLength: fixedLength ?? undefined,
          moveControllers,
        },
      });
      pushMIDIClipEventsAndCCUndoCommand(
        set,
        get,
        trackId,
        clipId,
        oldEvents,
        oldCCEvents,
        movedEvents,
        movedCCEvents,
        oldSelectedNoteIds,
        result.nextIds,
        oldRange,
        oldRange,
        oldRangeClipboard,
        oldRangeClipboard,
        "Quantize MIDI notes",
        "midi_quantize",
        quantizePatches,
      );
      scheduleMIDITrackSync(get, trackId, true);
      return result.nextIds;
    },

    quantizeSelectedMIDINotesUsingLast: (trackId, clipId) => {
      const state = get();
      const targetTrackId = trackId || state.pianoRollTrackId;
      const targetClipId = clipId || state.pianoRollClipId;
      if (!targetTrackId || !targetClipId) return [];
      const settings = !state.lastMIDIQuantizeSettings
        || state.lastMIDIQuantizeSettings.presetId !== state.quantizePresetId
        ? midiQuantizeSettingsFromPreset(state)
        : state.lastMIDIQuantizeSettings;
      return get().quantizeSelectedMIDINotes(targetTrackId, targetClipId, settings.gridSeconds, settings.strength, {
        presetId: settings.presetId,
        gridSize: settings.gridSize,
        mode: settings.mode,
        swing: settings.swing,
        groovePreset: settings.groovePreset,
        tupletDivisions: settings.tupletDivisions,
        catchRangeMs: settings.catchRangeMs,
        safeRangeMs: settings.safeRangeMs,
        randomizeMs: settings.randomizeMs,
        fixedLength: settings.fixedLength,
        moveControllers: settings.moveControllers,
      });
    },

    resetMIDIQuantize: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip?.quantizeBackup) return false;
      const oldEvents = cloneEvents(clip.events || []);
      const oldCCEvents = cloneCCEvents(clip.ccEvents || []);
      const oldBackup = {
        events: cloneEvents(clip.quantizeBackup.events || []),
        ccEvents: cloneCCEvents(clip.quantizeBackup.ccEvents || []),
      };
      const newEvents = cloneEvents(oldBackup.events);
      const newCCEvents = cloneCCEvents(oldBackup.ccEvents);

      setClipPatch(set, trackId, clipId, {
        events: newEvents,
        ccEvents: newCCEvents,
        quantizeBackup: undefined,
      });
      commandManager.push({
        type: "midi_quantize_reset",
        description: "Reset MIDI quantize",
        timestamp: Date.now(),
        execute: () => {
          setClipPatch(set, trackId, clipId, {
            events: cloneEvents(newEvents),
            ccEvents: cloneCCEvents(newCCEvents),
            quantizeBackup: undefined,
          });
          scheduleMIDITrackSync(get, trackId, true);
        },
        undo: () => {
          setClipPatch(set, trackId, clipId, {
            events: cloneEvents(oldEvents),
            ccEvents: cloneCCEvents(oldCCEvents),
            quantizeBackup: oldBackup,
          });
          scheduleMIDITrackSync(get, trackId, true);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      scheduleMIDITrackSync(get, trackId, true);
      return true;
    },

    freezeMIDIQuantize: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip?.quantizeBackup) return false;
      const oldBackup = {
        events: cloneEvents(clip.quantizeBackup.events || []),
        ccEvents: cloneCCEvents(clip.quantizeBackup.ccEvents || []),
      };

      setClipPatch(set, trackId, clipId, { quantizeBackup: undefined });
      commandManager.push({
        type: "midi_quantize_freeze",
        description: "Freeze MIDI quantize",
        timestamp: Date.now(),
        execute: () => {
          setClipPatch(set, trackId, clipId, { quantizeBackup: undefined });
          scheduleMIDITrackSync(get, trackId, true);
        },
        undo: () => {
          setClipPatch(set, trackId, clipId, { quantizeBackup: oldBackup });
          scheduleMIDITrackSync(get, trackId, true);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      scheduleMIDITrackSync(get, trackId, true);
      return true;
    },

    humanizeSelectedMIDINotes: (trackId, clipId, options = {}) => {
      const timing = (options.timingMs ?? 10) / 1000;
      const velocityAmount = options.velocity ?? 5;
      const clip = getClip(get, trackId, clipId);
      const clipDuration = clip ? getMIDIClipSourceLength(clip) : 0;
      return applySelectedNoteTransform(set, get, trackId, clipId, "Humanize MIDI notes", "midi_humanize", (pair) => ({
        ...pair,
        startTime: Math.max(0, Math.min(clipDuration - pair.duration, pair.startTime + (Math.random() * 2 - 1) * timing)),
        velocity: clampSharedMIDIVelocity(pair.velocity + (Math.random() * 2 - 1) * velocityAmount),
      }));
    },

    setSelectedMIDINoteVelocity: (trackId, clipId, velocity) =>
      applySelectedNoteTransform(set, get, trackId, clipId, "Set MIDI note velocity", "midi_velocity_set", (pair) => ({
        ...pair,
        velocity: clampSharedMIDIVelocity(velocity),
      })),

    scaleSelectedMIDINoteVelocity: (trackId, clipId, factor) =>
      applySelectedNoteTransform(set, get, trackId, clipId, "Scale MIDI note velocity", "midi_velocity_scale", (pair) => ({
        ...pair,
        velocity: clampSharedMIDIVelocity(pair.velocity * factor),
      })),

    randomizeSelectedMIDINoteVelocity: (trackId, clipId, amount = 8) =>
      applySelectedNoteTransform(set, get, trackId, clipId, "Randomize MIDI note velocity", "midi_velocity_randomize", (pair) => ({
        ...pair,
        velocity: clampSharedMIDIVelocity(pair.velocity + (Math.random() * 2 - 1) * amount),
      })),

    setSelectedMIDINoteLength: (trackId, clipId, duration) => {
      return applySelectedNoteTransform(set, get, trackId, clipId, "Set MIDI note length", "midi_note_length", (pair) => ({
        ...pair,
        duration: Math.max(SHARED_MIDI_NOTE_MIN_DURATION, duration),
      }));
    },

    legatoSelectedMIDINotes: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events).sort((a: any, b: any) => a.startTime - b.startTime) : [];
      const nextStartById = new Map<string, number>();
      for (let index = 0; index < selected.length - 1; index += 1) {
        nextStartById.set(selected[index].id, selected[index + 1].startTime);
      }
      return applySelectedNoteTransform(set, get, trackId, clipId, "Legato MIDI notes", "midi_legato", (pair) => ({
        ...pair,
        duration: Math.max(SHARED_MIDI_NOTE_MIN_DURATION, (nextStartById.get(pair.id) ?? (clip ? getMIDIClipSourceLength(clip) : pair.startTime + pair.duration)) - pair.startTime),
      }));
    },

    reverseSelectedMIDINotes: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events) : [];
      if (selected.length === 0) return [];
      const minStart = Math.min(...selected.map((pair: any) => pair.startTime));
      const maxEnd = Math.max(...selected.map((pair: any) => pair.startTime + pair.duration));
      return applySelectedNoteTransform(set, get, trackId, clipId, "Reverse selected MIDI notes", "midi_reverse_selected", (pair) => ({
        ...pair,
        startTime: minStart + (maxEnd - (pair.startTime + pair.duration)),
      }));
    },

    invertSelectedMIDINotePitches: (trackId, clipId) => {
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events) : [];
      if (selected.length === 0) return [];
      const center = (Math.min(...selected.map((pair: any) => pair.noteNumber)) + Math.max(...selected.map((pair: any) => pair.noteNumber))) / 2;
      return get().mirrorSelectedMIDINotePitches(trackId, clipId, center);
    },

    mirrorSelectedMIDINotePitches: (trackId, clipId, centerNote) => {
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events) : [];
      if (selected.length === 0) return [];
      const center = centerNote ?? selected[0].noteNumber;
      return applySelectedNoteTransform(set, get, trackId, clipId, "Mirror MIDI note pitches", "midi_pitch_mirror", (pair) => ({
        ...pair,
        noteNumber: clampSharedMIDINote(Math.round(2 * center - pair.noteNumber)),
      }));
    },

    snapSelectedMIDINotesToScale: (trackId, clipId, scaleRoot, scaleType) => {
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events) : [];
      if (selected.length === 0) return [];
      const snappedNotes = new Map(selected.map((pair: any) => [
        pair.id,
        snapMidiNoteToScale(pair.noteNumber, scaleRoot, scaleType),
      ]));
      const hasChanges = selected.some((pair: any) => snappedNotes.get(pair.id) !== pair.noteNumber);
      if (!hasChanges) return selected.map((pair: any) => pair.id);
      return applySelectedNoteTransform(set, get, trackId, clipId, "Snap MIDI notes to scale", "midi_pitch_snap_scale", (pair) => ({
        ...pair,
        noteNumber: snappedNotes.get(pair.id) ?? pair.noteNumber,
      }));
    },

    toggleSelectedMIDINoteMute: (trackId, clipId, muted) => {
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events) : [];
      if (selected.length === 0) return [];
      const nextMuted = muted ?? !selected.every((pair: any) => pair.muted);
      return applySelectedNoteTransform(set, get, trackId, clipId, nextMuted ? "Mute MIDI notes" : "Unmute MIDI notes", "midi_note_mute", (pair) => ({
        ...pair,
        muted: nextMuted,
      }));
    },

    insertMIDIChord: (trackId, clipId, startTime, rootNote, chordType = "major") => {
      const state = get();
      const notes = chordType === "diatonic"
        ? buildDiatonicChordNotes(rootNote, state.pianoRollScaleRoot, state.pianoRollScaleType)
        : (chordType === "minor" ? [0, 3, 7] : chordType === "power" ? [0, 7] : [0, 4, 7])
          .map((interval) => clampSharedMIDINote(rootNote + interval));
      const ids = notes.map((note) =>
        get().addMIDINote(trackId, clipId, startTime, note, 0.5, 80),
      ).filter(Boolean);
      set({ selectedNoteIds: ids });
      return ids;
    },

    cropMIDIClipToSelectedNotes: (trackId, clipId) => {
      const track = getTrack(get, trackId);
      const clip = getClip(get, trackId, clipId);
      const selected = clip ? selectedPairsForClip(get, clipId, clip.events) : [];
      if (!track || !clip || selected.length === 0) return;

      const start = Math.max(0, Math.min(...selected.map((pair: any) => pair.startTime)));
      const end = Math.min(getMIDIClipSourceLength(clip), Math.max(...selected.map((pair: any) => pair.startTime + pair.duration)));
      if (end <= start) return;

      const oldClip = { ...clip, events: cloneEvents(clip.events), ccEvents: cloneCCEvents(clip.ccEvents || []) };
      const oldSelectedNoteIds = [...(get().selectedNoteIds || [])];
      const nextClip = {
        ...clip,
        startTime: clip.startTime + start,
        duration: end - start,
        sourceLength: end - start,
        loopLength: end - start,
        events: sortMIDIEvents(clip.events
          .filter((event: any) => event.timestamp >= start && event.timestamp <= end)
          .map((event: any) => ({ ...event, timestamp: Math.max(0, event.timestamp - start) }))),
        ccEvents: (clip.ccEvents || [])
          .filter((event: any) => event.time >= start && event.time <= end)
          .map((event: any) => ({ ...event, time: Math.max(0, event.time - start) })),
      };
      const nextIds = parseMIDINotePairs(nextClip.events, clipId).map((pair) => pair.id);

      const applyClip = (targetClip: any) => {
        set((state: any) => ({
          tracks: state.tracks.map((candidate: any) =>
            candidate.id === trackId
              ? {
                  ...candidate,
                  midiClips: candidate.midiClips.map((midiClip: any) =>
                    midiClip.id === clipId ? targetClip : midiClip,
                  ),
                }
              : candidate,
          ),
          selectedNoteIds: targetClip === nextClip ? nextIds : oldSelectedNoteIds,
          isModified: true,
        }));
        scheduleMIDITrackSync(get, trackId, true);
      };

      applyClip(nextClip);
      commandManager.push({
        type: "midi_clip_crop",
        description: "Crop MIDI clip to selected notes",
        timestamp: Date.now(),
        execute: () => applyClip(nextClip),
        undo: () => applyClip(oldClip),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleStep: (pitch, step) => {
      const s = get();
      const oldSteps = s.stepSequencer.steps;
      const oldValue = oldSteps[pitch]?.[step] ?? false;
      const newValue = !oldValue;
      const newSteps = oldSteps.map((row, r) =>
        r === pitch ? row.map((v, c) => (c === step ? newValue : v)) : row,
      );

      set({
        stepSequencer: { ...s.stepSequencer, steps: newSteps },
        isModified: true,
      });

      commandManager.push({
        type: "step_sequencer_toggle",
        description: `Toggle step [${pitch}, ${step}] ${newValue ? "on" : "off"}`,
        timestamp: Date.now(),
        execute: () => set({ stepSequencer: { ...get().stepSequencer, steps: newSteps } }),
        undo: () => set({ stepSequencer: { ...get().stepSequencer, steps: oldSteps } }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setStepVelocity: (pitch, step, velocity) => {
      const s = get();
      const newVelocities = s.stepSequencer.velocities.map((row, r) =>
        r === pitch ? row.map((v, c) => (c === step ? Math.max(0, Math.min(127, velocity)) : v)) : row,
      );
      set({ stepSequencer: { ...s.stepSequencer, velocities: newVelocities } });
    },

    setStepCount: (count) => {
      const clamped = Math.max(4, Math.min(64, count));
      const s = get();
      const { steps, velocities, pitchCount } = s.stepSequencer;

      const newSteps = Array.from({ length: pitchCount }, (_, r) => {
        const existing = steps[r] || [];
        return Array.from({ length: clamped }, (_, c) => existing[c] ?? false);
      });
      const newVelocities = Array.from({ length: pitchCount }, (_, r) => {
        const existing = velocities[r] || [];
        return Array.from({ length: clamped }, (_, c) => existing[c] ?? 100);
      });

      set({
        stepSequencer: { ...s.stepSequencer, stepCount: clamped, steps: newSteps, velocities: newVelocities },
      });
    },

    setStepSize: (size) => {
      set((s) => ({
        stepSequencer: { ...s.stepSequencer, stepSize: size },
      }));
    },

    clearStepSequencer: () => {
      const s = get();
      const oldSteps = s.stepSequencer.steps;
      const oldVelocities = s.stepSequencer.velocities;
      const { stepCount, pitchCount } = s.stepSequencer;

      const emptySteps = Array.from({ length: pitchCount }, () => Array(stepCount).fill(false));
      const defaultVelocities = Array.from({ length: pitchCount }, () => Array(stepCount).fill(100));

      set({
        stepSequencer: { ...s.stepSequencer, steps: emptySteps, velocities: defaultVelocities },
        isModified: true,
      });

      commandManager.push({
        type: "step_sequencer_clear",
        description: "Clear step sequencer",
        timestamp: Date.now(),
        execute: () => set({ stepSequencer: { ...get().stepSequencer, steps: emptySteps, velocities: defaultVelocities } }),
        undo: () => set({ stepSequencer: { ...get().stepSequencer, steps: oldSteps, velocities: oldVelocities } }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    generateMIDIClipFromSteps: () => {
      const s = get();
      const { steps, velocities, stepCount, stepSize, pitchCount } = s.stepSequencer;
      const tempo = s.transport.tempo;
      let beatsPerStep = 0.25;
      if (stepSize === "1/8") beatsPerStep = 0.5;
      else if (stepSize === "1/4") beatsPerStep = 1;
      else if (stepSize === "1/16") beatsPerStep = 0.25;
      const stepDurationSec = (60 / tempo) * beatsPerStep;
      const events: any[] = [];
      const basePitch = 60 - Math.floor(pitchCount / 2);

      for (let row = 0; row < pitchCount; row++) {
        for (let col = 0; col < stepCount; col++) {
          if (steps[row]?.[col]) {
            const time = col * stepDurationSec;
            const note = basePitch + (pitchCount - 1 - row);
            const vel = velocities[row]?.[col] ?? 100;
            events.push({ timestamp: time, type: "noteOn", note, velocity: vel });
            events.push({ timestamp: time + stepDurationSec * 0.9, type: "noteOff", note, velocity: 0 });
          }
        }
      }

      const totalDuration = stepCount * stepDurationSec;
      const selectedTrackId = s.selectedTrackId;
      if (!selectedTrackId) return;

      const track = s.tracks.find((t) => t.id === selectedTrackId);
      if (!track || (track.type !== "midi" && track.type !== "instrument")) return;

      const clipId = crypto.randomUUID();
      const midiClip = {
        id: clipId,
        name: "Step Pattern",
        startTime: s.transport.currentTime,
        duration: totalDuration,
        offset: 0,
        sourceStart: 0,
        sourceLength: totalDuration,
        loopEnabled: true,
        loopOffset: 0,
        loopLength: totalDuration,
        events,
        ccEvents: [],
        color: track.color || "#4361ee",
      };
      const newMidiClips = [...(track.midiClips || []), midiClip];
      set({
        tracks: s.tracks.map((t) =>
          t.id === selectedTrackId ? { ...t, midiClips: newMidiClips } : t,
        ),
        isModified: true,
      });
      scheduleMIDITrackSync(get, selectedTrackId, false);

      commandManager.push({
        type: "step_sequencer_generate",
        description: "Generate MIDI clip from step sequencer",
        timestamp: Date.now(),
        execute: () => {
          set({
            tracks: get().tracks.map((t) =>
              t.id === selectedTrackId ? { ...t, midiClips: [...(t.midiClips || []), midiClip] } : t,
            ),
          });
          scheduleMIDITrackSync(get, selectedTrackId, false);
        },
        undo: () => {
          set({
            tracks: get().tracks.map((t) =>
              t.id === selectedTrackId ? { ...t, midiClips: (t.midiClips || []).filter((c) => c.id !== clipId) } : t,
            ),
          });
          scheduleMIDITrackSync(get, selectedTrackId, false);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleStepSequencer: () =>
      set((s) => ({ showStepSequencer: !s.showStepSequencer })),

    toggleStepInput: () => set((s) => ({
      stepInputEnabled: !s.stepInputEnabled,
      stepInputPosition: !s.stepInputEnabled ? 0 : s.stepInputPosition,
    })),
    setStepInputSize: (beats) => set({ stepInputSize: beats }),
    setStepInputPosition: (time) => set({ stepInputPosition: Math.max(0, time) }),
    setMIDIInputQuantize: (settings) => set((s) => ({
      midiInputQuantizeEnabled: settings.midiInputQuantizeEnabled ?? s.midiInputQuantizeEnabled,
      midiInputQuantizeGridBeats: Math.max(0.03125, settings.midiInputQuantizeGridBeats ?? s.midiInputQuantizeGridBeats),
      midiInputQuantizeStrength: Math.max(0, Math.min(1, settings.midiInputQuantizeStrength ?? s.midiInputQuantizeStrength)),
    })),
    advanceStepInput: () => {
      const { stepInputSize, stepInputPosition, transport } = get();
      const beatsPerSecond = transport.tempo / 60;
      const advanceSeconds = stepInputSize / beatsPerSecond;
      set({ stepInputPosition: stepInputPosition + advanceSeconds });
    },

    transposeMIDINotes: (clipId, semitones) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const oldEvents = cloneEvents(clip.events);
      const newEvents = sortMIDIEvents(clip.events.map((event) => {
        if ((event.type === "noteOn" || event.type === "noteOff") && event.note !== undefined) {
          return { ...event, note: clampMidiNote(event.note + semitones) };
        }
        return { ...event };
      }));

      setClipPatch(set, pianoRollTrackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, pianoRollTrackId, clipId, oldEvents, newEvents, `Transpose ${semitones > 0 ? "+" : ""}${semitones} semitones`, "midi_transpose");
      scheduleMIDITrackSync(get, pianoRollTrackId, true);
    },

    scaleMIDINoteVelocity: (clipId, factor) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const oldEvents = cloneEvents(clip.events);
      const newEvents = sortMIDIEvents(clip.events.map((event) => {
        if (event.type === "noteOn" && event.velocity !== undefined) {
          return { ...event, velocity: clampVelocity(event.velocity * factor) };
        }
        return { ...event };
      }));

      setClipPatch(set, pianoRollTrackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, pianoRollTrackId, clipId, oldEvents, newEvents, `Scale velocity x${factor.toFixed(2)}`, "midi_velocity_scale");
      scheduleMIDITrackSync(get, pianoRollTrackId, true);
    },

    reverseMIDINotes: (clipId) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const oldEvents = cloneEvents(clip.events);
      const pairs = parseNotePairs(oldEvents, clipId);
      const consumed = new Set<number>();
      const noteEvents: any[] = [];
      const maxTime = Math.max(getMIDIClipSourceLength(clip), ...pairs.map((pair) => pair.startTime + pair.duration));

      for (const pair of pairs) {
        consumed.add(pair.onIndex);
        consumed.add(pair.offIndex);
        const newStart = Math.max(0, maxTime - (pair.startTime + pair.duration));
        noteEvents.push(
          { ...pair.noteOn, timestamp: newStart },
          { ...pair.noteOff, timestamp: newStart + pair.duration },
        );
      }

      const newEvents = sortMIDIEvents([...oldEvents.filter((_, index) => !consumed.has(index)), ...noteEvents]);
      setClipPatch(set, pianoRollTrackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, pianoRollTrackId, clipId, oldEvents, newEvents, "Reverse MIDI notes", "midi_reverse");
      scheduleMIDITrackSync(get, pianoRollTrackId, true);
    },

    invertMIDINotes: (clipId) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const oldEvents = cloneEvents(clip.events);
      const noteOnPitches = clip.events
        .filter((event) => event.type === "noteOn" && event.note !== undefined)
        .map((event) => event.note);
      if (noteOnPitches.length === 0) return;
      const centerPitch = (Math.min(...noteOnPitches) + Math.max(...noteOnPitches)) / 2;
      const newEvents = sortMIDIEvents(clip.events.map((event) => {
        if ((event.type === "noteOn" || event.type === "noteOff") && event.note !== undefined) {
          return { ...event, note: clampMidiNote(Math.round(2 * centerPitch - event.note)) };
        }
        return { ...event };
      }));

      setClipPatch(set, pianoRollTrackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, pianoRollTrackId, clipId, oldEvents, newEvents, "Invert MIDI note pitches", "midi_invert");
      scheduleMIDITrackSync(get, pianoRollTrackId, true);
    },

    setNoteExpression: (clipId, noteId, expr) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const clip = getClip(get, pianoRollTrackId, clipId);
      if (!clip) return;
      const parsed = parseNoteIdentity(noteId);
      if (!parsed) return;

      const oldEvents = cloneEvents(clip.events);
      const newEvents = sortMIDIEvents(clip.events.map((event) => {
        if (
          event.type === "noteOn" &&
          event.note === parsed.note &&
          Math.abs(event.timestamp - parsed.timestamp) < 0.001
        ) {
          return {
            ...event,
            pitchBend: expr.pitchBend !== undefined ? Math.max(-1, Math.min(1, expr.pitchBend)) : event.pitchBend,
            pressure: expr.pressure !== undefined ? Math.max(0, Math.min(1, expr.pressure)) : event.pressure,
            slide: expr.slide !== undefined ? Math.max(0, Math.min(1, expr.slide)) : event.slide,
          };
        }
        return { ...event };
      }));

      setClipPatch(set, pianoRollTrackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, pianoRollTrackId, clipId, oldEvents, newEvents, "Set note expression", "note_expression");
      scheduleMIDITrackSync(get, pianoRollTrackId, true);
    },

    toggleMediaPool: () =>
      set((s) => ({ showMediaPool: !s.showMediaPool })),
});
