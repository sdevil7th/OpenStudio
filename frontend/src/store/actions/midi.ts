// @ts-nocheck
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { syncTrackMIDIClipsToBackend } from "../../utils/midiClipSerialization";

type SetFn = (...args: any[]) => void;
type GetFn = () => any;

const MIDI_SYNC_DEBOUNCE_MS = 120;
const MIDI_NOTE_MIN_DURATION = 0.01;
const midiSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  await syncTrackMIDIClipsToBackend(trackId, track.midiClips).catch(logBridgeError("midi sync"));
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

function pushEventsUndoCommand(set: SetFn, get: GetFn, trackId: string, clipId: string, oldEvents: any[], newEvents: any[], description: string, type: string) {
  if (!eventsChanged(oldEvents, newEvents)) return;

  commandManager.push({
    type,
    description,
    timestamp: Date.now(),
    execute: () => {
      setClipPatch(set, trackId, clipId, { events: cloneEvents(newEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
    undo: () => {
      setClipPatch(set, trackId, clipId, { events: cloneEvents(oldEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
  });
  set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
}

function pushCCUndoCommand(set: SetFn, get: GetFn, trackId: string, clipId: string, oldCCEvents: any[], newCCEvents: any[], description: string) {
  if (!eventsChanged(oldCCEvents, newCCEvents)) return;

  commandManager.push({
    type: "midi_cc",
    description,
    timestamp: Date.now(),
    execute: () => {
      setClipPatch(set, trackId, clipId, { ccEvents: cloneCCEvents(newCCEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
    undo: () => {
      setClipPatch(set, trackId, clipId, { ccEvents: cloneCCEvents(oldCCEvents) });
      scheduleMIDITrackSync(get, trackId, true);
    },
  });
  set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
}

export const midiActions = (set: SetFn, get: GetFn) => ({
    openPianoRoll: (trackId, clipId) =>
      set({ showPianoRoll: true, pianoRollTrackId: trackId, pianoRollClipId: clipId }),
    closePianoRoll: () =>
      set({ showPianoRoll: false, pianoRollTrackId: null, pianoRollClipId: null }),

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
      setClipPatch(set, trackId, clipId, { events: sortMIDIEvents(events) });
      scheduleMIDITrackSync(get, trackId, true);
    },

    commitMIDIClipEvents: (trackId, clipId, oldEvents, newEvents, description = "Edit MIDI notes") => {
      const sortedOld = sortMIDIEvents(oldEvents);
      const sortedNew = sortMIDIEvents(newEvents);
      setClipPatch(set, trackId, clipId, { events: sortedNew });
      pushEventsUndoCommand(set, get, trackId, clipId, sortedOld, sortedNew, description, "midi_notes_edit");
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

      setClipPatch(set, trackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, "Add MIDI note", "midi_note_add");
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
      const clipDuration = Math.max(MIDI_NOTE_MIN_DURATION, clip.duration || 0);
      const { events: newEvents, nextIds } = rebuildEventsForNotes(oldEvents, clipId, noteIds, (pair) => {
        const duration = Math.max(MIDI_NOTE_MIN_DURATION, pair.duration);
        const maxStart = Math.max(0, clipDuration - duration);
        return {
          ...pair,
          startTime: Math.max(0, Math.min(maxStart, pair.startTime + deltaTime)),
          noteNumber: clampMidiNote(pair.noteNumber + deltaNote),
          duration,
        };
      });

      setClipPatch(set, trackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, "Move MIDI notes", "midi_note_move");
      scheduleMIDITrackSync(get, trackId, true);
      return nextIds;
    },

    resizeMIDINote: (trackId, clipId, noteId, startTime, duration) => {
      const clip = getClip(get, trackId, clipId);
      if (!clip) return [];

      const oldEvents = cloneEvents(clip.events);
      const clipDuration = Math.max(MIDI_NOTE_MIN_DURATION, clip.duration || 0);
      const nextStart = Math.max(0, Math.min(clipDuration - MIDI_NOTE_MIN_DURATION, startTime));
      const nextDuration = Math.max(MIDI_NOTE_MIN_DURATION, Math.min(duration, clipDuration - nextStart));
      const { events: newEvents, nextIds } = rebuildEventsForNotes(oldEvents, clipId, [noteId], (pair) => ({
        ...pair,
        startTime: nextStart,
        duration: nextDuration,
      }));

      setClipPatch(set, trackId, clipId, { events: newEvents });
      pushEventsUndoCommand(set, get, trackId, clipId, oldEvents, newEvents, "Resize MIDI note", "midi_note_resize");
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
      setClipPatch(set, trackId, clipId, { ccEvents: sortedNewCCEvents });
      if (!options.transient) {
        pushCCUndoCommand(set, get, trackId, clipId, oldCCEvents, sortedNewCCEvents, options.description || "Update MIDI CC events");
      }
      scheduleMIDITrackSync(get, trackId, true);
    },

    commitMIDICCEvents: (trackId, clipId, oldCCEvents, newCCEvents, description = "Update MIDI CC events") => {
      const sortedOld = sortCCEvents(oldCCEvents);
      const sortedNew = sortCCEvents(newCCEvents);
      setClipPatch(set, trackId, clipId, { ccEvents: sortedNew });
      pushCCUndoCommand(set, get, trackId, clipId, sortedOld, sortedNew, description);
      scheduleMIDITrackSync(get, trackId, true);
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
      const maxTime = Math.max(clip.duration || 0, ...pairs.map((pair) => pair.startTime + pair.duration));

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
