// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { logBridgeError } from "../../utils/bridgeErrorHandler";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const clipLauncherActions = (set: SetFn, get: GetFn) => ({
    triggerSlot: (trackIndex, slotIndex) => {
      nativeBridge.triggerSlot(trackIndex, slotIndex).catch((err) => {
        console.error("[Store] Failed to trigger slot:", err);
      });

      // Optimistically update local state
      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots, ti) =>
          trackSlots.map((slot, si) => {
            if (ti === trackIndex && si === slotIndex) {
              return { ...slot, isPlaying: true, isQueued: false };
            }
            // Stop other slots on the same track
            if (ti === trackIndex && si !== slotIndex && slot.isPlaying) {
              return { ...slot, isPlaying: false, isQueued: false };
            }
            return slot;
          }),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    stopSlot: (trackIndex, slotIndex) => {
      nativeBridge.stopSlot(trackIndex, slotIndex).catch((err) => {
        console.error("[Store] Failed to stop slot:", err);
      });

      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots, ti) =>
          trackSlots.map((slot, si) =>
            ti === trackIndex && si === slotIndex
              ? { ...slot, isPlaying: false, isQueued: false }
              : slot,
          ),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    triggerScene: (slotIndex) => {
      nativeBridge.triggerScene(slotIndex).catch((err) => {
        console.error("[Store] Failed to trigger scene:", err);
      });

      // Trigger all slots in this row
      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots) =>
          trackSlots.map((slot, si) => {
            if (si === slotIndex && slot.filePath) {
              return { ...slot, isPlaying: true, isQueued: false };
            }
            if (si !== slotIndex && slot.isPlaying) {
              return { ...slot, isPlaying: false };
            }
            return slot;
          }),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    stopAllSlots: () => {
      nativeBridge.stopAllSlots().catch((err) => {
        console.error("[Store] Failed to stop all slots:", err);
      });

      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots) =>
          trackSlots.map((slot) => ({ ...slot, isPlaying: false, isQueued: false })),
        );
        return { clipLauncher: { ...s.clipLauncher, slots } };
      });
    },

    setSlotClip: (trackIndex, slotIndex, filePath, name, duration) => {
      nativeBridge.setSlotClip(trackIndex, slotIndex, filePath, duration).catch((err) => {
        console.error("[Store] Failed to set slot clip:", err);
      });

      set((s) => {
        // Ensure the slots array is large enough
        const numTracks = Math.max(s.clipLauncher.numTracks, trackIndex + 1);
        const numSlots = Math.max(s.clipLauncher.numSlots, slotIndex + 1);
        const slots = Array.from({ length: numTracks }, (_, ti) =>
          Array.from({ length: numSlots }, (_, si) => {
            const existing = s.clipLauncher.slots[ti]?.[si] || {};
            if (ti === trackIndex && si === slotIndex) {
              return { ...existing, filePath, name, duration, isPlaying: false, isQueued: false };
            }
            return existing;
          }),
        );
        return {
          clipLauncher: { ...s.clipLauncher, slots, numTracks, numSlots },
          isModified: true,
        };
      });
    },

    clearSlot: (trackIndex, slotIndex) => {
      nativeBridge.clearSlot(trackIndex, slotIndex).catch((err) => {
        console.error("[Store] Failed to clear slot:", err);
      });

      set((s) => {
        const slots = s.clipLauncher.slots.map((trackSlots, ti) =>
          trackSlots.map((slot, si) =>
            ti === trackIndex && si === slotIndex
              ? { isPlaying: false, isQueued: false }
              : slot,
          ),
        );
        return { clipLauncher: { ...s.clipLauncher, slots }, isModified: true };
      });
    },

    setClipLauncherQuantize: (quantize) => {
      set((s) => ({
        clipLauncher: { ...s.clipLauncher, quantize },
      }));
    },

    toggleClipLauncher: () =>
      set((s) => ({ showClipLauncher: !s.showClipLauncher })),

    toggleTimecodeSettings: () =>
      set((s) => ({ showTimecodeSettings: !s.showTimecodeSettings })),

    // Missing Media Resolver
    resolveMissingMedia: (originalPath: string, newPath: string) => {
      // Update all clips that reference the original path
      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.filePath === originalPath ? { ...clip, filePath: newPath } : clip,
          ),
        })),
        isModified: true,
      }));
    },
    closeMissingMedia: () => set({ showMissingMedia: false, missingMediaFiles: [] }),

    // Sprint 17: Visual Improvements
    addRecentColor: (color) => {
      set((s) => {
        const filtered = s.recentColors.filter((c) => c !== color);
        return { recentColors: [color, ...filtered].slice(0, 8) };
      });
    },

    // Sprint 18: Interaction/Workflow
    toggleAutoScroll: () =>
      set((s) => ({ autoScrollDuringPlayback: !s.autoScrollDuringPlayback })),

    zoomToSelection: () => {
      const { timeSelection } = get();
      if (!timeSelection) return;
      const duration = timeSelection.end - timeSelection.start;
      if (duration <= 0) return;
      // Fit selection into ~80% of viewport
      const viewportWidth = document.querySelector("[data-workspace]")?.clientWidth ?? 800;
      const newPps = (viewportWidth * 0.8) / duration;
      set({
        pixelsPerSecond: Math.max(1, Math.min(1000, newPps)),
        scrollX: Math.max(0, timeSelection.start * newPps - viewportWidth * 0.1),
      });
    },

    toggleDrumEditor: () =>
      set((s) => ({ showDrumEditor: !s.showDrumEditor })),

    selectAllMIDINotes: () => {
      const { pianoRollClipId, tracks } = get();
      if (!pianoRollClipId) return;
      const clip = tracks.flatMap((t) => t.clips).find((c) => c.id === pianoRollClipId);
      if (!(clip as any).notes) return;
      const midiClip = clip as any;
      if (midiClip.notes) {
        set({ selectedNoteIds: midiClip.notes.map((n: any) => n.id) });
      }
    },

    updateMIDINotes: (clipId: string, notes: any[]) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, notes } : c,
          ),
        })),
        isModified: true,
      }));
    },

    updateMIDINoteVelocity: (trackId, clipId, noteTimestamp, noteNumber, velocity) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const noteOnIdx = clip.events.findIndex((e) => e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001);
      if (noteOnIdx === -1) return;
      const oldVelocity = clip.events[noteOnIdx].velocity || 80;
      const clampedVelocity = Math.max(1, Math.min(127, Math.round(velocity)));
      const applyVel = (s: any, vel: number) => ({ tracks: s.tracks.map((t: any) => t.id === trackId ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, events: c.events.map((e: any) => e.type === "noteOn" && e.note === noteNumber && Math.abs(e.timestamp - noteTimestamp) < 0.001 ? { ...e, velocity: vel } : e) } : c) } : t) });
      set((s) => ({ ...applyVel(s, clampedVelocity), isModified: true }));
      commandManager.push({ type: "midi_velocity", description: `Set velocity to ${clampedVelocity}`, timestamp: Date.now(), execute: () => { set((s) => applyVel(s, clampedVelocity)); }, undo: () => { set((s) => applyVel(s, oldVelocity)); } });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateMIDICCEvents: (trackId, clipId, newCCEvents) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      const clip = track.midiClips.find((c) => c.id === clipId);
      if (!clip) return;
      const oldCCEvents = clip.ccEvents ? [...clip.ccEvents] : [];
      const applyCc = (s: any, evts: MIDICCEvent[]) => ({ tracks: s.tracks.map((t: any) => t.id === trackId ? { ...t, midiClips: t.midiClips.map((c: any) => c.id === clipId ? { ...c, ccEvents: evts } : c) } : t) });
      set((s) => ({ ...applyCc(s, newCCEvents), isModified: true }));
      commandManager.push({ type: "midi_cc", description: "Update MIDI CC events", timestamp: Date.now(), execute: () => { set((s) => applyCc(s, newCCEvents)); }, undo: () => { set((s) => applyCc(s, oldCCEvents)); } });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setPianoRollScaleRoot: (root) => set({ pianoRollScaleRoot: root }),
    setPianoRollScaleType: (scaleType) => set({ pianoRollScaleType: scaleType }),

});
