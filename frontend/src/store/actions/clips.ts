// @ts-nocheck
/**
 * Clip management actions — add, remove, select, deselect, copy, cut, paste clips.
 * Extracted from useDAWStore.ts for modularity.
 */

import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { syncTempoMarkersToBackend } from "./storeHelpers";

const AUDIO_PLAYBACK_LOG_PREFIX = "[audio.playback]";

// Diff-based sync cache: tracks which clips were last sent to the C++ backend.
let _lastSyncedClipKeys = new Set<string>();

function makeClipKey(
  trackId: string, filePath: string, startTime: number, duration: number,
  offset: number, volumeDB: number, fadeIn: number, fadeOut: number
): string {
  return `${trackId}|${filePath}|${startTime}|${duration}|${offset}|${volumeDB}|${fadeIn}|${fadeOut}`;
}

export function resetSyncCache() {
  _lastSyncedClipKeys = new Set<string>();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const clipActions = (set: SetFn, get: GetFn) => ({
    addClip: (trackId, clip) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t,
        ),
      }));
    },

    removeClip: (trackId, clipId) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId
            ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
            : t,
        ),
      }));
    },

    syncClipsWithBackend: async () => {
      const syncStart = performance.now();
      const { tracks } = get();
      const totalTrackClips = tracks.reduce((sum, track) => sum + track.clips.length, 0);
      const mutedTrackClips = tracks.reduce(
        (sum, track) => sum + track.clips.filter((clip) => clip.muted).length,
        0,
      );
      console.log(`${AUDIO_PLAYBACK_LOG_PREFIX} syncClipsWithBackend:start`, {
        totalTracks: tracks.length,
        totalTrackClips,
        mutedTrackClips,
      });

      // Build current clip set with keys
      const currentClips = new Map<string, { trackId: string; filePath: string; startTime: number; duration: number; offset: number; volumeDB: number; fadeIn: number; fadeOut: number; clipId: string; pitchCorrectionSourceFilePath?: string; pitchCorrectionSourceOffset?: number }>();
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (clip.filePath && !clip.muted) {
            const offset = clip.offset || 0;
            const volumeDB = clip.volumeDB || 0;
            const fadeIn = clip.fadeIn || 0;
            const fadeOut = clip.fadeOut || 0;
            const key = makeClipKey(track.id, clip.filePath, clip.startTime, clip.duration, offset, volumeDB, fadeIn, fadeOut);
            currentClips.set(key, {
              trackId: track.id,
              filePath: clip.filePath,
              startTime: clip.startTime,
              duration: clip.duration,
              offset,
              volumeDB,
              fadeIn,
              fadeOut,
              clipId: clip.id,
              pitchCorrectionSourceFilePath: clip.pitchCorrectionSourceFilePath,
              pitchCorrectionSourceOffset: clip.pitchCorrectionSourceOffset,
            });
          }
        }
      }

      const currentKeys = new Set(currentClips.keys());

      // Diff: find clips to remove (in old set but not in new)
      const toRemove: string[] = [];
      for (const key of _lastSyncedClipKeys) {
        if (!currentKeys.has(key)) toRemove.push(key);
      }

      // Diff: find clips to add (in new set but not in old)
      const toAdd: string[] = [];
      for (const key of currentKeys) {
        if (!_lastSyncedClipKeys.has(key)) toAdd.push(key);
      }

      // If more than 60% changed, just do a full clear+rebuild (cheaper than many removes)
      const t1 = performance.now();
      const totalOld = _lastSyncedClipKeys.size;
      const fullRebuild = totalOld === 0 || toRemove.length > totalOld * 0.6;
      console.log(`${AUDIO_PLAYBACK_LOG_PREFIX} syncClipsWithBackend:diff`, {
        cachedKeys: totalOld,
        currentKeys: currentKeys.size,
        toAdd: toAdd.length,
        toRemove: toRemove.length,
        fullRebuild,
      });
      if (toAdd.length > 0) {
        console.log(`${AUDIO_PLAYBACK_LOG_PREFIX} syncClipsWithBackend:toAdd`, toAdd.map((key) => currentClips.get(key)).filter(Boolean).map((clip) => ({
          trackId: clip!.trackId,
          clipId: clip!.clipId,
          filePath: clip!.filePath,
          startTime: clip!.startTime,
          duration: clip!.duration,
          offset: clip!.offset,
        })));
      }
      if (toRemove.length > 0) {
        console.log(`${AUDIO_PLAYBACK_LOG_PREFIX} syncClipsWithBackend:toRemoveKeys`, toRemove);
      }
      if (fullRebuild) {
        // Full rebuild — clear first, then batch-add all clips in parallel
        await nativeBridge.clearPlaybackClips();
        const allClips = Array.from(currentClips.values());
        if (allClips.length > 0) {
          await nativeBridge.addPlaybackClipsBatch(allClips);
        }
      } else {
        // Incremental: batch remove old in parallel, then batch add new in parallel
        if (toRemove.length > 0) {
          await Promise.all(
            toRemove.map((key) => {
              const parts = key.split("|");
              return nativeBridge.removePlaybackClip(parts[0], parts[1]);
            }),
          );
        }
        if (toAdd.length > 0) {
          const clipsToAdd = toAdd.map((key) => currentClips.get(key)!);
          await nativeBridge.addPlaybackClipsBatch(clipsToAdd);
        }
      }
      const t2 = performance.now();

      // Update cache
      _lastSyncedClipKeys = currentKeys;

      // Collect all fire-and-forget sync promises to run in parallel
      const syncPromises: Promise<any>[] = [];

      // Sync MIDI clips for MIDI/instrument tracks so backend playback can
      // schedule the same note/CC data the frontend edits.
      for (const track of tracks) {
        if (track.type !== "midi" && track.type !== "instrument") continue;

        const midiClipsPayload = track.midiClips.map((clip) => ({
          id: clip.id,
          startTime: clip.startTime,
          duration: clip.duration,
          events: [
            ...clip.events.map((e) => ({
              type: e.type,
              timestamp: e.timestamp,
              note: e.note,
              velocity: e.velocity,
              controller: e.controller,
              value: e.value,
              channel: 1,
            })),
            ...(clip.ccEvents || []).map((e) => ({
              type: "cc",
              timestamp: e.time,
              controller: e.cc,
              value: e.value,
              channel: 1,
            })),
          ].sort((a, b) => a.timestamp - b.timestamp),
        }));

        syncPromises.push(
          nativeBridge.setTrackMIDIClips(track.id, midiClipsPayload).catch(logBridgeError("sync")),
        );
      }

      // Sync gain envelopes to backend for all clips that have them
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (clip.gainEnvelope && clip.gainEnvelope.length > 0) {
            syncPromises.push(nativeBridge.setClipGainEnvelope(track.id, clip.id, clip.gainEnvelope).catch(logBridgeError("sync")));
          }
        }
      }

      // Sync automation lanes to backend (all lanes, even empty ones, to sync modes)
      for (const track of tracks) {
        for (const lane of track.automationLanes) {
          const parameterId = lane.param;
          const converted = lane.points.map((p) => ({
            time: p.time,
            value: automationToBackend(lane.param, p.value),
          }));
          syncPromises.push(nativeBridge.setAutomationPoints(track.id, parameterId, converted).catch(logBridgeError("sync")));
          if (lane.mode) {
            syncPromises.push(nativeBridge.setAutomationMode(track.id, parameterId, lane.mode).catch(logBridgeError("sync")));
          }
        }
      }
      // Sync master automation lanes
      for (const lane of get().masterAutomationLanes) {
        const parameterId = lane.param;
        const converted = lane.points.map((p) => ({
          time: p.time,
          value: automationToBackend(lane.param, p.value),
        }));
        syncPromises.push(nativeBridge.setAutomationPoints("master", parameterId, converted).catch(logBridgeError("sync")));
        if (lane.mode) {
          syncPromises.push(nativeBridge.setAutomationMode("master", parameterId, lane.mode).catch(logBridgeError("sync")));
        }
      }
      // Also sync tempo markers to backend
      syncTempoMarkersToBackend(get().tempoMarkers);

      // Wait for all auxiliary syncs in parallel (not sequentially)
      await Promise.all(syncPromises);
      const t3 = performance.now();

      console.log(`${AUDIO_PLAYBACK_LOG_PREFIX} frontend clips synced: total=${currentClips.size}, added=${toAdd.length}, removed=${toRemove.length}`, {
        fullRebuild,
        clipsMs: Number((t2 - t1).toFixed(1)),
        auxMs: Number((t3 - t2).toFixed(1)),
        totalMs: Number((t3 - syncStart).toFixed(1)),
      });
      console.log(`[DAW] syncClipsWithBackend: clips=${(t2 - t1).toFixed(0)}ms, aux=${(t3 - t2).toFixed(0)}ms, total=${(t3 - syncStart).toFixed(0)}ms (added: ${toAdd.length}, removed: ${toRemove.length}, auxCalls: ${syncPromises.length})`);
    },

    importMedia: async (filePath, trackId, startTime) => {
      try {
        // Call backend to import media file (handles video extraction if needed)
        const mediaInfo = await nativeBridge.importMediaFile(filePath);

        if (!mediaInfo || !mediaInfo.filePath || !mediaInfo.duration) {
          throw new Error("Unsupported file format or failed to read: " + filePath);
        }

        // Create a new clip from the imported media
        const track = get().tracks.find((t) => t.id === trackId);
        const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") || "Clip";
        const newClip: AudioClip = {
          id: crypto.randomUUID(),
          filePath: mediaInfo.filePath,
          name: fileName,
          startTime: startTime,
          duration: mediaInfo.duration,
          offset: 0,
          color: track?.color || "#4cc9f0",
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
          sampleRate: mediaInfo.sampleRate,
          sourceLength: mediaInfo.duration,
        };

        // Add clip to track
        get().addClip(trackId, newClip);

        // Register clip with backend for playback
        await nativeBridge.addPlaybackClip(
          trackId,
          newClip.filePath,
          newClip.startTime,
          newClip.duration,
          newClip.offset || 0,
          newClip.volumeDB || 0,
          newClip.fadeIn || 0,
          newClip.fadeOut || 0,
          newClip.id,
          newClip.pitchCorrectionSourceFilePath,
          newClip.pitchCorrectionSourceOffset,
        );

        console.log(
          `[DAWStore] Imported media: ${filePath} → track ${trackId} at ${startTime}s`,
        );
      } catch (error) {
        console.error(`[DAWStore] Failed to import media:`, error);
        throw error;
      }
    },


});
