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

type SyncedPlaybackClip = {
  trackId: string;
  filePath: string;
  startTime: number;
  duration: number;
  offset: number;
  volumeDB: number;
  fadeIn: number;
  fadeOut: number;
  clipId: string;
  pitchCorrectionSourceFilePath?: string;
  pitchCorrectionSourceOffset?: number;
};

// Diff-based sync cache: retains the identity needed to remove one logical clip.
let _lastSyncedClips = new Map<string, SyncedPlaybackClip>();
let _clipSyncTail: Promise<void> = Promise.resolve();
let _clipSyncEpoch = 0;
let _clipSyncRequestedRevision = 0;
let _clipSyncCompletedRevision = 0;

function makeClipKey(
  trackId: string, clipId: string, filePath: string, startTime: number, duration: number,
  offset: number, volumeDB: number, fadeIn: number, fadeOut: number
): string {
  return `${trackId}|${clipId}|${filePath}|${startTime}|${duration}|${offset}|${volumeDB}|${fadeIn}|${fadeOut}`;
}

export function resetSyncCache(): Promise<void> {
  _clipSyncEpoch += 1;
  _clipSyncRequestedRevision = 0;
  _clipSyncCompletedRevision = 0;

  // Reset is a queue barrier: direct backend mutations must await it so no
  // older sync can publish clips after a project or recording reset.
  const resetPromise = _clipSyncTail.then(() => {
    _lastSyncedClips = new Map<string, SyncedPlaybackClip>();
  });
  _clipSyncTail = resetPromise.catch(() => {});
  return resetPromise;
}

function enqueueClipBackendSync(syncTask: () => Promise<void>): Promise<void> {
  const requestEpoch = _clipSyncEpoch;
  const requestRevision = ++_clipSyncRequestedRevision;
  const syncPromise = _clipSyncTail.then(async () => {
    // Several edits can request a sync before the queued work begins. The task
    // reads Zustand only after it owns the queue, so one pass can publish the
    // newest state and superseded tasks behind it can become no-ops.
    if (requestEpoch !== _clipSyncEpoch || _clipSyncCompletedRevision >= requestRevision) return;
    const revisionBeingApplied = _clipSyncRequestedRevision;
    try {
      await syncTask();
    } catch (firstError) {
      if (requestEpoch !== _clipSyncEpoch) throw firstError;

      // A failed call may have partially mutated native state. Invalidate the
      // cache and make one bounded full-rebuild attempt unless a newer queued
      // request is already responsible for recovery.
      _lastSyncedClips = new Map<string, SyncedPlaybackClip>();
      if (_clipSyncRequestedRevision > revisionBeingApplied) throw firstError;
      console.warn(`${AUDIO_PLAYBACK_LOG_PREFIX} sync failed; retrying one full rebuild`, firstError);
      try {
        await syncTask();
      } catch (retryError) {
        if (requestEpoch === _clipSyncEpoch) {
          _lastSyncedClips = new Map<string, SyncedPlaybackClip>();
        }
        throw retryError;
      }
    }

    if (requestEpoch === _clipSyncEpoch) {
      _clipSyncCompletedRevision = revisionBeingApplied;
    }
  });

  // Keep the queue usable after a rejected bridge call while preserving the
  // rejection for the caller that requested this particular sync.
  _clipSyncTail = syncPromise.catch(() => {});
  return syncPromise;
}

