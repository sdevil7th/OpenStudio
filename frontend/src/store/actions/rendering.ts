// @ts-nocheck
import { applyTheme } from "../useDAWStore";
import { usePitchEditorStore } from "../pitchEditorStore";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

/**
 * Render pipeline, engine enhancements, send/bus routing.
 * Extracted from useDAWStore.ts.
 */
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";

export const renderingActions = (set: SetFn, get: GetFn) => ({

    // 9A: Reverse Clip
    reverseClip: async (clipId: string) => {
      const state = get();
      let targetClip: AudioClip | null = null;
      let targetTrackId: string | null = null;

      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          targetClip = clip;
          targetTrackId = track.id;
          break;
        }
      }

      if (!targetClip || !targetTrackId || !targetClip.filePath) return;

      const oldFilePath = targetClip.filePath;
      const wasReversed = !!targetClip.reversed;

      const reversedPath = await nativeBridge.reverseAudioFile(targetClip.filePath);
      if (!reversedPath) return;

      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === targetTrackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? { ...c, filePath: reversedPath, reversed: !c.reversed }
                    : c
                ),
              }
            : t
        ),
        isModified: true,
      }));

      const capturedTrackId = targetTrackId;
      commandManager.push({
        type: "REVERSE_CLIP",
        description: "Reverse clip",
        timestamp: Date.now(),
        execute: () => set((s) => ({
          tracks: s.tracks.map((t) => t.id === capturedTrackId
            ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, filePath: reversedPath, reversed: !wasReversed } : c) }
            : t),
          isModified: true,
        })),
        undo: () => set((s) => ({
          tracks: s.tracks.map((t) => t.id === capturedTrackId
            ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, filePath: oldFilePath, reversed: wasReversed } : c) }
            : t),
          isModified: true,
        })),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // 9B: Dynamic Split
    openDynamicSplit: (clipId?: string) => {
      const id = clipId || get().selectedClipId;
      if (id) {
        set({ showDynamicSplit: true, dynamicSplitClipId: id });
      }
    },
    closeDynamicSplit: () =>
      set({ showDynamicSplit: false, dynamicSplitClipId: null }),

    executeDynamicSplit: (clipId: string, transientTimes: number[]) => {
      const state = get();
      let targetTrackId: string | null = null;
      let targetClip: AudioClip | null = null;

      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          targetClip = { ...clip };
          targetTrackId = track.id;
          break;
        }
      }

      if (!targetClip || !targetTrackId) return;

      // Convert transient times (relative to file start) to absolute timeline times
      const absoluteTimes = transientTimes
        .map((t) => targetClip!.startTime + t - targetClip!.offset)
        .filter((t) => t > targetClip!.startTime && t < targetClip!.startTime + targetClip!.duration)
        .sort((a, b) => a - b);

      if (absoluteTimes.length === 0) return;

      // Create split clips from the original clip at each transient point
      const newClips: AudioClip[] = [];
      let currentStart = targetClip.startTime;
      let currentOffset = targetClip.offset;

      for (const splitTime of absoluteTimes) {
        const duration = splitTime - currentStart;
        if (duration > 0.001) {
          newClips.push({
            ...targetClip,
            id: crypto.randomUUID(),
            startTime: currentStart,
            duration,
            offset: currentOffset,
            fadeIn: currentStart === targetClip.startTime ? targetClip.fadeIn : 0,
            fadeOut: 0,
          });
        }
        currentOffset += splitTime - currentStart;
        currentStart = splitTime;
      }

      // Final segment
      const finalDuration = (targetClip.startTime + targetClip.duration) - currentStart;
      if (finalDuration > 0.001) {
        newClips.push({
          ...targetClip,
          id: crypto.randomUUID(),
          startTime: currentStart,
          duration: finalDuration,
          offset: currentOffset,
          fadeIn: 0,
          fadeOut: targetClip.fadeOut,
        });
      }

      // Replace the original clip with the split clips
      const trackId = targetTrackId;
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: [
                  ...t.clips.filter((c) => c.id !== clipId),
                  ...newClips,
                ],
              }
            : t
        ),
        showDynamicSplit: false,
        dynamicSplitClipId: null,
      }));
    },

    // 9C: Custom Metronome Sounds
    setMetronomeClickSound: async (filePath: string) => {
      const success = await nativeBridge.setMetronomeClickSound(filePath);
      if (success) set({ metronomeClickPath: filePath });
      return success;
    },
    setMetronomeAccentSound: async (filePath: string) => {
      const success = await nativeBridge.setMetronomeAccentSound(filePath);
      if (success) set({ metronomeAccentPath: filePath });
      return success;
    },
    resetMetronomeSounds: async () => {
      const success = await nativeBridge.resetMetronomeSounds();
      if (success) set({ metronomeClickPath: "", metronomeAccentPath: "" });
      return success;
    },

    // 9E: Dither
    setDitherType: (type) => set({ ditherType: type }),

    // 9F: Resample Quality
    setResampleQuality: (quality) => set({ resampleQuality: quality }),

    // ========== Phase 11: Send/Bus Routing ==========
    addTrackSend: async (sourceTrackId, destTrackId) => {
      await nativeBridge.addTrackSend(sourceTrackId, destTrackId);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: [...t.sends, { destTrackId, level: 0.5, pan: 0, enabled: true, preFader: false, phaseInvert: false }] }
            : t
        ),
      }));
    },
    removeTrackSend: async (sourceTrackId, sendIndex) => {
      await nativeBridge.removeTrackSend(sourceTrackId, sendIndex);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.filter((_, i) => i !== sendIndex) }
            : t
        ),
      }));
    },
    setTrackSendLevel: async (sourceTrackId, sendIndex, level) => {
      await nativeBridge.setTrackSendLevel(sourceTrackId, sendIndex, level);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, level } : sd) }
            : t
        ),
      }));
    },
    setTrackSendPan: async (sourceTrackId, sendIndex, pan) => {
      await nativeBridge.setTrackSendPan(sourceTrackId, sendIndex, pan);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, pan } : sd) }
            : t
        ),
      }));
    },
    setTrackSendEnabled: async (sourceTrackId, sendIndex, enabled) => {
      await nativeBridge.setTrackSendEnabled(sourceTrackId, sendIndex, enabled);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, enabled } : sd) }
            : t
        ),
      }));
    },
    setTrackSendPreFader: async (sourceTrackId, sendIndex, preFader) => {
      await nativeBridge.setTrackSendPreFader(sourceTrackId, sendIndex, preFader);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, preFader } : sd) }
            : t
        ),
      }));
    },
    setTrackSendPhaseInvert: async (sourceTrackId, sendIndex, invert) => {
      await nativeBridge.setTrackSendPhaseInvert(sourceTrackId, sendIndex, invert);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === sourceTrackId
            ? { ...t, sends: t.sends.map((sd, i) => i === sendIndex ? { ...sd, phaseInvert: invert } : sd) }
            : t
        ),
      }));
    },
    setTrackPhaseInvert: async (trackId, invert) => {
      await nativeBridge.setTrackPhaseInvert(trackId, invert);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, phaseInverted: invert } : t),
      }));
    },
    setTrackStereoWidth: async (trackId, widthPercent) => {
      await nativeBridge.setTrackStereoWidth(trackId, widthPercent);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, stereoWidth: widthPercent } : t),
      }));
    },
    setTrackMasterSendEnabled: async (trackId, enabled) => {
      await nativeBridge.setTrackMasterSendEnabled(trackId, enabled);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, masterSendEnabled: enabled } : t),
      }));
    },
    setTrackOutputChannels: async (trackId, startChannel, numChannels) => {
      await nativeBridge.setTrackOutputChannels(trackId, startChannel, numChannels);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, outputStartChannel: startChannel, outputChannelCount: numChannels } : t),
      }));
    },
    setTrackPlaybackOffset: async (trackId, offsetMs) => {
      await nativeBridge.setTrackPlaybackOffset(trackId, offsetMs);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, playbackOffsetMs: offsetMs } : t),
      }));
    },
    setTrackChannelCount: async (trackId, numChannels) => {
      await nativeBridge.setTrackChannelCount(trackId, numChannels);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, trackChannelCount: numChannels } : t),
      }));
    },
    setTrackMIDIOutput: async (trackId, deviceName) => {
      await nativeBridge.setTrackMIDIOutput(trackId, deviceName);
      set((s) => ({
        tracks: s.tracks.map((t) => t.id === trackId ? { ...t, midiOutputDevice: deviceName } : t),
      }));
    },

    // Phase 11B: Routing Matrix
    toggleRoutingMatrix: () => set((s) => ({ showRoutingMatrix: !s.showRoutingMatrix })),

    // Phase 11C: Track Groups (VCA)
    addTrackGroup: (name, leadTrackId, memberTrackIds, linkedParams) => {
      set((s) => ({
        trackGroups: [...s.trackGroups, { id: crypto.randomUUID(), name, leadTrackId, memberTrackIds, linkedParams }],
      }));
    },
    removeTrackGroup: (groupId) => {
      set((s) => ({ trackGroups: s.trackGroups.filter((g) => g.id !== groupId) }));
    },
    updateTrackGroup: (groupId, updates) => {
      set((s) => ({
        trackGroups: s.trackGroups.map((g) => g.id === groupId ? { ...g, ...updates } : g),
      }));
    },

    // ========== Phase 10: Render Pipeline Expansion ==========
    selectRegion: (id, modifiers) => {
      set((s) => {
        if (modifiers?.ctrl) {
          const isSelected = s.selectedRegionIds.includes(id);
          return {
            selectedRegionIds: isSelected
              ? s.selectedRegionIds.filter((rid) => rid !== id)
              : [...s.selectedRegionIds, id],
          };
        }
        return { selectedRegionIds: [id] };
      });
    },
    deselectAllRegions: () => set({ selectedRegionIds: [] }),
    setRenderMetadata: (metadata) =>
      set((s) => ({ renderMetadata: { ...s.renderMetadata, ...metadata } })),
    setSecondaryOutputEnabled: (enabled) =>
      set({ secondaryOutputEnabled: enabled }),
    setSecondaryOutputFormat: (format) =>
      set({ secondaryOutputFormat: format }),
    setSecondaryOutputBitDepth: (bitDepth) =>
      set({ secondaryOutputBitDepth: bitDepth }),
    setOnlineRender: (enabled) => set({ onlineRender: enabled }),
    setAddToProjectAfterRender: (enabled) =>
      set({ addToProjectAfterRender: enabled }),
    // toggleRegionRenderMatrix → store/actions/uiState.ts

    // ===== Phase 12: Media & File Management =====
    // toggleMediaExplorer → store/actions/uiState.ts
    setMediaExplorerPath: (path) => set({ mediaExplorerPath: path }),
    addMediaExplorerRecentPath: (path) =>
      set((s) => {
        const recent = [path, ...s.mediaExplorerRecentPaths.filter((p) => p !== path)].slice(0, 10);
        return { mediaExplorerRecentPaths: recent };
      }),
    // toggleCleanProject, toggleBatchConverter → store/actions/uiState.ts
    exportProjectMIDI: async () => {
      const state = get();
      const midiTracks = state.tracks
        .filter((t) => (t.type === "midi" || t.type === "instrument") && t.midiClips.length > 0)
        .map((t) => ({
          name: t.name,
          clips: t.midiClips.map((c) => ({
            startTime: c.startTime,
            duration: c.duration,
            events: c.events,
          })),
        }));
      if (midiTracks.length === 0) return false;
      const filePath = await nativeBridge.showSaveDialog(undefined, "Export Project MIDI");
      if (!filePath) return false;
      return await nativeBridge.exportProjectMIDI(filePath, midiTracks);
    },
    consolidateTrack: async (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || track.clips.length === 0) return null;
      const earliest = Math.min(...track.clips.map((c) => c.startTime));
      const latest = Math.max(...track.clips.map((c) => c.startTime + c.duration));
      const fileName = `${track.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_consolidated.wav`;
      const filePath = await nativeBridge.showRenderSaveDialog(fileName, "wav");
      if (!filePath) return null;
      const success = await nativeBridge.renderProject({
        source: `stem:${trackId}`,
        startTime: earliest,
        endTime: latest,
        filePath,
        format: "wav",
        sampleRate: state.projectSampleRate || 44100,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: false,
        tailLength: 0,
      });
      if (success) {
        // Replace track clips with single consolidated clip
        const clipIds = track.clips.map((c) => c.id);
        clipIds.forEach((id) => state.deleteClip(id));
        state.addClip(trackId, {
          id: crypto.randomUUID(),
          filePath,
          name: `${track.name} (consolidated)`,
          startTime: earliest,
          duration: latest - earliest,
          offset: 0,
          color: track.color,
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
        });
        return filePath;
      }
      return null;
    },

    renderClipInPlace: async (clipId) => {
      const state = get();
      // Find the clip and its track
      let sourceClip: AudioClip | null = null;
      let sourceTrack: Track | null = null;
      let sourceTrackIndex = -1;
      for (let i = 0; i < state.tracks.length; i++) {
        const clip = state.tracks[i].clips.find((c) => c.id === clipId);
        if (clip) {
          sourceClip = clip;
          sourceTrack = state.tracks[i];
          sourceTrackIndex = i;
          break;
        }
      }
      if (!sourceClip || !sourceTrack) return;

      const startTime = sourceClip.startTime;
      const endTime = sourceClip.startTime + sourceClip.duration;
      const safeName = sourceClip.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = await nativeBridge.showRenderSaveDialog(`${safeName}_rendered.wav`, "wav");
      if (!filePath) return;

      const success = await nativeBridge.renderProject({
        source: `stem:${sourceTrack.id}`,
        startTime,
        endTime,
        filePath,
        format: "wav",
        sampleRate: state.projectSampleRate || 44100,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: true,
        tailLength: 1000,
      });
      if (!success) return;

      // Import rendered file for accurate duration
      const mediaInfo = await nativeBridge.importMediaFile(filePath);
      const renderedDuration = mediaInfo?.duration || (endTime - startTime);

      // Create new track below source
      const newTrackId = crypto.randomUUID();
      get().addTrack({ id: newTrackId, name: `${sourceTrack.name} (Rendered)`, type: "audio", color: sourceTrack.color });

      // Move new track to right below source track
      set((s) => {
        const tracks = [...s.tracks];
        const newIdx = tracks.findIndex((t) => t.id === newTrackId);
        if (newIdx !== -1) {
          const [moved] = tracks.splice(newIdx, 1);
          tracks.splice(sourceTrackIndex + 1, 0, moved);
        }
        return { tracks };
      });
      nativeBridge.reorderTrack(newTrackId, sourceTrackIndex + 1).catch(logBridgeError("sync"));

      // Add rendered clip to new track
      get().addClip(newTrackId, {
        id: crypto.randomUUID(),
        filePath,
        name: `${sourceClip.name} (Rendered)`,
        startTime,
        duration: renderedDuration,
        offset: 0,
        color: sourceTrack.color,
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: mediaInfo?.sampleRate,
        sourceLength: renderedDuration,
      });

      // Mute the original clip
      get().toggleClipMute(clipId);
    },

    renderTrackInPlace: async (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || track.clips.length === 0) return;

      const sourceTrackIndex = state.tracks.findIndex((t) => t.id === trackId);
      const earliest = Math.min(...track.clips.map((c) => c.startTime));
      const latest = Math.max(...track.clips.map((c) => c.startTime + c.duration));
      const safeName = track.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = await nativeBridge.showRenderSaveDialog(`${safeName}_rendered.wav`, "wav");
      if (!filePath) return;

      const success = await nativeBridge.renderProject({
        source: `stem:${trackId}`,
        startTime: earliest,
        endTime: latest,
        filePath,
        format: "wav",
        sampleRate: state.projectSampleRate || 44100,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: true,
        tailLength: 1000,
      });
      if (!success) return;

      const mediaInfo = await nativeBridge.importMediaFile(filePath);
      const renderedDuration = mediaInfo?.duration || (latest - earliest);

      // Create new track below source
      const newTrackId = crypto.randomUUID();
      get().addTrack({ id: newTrackId, name: `${track.name} (Rendered)`, type: "audio", color: track.color });

      set((s) => {
        const tracks = [...s.tracks];
        const newIdx = tracks.findIndex((t) => t.id === newTrackId);
        if (newIdx !== -1) {
          const [moved] = tracks.splice(newIdx, 1);
          tracks.splice(sourceTrackIndex + 1, 0, moved);
        }
        return { tracks };
      });
      nativeBridge.reorderTrack(newTrackId, sourceTrackIndex + 1).catch(logBridgeError("sync"));

      get().addClip(newTrackId, {
        id: crypto.randomUUID(),
        filePath,
        name: `${track.name} (Rendered)`,
        startTime: earliest,
        duration: renderedDuration,
        offset: 0,
        color: track.color,
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: mediaInfo?.sampleRate,
        sourceLength: renderedDuration,
      });

      // Mute the original track
      if (!track.muted) {
        get().toggleTrackMute(trackId);
      }
    },

    // ===== Phase 13: Advanced Editing =====
    setClipFadeInShape: (clipId, shape) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, fadeInShape: shape } : c,
          ),
        })),
      }));
    },
    setClipFadeOutShape: (clipId, shape) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, fadeOutShape: shape } : c,
          ),
        })),
      }));
    },
    openCrossfadeEditor: (clipId1, clipId2) =>
      set({ showCrossfadeEditor: true, crossfadeEditorClipIds: [clipId1, clipId2] }),
    closeCrossfadeEditor: () =>
      set({ showCrossfadeEditor: false, crossfadeEditorClipIds: null }),

    addClipTake: (clipId, take) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== clipId) return c;
            const takes = c.takes ? [...c.takes, take] : [take];
            return { ...c, takes, activeTakeIndex: takes.length - 1 };
          }),
        })),
      }));
    },
    setActiveClipTake: (clipId, takeIndex) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== clipId || !c.takes) return c;
            if (takeIndex < 0 || takeIndex >= c.takes.length) return c;
            const activeTake = c.takes[takeIndex];
            // Swap: current clip becomes a take, selected take becomes active
            const currentAsClip: AudioClip = { ...c, takes: undefined, activeTakeIndex: undefined };
            const newTakes = c.takes.map((tk, i) => (i === takeIndex ? currentAsClip : tk));
            return { ...activeTake, id: c.id, takes: newTakes, activeTakeIndex: takeIndex, startTime: c.startTime };
          }),
        })),
      }));
      // Re-sync backend since the active clip's audio changed
      if (get().transport.isPlaying) get().syncClipsWithBackend();
    },
    explodeTakes: (clipId) => {
      const state = get();
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip?.takes && clip.takes.length > 0) {
          // Create a new track for each take
          clip.takes.forEach((take, i) => {
            const newTrackId = crypto.randomUUID();
            state.addTrack({
              id: newTrackId,
              name: `${track.name} - Take ${i + 1}`,
              type: track.type,
            });
            state.addClip(newTrackId, {
              ...take,
              id: crypto.randomUUID(),
              startTime: clip.startTime,
              takes: undefined,
              activeTakeIndex: undefined,
            });
          });
          // Remove takes from original clip
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? { ...c, takes: undefined, activeTakeIndex: undefined } : c,
              ),
            })),
          }));
          break;
        }
      }
    },
    implodeTakes: (clipIds) => {
      if (clipIds.length < 2) return;
      const state = get();
      // Find all clips and their tracks
      const clipInfos: Array<{ clip: AudioClip; trackId: string }> = [];
      for (const cid of clipIds) {
        for (const track of state.tracks) {
          const clip = track.clips.find((c) => c.id === cid);
          if (clip) {
            clipInfos.push({ clip, trackId: track.id });
            break;
          }
        }
      }
      if (clipInfos.length < 2) return;
      // First clip becomes the main, rest become takes
      const main = clipInfos[0];
      const takes = clipInfos.slice(1).map((ci) => ({ ...ci.clip, takes: undefined, activeTakeIndex: undefined }));
      // Remove all but the first clip
      clipInfos.slice(1).forEach((ci) => state.deleteClip(ci.clip.id));
      // Update main clip with takes
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === main.clip.id ? { ...c, takes, activeTakeIndex: 0 } : c,
          ),
        })),
      }));
    },

    setClipPlaybackRate: async (clipId, rate) => {
      const state = get();
      let clip: AudioClip | undefined;
      let trackId: string | undefined;
      for (const track of state.tracks) {
        const found = track.clips.find((c) => c.id === clipId);
        if (found) { clip = found; trackId = track.id; break; }
      }
      if (!clip || !trackId) return;
      if (rate <= 0 || Math.abs(rate - 1.0) < 0.0001) {
        // Reset to original if rate ~1.0
        if (clip.originalFilePath && clip.originalFilePath !== clip.filePath) {
          const origPath = clip.originalFilePath;
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? { ...c, playbackRate: 1.0, filePath: origPath, originalFilePath: undefined } : c,
              ),
            })),
          }));
        }
        return;
      }

      // Snapshot for undo
      const oldClip = { ...clip };
      const sourceFile = clip.originalFilePath || clip.filePath;

      // Call backend to process
      const result = await nativeBridge.timeStretchClip(sourceFile, rate);
      if (!result.success || !result.filePath) return;

      const newDuration = result.duration || clip.duration / rate;
      const newSampleRate = result.sampleRate || clip.sampleRate;

      const command: Command = {
        type: "TIME_STRETCH_CLIP",
        description: `Time stretch clip to ${rate}x`,
        timestamp: Date.now(),
        execute: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  playbackRate: rate,
                  filePath: result.filePath!,
                  originalFilePath: sourceFile,
                  duration: newDuration,
                  sampleRate: newSampleRate,
                  offset: 0,
                } : c,
              ),
            })),
          }));
        },
        undo: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  playbackRate: oldClip.playbackRate,
                  filePath: oldClip.filePath,
                  originalFilePath: oldClip.originalFilePath,
                  duration: oldClip.duration,
                  sampleRate: oldClip.sampleRate,
                  offset: oldClip.offset,
                } : c,
              ),
            })),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    setClipPitch: async (clipId, semitones) => {
      const state = get();
      let clip: AudioClip | undefined;
      let trackId: string | undefined;
      for (const track of state.tracks) {
        const found = track.clips.find((c) => c.id === clipId);
        if (found) { clip = found; trackId = track.id; break; }
      }
      if (!clip || !trackId) return;
      if (Math.abs(semitones) < 0.01) {
        // Reset to original if ~0 semitones
        if (clip.originalFilePath && clip.originalFilePath !== clip.filePath) {
          const origPath = clip.originalFilePath;
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? { ...c, pitchSemitones: 0, filePath: origPath, originalFilePath: undefined } : c,
              ),
            })),
          }));
        }
        return;
      }

      // Snapshot for undo
      const oldClip = { ...clip };
      const sourceFile = clip.originalFilePath || clip.filePath;

      // Call backend to process
      const result = await nativeBridge.pitchShiftClip(sourceFile, semitones);
      if (!result.success || !result.filePath) return;

      const command: Command = {
        type: "PITCH_SHIFT_CLIP",
        description: `Pitch shift clip by ${semitones} semitones`,
        timestamp: Date.now(),
        execute: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  pitchSemitones: semitones,
                  filePath: result.filePath!,
                  originalFilePath: sourceFile,
                  sampleRate: result.sampleRate || c.sampleRate,
                } : c,
              ),
            })),
          }));
        },
        undo: async () => {
          set((s) => ({
            tracks: s.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId ? {
                  ...c,
                  pitchSemitones: oldClip.pitchSemitones,
                  filePath: oldClip.filePath,
                  originalFilePath: oldClip.originalFilePath,
                  sampleRate: oldClip.sampleRate,
                } : c,
              ),
            })),
          }));
        },
      };
      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleFreePositioning: () =>
      set((s) => ({ freePositioning: !s.freePositioning })),
    setClipFreeY: (clipId, freeY) => {
      set((s) => ({
        tracks: s.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, freeY } : c,
          ),
        })),
      }));
    },

    // Phase 14: Theming & Customization
    setTheme: (themeName) => {
      set({ theme: themeName, customThemeOverrides: {} });
      applyTheme(themeName, {});
    },
    setCustomThemeOverride: (property, value) => {
      set((s) => {
        const newOverrides = { ...s.customThemeOverrides, [property]: value };
        applyTheme(s.theme, newOverrides);
        return { customThemeOverrides: newOverrides };
      });
    },
    clearCustomThemeOverrides: () => {
      const theme = get().theme;
      set({ customThemeOverrides: {} });
      applyTheme(theme, {});
    },
    // toggleThemeEditor → store/actions/uiState.ts
    setMouseModifier: (context, modifiers, action) => {
      set((s) => ({
        mouseModifiers: {
          ...s.mouseModifiers,
          [context]: { ...s.mouseModifiers[context], [modifiers]: action },
        },
      }));
    },
    resetMouseModifiers: () => {
      set({
        mouseModifiers: {
          clip_drag: { none: "move", ctrl: "copy", shift: "constrain", alt: "bypass_snap" },
          clip_resize: { none: "resize", ctrl: "fine", shift: "symmetric", alt: "stretch" },
          timeline_click: { none: "seek", ctrl: "select_range", shift: "extend_selection", alt: "zoom" },
          track_header: { none: "select", ctrl: "toggle_select", shift: "range_select", alt: "solo" },
          automation_point: { none: "move", ctrl: "fine", shift: "constrain_y", alt: "delete" },
          fade_handle: { none: "adjust", ctrl: "fine", shift: "symmetric", alt: "shape_cycle" },
          ruler_click: { none: "seek", ctrl: "loop_set", shift: "time_select", alt: "zoom_to" },
        },
      });
    },
    setPanelPosition: (panelId, position) => {
      set((s) => ({
        panelPositions: {
          ...s.panelPositions,
          [panelId]: { ...s.panelPositions[panelId], ...position },
        },
      }));
    },
    togglePanelDock: (panelId, dock) => {
      set((s) => ({
        panelPositions: {
          ...s.panelPositions,
          [panelId]: { ...s.panelPositions[panelId], dock },
        },
      }));
    },

    // Phase 15: Platform & Extensibility
    // toggleVideoWindow → store/actions/uiState.ts
    openVideoFile: async (filePath) => {
      try {
        const info = await nativeBridge.openVideoFile(filePath);
        set({ videoFilePath: filePath, videoInfo: info, showVideoWindow: true });
      } catch (err) {
        console.error("[Store] Failed to open video:", err);
      }
    },
    closeVideoFile: () => {
      nativeBridge.closeVideoFile();
      set({ videoFilePath: "", videoInfo: null });
    },
    // toggleScriptEditor → store/actions/uiState.ts
    openPitchEditor: (trackId, clipId, fxIndex) => {
      set({ showPitchEditor: true, pitchEditorTrackId: trackId, pitchEditorClipId: clipId, pitchEditorFxIndex: fxIndex });
      usePitchEditorStore.getState().open(trackId, clipId, fxIndex);
    },
    closePitchEditor: () => {
      set({ showPitchEditor: false, pitchEditorTrackId: null, pitchEditorClipId: null, pitchEditorFxIndex: 0 });
      usePitchEditorStore.getState().close();
    },
    setLowerZoneHeight: (h) => set({ lowerZoneHeight: Math.max(150, Math.min(600, h)) }),
    executeScript: async (code) => {
      try {
        const result = await nativeBridge.executeScript(code);
        get().appendScriptConsole(`> ${result.result || "OK"}`);
        if (result.error) get().appendScriptConsole(`Error: ${result.error}`);
      } catch (err) {
        get().appendScriptConsole(`Error: ${err}`);
      }
    },
    addUserScript: (name, code) => {
      set((s) => ({
        userScripts: [...s.userScripts, { id: crypto.randomUUID(), name, code }],
      }));
    },
    removeUserScript: (scriptId) => {
      set((s) => ({
        userScripts: s.userScripts.filter((sc) => sc.id !== scriptId),
      }));
    },
    appendScriptConsole: (line) => {
      set((s) => ({
        scriptConsoleOutput: [...s.scriptConsoleOutput.slice(-199), line],
      }));
    },
    clearScriptConsole: () => set({ scriptConsoleOutput: [] }),
    addProjectTab: (name) => {
      const id = crypto.randomUUID();
      set((s) => ({
        projectTabs: [
          ...s.projectTabs.map((t) => ({ ...t, isActive: false })),
          { id, name: name || `Project ${s.projectTabs.length + 1}`, isActive: true },
        ],
        activeTabId: id,
      }));
    },
    closeProjectTab: (tabId) => {
      set((s) => {
        const remaining = s.projectTabs.filter((t) => t.id !== tabId);
        if (remaining.length === 0) return s; // Can't close last tab
        const needsNewActive = s.activeTabId === tabId;
        return {
          projectTabs: needsNewActive
            ? remaining.map((t, i) => ({ ...t, isActive: i === remaining.length - 1 }))
            : remaining,
          activeTabId: needsNewActive ? remaining[remaining.length - 1].id : s.activeTabId,
        };
      });
    },
    switchProjectTab: (tabId) => {
      set((s) => ({
        projectTabs: s.projectTabs.map((t) => ({ ...t, isActive: t.id === tabId })),
        activeTabId: tabId,
      }));
    },
    addCustomToolbar: (name) => {
      set((s) => ({
        customToolbars: [...s.customToolbars, { id: crypto.randomUUID(), name, visible: true, buttons: [] }],
      }));
    },
    removeCustomToolbar: (toolbarId) => {
      set((s) => ({
        customToolbars: s.customToolbars.filter((t) => t.id !== toolbarId),
      }));
    },
    addToolbarButton: (toolbarId, actionId, icon, label) => {
      set((s) => ({
        customToolbars: s.customToolbars.map((t) =>
          t.id === toolbarId
            ? { ...t, buttons: [...t.buttons, { actionId, icon, label }] }
            : t,
        ),
      }));
    },
    removeToolbarButton: (toolbarId, buttonIndex) => {
      set((s) => ({
        customToolbars: s.customToolbars.map((t) =>
          t.id === toolbarId
            ? { ...t, buttons: t.buttons.filter((_, i) => i !== buttonIndex) }
            : t,
        ),
      }));
    },
    toggleToolbarVisibility: (toolbarId) => {
      set((s) => ({
        customToolbars: s.customToolbars.map((t) =>
          t.id === toolbarId ? { ...t, visible: !t.visible } : t,
        ),
      }));
    },
    // toggleToolbarEditor → store/actions/uiState.ts
    setLTCEnabled: async (enabled) => {
      try {
        await nativeBridge.setLTCOutput(enabled, get().ltcOutputChannel, get().ltcFrameRate);
        set({ ltcEnabled: enabled });
      } catch (err) {
        console.error("[Store] Failed to set LTC:", err);
      }
    },
    setLTCOutputChannel: (channel) => set({ ltcOutputChannel: channel }),
    setLTCFrameRate: (rate) => set({ ltcFrameRate: rate }),

    // Phase 16: Pro Audio & Compatibility
    setTrackChannelFormat: (trackId, format) => {
      set((s) => ({
        trackChannelFormats: { ...s.trackChannelFormats, [trackId]: format },
      }));
    },
    setMasterChannelFormat: (format) => set({ masterChannelFormat: format }),
    togglePluginBridge: () =>
      set((s) => ({ pluginBridgeEnabled: !s.pluginBridgeEnabled })),
    startLiveCapture: async () => {
      try {
        const filePath = await nativeBridge.startLiveCapture("wav");
        set({ liveCaptureEnabled: true, liveCaptureFilePath: filePath, liveCaptureDuration: 0 });
      } catch (err) {
        console.error("[Store] Failed to start live capture:", err);
      }
    },
    stopLiveCapture: async () => {
      try {
        const result = await nativeBridge.stopLiveCapture();
        set({ liveCaptureEnabled: false, liveCaptureDuration: result.duration });
      } catch (err) {
        console.error("[Store] Failed to stop live capture:", err);
      }
    },
    // toggleDDPExport → store/actions/uiState.ts
    exportDDP: async (sourceWavPath, outputDir, catalogNumber) => {
      try {
        const regions = get().regions;
        // Convert regions to DDP track format: { startTime, endTime, title, isrc }
        const tracks = regions.map((r: any) => ({
          startTime: r.startTime ?? r.time ?? 0,
          endTime: r.endTime ?? (r.time + (r.duration ?? 0)),
          title: r.name ?? r.label ?? "",
          isrc: r.isrc ?? "",
        }));
        return await nativeBridge.exportDDP(sourceWavPath, outputDir, tracks, catalogNumber);
      } catch (err) {
        console.error("[Store] Failed to export DDP:", err);
        return false;
      }
    },

});
