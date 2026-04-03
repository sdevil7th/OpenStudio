// @ts-nocheck
/**
 * Clip Editing actions — split, move, resize, paste, duplicate, normalize,
 * group, reverse, playback rate, strip silence, time selection operations.
 * Extracted from useDAWStore.ts for modularity.
 * Types are enforced at the store spread site (useDAWStore.ts), not here.
 */

import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { calculateGridInterval, type GridSize } from "../../utils/snapToGrid";
import { logBridgeError } from "../../utils/bridgeErrorHandler";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const clipEditingActions = (set: SetFn, get: GetFn) => ({
    splitClipAtPlayhead: () => {
      const state = get();
      const playhead = state.transport.currentTime;

      // Collect clips to split: selected clips, or all clips under playhead if none selected
      const clipsToSplit: Array<{ clip: AudioClip; trackId: string }> = [];

      if (state.selectedClipIds.length > 0) {
        // Split selected clips
        for (const track of state.tracks) {
          for (const clip of track.clips) {
            if (state.selectedClipIds.includes(clip.id)) {
              const clipEnd = clip.startTime + clip.duration;
              if (playhead > clip.startTime && playhead < clipEnd) {
                clipsToSplit.push({ clip, trackId: track.id });
              }
            }
          }
        }
      } else {
        // No clips selected — split all clips under playhead
        for (const track of state.tracks) {
          for (const clip of track.clips) {
            const clipEnd = clip.startTime + clip.duration;
            if (playhead > clip.startTime && playhead < clipEnd) {
              clipsToSplit.push({ clip, trackId: track.id });
            }
          }
        }
      }

      if (clipsToSplit.length === 0) return;

      // Build left/right clips for each split
      const splitData = clipsToSplit.map(({ clip, trackId }) => {
        const leftId = crypto.randomUUID();
        const rightId = crypto.randomUUID();
        const leftDuration = playhead - clip.startTime;
        const rightDuration = clip.duration - leftDuration;

        const leftClip: AudioClip = {
          ...clip,
          id: leftId,
          duration: leftDuration,
          fadeOut: 0, // Remove fade out from left clip (split point)
        };

        const rightClip: AudioClip = {
          ...clip,
          id: rightId,
          startTime: playhead,
          duration: rightDuration,
          offset: clip.offset + leftDuration,
          fadeIn: 0, // Remove fade in from right clip (split point)
        };

        return { originalClip: clip, trackId, leftClip, rightClip };
      });

      const command: Command = {
        type: "SPLIT_CLIP",
        description: `Split ${splitData.length} clip${splitData.length > 1 ? "s" : ""} at cursor`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              const splitsForTrack = splitData.filter((sd) => sd.trackId === track.id);
              if (splitsForTrack.length === 0) return track;

              const originalIds = new Set(splitsForTrack.map((sd) => sd.originalClip.id));
              const newClips = track.clips.filter((c) => !originalIds.has(c.id));
              for (const sd of splitsForTrack) {
                newClips.push(sd.leftClip, sd.rightClip);
              }
              return { ...track, clips: newClips };
            }),
            // Select the right-side clips after split
            selectedClipIds: splitData.map((sd) => sd.rightClip.id),
            selectedClipId: splitData.length > 0 ? splitData[0].rightClip.id : null,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              const splitsForTrack = splitData.filter((sd) => sd.trackId === track.id);
              if (splitsForTrack.length === 0) return track;

              const splitIds = new Set(
                splitsForTrack.flatMap((sd) => [sd.leftClip.id, sd.rightClip.id])
              );
              const newClips = track.clips.filter((c) => !splitIds.has(c.id));
              for (const sd of splitsForTrack) {
                newClips.push(sd.originalClip);
              }
              return { ...track, clips: newClips };
            }),
            selectedClipIds: clipsToSplit.map((c) => c.clip.id),
            selectedClipId: clipsToSplit.length > 0 ? clipsToSplit[0].clip.id : null,
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
        isModified: true,
      });
    },

    splitClipAtPosition: (clipId, splitTime) => {
      const state = get();

      // Find the clip and its track
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          foundClip = clip;
          foundTrackId = track.id;
          break;
        }
      }
      if (!foundClip || !foundTrackId) return;

      const clip = foundClip;
      const trackId = foundTrackId;
      const clipEnd = clip.startTime + clip.duration;

      // Split must be strictly inside the clip
      if (splitTime <= clip.startTime || splitTime >= clipEnd) return;

      const leftId = crypto.randomUUID();
      const rightId = crypto.randomUUID();
      const leftDuration = splitTime - clip.startTime;
      const rightDuration = clip.duration - leftDuration;

      const leftClip: AudioClip = {
        ...clip,
        id: leftId,
        duration: leftDuration,
        fadeOut: 0,
      };

      const rightClip: AudioClip = {
        ...clip,
        id: rightId,
        startTime: splitTime,
        duration: rightDuration,
        offset: clip.offset + leftDuration,
        fadeIn: 0,
      };

      const command: Command = {
        type: "SPLIT_CLIP",
        description: "Split clip at position",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id !== trackId) return track;
              return {
                ...track,
                clips: [
                  ...track.clips.filter((c) => c.id !== clip.id),
                  leftClip,
                  rightClip,
                ],
              };
            }),
            selectedClipIds: [rightClip.id],
            selectedClipId: rightClip.id,
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id !== trackId) return track;
              return {
                ...track,
                clips: [
                  ...track.clips.filter((c) => c.id !== leftId && c.id !== rightId),
                  clip,
                ],
              };
            }),
            selectedClipIds: [clip.id],
            selectedClipId: clip.id,
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
        isModified: true,
      });
    },

    splitMIDIClipAtPosition: (clipId, splitTime) => {
      const state = get();
      let foundClip: MIDIClip | null = null;
      let foundTrackId: string | null = null;
      for (const track of state.tracks) {
        const clip = track.midiClips.find((c) => c.id === clipId);
        if (clip) { foundClip = clip; foundTrackId = track.id; break; }
      }
      if (!foundClip || !foundTrackId) return;
      const clip = foundClip;
      const trackId = foundTrackId;
      const clipEnd = clip.startTime + clip.duration;
      if (splitTime <= clip.startTime || splitTime >= clipEnd) return;

      const splitOffset = splitTime - clip.startTime; // seconds into clip
      const leftId = crypto.randomUUID();
      const rightId = crypto.randomUUID();

      const leftClip: MIDIClip = {
        ...clip,
        id: leftId,
        duration: splitOffset,
        events: clip.events.filter((e) => e.timestamp < splitOffset),
        ccEvents: clip.ccEvents?.filter((e) => e.timestamp < splitOffset),
      };
      const rightClip: MIDIClip = {
        ...clip,
        id: rightId,
        startTime: splitTime,
        duration: clip.duration - splitOffset,
        // Shift event timestamps relative to new clip start
        events: clip.events
          .filter((e) => e.timestamp >= splitOffset)
          .map((e) => ({ ...e, timestamp: e.timestamp - splitOffset })),
        ccEvents: clip.ccEvents
          ?.filter((e) => e.timestamp >= splitOffset)
          .map((e) => ({ ...e, timestamp: e.timestamp - splitOffset })),
      };

      const newTracks = state.tracks.map((track) => {
        if (track.id !== trackId) return track;
        return {
          ...track,
          midiClips: [
            ...track.midiClips.filter((c) => c.id !== clip.id),
            leftClip,
            rightClip,
          ],
        };
      });

      commandManager.push({
        type: "SPLIT_MIDI_CLIP",
        description: "Split MIDI clip",
        timestamp: Date.now(),
        execute: () => {
          set({ tracks: newTracks, selectedClipIds: [rightId], selectedClipId: rightId, isModified: true });
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              if (t.id !== trackId) return t;
              return {
                ...t,
                midiClips: [...t.midiClips.filter((c) => c.id !== leftId && c.id !== rightId), clip],
              };
            }),
            selectedClipIds: [clip.id],
            selectedClipId: clip.id,
            isModified: true,
          }));
        },
      });
      set({ tracks: newTracks, selectedClipIds: [rightId], selectedClipId: rightId,
        canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo(), isModified: true });
    },

    selectClip: (clipId, modifiers) => {
      // Clear track selection when selecting a clip to avoid delete conflicts
      if (clipId === null) {
        set({ selectedClipId: null, selectedClipIds: [] });
        return;
      }

      const { ctrl } = modifiers || {};
      const state = get();

      if (ctrl) {
        // Toggle: add or remove from multi-selection
        const isSelected = state.selectedClipIds.includes(clipId);
        if (isSelected) {
          const newIds = state.selectedClipIds.filter((id) => id !== clipId);
          set({
            selectedClipIds: newIds,
            selectedClipId: newIds.length > 0 ? newIds[newIds.length - 1] : null,
          });
        } else {
          set({
            selectedClipIds: [...state.selectedClipIds, clipId],
            selectedClipId: clipId,
            selectedTrackIds: [],
            lastSelectedTrackId: null,
          });
        }
      } else {
        // Single selection — also select grouped clips
        const clickedClip = state.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
        let ids = [clipId];
        if (clickedClip?.groupId) {
          ids = state.tracks
            .flatMap((t) => t.clips)
            .filter((c) => c.groupId === clickedClip.groupId)
            .map((c) => c.id);
        }
        set({
          selectedClipId: clipId,
          selectedClipIds: ids,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
        });
      }
    },

    selectAllClips: () => {
      const state = get();
      const allClipIds = state.tracks.flatMap((t) => t.clips.map((c) => c.id));
      set({
        selectedClipIds: allClipIds,
        selectedClipId: allClipIds.length > 0 ? allClipIds[0] : null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    setSelectedClipIds: (clipIds: string[]) => {
      set({
        selectedClipIds: clipIds,
        selectedClipId: clipIds.length > 0 ? clipIds[clipIds.length - 1] : null,
      });
    },

    moveClipToTrack: async (clipId, newTrackId, newStartTime) => {
      const state = get();

      // Find the clip and its current track
      let clipToMove: AudioClip | null = null;
      let sourceTrackId: string | null = null;

      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          clipToMove = clip;
          sourceTrackId = track.id;
        }
      });

      if (!clipToMove || !sourceTrackId) return;

      // Get target track color for color inheritance
      const targetTrack = state.tracks.find((t) => t.id === newTrackId);
      const targetColor = targetTrack?.color;

      // Update frontend state only - backend sync happens via syncClipsWithBackend()
      // at drag end or when play() is called. This avoids race conditions from
      // rapid async remove/add calls during drag moves.
      if (sourceTrackId === newTrackId) {
        // Moving within the same track - just update startTime
        set((state) => ({
          tracks: state.tracks.map((track) => {
            if (track.id === sourceTrackId) {
              return {
                ...track,
                clips: track.clips.map((c) =>
                  c.id === clipId ? { ...c, startTime: newStartTime } : c,
                ),
              };
            }
            return track;
          }),
        }));
      } else {
        // Moving to a different track - inherit target track's color
        const updatedClip = {
          ...(clipToMove as AudioClip),
          startTime: newStartTime,
          color: targetColor || (clipToMove as AudioClip).color,
        };

        set((state) => ({
          tracks: state.tracks.map((track) => {
            if (track.id === sourceTrackId) {
              return {
                ...track,
                clips: track.clips.filter((c) => c.id !== clipId),
              };
            } else if (track.id === newTrackId) {
              return { ...track, clips: [...track.clips, updatedClip] };
            }
            return track;
          }),
        }));
      }

      // Apply auto-crossfades on affected track(s)
      if (get().autoCrossfade) {
        get().applyAutoCrossfades(newTrackId);
        if (sourceTrackId !== newTrackId) {
          get().applyAutoCrossfades(sourceTrackId);
        }
      }
    },

    resizeClip: (clipId, newStartTime, newDuration, newOffset) => {
      const state = get();

      // Find old clip values
      let oldValues: {
        startTime: number;
        duration: number;
        offset: number;
      } | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldValues = {
            startTime: clip.startTime,
            duration: clip.duration,
            offset: clip.offset,
          };
          break;
        }
      }

      if (!oldValues) return;

      const command: Command = {
        type: "RESIZE_CLIP",
        description: "Resize clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId
                  ? {
                      ...clip,
                      startTime: newStartTime,
                      duration: newDuration,
                      offset: newOffset,
                    }
                  : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    toggleClipMute: (clipId) => {
      let oldMuted = false;
      for (const track of get().tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { oldMuted = !!clip.muted; break; }
      }

      const command: Command = {
        type: "TOGGLE_CLIP_MUTE",
        description: oldMuted ? "Unmute clip" : "Mute clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: !oldMuted } : clip,
              ),
            })),
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: oldMuted } : clip,
              ),
            })),
            isModified: true,
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setClipVolume: (clipId, volumeDB) => {
      set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, volumeDB } : clip,
          ),
        })),
      }));
    },

    setClipFades: (clipId, fadeIn, fadeOut) => {
      const state = get();

      // Find old fade values
      let oldValues: { fadeIn: number; fadeOut: number } | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldValues = { fadeIn: clip.fadeIn, fadeOut: clip.fadeOut };
          break;
        }
      }

      if (!oldValues) return;

      const command: Command = {
        type: "SET_CLIP_FADES",
        description: "Adjust clip fades",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, fadeIn, fadeOut } : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, ...oldValues } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    addClipGainPoint: (clipId, time, gain) => {
      const state = get();
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      const clampedGain = Math.max(0, Math.min(2, gain));
      const newPoint = { time, gain: clampedGain };

      const command: Command = {
        type: "ADD_CLIP_GAIN_POINT",
        description: "Add clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope, newPoint] : [newPoint];
                envelope.sort((a, b) => a.time - b.time);
                return { ...clip, gainEnvelope: envelope };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    removeClipGainPoint: (clipId, pointIndex) => {
      const state = get();
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      if (!oldEnvelope || pointIndex < 0 || pointIndex >= oldEnvelope.length) return;

      const command: Command = {
        type: "REMOVE_CLIP_GAIN_POINT",
        description: "Remove clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope] : [];
                envelope.splice(pointIndex, 1);
                return { ...clip, gainEnvelope: envelope.length > 0 ? envelope : undefined };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    moveClipGainPoint: (clipId, pointIndex, time, gain) => {
      const state = get();
      let oldEnvelope: Array<{ time: number; gain: number }> | undefined;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldEnvelope = clip.gainEnvelope ? [...clip.gainEnvelope] : undefined;
          break;
        }
      }

      if (!oldEnvelope || pointIndex < 0 || pointIndex >= oldEnvelope.length) return;

      const clampedGain = Math.max(0, Math.min(2, gain));

      const command: Command = {
        type: "MOVE_CLIP_GAIN_POINT",
        description: "Move clip gain point",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                const envelope = clip.gainEnvelope ? [...clip.gainEnvelope] : [];
                if (pointIndex < envelope.length) {
                  envelope[pointIndex] = { time, gain: clampedGain };
                  envelope.sort((a, b) => a.time - b.time);
                }
                return { ...clip, gainEnvelope: envelope };
              }),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, gainEnvelope: oldEnvelope } : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    copyClip: (clipId) => {
      const state = get();
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { foundClip = clip; foundTrackId = track.id; }
      });

      if (foundClip && foundTrackId) {
        set({ clipboard: { clip: foundClip, clips: [{ clip: foundClip, trackId: foundTrackId }], isCut: false } });
      }
    },

    cutClip: (clipId) => {
      const state = get();
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      state.tracks.forEach((track) => {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { foundClip = clip; foundTrackId = track.id; }
      });

      if (foundClip && foundTrackId) {
        set({ clipboard: { clip: foundClip, clips: [{ clip: foundClip, trackId: foundTrackId }], isCut: true } });
      }
    },

    copySelectedClips: () => {
      const state = get();
      const clipEntries: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length > 0) {
        set({ clipboard: { clip: clipEntries[0].clip, clips: clipEntries, isCut: false } });
      }
    },

    cutSelectedClips: () => {
      const state = get();
      const clipEntries: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipEntries.push({ clip, trackId: track.id });
          }
        }
      }
      if (clipEntries.length > 0) {
        set({ clipboard: { clip: clipEntries[0].clip, clips: clipEntries, isCut: true } });
      }
    },

    pasteClip: (targetTrackId, targetTime) => {
      const state = get();
      const { clipboard } = state;
      if (!clipboard.clip) return;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldClipboard = clipboard;

      const newClip: AudioClip = {
        ...clipboard.clip,
        id: crypto.randomUUID(),
        startTime: targetTime,
      };

      set((s) => {
        let newTracks = s.tracks;
        if (clipboard.isCut) {
          newTracks = s.tracks.map((t) => ({
            ...t,
            clips: t.clips.filter((c) => c.id !== clipboard.clip!.id),
          }));
        }

        return {
          tracks: newTracks.map((t) =>
            t.id === targetTrackId ? { ...t, clips: [...t.clips, newClip] } : t,
          ),
          clipboard: clipboard.isCut
            ? { clip: null, clips: [], isCut: false }
            : s.clipboard,
          isModified: true,
        };
      });

      const newTracks = get().tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const newClipboardState = get().clipboard;

      commandManager.push({
        type: "PASTE_CLIP",
        description: "Paste clip",
        timestamp: Date.now(),
        execute: () => set({ tracks: newTracks, clipboard: newClipboardState, isModified: true }),
        undo: () => set({ tracks: oldTracks, clipboard: oldClipboard, isModified: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    pasteClips: () => {
      const state = get();
      const { clipboard } = state;
      if (clipboard.clips.length === 0) return;

      // Snapshot for undo
      const oldTracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const oldClipboard = clipboard;

      const currentTime = state.transport.currentTime;
      const earliestTime = Math.min(...clipboard.clips.map((c) => c.clip.startTime));

      if (clipboard.clips.length === 1) {
        const targetTrackId =
          state.selectedTrackIds.length > 0
            ? state.selectedTrackIds[0]
            : state.tracks.length > 0
              ? state.tracks[0].id
              : null;
        if (!targetTrackId) return;

        const newClip: AudioClip = {
          ...clipboard.clips[0].clip,
          id: crypto.randomUUID(),
          startTime: currentTime,
        };

        set((s) => {
          let newTracks = s.tracks;
          if (clipboard.isCut) {
            const origId = clipboard.clips[0].clip.id;
            newTracks = s.tracks.map((t) => ({
              ...t,
              clips: t.clips.filter((c) => c.id !== origId),
            }));
          }
          return {
            tracks: newTracks.map((t) =>
              t.id === targetTrackId ? { ...t, clips: [...t.clips, newClip] } : t,
            ),
            clipboard: clipboard.isCut ? { clip: null, clips: [], isCut: false } : s.clipboard,
            isModified: true,
          };
        });
      } else {
        const trackOrder = state.tracks.map((t) => t.id);
        const sourceTrackIndices = [...new Set(clipboard.clips.map((c) => c.trackId))];
        sourceTrackIndices.sort((a, b) => trackOrder.indexOf(a) - trackOrder.indexOf(b));

        const targetTrackIds: string[] = [];
        const newTracks: Array<{ id: string; name: string; color: string }> = [];

        if (state.selectedTrackIds.length >= sourceTrackIndices.length) {
          for (let i = 0; i < sourceTrackIndices.length; i++) {
            targetTrackIds.push(state.selectedTrackIds[i]);
          }
        } else {
          for (const srcTrackId of sourceTrackIndices) {
            const existingTrack = state.tracks.find((t) => t.id === srcTrackId);
            if (existingTrack) {
              targetTrackIds.push(srcTrackId);
            } else {
              const newId = crypto.randomUUID();
              newTracks.push({ id: newId, name: `Track ${state.tracks.length + newTracks.length + 1}`, color: "#3b82f6" });
              targetTrackIds.push(newId);
            }
          }
        }

        const trackMap = new Map<string, string>();
        sourceTrackIndices.forEach((srcId, i) => {
          trackMap.set(srcId, targetTrackIds[i]);
        });

        const newClips = clipboard.clips.map((entry) => ({
          clip: {
            ...entry.clip,
            id: crypto.randomUUID(),
            startTime: currentTime + (entry.clip.startTime - earliestTime),
          },
          targetTrackId: trackMap.get(entry.trackId) || targetTrackIds[0],
        }));

        set((s) => {
          let tracks = s.tracks;

          if (clipboard.isCut) {
            const origIds = new Set(clipboard.clips.map((c) => c.clip.id));
            tracks = tracks.map((t) => ({
              ...t,
              clips: t.clips.filter((c) => !origIds.has(c.id)),
            }));
          }

          const clipsByTrack = new Map<string, AudioClip[]>();
          for (const { clip, targetTrackId } of newClips) {
            if (!clipsByTrack.has(targetTrackId)) clipsByTrack.set(targetTrackId, []);
            clipsByTrack.get(targetTrackId)!.push(clip);
          }

          tracks = tracks.map((t) => {
            const addClips = clipsByTrack.get(t.id);
            return addClips ? { ...t, clips: [...t.clips, ...addClips] } : t;
          });

          return {
            tracks,
            clipboard: clipboard.isCut ? { clip: null, clips: [], isCut: false } : s.clipboard,
            isModified: true,
          };
        });

        for (const newTrack of newTracks) {
          get().addTrack(newTrack);
        }
      }

      // Undo tracking (captures full state after paste)
      const afterState = get();
      const newTracksSnapshot = afterState.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const newClipboardSnapshot = afterState.clipboard;

      commandManager.push({
        type: "PASTE_CLIPS",
        description: "Paste clips",
        timestamp: Date.now(),
        execute: () => set({ tracks: newTracksSnapshot, clipboard: newClipboardSnapshot, isModified: true }),
        undo: () => set({ tracks: oldTracks, clipboard: oldClipboard, isModified: true }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    nudgeClips: (direction, fine) => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      const amount = fine
        ? 0.01 // 10ms fine nudge
        : calculateGridInterval(state.transport.tempo, state.timeSignature, state.gridSize);
      const delta = direction === "right" ? amount : -amount;

      // Capture old positions for undo
      const clipPositions = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            clipPositions.set(clip.id, clip.startTime);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, startTime: Math.max(0, clip.startTime + delta) }
              : clip,
          ),
        })),
        isModified: true,
      }));

      const command: Command = {
        type: "NUDGE_CLIPS",
        description: `Nudge clips ${direction}`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clipPositions.has(clip.id)
                  ? { ...clip, startTime: Math.max(0, clipPositions.get(clip.id)! + delta) }
                  : clip,
              ),
            })),
            isModified: true,
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clipPositions.has(clip.id)
                  ? { ...clip, startTime: clipPositions.get(clip.id)! }
                  : clip,
              ),
            })),
            isModified: true,
          }));
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    deleteClip: (clipId) => {
      const state = get();

      // Check if clip is locked
      const lockedClip = state.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      if (lockedClip?.locked) return;

      // Find the clip and its track
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;
      let clipIndex = 0;

      for (const track of state.tracks) {
        const idx = track.clips.findIndex((c) => c.id === clipId);
        if (idx !== -1) {
          foundClip = track.clips[idx];
          foundTrackId = track.id;
          clipIndex = idx;
          break;
        }
      }

      if (!foundClip || !foundTrackId) return;

      // Capture values for ripple editing and backend sync
      const clipFilePath = foundClip.filePath;
      const trackIdForBackend = foundTrackId;
      const rippleMode = state.rippleMode;
      const deletedDuration = foundClip.duration;
      const deletedEnd = foundClip.startTime + deletedDuration;

      // Create and execute command
      const command: Command = {
        type: "DELETE_CLIP",
        description: `Delete clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Remove from frontend state + apply ripple shift
          set((s) => ({
            tracks: s.tracks.map((track) => {
              let clips = track.clips.filter((c) => c.id !== clipId);

              // Ripple: shift downstream clips left by the deleted clip's duration
              if (rippleMode === "per_track" && track.id === foundTrackId) {
                clips = clips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
              } else if (rippleMode === "all_tracks") {
                clips = clips.map((c) =>
                  c.startTime >= deletedEnd
                    ? { ...c, startTime: Math.max(0, c.startTime - deletedDuration) }
                    : c,
                );
              }

              return { ...track, clips };
            }),
            selectedClipId:
              s.selectedClipId === clipId ? null : s.selectedClipId,
            selectedClipIds: s.selectedClipIds.filter((id) => id !== clipId),
          }));

          // Sync with backend - remove from playback engine
          if (clipFilePath) {
            try {
              await nativeBridge.removePlaybackClip(trackIdForBackend, clipFilePath);
              console.log(`[DAW] Clip deleted and removed from backend: ${clipFilePath}`);
            } catch (error) {
              console.error("[DAW] Failed to remove clip from backend:", error);
            }
          }
        },
        undo: async () => {
          // Restore to frontend state + reverse ripple shift
          set((s) => ({
            tracks: s.tracks.map((track) => {
              if (track.id === foundTrackId) {
                // Reverse ripple shift on this track
                let clips = [...track.clips];
                if (rippleMode !== "off") {
                  clips = clips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  );
                }
                clips.splice(clipIndex, 0, foundClip!);
                return { ...track, clips };
              }
              if (rippleMode === "all_tracks") {
                // Reverse ripple on other tracks too
                return {
                  ...track,
                  clips: track.clips.map((c) =>
                    c.startTime >= deletedEnd - deletedDuration
                      ? { ...c, startTime: c.startTime + deletedDuration }
                      : c,
                  ),
                };
              }
              return track;
            }),
          }));

          // Re-add to backend
          if (clipFilePath && foundClip) {
            try {
              await nativeBridge.addPlaybackClip(
                trackIdForBackend,
                clipFilePath,
                foundClip.startTime,
                foundClip.duration,
                foundClip.offset || 0,
                foundClip.volumeDB || 0,
                foundClip.fadeIn || 0,
                foundClip.fadeOut || 0,
                foundClip.id,
                foundClip.pitchCorrectionSourceFilePath,
                foundClip.pitchCorrectionSourceOffset,
              );
              console.log(`[DAW] Clip restored to backend: ${clipFilePath}`);
            } catch (error) {
              console.error("[DAW] Failed to restore clip to backend:", error);
            }
          }
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    duplicateClip: (clipId) => {
      const state = get();

      // Find the clip and its track
      let foundClip: AudioClip | null = null;
      let foundTrackId: string | null = null;

      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          foundClip = clip;
          foundTrackId = track.id;
          break;
        }
      }

      if (!foundClip || !foundTrackId) return;

      // Create new clip ID upfront so we can track it for undo
      const newClipId = crypto.randomUUID();
      const newClip: AudioClip = {
        ...foundClip,
        id: newClipId,
        startTime: foundClip.startTime + foundClip.duration,
      };

      const command: Command = {
        type: "DUPLICATE_CLIP",
        description: `Duplicate clip "${foundClip.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) =>
              track.id === foundTrackId
                ? { ...track, clips: [...track.clips, newClip] }
                : track,
            ),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.filter((c) => c.id !== newClipId),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    // ========== Advanced Clip Editing ==========
    splitAtTimeSelection: () => {
      const state = get();
      const { timeSelection } = state;
      if (!timeSelection) return;

      const splitTimes = [timeSelection.start, timeSelection.end];
      const newClipEntries: Array<{ trackId: string; clips: AudioClip[] }> = [];

      for (const track of state.tracks) {
        const clipsToRemove: string[] = [];
        const clipsToAdd: AudioClip[] = [];

        for (const clip of track.clips) {
          let currentClip = clip;
          let wasSplit = false;

          for (const splitTime of splitTimes) {
            if (splitTime > currentClip.startTime && splitTime < currentClip.startTime + currentClip.duration) {
              if (!wasSplit) {
                clipsToRemove.push(clip.id);
                wasSplit = true;
              }
              const leftDuration = splitTime - currentClip.startTime;
              const leftClip: AudioClip = {
                ...currentClip,
                id: crypto.randomUUID(),
                duration: leftDuration,
                fadeOut: 0,
              };
              clipsToAdd.push(leftClip);

              currentClip = {
                ...currentClip,
                id: crypto.randomUUID(),
                startTime: splitTime,
                duration: currentClip.startTime + currentClip.duration - splitTime,
                offset: currentClip.offset + leftDuration,
                fadeIn: 0,
              };
            }
          }
          if (wasSplit) {
            clipsToAdd.push(currentClip);
          }
        }

        if (clipsToRemove.length > 0) {
          newClipEntries.push({ trackId: track.id, clips: clipsToAdd });
        }
      }

      if (newClipEntries.length === 0) return;

      set((s) => ({
        tracks: s.tracks.map((track) => {
          const entry = newClipEntries.find((e) => e.trackId === track.id);
          if (!entry) return track;
          const removeIds = new Set(
            track.clips
              .filter((c) => {
                const clipEnd = c.startTime + c.duration;
                return (
                  (timeSelection.start > c.startTime && timeSelection.start < clipEnd) ||
                  (timeSelection.end > c.startTime && timeSelection.end < clipEnd)
                );
              })
              .map((c) => c.id),
          );
          return {
            ...track,
            clips: [...track.clips.filter((c) => !removeIds.has(c.id)), ...entry.clips],
          };
        }),
        isModified: true,
      }));
    },

    groupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length < 2) return;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }

      const groupId = crypto.randomUUID();
      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, groupId }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "GROUP_CLIPS",
        description: "Group selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldGroupIds.has(c.id) ? { ...c, groupId } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldGroupIds.get(c.id);
              return old !== undefined || oldGroupIds.has(c.id) ? { ...c, groupId: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    ungroupSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      // Capture old groupIds for undo
      const oldGroupIds = new Map<string, string | undefined>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldGroupIds.set(clip.id, clip.groupId);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, groupId: undefined }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "UNGROUP_CLIPS",
        description: "Ungroup selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldGroupIds.has(c.id) ? { ...c, groupId: undefined } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldGroupIds.get(c.id);
              return old !== undefined || oldGroupIds.has(c.id) ? { ...c, groupId: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    normalizeSelectedClips: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      // Capture old volumes for undo
      const oldVolumes = new Map<string, number>();
      for (const track of state.tracks) {
        for (const clip of track.clips) {
          if (state.selectedClipIds.includes(clip.id)) {
            oldVolumes.set(clip.id, clip.volumeDB ?? 0);
          }
        }
      }

      set((s) => ({
        tracks: s.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            s.selectedClipIds.includes(clip.id)
              ? { ...clip, volumeDB: 0 }
              : clip,
          ),
        })),
        isModified: true,
      }));

      commandManager.push({
        type: "NORMALIZE_CLIPS",
        description: "Normalize selected clips",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => oldVolumes.has(c.id) ? { ...c, volumeDB: 0 } : c),
          })),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const old = oldVolumes.get(c.id);
              return old !== undefined ? { ...c, volumeDB: old } : c;
            }),
          })),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },


});

// ========== Quantize Clips (appended) ==========
