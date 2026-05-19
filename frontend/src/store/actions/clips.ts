// @ts-nocheck
/**
 * Clip management actions — add, remove, select, deselect, copy, cut, paste clips.
 * Extracted from useDAWStore.ts for modularity.
 */

import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { syncAutomationLaneToBackend, syncTempoMarkersToBackend } from "./storeHelpers";
import { serializeMIDIClipsForBackend } from "../../utils/midiClipSerialization";
import { createDefaultTrack } from "../useDAWStore";

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

function clampInsertIndex(index, trackCount) {
  if (!Number.isFinite(Number(index))) return trackCount;
  return Math.max(0, Math.min(trackCount, Math.round(Number(index))));
}

function normalizeMIDIVelocity(value, fallback = 80) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed > 0 && parsed <= 1) return Math.max(1, Math.min(127, Math.round(parsed * 127)));
  return Math.max(1, Math.min(127, Math.round(parsed)));
}

function normalizeMIDIImportTrack(rawTrack, index, fallbackName) {
  const events = [];
  const ccEvents = [];
  let maxTime = 0;
  const rawEvents = Array.isArray(rawTrack?.events) ? rawTrack.events : [];

  for (const rawEvent of rawEvents) {
    const timestamp = Math.max(0, Number(rawEvent?.timestamp) || 0);
    maxTime = Math.max(maxTime, timestamp);
    const channel = Number.isFinite(Number(rawEvent?.channel))
      ? Math.max(1, Math.min(16, Math.round(Number(rawEvent.channel))))
      : undefined;

    if (rawEvent?.type === "noteOn" || rawEvent?.type === "noteOff") {
      events.push({
        timestamp,
        type: rawEvent.type,
        note: Math.max(0, Math.min(127, Math.round(Number(rawEvent.note) || 60))),
        velocity: rawEvent.type === "noteOn" ? normalizeMIDIVelocity(rawEvent.velocity) : 0,
        channel,
      });
      continue;
    }

    if (rawEvent?.type === "cc") {
      ccEvents.push({
        time: timestamp,
        cc: Math.max(0, Math.min(127, Math.round(Number(rawEvent.controller) || 0))),
        value: Math.max(0, Math.min(127, Math.round(Number(rawEvent.value) || 0))),
        channel,
      });
      continue;
    }

    if (rawEvent?.type === "pitchBend") {
      events.push({
        timestamp,
        type: "pitchBend",
        value: Math.max(0, Math.min(16383, Math.round(Number(rawEvent.value) || 8192))),
        channel,
      });
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp || (a.note ?? 0) - (b.note ?? 0));
  ccEvents.sort((a, b) => a.time - b.time || a.cc - b.cc);

  return {
    name: rawTrack?.name || fallbackName || `MIDI Track ${index + 1}`,
    channel: rawTrack?.channel,
    events,
    ccEvents,
    duration: Math.max(0.25, maxTime || 4),
    isEmpty: events.length === 0 && ccEvents.length === 0,
  };
}

function syncMIDITrackIds(get, trackIds) {
  const state = get();
  for (const trackId of trackIds) {
    const track = state.tracks.find((candidate) => candidate.id === trackId);
    if (!track) continue;
    nativeBridge
      .setTrackMIDIClips(track.id, serializeMIDIClipsForBackend(track.midiClips || [], track.midiEffects || []))
      .catch(logBridgeError("midi sync"));
  }
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

    importExternalMediaAtTimeline: async (request) => {
      const startedAt = performance.now();
      const sourcePath = request.filePath;
      const fileName = sourcePath.split(/[/\\]/).pop() || "Audio";
      const clipName = request.name || fileName.replace(/\.[^.]+$/, "") || "Audio";
      const existingTrack = request.trackId
        ? get().tracks.find((track) => track.id === request.trackId)
        : null;
      const createdTrackId = existingTrack ? null : (request.trackId || crypto.randomUUID());
      const trackId = existingTrack?.id || createdTrackId;
      const trackColor = existingTrack?.color || `hsl(${(get().tracks.length * 60) % 360}, 60%, 50%)`;
      const provisionalDuration = Math.max(0.25, request.duration || 4);
      const clipId = crypto.randomUUID();
      const provisionalClip = {
        id: clipId,
        filePath: sourcePath,
        name: clipName,
        startTime: Math.max(0, request.startTime || 0),
        duration: provisionalDuration,
        offset: 0,
        color: trackColor,
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: request.sampleRate || 44100,
        sourceLength: provisionalDuration,
        importStatus: "probing",
        waveformStatus: request.waveformStatus || "preview",
      };
      const createdTrack = createdTrackId
        ? createDefaultTrack(createdTrackId, clipName, trackColor, "audio", get().tracks)
        : null;
      const requestedInsertIndex = request.insertIndex;

      const command = {
        type: "IMPORT_EXTERNAL_MEDIA",
        description: `Import "${clipName}"`,
        timestamp: Date.now(),
        execute: () => {
          set((state) => {
            let tracks = state.tracks;
            if (createdTrack && !tracks.some((track) => track.id === createdTrack.id)) {
              const newTracks = [...tracks];
              newTracks.splice(clampInsertIndex(requestedInsertIndex, newTracks.length), 0, createdTrack);
              tracks = newTracks;
              nativeBridge.addTrack(createdTrack.id, "audio").catch((error) =>
                console.error("[DAWStore] Failed to create backend track for external import:", error),
              );
            }

            return {
              tracks: tracks.map((track) =>
                track.id === trackId && !track.clips.some((clip) => clip.id === clipId)
                  ? { ...track, clips: [...track.clips, provisionalClip] }
                  : track,
              ),
              selectedTrackId: trackId,
              selectedClipIds: [clipId],
            };
          });
        },
        undo: () => {
          const current = get().tracks
            .flatMap((track) => track.clips.map((clip) => ({ trackId: track.id, clip })))
            .find((entry) => entry.clip.id === clipId);
          if (current) {
            nativeBridge.removePlaybackClip(current.trackId, current.clip.filePath).catch(() => false);
          }
          if (createdTrack) {
            nativeBridge.removeTrack(createdTrack.id).catch(() => false);
          }
          set((state) => ({
            tracks: createdTrack
              ? state.tracks.filter((track) => track.id !== createdTrack.id)
              : state.tracks.map((track) =>
                  track.id === trackId
                    ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
                    : track,
                ),
            selectedClipIds: state.selectedClipIds.filter((id) => id !== clipId),
            selectedTrackId: state.selectedTrackId === createdTrack?.id ? null : state.selectedTrackId,
          }));
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

      const updateClip = (patch) => {
        set((state) => ({
          tracks: state.tracks.map((track) =>
            track.id === trackId
              ? {
                  ...track,
                  clips: track.clips.map((clip) =>
                    clip.id === clipId ? { ...clip, ...patch } : clip,
                  ),
                }
              : track,
          ),
        }));
      };
      const clipStillExists = () =>
        get().tracks.some((track) => track.id === trackId && track.clips.some((clip) => clip.id === clipId));

      try {
        const mediaInfo = await nativeBridge.probeMediaFile(sourcePath);
        if (!mediaInfo || !mediaInfo.filePath || !mediaInfo.duration) {
          updateClip({ importStatus: "failed" });
          throw new Error("Unsupported file format or failed to read: " + sourcePath);
        }
        if (!clipStillExists()) return;

        updateClip({
          filePath: mediaInfo.filePath,
          duration: mediaInfo.duration,
          sampleRate: mediaInfo.sampleRate,
          sourceLength: mediaInfo.duration,
          importStatus: "preparingPlayback",
        });

        await nativeBridge.addPlaybackClip(
          trackId,
          mediaInfo.filePath,
          provisionalClip.startTime,
          mediaInfo.duration,
          0,
          0,
          0,
          0,
          clipId,
        );

        if (clipStillExists()) {
          updateClip({ importStatus: "ready", waveformStatus: "building" });
          console.log("[audio.import] external import ready", {
            filePath: mediaInfo.filePath,
            ms: Number((performance.now() - startedAt).toFixed(1)),
          });
        }
      } catch (error) {
        updateClip({ importStatus: "failed" });
        console.error("[DAWStore] Failed to import external media:", error);
        throw error;
      }
    },

    importExternalMIDIAtTimeline: async (request) => {
      const sourcePath = request.filePath;
      const fileName = sourcePath.split(/[/\\]/).pop() || "MIDI";
      const baseName = request.name || fileName.replace(/\.[^.]+$/, "") || "MIDI";
      const shouldUsePreviewTracks = Array.isArray(request.parsedTracks) && request.parsedTracks.length > 0;

      const importResult = shouldUsePreviewTracks
        ? { success: true, tracks: request.parsedTracks }
        : await nativeBridge.importMIDIFile(sourcePath);
      const normalizedTracks = (importResult.tracks || [])
        .map((track, index) => normalizeMIDIImportTrack(track, index, importResult.tracks?.length === 1 ? baseName : `${baseName} ${index + 1}`))
        .filter((track) => !track.isEmpty);

      if (normalizedTracks.length === 0) {
        throw new Error(importResult.error || "No supported MIDI events found in file: " + sourcePath);
      }

      const existingTrack = request.targetTrackId
        ? get().tracks.find((track) => track.id === request.targetTrackId)
        : null;
      const canUseExistingTrack =
        existingTrack &&
        normalizedTracks.length === 1 &&
        (existingTrack.type === "midi" || existingTrack.type === "instrument");
      const initialTracks = get().tracks;
      const targetTrackIndex = existingTrack
        ? initialTracks.findIndex((track) => track.id === existingTrack.id)
        : -1;
      const insertIndex = clampInsertIndex(
        request.insertIndex ?? (targetTrackIndex >= 0 ? targetTrackIndex : initialTracks.length),
        initialTracks.length,
      );
      const startTime = Math.max(0, request.startTime || 0);
      const touchedTrackIds = [];
      const importedClipIds = [];
      const createdTracks = [];
      const importedEntries = [];

      if (canUseExistingTrack) {
        const source = normalizedTracks[0];
        const clipId = crypto.randomUUID();
        importedClipIds.push(clipId);
        touchedTrackIds.push(existingTrack.id);
        importedEntries.push({
          trackId: existingTrack.id,
          clip: {
            id: clipId,
            name: baseName,
            startTime,
            duration: source.duration,
            offset: 0,
            sourceStart: 0,
            sourceLength: source.duration,
            loopEnabled: true,
            loopOffset: 0,
            loopLength: source.duration,
            events: source.events,
            ccEvents: source.ccEvents,
            color: existingTrack.color || "#4361ee",
          },
        });
      } else {
        normalizedTracks.forEach((source, index) => {
          const trackId = crypto.randomUUID();
          const clipId = crypto.randomUUID();
          const color = `hsl(${((insertIndex + index) * 60) % 360}, 60%, 50%)`;
          const track = createDefaultTrack(trackId, source.name || `${baseName} ${index + 1}`, color, "midi", initialTracks);
          createdTracks.push(track);
          touchedTrackIds.push(trackId);
          importedClipIds.push(clipId);
          importedEntries.push({
            trackId,
            clip: {
              id: clipId,
              name: source.name || baseName,
              startTime,
              duration: source.duration,
              offset: 0,
              sourceStart: 0,
              sourceLength: source.duration,
              loopEnabled: true,
              loopOffset: 0,
              loopLength: source.duration,
              events: source.events,
              ccEvents: source.ccEvents,
              color,
            },
          });
        });
      }

      const syncAfterCreate = () => {
        const createdTrackIds = createdTracks.map((track) => track.id);
        if (createdTrackIds.length > 0) {
          Promise
            .all(createdTracks.map((track) => nativeBridge.addTrack(track.id, "midi").catch(() => false)))
            .finally(() => syncMIDITrackIds(get, touchedTrackIds));
        } else {
          syncMIDITrackIds(get, touchedTrackIds);
        }
      };

      const command = {
        type: "IMPORT_EXTERNAL_MIDI",
        description: `Import MIDI "${baseName}"`,
        timestamp: Date.now(),
        execute: () => {
          set((state) => {
            let tracks = state.tracks;
            if (createdTracks.length > 0) {
              const newTracks = [...tracks];
              let offset = 0;
              for (const track of createdTracks) {
                if (newTracks.some((candidate) => candidate.id === track.id)) continue;
                newTracks.splice(clampInsertIndex(insertIndex + offset, newTracks.length), 0, track);
                offset += 1;
              }
              tracks = newTracks;
            }

            return {
              tracks: tracks.map((track) => {
                const clipsForTrack = importedEntries
                  .filter((entry) => entry.trackId === track.id && !track.midiClips.some((clip) => clip.id === entry.clip.id))
                  .map((entry) => entry.clip);
                return clipsForTrack.length > 0
                  ? { ...track, midiClips: [...track.midiClips, ...clipsForTrack] }
                  : track;
              }),
              selectedTrackId: touchedTrackIds[0] || state.selectedTrackId,
              selectedTrackIds: [...touchedTrackIds],
              lastSelectedTrackId: touchedTrackIds[touchedTrackIds.length - 1] || state.lastSelectedTrackId,
              selectedClipId: importedClipIds[0] || state.selectedClipId,
              selectedClipIds: [...importedClipIds],
              isModified: true,
            };
          });
          syncAfterCreate();
        },
        undo: () => {
          for (const track of createdTracks) {
            nativeBridge.removeTrack(track.id).catch(() => false);
          }
          set((state) => ({
            tracks: createdTracks.length > 0
              ? state.tracks.filter((track) => !createdTracks.some((created) => created.id === track.id))
              : state.tracks.map((track) =>
                  touchedTrackIds.includes(track.id)
                    ? { ...track, midiClips: track.midiClips.filter((clip) => !importedClipIds.includes(clip.id)) }
                    : track,
                ),
            selectedClipId: importedClipIds.includes(state.selectedClipId) ? null : state.selectedClipId,
            selectedClipIds: state.selectedClipIds.filter((id) => !importedClipIds.includes(id)),
            selectedTrackId: touchedTrackIds.includes(state.selectedTrackId) ? null : state.selectedTrackId,
            selectedTrackIds: state.selectedTrackIds.filter((id) => !touchedTrackIds.includes(id)),
            lastSelectedTrackId: touchedTrackIds.includes(state.lastSelectedTrackId) ? null : state.lastSelectedTrackId,
            isModified: true,
          }));
          if (createdTracks.length === 0) {
            syncMIDITrackIds(get, touchedTrackIds);
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
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

        const midiClipsPayload = serializeMIDIClipsForBackend(track.midiClips, track.midiEffects || []);

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
          syncPromises.push(syncAutomationLaneToBackend(track.id, lane));
        }
      }
      // Sync master automation lanes
      for (const lane of get().masterAutomationLanes) {
        syncPromises.push(syncAutomationLaneToBackend("master", lane));
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
