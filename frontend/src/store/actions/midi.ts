// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const midiActions = (set: SetFn, get: GetFn) => ({
    openPianoRoll: (trackId, clipId) =>
      set({ showPianoRoll: true, pianoRollTrackId: trackId, pianoRollClipId: clipId }),
    closePianoRoll: () =>
      set({ showPianoRoll: false, pianoRollTrackId: null, pianoRollClipId: null }),
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
                    color: clipColor,
                  },
                ],
              }
            : t
        ),
        isModified: true,
      }));

      return clipId;
    },


    toggleStep: (pitch, step) => {
      const s = get();
      const oldSteps = s.stepSequencer.steps;
      const oldValue = oldSteps[pitch]?.[step] ?? false;
      const newValue = !oldValue;

      // Build new steps array
      const newSteps = oldSteps.map((row, r) =>
        r === pitch ? row.map((v, c) => (c === step ? newValue : v)) : row,
      );

      set({
        stepSequencer: { ...s.stepSequencer, steps: newSteps },
        isModified: true,
      });

      // Undo support
      const undoSteps = oldSteps;
      commandManager.push({
        type: "step_sequencer_toggle",
        description: `Toggle step [${pitch}, ${step}] ${newValue ? "on" : "off"}`,
        timestamp: Date.now(),
        execute: () => set({ stepSequencer: { ...get().stepSequencer, steps: newSteps } }),
        undo: () => set({ stepSequencer: { ...get().stepSequencer, steps: undoSteps } }),
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

      // Resize each row to the new step count
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

      // Undo support
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

      // Calculate step duration in seconds
      let beatsPerStep = 0.25; // default 1/16
      if (stepSize === "1/8") beatsPerStep = 0.5;
      else if (stepSize === "1/4") beatsPerStep = 1;
      else if (stepSize === "1/16") beatsPerStep = 0.25;
      const stepDurationSec = (60 / tempo) * beatsPerStep;

      // Generate MIDI events from the step grid
      const events: MIDIEvent[] = [];
      const basePitch = 60 - Math.floor(pitchCount / 2); // Center around middle C

      for (let row = 0; row < pitchCount; row++) {
        for (let col = 0; col < stepCount; col++) {
          if (steps[row]?.[col]) {
            const time = col * stepDurationSec;
            const note = basePitch + (pitchCount - 1 - row); // Bottom row = lowest pitch
            const vel = velocities[row]?.[col] ?? 100;

            events.push({
              timestamp: time,
              type: "noteOn",
              note,
              velocity: vel,
            });
            events.push({
              timestamp: time + stepDurationSec * 0.9, // 90% gate
              type: "noteOff",
              note,
              velocity: 0,
            });
          }
        }
      }

      const totalDuration = stepCount * stepDurationSec;
      console.log(
        `[StepSequencer] Generated ${events.length} MIDI events, duration: ${totalDuration.toFixed(2)}s`,
        events,
      );

      // If a MIDI track is selected, add the clip to it
      const selectedTrackId = s.selectedTrackId;
      if (selectedTrackId) {
        const track = s.tracks.find((t) => t.id === selectedTrackId);
        if (track && (track.type === "midi" || track.type === "instrument")) {
          const clipId = crypto.randomUUID();
          const midiClip: MIDIClip = {
            id: clipId,
            name: "Step Pattern",
            startTime: s.transport.currentTime,
            duration: totalDuration,
            events,
            color: track.color || "#4361ee",
          };

          const newMidiClips = [...(track.midiClips || []), midiClip];
          set({
            tracks: s.tracks.map((t) =>
              t.id === selectedTrackId ? { ...t, midiClips: newMidiClips } : t,
            ),
            isModified: true,
          });

          commandManager.push({
            type: "step_sequencer_generate",
            description: "Generate MIDI clip from step sequencer",
            timestamp: Date.now(),
            execute: () => set({
              tracks: get().tracks.map((t) =>
                t.id === selectedTrackId ? { ...t, midiClips: [...(t.midiClips || []), midiClip] } : t,
              ),
            }),
            undo: () => set({
              tracks: get().tracks.map((t) =>
                t.id === selectedTrackId ? { ...t, midiClips: (t.midiClips || []).filter((c) => c.id !== clipId) } : t,
              ),
            }),
          });
          set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        }
      }
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

    // ========== MIDI Transform ==========
    transposeMIDINotes: (clipId, semitones) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      // Transpose all noteOn/noteOff events in the clip by the given semitones.
      // Operates on all notes (selectedNoteIds is not used for filtering since
      // the piano roll events don't carry per-note IDs).
      const newEvents = clip.events.map((e) => {
        if ((e.type === "noteOn" || e.type === "noteOff") && e.note !== undefined) {
          const newNote = Math.max(0, Math.min(127, e.note + semitones));
          return { ...e, note: newNote };
        }
        return e;
      });

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_transpose",
        description: `Transpose ${semitones > 0 ? "+" : ""}${semitones} semitones`,
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    scaleMIDINoteVelocity: (clipId, factor) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      const newEvents = clip.events.map((e) => {
        if (e.type === "noteOn" && e.velocity !== undefined) {
          const newVel = Math.max(1, Math.min(127, Math.round(e.velocity * factor)));
          return { ...e, velocity: newVel };
        }
        return e;
      });

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_velocity_scale",
        description: `Scale velocity x${factor.toFixed(2)}`,
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reverseMIDINotes: (clipId) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      // Collect noteOn/noteOff pairs
      const noteOns = clip.events.filter((e) => e.type === "noteOn");
      const noteOffs = clip.events.filter((e) => e.type === "noteOff");
      const otherEvents = clip.events.filter((e) => e.type !== "noteOn" && e.type !== "noteOff");

      // Find the max end time of all notes
      let maxTime = 0;
      for (const on of noteOns) {
        const off = noteOffs.find((e) => e.note === on.note && e.timestamp > on.timestamp);
        if (off && off.timestamp > maxTime) maxTime = off.timestamp;
      }
      if (maxTime === 0) maxTime = clip.duration;

      // Reverse: mirror each note around the midpoint of the clip
      const newNoteEvents: MIDIEvent[] = [];
      for (const on of noteOns) {
        const off = noteOffs.find((e) => e.note === on.note && e.timestamp > on.timestamp);
        if (!off) continue;
        const dur = off.timestamp - on.timestamp;
        const newStart = maxTime - off.timestamp;
        newNoteEvents.push({ ...on, timestamp: Math.max(0, newStart) });
        newNoteEvents.push({ ...off, timestamp: Math.max(0, newStart + dur) });
      }

      const newEvents = [...otherEvents, ...newNoteEvents].sort((a, b) => a.timestamp - b.timestamp);

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_reverse",
        description: "Reverse MIDI notes",
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    invertMIDINotes: (clipId) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldEvents = [...clip.events];

      // Find center pitch from noteOn events
      const noteOnPitches = clip.events
        .filter((e) => e.type === "noteOn" && e.note !== undefined)
        .map((e) => e.note!);
      if (noteOnPitches.length === 0) return;
      const minPitch = Math.min(...noteOnPitches);
      const maxPitch = Math.max(...noteOnPitches);
      const centerPitch = (minPitch + maxPitch) / 2;

      const newEvents = clip.events.map((e) => {
        if ((e.type === "noteOn" || e.type === "noteOff") && e.note !== undefined) {
          const inverted = Math.round(2 * centerPitch - e.note);
          const clamped = Math.max(0, Math.min(127, inverted));
          return { ...e, note: clamped };
        }
        return e;
      });

      const applyEvents = (s: any, events: MIDIEvent[]) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events } : c) }
            : t,
        ),
      });
      set((s) => ({ ...applyEvents(s, newEvents), isModified: true }));
      commandManager.push({
        type: "midi_invert",
        description: "Invert MIDI note pitches",
        timestamp: Date.now(),
        execute: () => set((s) => applyEvents(s, newEvents)),
        undo: () => set((s) => applyEvents(s, oldEvents)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setNoteExpression: (clipId, noteId, expr) => {
      const { pianoRollTrackId } = get();
      if (!pianoRollTrackId) return;
      const track = get().tracks.find((t) => t.id === pianoRollTrackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const [tsStr, noteStr] = noteId.split(":");
      const noteTimestamp = parseFloat(tsStr);
      const noteNumber = parseInt(noteStr, 10);
      const noteIdx = clip.events.findIndex(
        (e) => e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001,
      );
      if (noteIdx === -1) return;
      const oldEvent = clip.events[noteIdx];
      const oldExpr = { pitchBend: oldEvent.pitchBend, pressure: oldEvent.pressure, slide: oldEvent.slide };
      const newExpr = {
        pitchBend: expr.pitchBend !== undefined ? Math.max(-1, Math.min(1, expr.pitchBend)) : oldEvent.pitchBend,
        pressure: expr.pressure !== undefined ? Math.max(0, Math.min(1, expr.pressure)) : oldEvent.pressure,
        slide: expr.slide !== undefined ? Math.max(0, Math.min(1, expr.slide)) : oldEvent.slide,
      };
      const applyExpr = (s: any, ex: { pitchBend?: number; pressure?: number; slide?: number }) => ({
        tracks: s.tracks.map((t: any) =>
          t.id === pianoRollTrackId
            ? {
                ...t,
                midiClips: t.midiClips.map((c: any) =>
                  c.id === clipId
                    ? {
                        ...c,
                        events: c.events.map((e: any) =>
                          e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001
                            ? { ...e, ...ex }
                            : e,
                        ),
                      }
                    : c,
                ),
              }
            : t,
        ),
      });
      set((s) => ({ ...applyExpr(s, newExpr), isModified: true }));
      commandManager.push({
        type: "note_expression",
        description: "Set note expression",
        timestamp: Date.now(),
        execute: () => set((s) => applyExpr(s, newExpr)),
        undo: () => set((s) => applyExpr(s, oldExpr)),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // Sprint 19: Plugin + Mixing
    toggleMediaPool: () =>
      set((s) => ({ showMediaPool: !s.showMediaPool })),

});