function requireClipBridgeSuccess(result: boolean, operation: string) {
  if (result !== true) {
    throw new Error(`${AUDIO_PLAYBACK_LOG_PREFIX} ${operation} returned false`);
  }
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

function makeMIDIEventKey(event) {
  const channel = event.channel ?? "";
  if (event.type === "noteOn" || event.type === "noteOff") {
    return [
      event.type,
      event.timestamp,
      event.note,
      event.velocity ?? 0,
      channel,
    ].join("|");
  }
  if (event.type === "pitchBend") {
    return [
      event.type,
      event.timestamp,
      event.value ?? 8192,
      channel,
    ].join("|");
  }
  return JSON.stringify(event);
}

function makeMIDICCEventKey(event) {
  return [
    event.time,
    event.cc,
    event.value,
    event.channel ?? "",
  ].join("|");
}

function dedupeByKey(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortMIDIEvents(a, b) {
  return a.timestamp - b.timestamp
    || (a.note ?? 0) - (b.note ?? 0)
    || String(a.type).localeCompare(String(b.type))
    || (a.channel ?? 0) - (b.channel ?? 0);
}

function sortMIDICCEvents(a, b) {
  return a.time - b.time
    || a.cc - b.cc
    || (a.channel ?? 0) - (b.channel ?? 0)
    || a.value - b.value;
}

function mergeMIDIImportTracks(normalizedTracks, baseName) {
  const events = [];
  const ccEvents = [];
  let duration = 0;

  for (const track of normalizedTracks) {
    duration = Math.max(duration, Number(track.duration) || 0);
    events.push(...(track.events || []).map((event) => ({ ...event })));
    ccEvents.push(...(track.ccEvents || []).map((event) => ({ ...event })));
  }

  return {
    name: baseName,
    events: dedupeByKey(events, makeMIDIEventKey).sort(sortMIDIEvents),
    ccEvents: dedupeByKey(ccEvents, makeMIDICCEventKey).sort(sortMIDICCEvents),
    duration: Math.max(0.25, duration || 4),
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
            nativeBridge.removePlaybackClipById(current.trackId, current.clip.id).catch(() => false);
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

      const mergedSource = mergeMIDIImportTracks(normalizedTracks, baseName);
      const existingTrack = request.targetTrackId
        ? get().tracks.find((track) => track.id === request.targetTrackId)
        : null;
      const canUseExistingTrack =
        existingTrack &&
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
      const targetTrackId = canUseExistingTrack ? existingTrack.id : crypto.randomUUID();
      const clipId = crypto.randomUUID();
      const color = canUseExistingTrack
        ? existingTrack.color || "#4361ee"
        : `hsl(${(insertIndex * 60) % 360}, 60%, 50%)`;

      if (!canUseExistingTrack) {
        createdTracks.push(createDefaultTrack(targetTrackId, baseName, color, "midi", initialTracks));
      }
      touchedTrackIds.push(targetTrackId);
      importedClipIds.push(clipId);
      importedEntries.push({
        trackId: targetTrackId,
        clip: {
          id: clipId,
          name: baseName,
          startTime,
          duration: mergedSource.duration,
          offset: 0,
          sourceStart: 0,
          sourceLength: mergedSource.duration,
          loopEnabled: true,
          loopOffset: 0,
          loopLength: mergedSource.duration,
          events: mergedSource.events,
          ccEvents: mergedSource.ccEvents,
          color,
        },
      });

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

    syncClipsWithBackend: () => enqueueClipBackendSync(async () => {
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
      const currentClips = new Map<string, SyncedPlaybackClip>();
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (clip.filePath && !clip.muted) {
            const offset = clip.offset || 0;
            const volumeDB = clip.volumeDB || 0;
            const fadeIn = clip.fadeIn || 0;
            const fadeOut = clip.fadeOut || 0;
            const key = makeClipKey(track.id, clip.id, clip.filePath, clip.startTime, clip.duration, offset, volumeDB, fadeIn, fadeOut);
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
      for (const key of _lastSyncedClips.keys()) {
        if (!currentKeys.has(key)) toRemove.push(key);
      }

      // Diff: find clips to add (in new set but not in old)
      const toAdd: string[] = [];
      for (const key of currentKeys) {
        if (!_lastSyncedClips.has(key)) toAdd.push(key);
      }

      // If more than 60% changed, just do a full clear+rebuild (cheaper than many removes)
      const t1 = performance.now();
      const totalOld = _lastSyncedClips.size;
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
        requireClipBridgeSuccess(
          await nativeBridge.clearPlaybackClips(),
          "clearPlaybackClips",
        );
        const allClips = Array.from(currentClips.values());
        if (allClips.length > 0) {
          requireClipBridgeSuccess(
            await nativeBridge.addPlaybackClipsBatch(allClips),
            "addPlaybackClipsBatch",
          );
        }
      } else {
        // Incremental: batch remove old in parallel, then batch add new in parallel
        if (toRemove.length > 0) {
          const removalResults = await Promise.all(
            toRemove.map((key) => {
              const clip = _lastSyncedClips.get(key)!;
              return nativeBridge.removePlaybackClipById(clip.trackId, clip.clipId);
            }),
          );
          requireClipBridgeSuccess(
            removalResults.every((result) => result === true),
            "removePlaybackClipById",
          );
        }
        if (toAdd.length > 0) {
          const clipsToAdd = toAdd.map((key) => currentClips.get(key)!);
          requireClipBridgeSuccess(
            await nativeBridge.addPlaybackClipsBatch(clipsToAdd),
            "addPlaybackClipsBatch",
          );
        }
      }
      const t2 = performance.now();

      // Update cache
      _lastSyncedClips = new Map(currentClips);

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
    }),

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
