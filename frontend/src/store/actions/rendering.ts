import {
  applyTheme,
  createDefaultRenderDialogOptions,
  createDefaultTrack,
  type AudioClip,
  type Track,
  type DAWState,
  type DAWActions,
  type MIDIClip,
} from "../useDAWStore";
import type { StoreApi } from "zustand";
import { usePitchEditorStore, cancelPitchEditorGesture } from "../pitchEditorStore";
type SetFn = StoreApi<DAWState & DAWActions>["setState"];
type GetFn = StoreApi<DAWState & DAWActions>["getState"];

/**
 * Render pipeline, engine enhancements, send/bus routing.
 * Extracted from useDAWStore.ts.
 */
import { nativeBridge } from "../../services/NativeBridge";
import { editTrackSends } from "../../utils/trackSendHistory";
import { sendAutomationParamId } from "../automationParams";
import { commandManager } from "../commands";
import type { Command } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { getProjectEpoch } from "../../utils/projectLifetime";
import { prepareForManualRender } from "../../utils/renderPreparation";
import { serializeMIDIClipsForBackend } from "../../utils/midiClipSerialization";
import {
  cloneTimelineClipDeep,
  cloneTracksForTimelineUndo,
} from "./clipEditing";
import { isClipEditLocked } from "../../utils/clipEditLock";
import { resolvePitchClipTarget } from "../../utils/pitchEditorEntry";
import {
  persistMouseModifierOverrides,
  withMouseModifierOverride,
} from "../../utils/mouseModifierPersistence";

interface TakeClipEntry {
  track: Track;
  clip: AudioClip;
}

function findTakeClipEntry(state: Pick<DAWState, "tracks">, clipId: string): TakeClipEntry | null {
  if (typeof clipId !== "string" || clipId.length === 0) return null;
  for (const track of state.tracks || []) {
    const clip = (track.clips || []).find((candidate: AudioClip) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function isValidStandaloneTake(clip: AudioClip | undefined): clip is AudioClip {
  return Boolean(
    clip
    && typeof clip.id === "string"
    && clip.id.length > 0
    && typeof clip.filePath === "string"
    && clip.filePath.trim().length > 0
    && Number.isFinite(clip.duration)
    && clip.duration > 0
    && Number.isFinite(clip.offset)
    && clip.offset >= 0,
  );
}

function isValidTakeTree(clip: AudioClip | undefined): clip is AudioClip {
  return isValidStandaloneTake(clip)
    && (!Array.isArray(clip.takes) || clip.takes.every((take) => isValidTakeTree(take)));
}

function isTakeItemEditLocked(state: Pick<DAWState, "globalLocked" | "lockSettings">, entry: TakeClipEntry | null) {
  return !entry
    || Boolean(state.globalLocked)
    || Boolean(state.lockSettings?.items)
    || Boolean(entry.track.frozen)
    || Boolean(entry.clip.locked);
}

export function canExplodeClipTakes(state: Pick<DAWState, "tracks" | "globalLocked" | "lockSettings">, clipId: string) {
  const entry = findTakeClipEntry(state, clipId);
  return !isTakeItemEditLocked(state, entry)
    && Number.isFinite(entry?.clip.startTime)
    && Array.isArray(entry?.clip.takes)
    && entry.clip.takes.length > 0
    && entry.clip.takes.every((take) => isValidTakeTree(take));
}

function getImplodeTakeEntries(state: Pick<DAWState, "tracks" | "globalLocked" | "lockSettings">, clipIds: readonly string[]) {
  if (Boolean(state.globalLocked) || Boolean(state.lockSettings?.items)) return [];
  const seen = new Set<string>();
  const entries: TakeClipEntry[] = [];
  for (const clipId of clipIds) {
    if (seen.has(clipId)) continue;
    seen.add(clipId);
    const entry = findTakeClipEntry(state, clipId);
    if (
      isTakeItemEditLocked(state, entry)
      || !isValidTakeTree(entry?.clip)
      || !Number.isFinite(entry?.clip.startTime)
    ) continue;
    entries.push(entry!);
  }
  return entries;
}

export function canImplodeSelectedClipTakes(state: Pick<DAWState, "tracks" | "globalLocked" | "lockSettings">, clipIds: readonly string[]) {
  return getImplodeTakeEntries(state, clipIds).length >= 2;
}

function standaloneTakeSnapshot(clip: AudioClip): AudioClip {
  const snapshot = cloneTimelineClipDeep(clip) as AudioClip;
  return {
    ...snapshot,
    takes: undefined,
    activeTakeIndex: undefined,
  };
}

function flattenTakeSnapshots(clip: AudioClip): AudioClip[] {
  const nested = Array.isArray(clip.takes) ? clip.takes : [];
  return [
    standaloneTakeSnapshot(clip),
    ...nested.flatMap((take) => flattenTakeSnapshots(take)),
  ];
}

function cloneTakeSelection(state: Pick<DAWState, "selectedClipId" | "selectedClipIds" | "selectedTrackId" | "selectedTrackIds" | "lastSelectedTrackId">) {
  return {
    selectedClipId: state.selectedClipId,
    selectedClipIds: [...(state.selectedClipIds || [])],
    selectedTrackId: state.selectedTrackId,
    selectedTrackIds: [...(state.selectedTrackIds || [])],
    lastSelectedTrackId: state.lastSelectedTrackId,
  };
}

function enqueueTakeBackendWork(
  queue: { current: Promise<void> },
  context: string,
  work: () => Promise<void>,
) {
  queue.current = queue.current.then(work, work).catch(logBridgeError(context));
}

async function syncRenderInPlaceExecute(
  get: GetFn,
  renderedTrackId: string,
  insertIndex: number,
  renderedFilePath: string,
  syncSource?: () => Promise<void>,
) {
  await nativeBridge.addTrack(renderedTrackId, "audio");
  await nativeBridge.reorderTrack(renderedTrackId, insertIndex);
  if (syncSource) {
    await syncSource();
  }
  await get().syncClipsWithBackend?.();
  await nativeBridge.refreshWaveformPeaks(renderedFilePath);
}

async function syncRenderInPlaceUndo(
  get: GetFn,
  renderedTrackId: string,
  syncSource?: () => Promise<void>,
) {
  if (syncSource) {
    await syncSource();
  }
  await get().syncClipsWithBackend?.();
  await nativeBridge.removeTrack(renderedTrackId);
}

interface TrackSendLevelEditSnapshot {
  destTrackId: string;
  oldLevel: number;
}

interface TrackSendPanEditSnapshot {
  destTrackId: string;
  oldPan: number;
}

const trackSendLevelEditSnapshots = new Map<string, TrackSendLevelEditSnapshot>();
const trackSendPanEditSnapshots = new Map<string, TrackSendPanEditSnapshot>();
const trackStereoWidthEditSnapshots = new Map<string, number>();

function trackSendLevelEditKey(sourceTrackId: string, sendIndex: number) {
  return `${sourceTrackId}:${sendIndex}`;
}

function normalizeTrackSendLevel(level: unknown) {
  if (typeof level !== "number" || !Number.isFinite(level)) return null;
  return Math.max(0, Math.min(1, level));
}

function normalizeTrackSendPan(pan: unknown) {
  if (typeof pan !== "number" || !Number.isFinite(pan)) return null;
  return Math.max(-1, Math.min(1, pan));
}

async function applyTrackSendLevel(
  set: SetFn,
  get: GetFn,
  sourceTrackId: string,
  sendIndex: number,
  level: unknown,
  expectedDestTrackId: string | undefined,
  bridgeContext: string,
) {
  const nextLevel = normalizeTrackSendLevel(level);
  if (nextLevel === null) return false;
  const track = get().tracks.find((candidate) => candidate.id === sourceTrackId);
  const send = track?.sends?.[sendIndex];
  if (!send || (expectedDestTrackId && send.destTrackId !== expectedDestTrackId)) {
    return false;
  }
  if (send.level === nextLevel) return false;

  set((state) => ({
    tracks: state.tracks.map((candidate) => candidate.id === sourceTrackId
      ? {
          ...candidate,
          sends: candidate.sends.map((candidateSend, index: number) => index === sendIndex
            ? { ...candidateSend, level: nextLevel }
            : candidateSend),
        }
      : candidate),
    isModified: true,
  }));
  await nativeBridge.setTrackSendLevel(sourceTrackId, sendIndex, nextLevel)
    .catch(logBridgeError(bridgeContext));
  return true;
}

async function applyTrackSendPan(
  set: SetFn,
  get: GetFn,
  sourceTrackId: string,
  sendIndex: number,
  pan: unknown,
  expectedDestTrackId: string | undefined,
  bridgeContext: string,
) {
  const nextPan = normalizeTrackSendPan(pan);
  if (nextPan === null) return false;
  const track = get().tracks.find((candidate) => candidate.id === sourceTrackId);
  const send = track?.sends?.[sendIndex];
  if (!send || (expectedDestTrackId && send.destTrackId !== expectedDestTrackId)) {
    return false;
  }
  if (send.pan === nextPan) return false;

  set((state) => ({
    tracks: state.tracks.map((candidate) => candidate.id === sourceTrackId
      ? {
          ...candidate,
          sends: candidate.sends.map((candidateSend, index: number) => index === sendIndex
            ? { ...candidateSend, pan: nextPan }
            : candidateSend),
        }
      : candidate),
    isModified: true,
  }));
  await nativeBridge.setTrackSendPan(sourceTrackId, sendIndex, nextPan)
    .catch(logBridgeError(bridgeContext));
  return true;
}

async function applyTrackStereoWidth(
  set: SetFn,
  get: GetFn,
  trackId: string,
  widthPercent: unknown,
  bridgeContext: string,
) {
  if (typeof widthPercent !== "number" || !Number.isFinite(widthPercent)) return false;
  const nextWidth = Math.max(0, Math.min(200, widthPercent));
  const track = get().tracks.find((candidate) => candidate.id === trackId);
  if (!track || track.stereoWidth === nextWidth) return false;
  set((state) => ({
    tracks: state.tracks.map((candidate) => candidate.id === trackId
      ? { ...candidate, stereoWidth: nextWidth }
      : candidate),
    isModified: true,
  }));
  await nativeBridge.setTrackStereoWidth(trackId, nextWidth)
    .catch(logBridgeError(bridgeContext));
  return true;
}

export const renderingActions = (set: SetFn, get: GetFn) => ({

    // 9A: Reverse Clip
    reverseClip: async (clipId: string) => {
      const state = get();
      if (state.globalLocked || state.lockSettings?.items) return;
      let targetClip: AudioClip | null = null;
      let targetTrackId: string | null = null;
      let targetTrackFrozen = false;

      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          targetClip = clip;
          targetTrackId = track.id;
          targetTrackFrozen = Boolean(track.frozen);
          break;
        }
      }

      if (
        !targetClip
        || !targetTrackId
        || targetTrackFrozen
        || !targetClip.filePath
        || targetClip.locked
      ) return;

      const oldFilePath = targetClip.filePath;
      const wasReversed = !!targetClip.reversed;

      const reversedPath = await nativeBridge.reverseAudioFile(targetClip.filePath);
      if (!reversedPath) return;

      const currentTrack = get().tracks.find((track: Track) => track.id === targetTrackId);
      const currentClip = currentTrack?.clips.find((clip: AudioClip) => clip.id === clipId);
      if (
        !currentTrack
        || currentTrack.frozen
        || !currentClip
        || currentClip.locked
        || currentClip.filePath !== oldFilePath
        || get().globalLocked
        || get().lockSettings?.items
      ) return;

      const capturedTrackId = targetTrackId;
      const apply = (filePath: string, reversed: boolean) => {
        set((s) => ({
          tracks: s.tracks.map((t) => t.id === capturedTrackId
            ? {
                ...t,
                clips: t.clips.map((c) => c.id === clipId
                  ? { ...c, filePath, reversed }
                  : c),
              }
            : t),
          isModified: true,
        }));
        const sync = get().syncClipsWithBackend?.();
        if (sync?.catch) sync.catch(logBridgeError("sync reversed clip"));
      };
      apply(reversedPath, !wasReversed);
      commandManager.push({
        type: "REVERSE_CLIP",
        description: "Reverse clip",
        timestamp: Date.now(),
        execute: () => apply(reversedPath, !wasReversed),
        undo: () => apply(oldFilePath, wasReversed),
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
      const epoch = getProjectEpoch();
      const success = await nativeBridge.setMetronomeClickSound(filePath);
      const info = success ? await nativeBridge.getMetronomeSoundInfo(false) : null;
      if (getProjectEpoch() !== epoch) return false;
      if (success) {
        set({ metronomeClickPath: info?.selection ?? filePath });
        get().setModified(true);
      }
      return success;
    },
    setMetronomeAccentSound: async (filePath: string) => {
      const epoch = getProjectEpoch();
      const success = await nativeBridge.setMetronomeAccentSound(filePath);
      const info = success ? await nativeBridge.getMetronomeSoundInfo(true) : null;
      if (getProjectEpoch() !== epoch) return false;
      if (success) {
        set({ metronomeAccentPath: info?.selection ?? filePath });
        get().setModified(true);
      }
      return success;
    },
    resetMetronomeSounds: async () => {
      const epoch = getProjectEpoch();
      const success = await nativeBridge.resetMetronomeSounds();
      if (getProjectEpoch() !== epoch) return false;
      if (success) {
        set({ metronomeClickPath: "", metronomeAccentPath: "" });
        get().setModified(true);
      }
      return success;
    },

    // 9E: Dither
    setDitherType: (type) => set({ ditherType: type }),

    // 9F: Resample Quality
    setResampleQuality: (quality) => set({ resampleQuality: quality }),

    // ========== Phase 11: Send/Bus Routing ==========
    createBusFromSelectedTracks: async () => {
      const invocationState = get();
      if (invocationState.globalLocked) return false;
      const sourceTrackIds = Array.from(new Set(
        invocationState.selectedTrackIds.filter((trackId) => (
          invocationState.tracks.some((track) => track.id === trackId)
        )),
      ));
      if (sourceTrackIds.length === 0) {
        invocationState.showToast("Select tracks first to create a bus.", "info");
        return false;
      }

      const busId = crypto.randomUUID();
      const busName = `Bus ${invocationState.tracks.filter((track) => track.type === "bus").length + 1}`;
      const busTrack: Track = {
        ...createDefaultTrack(busId, busName, undefined, "bus", invocationState.tracks),
        id: busId,
        name: busName,
        type: "bus",
      };
      let nativeSendIndices = new Map<string, number>();
      const globalLockAbort = new Error("Global Lock enabled while creating a bus");

      const removeNativeResources = async (sendIndices: Map<string, number>) => {
        for (const [sourceTrackId, sendIndex] of [...sendIndices.entries()].reverse()) {
          await nativeBridge.removeTrackSend(sourceTrackId, sendIndex).catch(() => false);
        }
        await nativeBridge.removeTrack(busId).catch(() => false);
      };
      const addNativeResources = async (respectGlobalLock = false) => {
        if (respectGlobalLock && get().globalLocked) throw globalLockAbort;
        const addedId = await nativeBridge.addTrack(busId, "bus");
        if (!addedId) throw new Error("Backend rejected the new bus track");
        const addedSendIndices = new Map<string, number>();
        try {
          if (respectGlobalLock && get().globalLocked) throw globalLockAbort;
          for (const sourceTrackId of sourceTrackIds) {
            const sendIndex = await nativeBridge.addTrackSend(sourceTrackId, busId);
            if (!Number.isInteger(sendIndex) || sendIndex < 0) {
              throw new Error(`Backend rejected the send from ${sourceTrackId}`);
            }
            addedSendIndices.set(sourceTrackId, sendIndex);
            if (respectGlobalLock && get().globalLocked) throw globalLockAbort;
          }
          nativeSendIndices = addedSendIndices;
        } catch (error) {
          await removeNativeResources(addedSendIndices);
          throw error;
        }
      };
      const applyFrontend = (respectGlobalLock = false) => {
        const current = get();
        if ((respectGlobalLock && current.globalLocked)
            || current.tracks.some((track) => track.id === busId)
            || sourceTrackIds.some((trackId) => !current.tracks.some((track) => track.id === trackId))) {
          return false;
        }
        set((state) => ({
          tracks: [
            ...state.tracks.map((track) => sourceTrackIds.includes(track.id)
              ? {
                  ...track,
                  sends: [
                    ...track.sends,
                    { destTrackId: busId, level: 0.5, pan: 0, enabled: true, preFader: false, phaseInvert: false },
                  ],
                }
              : track),
            busTrack,
          ],
          isModified: true,
        }));
        return true;
      };
      const removeFrontend = () => set((state) => ({
        tracks: state.tracks
          .filter((track) => track.id !== busId)
          .map((track) => sourceTrackIds.includes(track.id)
            ? { ...track, sends: track.sends.filter((send) => send.destTrackId !== busId) }
            : track),
        selectedTrackId: state.selectedTrackId === busId ? null : state.selectedTrackId,
        selectedTrackIds: state.selectedTrackIds.filter((trackId) => trackId !== busId),
        lastSelectedTrackId: state.lastSelectedTrackId === busId ? null : state.lastSelectedTrackId,
        isModified: true,
      }));

      try {
        await addNativeResources(true);
        if (!applyFrontend(true)) {
          await removeNativeResources(nativeSendIndices);
          return false;
        }
      } catch (error) {
        if (error !== globalLockAbort) {
          logBridgeError("create bus from selected tracks")(
            error instanceof Error ? error : new Error("Could not create the bus"),
          );
        }
        return false;
      }

      let backendQueue = Promise.resolve();
      const enqueue = (context: string, work: () => Promise<void>) => {
        backendQueue = backendQueue.then(work, work).catch(logBridgeError(context));
      };
      commandManager.push({
        type: "CREATE_BUS_FROM_SELECTED_TRACKS",
        description: `Create ${busName} with ${sourceTrackIds.length} send${sourceTrackIds.length === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => enqueue("redo create bus", async () => {
          await addNativeResources(false);
          if (!applyFrontend()) await removeNativeResources(nativeSendIndices);
        }),
        undo: () => {
          removeFrontend();
          const indices = new Map(nativeSendIndices);
          enqueue("undo create bus", () => removeNativeResources(indices));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      get().showToast(`Created bus "${busName}" with ${sourceTrackIds.length} sends`, "success");
      return true;
    },

    addTrackSend: async (sourceTrackId, destTrackId) => {
      await editTrackSends(set, get, sourceTrackId, "Add send", sends => [...sends,
        { destTrackId, level: .5, pan: 0, enabled: true, preFader: false, phaseInvert: false, sourceChannel: 0 }]);
    },
    removeTrackSend: async (sourceTrackId, sendIndex) => {
      const destination = get().tracks.find(track => track.id === sourceTrackId)?.sends[sendIndex]?.destTrackId;
      await editTrackSends(set, get, sourceTrackId, "Remove send", sends => sends.filter(send => send.destTrackId !== destination));
    },
    beginTrackSendLevelEdit: (sourceTrackId, sendIndex) => {
      const key = trackSendLevelEditKey(sourceTrackId, sendIndex);
      if (trackSendLevelEditSnapshots.has(key)) return;
      const send = get().tracks
        .find((track) => track.id === sourceTrackId)
        ?.sends?.[sendIndex];
      if (!send) return;
      trackSendLevelEditSnapshots.set(key, {
        destTrackId: send.destTrackId,
        oldLevel: send.level,
      });
      get().beginAutomationParamTouch(sourceTrackId, sendAutomationParamId(send.destTrackId, "level"));
    },
    setTrackSendLevel: async (sourceTrackId, sendIndex, level) => {
      const key = trackSendLevelEditKey(sourceTrackId, sendIndex);
      const hadActiveEdit = trackSendLevelEditSnapshots.has(key);
      if (!hadActiveEdit) get().beginTrackSendLevelEdit(sourceTrackId, sendIndex);
      const snapshot = trackSendLevelEditSnapshots.get(key);
      if (snapshot) get().setAutomationWriteValue(sourceTrackId, sendAutomationParamId(snapshot.destTrackId, "level"), Math.max(0, Math.min(1, level)));
      const backendUpdate = applyTrackSendLevel(
        set,
        get,
        sourceTrackId,
        sendIndex,
        level,
        snapshot?.destTrackId,
        "track send level",
      );
      if (!hadActiveEdit) get().commitTrackSendLevelEdit(sourceTrackId, sendIndex);
      await backendUpdate;
    },
    commitTrackSendLevelEdit: (sourceTrackId, sendIndex) => {
      const key = trackSendLevelEditKey(sourceTrackId, sendIndex);
      const snapshot = trackSendLevelEditSnapshots.get(key);
      trackSendLevelEditSnapshots.delete(key);
      if (!snapshot) return;
      get().endAutomationParamTouch(sourceTrackId, sendAutomationParamId(snapshot.destTrackId, "level"));
      const send = get().tracks
        .find((track) => track.id === sourceTrackId)
        ?.sends?.[sendIndex];
      if (
        !send
        || send.destTrackId !== snapshot.destTrackId
        || send.level === snapshot.oldLevel
      ) {
        return;
      }
      const newLevel = send.level;

      commandManager.push({
        type: "SET_TRACK_SEND_LEVEL",
        description: "Adjust track send level",
        timestamp: Date.now(),
        execute: () => {
          void applyTrackSendLevel(
            set,
            get,
            sourceTrackId,
            sendIndex,
            newLevel,
            snapshot.destTrackId,
            "redo track send level",
          );
        },
        undo: () => {
          void applyTrackSendLevel(
            set,
            get,
            sourceTrackId,
            sendIndex,
            snapshot.oldLevel,
            snapshot.destTrackId,
            "undo track send level",
          );
        },
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },
    beginTrackSendPanEdit: (sourceTrackId, sendIndex) => {
      const key = trackSendLevelEditKey(sourceTrackId, sendIndex);
      if (trackSendPanEditSnapshots.has(key)) return;
      const send = get().tracks
        .find((track) => track.id === sourceTrackId)
        ?.sends?.[sendIndex];
      if (!send) return;
      trackSendPanEditSnapshots.set(key, {
        destTrackId: send.destTrackId,
        oldPan: send.pan,
      });
      get().beginAutomationParamTouch(sourceTrackId, sendAutomationParamId(send.destTrackId, "pan"));
    },
    setTrackSendPan: async (sourceTrackId, sendIndex, pan) => {
      const key = trackSendLevelEditKey(sourceTrackId, sendIndex);
      const hadActiveEdit = trackSendPanEditSnapshots.has(key);
      if (!hadActiveEdit) get().beginTrackSendPanEdit(sourceTrackId, sendIndex);
      const snapshot = trackSendPanEditSnapshots.get(key);
      if (snapshot) get().setAutomationWriteValue(sourceTrackId, sendAutomationParamId(snapshot.destTrackId, "pan"), Math.max(0, Math.min(1, (pan + 1) / 2)));
      const backendUpdate = applyTrackSendPan(
        set,
        get,
        sourceTrackId,
        sendIndex,
        pan,
        snapshot?.destTrackId,
        "track send pan",
      );
      if (!hadActiveEdit) get().commitTrackSendPanEdit(sourceTrackId, sendIndex);
      await backendUpdate;
    },
    commitTrackSendPanEdit: (sourceTrackId, sendIndex) => {
      const key = trackSendLevelEditKey(sourceTrackId, sendIndex);
      const snapshot = trackSendPanEditSnapshots.get(key);
      trackSendPanEditSnapshots.delete(key);
      if (!snapshot) return;
      get().endAutomationParamTouch(sourceTrackId, sendAutomationParamId(snapshot.destTrackId, "pan"));
      const send = get().tracks
        .find((track) => track.id === sourceTrackId)
        ?.sends?.[sendIndex];
      if (
        !send
        || send.destTrackId !== snapshot.destTrackId
        || send.pan === snapshot.oldPan
      ) {
        return;
      }
      const newPan = send.pan;

      commandManager.push({
        type: "SET_TRACK_SEND_PAN",
        description: "Adjust track send pan",
        timestamp: Date.now(),
        execute: () => {
          void applyTrackSendPan(
            set,
            get,
            sourceTrackId,
            sendIndex,
            newPan,
            snapshot.destTrackId,
            "redo track send pan",
          );
        },
        undo: () => {
          void applyTrackSendPan(
            set,
            get,
            sourceTrackId,
            sendIndex,
            snapshot.oldPan,
            snapshot.destTrackId,
            "undo track send pan",
          );
        },
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },
    setTrackSendEnabled: async (sourceTrackId, sendIndex, enabled) => {
      const epoch = getProjectEpoch();
      const destination = get().tracks.find(track => track.id === sourceTrackId)?.sends[sendIndex]?.destTrackId;
      const accepted = await editTrackSends(set, get, sourceTrackId, "Change send enabled", sends => sends.map(send => send.destTrackId === destination ? { ...send, enabled } : send));
      const current = get().tracks.find(track => track.id === sourceTrackId)?.sends.find(send => send.destTrackId === destination);
      if (accepted && epoch === getProjectEpoch() && destination && current?.enabled === enabled) {
        const param = sendAutomationParamId(destination, "mute");
        get().beginAutomationParamTouch(sourceTrackId, param);
        get().setAutomationWriteValue(sourceTrackId, param, enabled ? 0 : 1);
        get().recordAutomationWriteTick(Date.now());
        get().endAutomationParamTouch(sourceTrackId, param);
      }
    },
    setTrackSendPreFader: async (sourceTrackId, sendIndex, preFader) => {
      const destination = get().tracks.find(track => track.id === sourceTrackId)?.sends[sendIndex]?.destTrackId;
      await editTrackSends(set, get, sourceTrackId, "Change send fader position", sends => sends.map(send => send.destTrackId === destination ? { ...send, preFader } : send));
    },
    setTrackSendSourceChannel: async (sourceTrackId, sendIndex, sourceChannel) => {
      if (!Number.isInteger(sourceChannel) || sourceChannel < 0 || sourceChannel > 62 || sourceChannel % 2 !== 0) return;
      const destination = get().tracks.find(track => track.id === sourceTrackId)?.sends[sendIndex]?.destTrackId;
      await editTrackSends(set, get, sourceTrackId, "Change send output pair", sends => sends.map(send => send.destTrackId === destination ? { ...send, sourceChannel } : send));
    },
    setTrackSendPhaseInvert: async (sourceTrackId, sendIndex, phaseInvert) => {
      const destination = get().tracks.find(track => track.id === sourceTrackId)?.sends[sendIndex]?.destTrackId;
      await editTrackSends(set, get, sourceTrackId, "Change send phase", sends => sends.map(send => send.destTrackId === destination ? { ...send, phaseInvert } : send));
    },
    setTrackPhaseInvert: async (trackId, invert) => {
      const track = get().tracks.find((candidate) => candidate.id === trackId);
      if (!track || track.phaseInverted === invert) return;
      const oldValue = !!track.phaseInverted;
      const applyPhaseInvert = async (phaseInverted: boolean) => {
        set((state) => ({
          tracks: state.tracks.map((candidate) => candidate.id === trackId
            ? { ...candidate, phaseInverted }
            : candidate),
          isModified: true,
        }));
        await nativeBridge.setTrackPhaseInvert(trackId, phaseInverted).catch(logBridgeError("track phase invert"));
      };

      await applyPhaseInvert(invert);
      commandManager.push({
        type: "SET_TRACK_PHASE_INVERT",
        description: invert ? "Invert track phase" : "Restore track phase",
        timestamp: Date.now(),
        execute: () => {
          void applyPhaseInvert(invert).catch(logBridgeError("redo track phase invert"));
        },
        undo: () => {
          void applyPhaseInvert(oldValue).catch(logBridgeError("undo track phase invert"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    beginTrackStereoWidthEdit: (trackId) => {
      if (trackStereoWidthEditSnapshots.has(trackId)) return;
      const track = get().tracks.find((candidate) => candidate.id === trackId);
      if (!track) return;
      trackStereoWidthEditSnapshots.set(trackId, track.stereoWidth);
    },
    setTrackStereoWidth: async (trackId, widthPercent) => {
      const hadActiveEdit = trackStereoWidthEditSnapshots.has(trackId);
      if (!hadActiveEdit) get().beginTrackStereoWidthEdit(trackId);
      const backendUpdate = applyTrackStereoWidth(
        set,
        get,
        trackId,
        widthPercent,
        "track stereo width",
      );
      if (!hadActiveEdit) get().commitTrackStereoWidthEdit(trackId);
      await backendUpdate;
    },
    commitTrackStereoWidthEdit: (trackId) => {
      const oldWidth = trackStereoWidthEditSnapshots.get(trackId);
      trackStereoWidthEditSnapshots.delete(trackId);
      if (oldWidth === undefined) return;
      const track = get().tracks.find((candidate) => candidate.id === trackId);
      if (!track || track.stereoWidth === oldWidth) return;
      const newWidth = track.stereoWidth;

      commandManager.push({
        type: "SET_TRACK_STEREO_WIDTH",
        description: "Adjust track stereo width",
        timestamp: Date.now(),
        execute: () => {
          void applyTrackStereoWidth(
            set,
            get,
            trackId,
            newWidth,
            "redo track stereo width",
          );
        },
        undo: () => {
          void applyTrackStereoWidth(
            set,
            get,
            trackId,
            oldWidth,
            "undo track stereo width",
          );
        },
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
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
    setTrackMIDIOutputMergeKeys: async (trackId, merge) => {
      const track = get().tracks.find(candidate => candidate.id === trackId);
      if (!track || get().globalLocked || Boolean(track.midiOutputMergeKeys) === merge) return;
      const before = Boolean(track.midiOutputMergeKeys);
      const projectEpoch = getProjectEpoch();
      try {
        if (!await nativeBridge.setTrackMIDIOutputMergeKeys(trackId, merge)) throw Error("Native MIDI output policy was rejected");
      } catch (error) { get().showToast("Could not change MIDI output overlap policy", "error"); logBridgeError("MIDI overlap policy")(error); return; }
      if (projectEpoch !== getProjectEpoch() || !get().tracks.some(candidate => candidate.id === trackId)) return;
      if (get().globalLocked) { void nativeBridge.setTrackMIDIOutputMergeKeys(trackId, before).catch(logBridgeError("MIDI overlap rollback")); return; }
      const update = (value: boolean) => set(state => ({ tracks: state.tracks.map(candidate => candidate.id === trackId ? { ...candidate, midiOutputMergeKeys: value } : candidate), isModified: true }));
      const replay = (value: boolean) => { if (projectEpoch !== getProjectEpoch() || !get().tracks.some(candidate => candidate.id === trackId)) return; update(value); void nativeBridge.setTrackMIDIOutputMergeKeys(trackId, value).catch(logBridgeError("MIDI overlap history")); };
      update(merge);
      commandManager.push({ type: "SET_TRACK_MIDI_OVERLAP", description: `MIDI key overlap for ${track.name}`, timestamp: Date.now(), execute: () => replay(merge), undo: () => replay(before) });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
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
      if (get().globalLocked) return;
      const validMemberIds = Array.from(new Set(memberTrackIds)).filter((trackId) =>
        get().tracks.some((track) => track.id === trackId),
      );
      if (validMemberIds.length < 2) return;
      const group = {
        id: crypto.randomUUID(),
        name,
        leadTrackId: validMemberIds.includes(leadTrackId) ? leadTrackId : validMemberIds[0],
        memberTrackIds: validMemberIds,
        linkedParams: Array.from(new Set(linkedParams)),
      };
      const targetIds = new Set(validMemberIds);
      const before = get().trackGroups.map((candidate) => ({
        ...candidate,
        memberTrackIds: [...candidate.memberTrackIds],
        linkedParams: [...candidate.linkedParams],
      }));
      const retainedGroups = before.flatMap((candidate) => {
        const retainedMemberIds = candidate.memberTrackIds.filter((trackId) => !targetIds.has(trackId));
        if (retainedMemberIds.length < 2) return [];
        return [{
          ...candidate,
          memberTrackIds: retainedMemberIds,
          leadTrackId: retainedMemberIds.includes(candidate.leadTrackId)
            ? candidate.leadTrackId
            : retainedMemberIds[0],
        }];
      });
      const after = [...retainedGroups, group];
      const applyGroups = (trackGroups: DAWState["trackGroups"]) => set({
        trackGroups: trackGroups.map((candidate) => ({
          ...candidate,
          memberTrackIds: [...candidate.memberTrackIds],
          linkedParams: [...candidate.linkedParams],
        })),
        isModified: true,
      });
      commandManager.execute({
        type: "ADD_TRACK_GROUP",
        description: `Link ${validMemberIds.length} tracks`,
        timestamp: Date.now(),
        execute: () => applyGroups(after),
        undo: () => applyGroups(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    removeTrackGroup: (groupId) => {
      const state = get();
      if (state.globalLocked) return;
      const groupIndex = state.trackGroups.findIndex((group) => group.id === groupId);
      if (groupIndex < 0) return;
      const group = {
        ...state.trackGroups[groupIndex],
        memberTrackIds: [...state.trackGroups[groupIndex].memberTrackIds],
        linkedParams: [...state.trackGroups[groupIndex].linkedParams],
      };
      commandManager.execute({
        type: "REMOVE_TRACK_GROUP",
        description: `Unlink track group "${group.name}"`,
        timestamp: Date.now(),
        execute: () => set((current) => ({
          trackGroups: current.trackGroups.filter((candidate) => candidate.id !== groupId),
          isModified: true,
        })),
        undo: () => set((current) => {
          if (current.trackGroups.some((candidate) => candidate.id === groupId)) return current;
          const trackGroups = [...current.trackGroups];
          trackGroups.splice(Math.min(groupIndex, trackGroups.length), 0, group);
          return { trackGroups, isModified: true };
        }),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    updateTrackGroup: (groupId, updates) => {
      if (get().globalLocked) return;
      const currentGroup = get().trackGroups.find((group) => group.id === groupId);
      if (!currentGroup) return;
      const before = {
        ...currentGroup,
        memberTrackIds: [...currentGroup.memberTrackIds],
        linkedParams: [...currentGroup.linkedParams],
      };
      const after = {
        ...before,
        ...updates,
        memberTrackIds: updates.memberTrackIds ? [...updates.memberTrackIds] : before.memberTrackIds,
        linkedParams: updates.linkedParams ? [...updates.linkedParams] : before.linkedParams,
      };
      const applyGroup = (group: DAWState["trackGroups"][number]) => set((state) => ({
        trackGroups: state.trackGroups.map((candidate) => candidate.id === groupId ? group : candidate),
        isModified: true,
      }));
      commandManager.execute({
        type: "UPDATE_TRACK_GROUP",
        description: `Update track group "${before.name}"`,
        timestamp: Date.now(),
        execute: () => applyGroup(after),
        undo: () => applyGroup(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    unlinkTracksFromGroups: (trackIds) => {
      if (get().globalLocked) return;
      const targetIds = new Set(trackIds);
      if (targetIds.size === 0) return;
      const before = get().trackGroups.map((group) => ({
        ...group,
        memberTrackIds: [...group.memberTrackIds],
        linkedParams: [...group.linkedParams],
      }));
      const after = before.flatMap((group) => {
        const memberTrackIds = group.memberTrackIds.filter((trackId) => !targetIds.has(trackId));
        if (memberTrackIds.length < 2) return [];
        return [{
          ...group,
          memberTrackIds,
          leadTrackId: memberTrackIds.includes(group.leadTrackId) ? group.leadTrackId : memberTrackIds[0],
        }];
      });
      const changed = before.some((group) => {
        const next = after.find((candidate) => candidate.id === group.id);
        return !next
          || next.leadTrackId !== group.leadTrackId
          || next.memberTrackIds.length !== group.memberTrackIds.length
          || next.memberTrackIds.some((id, memberIndex) => id !== group.memberTrackIds[memberIndex]);
      }) || before.length !== after.length;
      if (!changed) return;
      const applyGroups = (trackGroups: DAWState["trackGroups"]) => set({
        trackGroups: trackGroups.map((group) => ({
          ...group,
          memberTrackIds: [...group.memberTrackIds],
          linkedParams: [...group.linkedParams],
        })),
        isModified: true,
      });
      commandManager.execute({
        type: "UNLINK_TRACKS_FROM_GROUPS",
        description: targetIds.size === 1 ? "Unlink track" : `Unlink ${targetIds.size} tracks`,
        timestamp: Date.now(),
        execute: () => applyGroups(after),
        undo: () => applyGroups(before),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
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
    setRenderDialogOptions: (options) =>
      set((s) => ({ renderDialogOptions: { ...s.renderDialogOptions, ...options } })),
    resetRenderDialogOptions: () =>
      set({ renderDialogOptions: createDefaultRenderDialogOptions() }),
    setLastRenderDirectory: (dir) => set({ lastRenderDirectory: dir }),
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
          clips: serializeMIDIClipsForBackend(t.midiClips, t.midiEffects || []).map((c) => ({
            startTime: c.startTime,
            duration: c.duration,
            events: c.events,
          })),
      }));
      if (midiTracks.length === 0) {
        get().showToast("No MIDI clips to export.", "info");
        return false;
      }
      const filePath = await nativeBridge.showSaveDialog("OpenStudio Project.mid", "Export Project MIDI", "*.mid;*.midi");
      if (!filePath) return false;
      const success = await nativeBridge.exportProjectMIDI(filePath, midiTracks);
      get().showToast(success ? "Project MIDI exported" : "Failed to export project MIDI", success ? "success" : "error");
      return success;
    },
    consolidateTrack: async (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track
          || state.globalLocked
          || state.lockSettings?.items
          || track.frozen
          || track.clips.length === 0
          || track.clips.some((clip) => clip.locked)) return null;
      const remainsEditable = () => {
        const current = get();
        const currentTrack = current.tracks.find((candidate) => candidate.id === trackId);
        return !current.globalLocked
          && !current.lockSettings?.items
          && currentTrack === track
          && !currentTrack.frozen
          && currentTrack.clips.length > 0
          && currentTrack.clips.every((clip) => !clip.locked);
      };
      const sourceClips = track.clips.map((clip) => ({
        ...clip,
        gainEnvelope: clip.gainEnvelope?.map((point) => ({ ...point })),
      }));
      const earliest = Math.min(...track.clips.map((c) => c.startTime));
      const latest = Math.max(...track.clips.map((c) => c.startTime + c.duration));
      const fileName = `${track.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_consolidated.wav`;
      const filePath = await nativeBridge.showRenderSaveDialog(fileName, "wav");
      if (!filePath || !remainsEditable()) return null;
      await prepareForManualRender(get().syncClipsWithBackend, "consolidate-track");
      if (!remainsEditable()) return null;
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
        includeMetronome: false,
      });
      if (success && remainsEditable()) {
        const consolidatedClip = {
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
        };
        const selectionBefore = {
          selectedClipId: state.selectedClipId,
          selectedClipIds: [...state.selectedClipIds],
        };
        const applyClips = (clips: AudioClip[], selection: Pick<DAWState, "selectedClipId" | "selectedClipIds">) => {
          set((current) => ({
            tracks: current.tracks.map((candidate) => candidate.id === trackId
              ? { ...candidate, clips }
              : candidate),
            ...selection,
            isModified: true,
          }));
          void get().syncClipsWithBackend().catch(logBridgeError("sync consolidated track"));
        };
        commandManager.execute({
          type: "CONSOLIDATE_TRACK",
          description: `Consolidate track "${track.name}"`,
          timestamp: Date.now(),
          execute: () => applyClips([consolidatedClip], {
            selectedClipId: consolidatedClip.id,
            selectedClipIds: [consolidatedClip.id],
          }),
          undo: () => applyClips(sourceClips, selectionBefore),
        });
        set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        return filePath;
      }
      return null;
    },

    renderClipInPlace: async (clipId) => {
      const state = get();
      // Find the clip and its track
      let sourceClip: AudioClip | MIDIClip | null = null;
      let sourceTrack: Track | null = null;
      let sourceTrackIndex = -1;
      for (let i = 0; i < state.tracks.length; i++) {
        const clip =
          state.tracks[i].clips.find((c) => c.id === clipId) ||
          state.tracks[i].midiClips.find((c) => c.id === clipId);
        if (clip) {
          sourceClip = clip;
          sourceTrack = state.tracks[i];
          sourceTrackIndex = i;
          break;
        }
      }
      if (!sourceClip
          || !sourceTrack
          || sourceTrack.frozen
          || isClipEditLocked(state, sourceClip)) return;
      const remainsEditable = () => {
        const current = get();
        const currentTrack = current.tracks.find((track) => track.id === sourceTrack.id);
        const currentClip = currentTrack
          ? [...currentTrack.clips, ...currentTrack.midiClips].find((clip) => clip.id === clipId)
          : null;
        return currentTrack === sourceTrack
          && currentClip === sourceClip
          && !currentTrack.frozen
          && !isClipEditLocked(current, currentClip);
      };

      const startTime = sourceClip.startTime;
      const endTime = sourceClip.startTime + sourceClip.duration;
      const sourceClipName = sourceClip.name || "Clip";
      const safeName = sourceClipName.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = await nativeBridge.showRenderSaveDialog(`${safeName}_rendered.wav`, "wav");
      if (!filePath || !remainsEditable()) return;
      await prepareForManualRender(get().syncClipsWithBackend, "render-clip-in-place");
      if (!remainsEditable()) return;

      const success = await nativeBridge.renderProject({
        source: `stem:${sourceTrack.id}`,
        startTime,
        endTime,
        filePath,
        format: "wav",
        // Render in place should match live playback. Passing 0 lets the
        // backend use the current audio-device rate instead of a stale project
        // export setting.
        sampleRate: 0,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: false,
        tailLength: 0,
        includeMetronome: false,
      });
      if (!success || !remainsEditable()) return;

      const mediaInfo = await nativeBridge.importMediaFile(filePath);
      if (!remainsEditable()) return;
      const renderedDuration = endTime - startTime;
      const sourceLength = mediaInfo?.duration || renderedDuration;
      const newTrackId = crypto.randomUUID();
      const newTrack = {
        ...createDefaultTrack(newTrackId, `${sourceTrack.name} (Rendered)`, sourceTrack.color, "audio", state.tracks),
        clips: [],
      };
      const renderedClip = {
        id: crypto.randomUUID(),
        filePath,
        name: `${sourceClipName} (Rendered)`,
        startTime,
        duration: renderedDuration,
        offset: 0,
        color: sourceClip.color || sourceTrack.color,
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
        sampleRate: mediaInfo?.sampleRate,
        sourceLength,
      };
      const oldMuted = !!sourceClip.muted;
      const isMidi = sourceTrack.midiClips.some((clip) => clip.id === clipId);
      const selectionBefore = {
        selectedClipId: state.selectedClipId,
        selectedClipIds: [...state.selectedClipIds],
        selectedTrackId: state.selectedTrackId,
        selectedTrackIds: [...state.selectedTrackIds],
        lastSelectedTrackId: state.lastSelectedTrackId,
      };

      commandManager.execute({
        type: "RENDER_CLIP_IN_PLACE",
        description: `Render "${sourceClipName}" in place`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => {
            const tracks = s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: true } : clip,
              ),
              midiClips: track.midiClips.map((clip) =>
                clip.id === clipId ? { ...clip, muted: true } : clip,
              ),
            }));
            const insertIndex = Math.max(0, Math.min(sourceTrackIndex + 1, tracks.length));
            tracks.splice(insertIndex, 0, { ...newTrack, clips: [renderedClip] });
            return {
              tracks,
              selectedClipId: renderedClip.id,
              selectedClipIds: [renderedClip.id],
              selectedTrackId: null,
              selectedTrackIds: [],
              lastSelectedTrackId: null,
              isModified: true,
            };
          });
          void syncRenderInPlaceExecute(
            get,
            newTrackId,
            sourceTrackIndex + 1,
            renderedClip.filePath,
            isMidi
              ? () => get().syncMIDITrackToBackend?.(sourceTrack.id, { debounce: false }) ?? Promise.resolve()
              : undefined,
          ).catch(logBridgeError("sync"));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks
              .filter((track) => track.id !== newTrackId)
              .map((track) => ({
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === clipId ? { ...clip, muted: oldMuted } : clip,
                ),
                midiClips: track.midiClips.map((clip) =>
                  clip.id === clipId ? { ...clip, muted: oldMuted } : clip,
                ),
              })),
            ...selectionBefore,
            isModified: true,
          }));
          void syncRenderInPlaceUndo(
            get,
            newTrackId,
            isMidi
              ? () => get().syncMIDITrackToBackend?.(sourceTrack.id, { debounce: false }) ?? Promise.resolve()
              : undefined,
          ).catch(logBridgeError("sync"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    renderTrackInPlace: async (trackId) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track || state.globalLocked || state.lockSettings?.items || track.frozen) return;
      const timelineClips = [...(track.clips || []), ...(track.midiClips || [])];
      if (timelineClips.length === 0 || timelineClips.some((clip) => clip.locked)) return;
      const remainsEditable = () => {
        const current = get();
        const currentTrack = current.tracks.find((candidate) => candidate.id === trackId);
        return !current.globalLocked
          && !current.lockSettings?.items
          && currentTrack === track
          && !currentTrack.frozen
          && [...currentTrack.clips, ...currentTrack.midiClips].every((clip) => !clip.locked);
      };

      const sourceTrackIndex = state.tracks.findIndex((t) => t.id === trackId);
      const earliest = Math.min(...timelineClips.map((c) => c.startTime));
      const latest = Math.max(...timelineClips.map((c) => c.startTime + c.duration));
      const safeName = track.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = await nativeBridge.showRenderSaveDialog(`${safeName}_rendered.wav`, "wav");
      if (!filePath || !remainsEditable()) return;
      await prepareForManualRender(get().syncClipsWithBackend, "render-track-in-place");
      if (!remainsEditable()) return;

      const success = await nativeBridge.renderProject({
        source: `stem:${trackId}`,
        startTime: earliest,
        endTime: latest,
        filePath,
        format: "wav",
        sampleRate: 0,
        bitDepth: state.projectBitDepth || 24,
        channels: 2,
        normalize: false,
        addTail: false,
        tailLength: 0,
        includeMetronome: false,
      });
      if (!success || !remainsEditable()) return;

      const mediaInfo = await nativeBridge.importMediaFile(filePath);
      if (!remainsEditable()) return;
      const renderedDuration = latest - earliest;
      const sourceLength = mediaInfo?.duration || renderedDuration;
      const newTrackId = crypto.randomUUID();
      const newTrack = {
        ...createDefaultTrack(newTrackId, `${track.name} (Rendered)`, track.color, "audio", state.tracks),
        clips: [],
      };
      const renderedClip = {
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
        sourceLength,
      };
      const oldMuted = !!track.muted;
      const selectionBefore = {
        selectedClipId: state.selectedClipId,
        selectedClipIds: [...state.selectedClipIds],
        selectedTrackId: state.selectedTrackId,
        selectedTrackIds: [...state.selectedTrackIds],
        lastSelectedTrackId: state.lastSelectedTrackId,
      };

      commandManager.execute({
        type: "RENDER_TRACK_IN_PLACE",
        description: `Render "${track.name}" in place`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => {
            const tracks = s.tracks.map((entry) =>
              entry.id === trackId ? { ...entry, muted: true } : entry,
            );
            const insertIndex = Math.max(0, Math.min(sourceTrackIndex + 1, tracks.length));
            tracks.splice(insertIndex, 0, { ...newTrack, clips: [renderedClip] });
            return {
              tracks,
              selectedClipId: renderedClip.id,
              selectedClipIds: [renderedClip.id],
              selectedTrackId: null,
              selectedTrackIds: [],
              lastSelectedTrackId: null,
              isModified: true,
            };
          });
          void syncRenderInPlaceExecute(
            get,
            newTrackId,
            sourceTrackIndex + 1,
            renderedClip.filePath,
            () => nativeBridge.setTrackMute(trackId, true).then(() => undefined),
          ).catch(logBridgeError("sync"));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks
              .filter((entry) => entry.id !== newTrackId)
              .map((entry) => entry.id === trackId ? { ...entry, muted: oldMuted } : entry),
            ...selectionBefore,
            isModified: true,
          }));
          void syncRenderInPlaceUndo(
            get,
            newTrackId,
            () => nativeBridge.setTrackMute(trackId, oldMuted).then(() => undefined),
          ).catch(logBridgeError("sync"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ===== Phase 13: Advanced Editing =====
    setClipFadeInShape: (clipId, shape) => {
      const clip = get().tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === clipId);
      if (!clip || !Number.isFinite(shape)) return;
      const oldShape = clip.fadeInShape ?? 0;
      const nextShape = Math.max(0, Math.min(4, Math.round(shape)));
      if (oldShape === nextShape) return;
      const applyShape = (fadeInShape: number) => set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((candidate) => candidate.id === clipId
            ? { ...candidate, fadeInShape }
            : candidate),
        })),
        isModified: true,
      }));
      commandManager.execute({
        type: "SET_CLIP_FADE_IN_SHAPE",
        description: "Set clip fade-in shape",
        timestamp: Date.now(),
        execute: () => applyShape(nextShape),
        undo: () => applyShape(oldShape),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    setClipFadeOutShape: (clipId, shape) => {
      const clip = get().tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === clipId);
      if (!clip || !Number.isFinite(shape)) return;
      const oldShape = clip.fadeOutShape ?? 0;
      const nextShape = Math.max(0, Math.min(4, Math.round(shape)));
      if (oldShape === nextShape) return;
      const applyShape = (fadeOutShape: number) => set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((candidate) => candidate.id === clipId
            ? { ...candidate, fadeOutShape }
            : candidate),
        })),
        isModified: true,
      }));
      commandManager.execute({
        type: "SET_CLIP_FADE_OUT_SHAPE",
        description: "Set clip fade-out shape",
        timestamp: Date.now(),
        execute: () => applyShape(nextShape),
        undo: () => applyShape(oldShape),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
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
    explodeTakes: async (clipId) => {
      const state = get();
      if (!canExplodeClipTakes(state, clipId)) return;
      const source = findTakeClipEntry(state, clipId)!;
      const explodedTakes = source.clip.takes!.flatMap((take) => flattenTakeSnapshots(take));
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const selection = cloneTakeSelection(state);
      const newTracks = explodedTakes.map((take, index) => {
        const trackId = crypto.randomUUID();
        const newTrack = createDefaultTrack(
          trackId,
          `${source.track.name} - Take ${index + 1}`,
          source.track.color,
          "audio",
          [...state.tracks],
        );
        newTrack.clips = [{
          ...take,
          id: crypto.randomUUID(),
          startTime: source.clip.startTime,
          takes: undefined,
          activeTakeIndex: undefined,
        }];
        return newTrack;
      });
      const nextTracks = cloneTracksForTimelineUndo([
        ...state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip: AudioClip) => clip.id === source.clip.id
            ? { ...cloneTimelineClipDeep(clip), takes: undefined, activeTakeIndex: undefined }
            : clip),
        })),
        ...newTracks,
      ]);
      const backendQueue = { current: Promise.resolve() };

      const removeExplodedTracksFromBackend = async (tracks = newTracks) => {
        for (const track of [...tracks].reverse()) {
          await nativeBridge.removeTrack(track.id).catch(logBridgeError("remove exploded take track"));
        }
      };

      const addExplodedTracksToBackend = async () => {
        const addedTracks: typeof newTracks = [];
        try {
          for (const track of newTracks) {
            const addedId = await nativeBridge.addTrack(track.id, track.type);
            if (addedId !== track.id) {
              if (addedId) {
                await nativeBridge.removeTrack(addedId).catch(logBridgeError("remove rejected exploded take track"));
              }
              throw new Error(`Backend rejected exploded take track ${track.id}`);
            }
            addedTracks.push(track);
          }
          for (const track of newTracks) {
            const index = nextTracks.findIndex((candidate) => candidate.id === track.id);
            const reordered = index >= 0 && await nativeBridge.reorderTrack(track.id, index);
            if (!reordered) {
              throw new Error(`Backend could not position exploded take track ${track.id}`);
            }
          }
        } catch (error) {
          await removeExplodedTracksFromBackend(addedTracks);
          throw error;
        }
      };

      const restoreOldStateAfterFailedSync = async () => {
        set({
          tracks: cloneTracksForTimelineUndo(oldTracks),
          ...selection,
          isModified: state.isModified,
        });
        await get().syncClipsWithBackend?.().catch(logBridgeError("restore clips after failed take explosion"));
        await removeExplodedTracksFromBackend();
      };

      const applyRedo = () => {
        enqueueTakeBackendWork(backendQueue, "redo exploded takes", async () => {
          try {
            await addExplodedTracksToBackend();
            set({
              tracks: cloneTracksForTimelineUndo(nextTracks),
              ...selection,
              isModified: true,
            });
            try {
              await get().syncClipsWithBackend?.();
            } catch (error) {
              await restoreOldStateAfterFailedSync();
              throw error;
            }
          } catch (error) {
            logBridgeError("redo exploded takes")(error);
          }
        });
      };

      try {
        await addExplodedTracksToBackend();
      } catch (error) {
        logBridgeError("explode takes")(error);
        return;
      }

      // Do not overwrite intervening project edits or ignore a lock/freeze that
      // was enabled while native tracks were being provisioned.
      if (get().tracks !== state.tracks || !canExplodeClipTakes(get(), clipId)) {
        await removeExplodedTracksFromBackend();
        return;
      }

      set({
        tracks: cloneTracksForTimelineUndo(nextTracks),
        ...selection,
        isModified: true,
      });
      try {
        await get().syncClipsWithBackend?.();
      } catch (error) {
        await restoreOldStateAfterFailedSync();
        logBridgeError("sync exploded takes")(error);
        return;
      }

      commandManager.push({
        type: "EXPLODE_CLIP_TAKES",
        description: `Explode ${explodedTakes.length} take${explodedTakes.length === 1 ? "" : "s"} to new tracks`,
        timestamp: Date.now(),
        execute: applyRedo,
        undo: () => {
          set({
            tracks: cloneTracksForTimelineUndo(oldTracks),
            ...selection,
            isModified: true,
          });
          enqueueTakeBackendWork(backendQueue, "undo exploded takes", async () => {
            try {
              await get().syncClipsWithBackend?.();
            } finally {
              await removeExplodedTracksFromBackend();
            }
          });
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    implodeTakes: (clipIds) => {
      const state = get();
      const entries = getImplodeTakeEntries(state, clipIds);
      if (entries.length < 2) return;
      const main = entries[0];
      const removedEntries = entries.slice(1);
      const removedIds = new Set(removedEntries.map((entry) => entry.clip.id));
      const existingTakes = (main.clip.takes || []).flatMap((take) => flattenTakeSnapshots(take));
      const implodedTakes = removedEntries.flatMap((entry) => flattenTakeSnapshots(entry.clip));
      const combinedTakes = [...existingTakes, ...implodedTakes].map((take) => standaloneTakeSnapshot(take));
      const oldTracks = cloneTracksForTimelineUndo(state.tracks);
      const selectionBefore = cloneTakeSelection(state);
      const selectionAfter = {
        ...selectionBefore,
        selectedClipId: selectionBefore.selectedClipId !== null && removedIds.has(selectionBefore.selectedClipId)
          ? main.clip.id
          : selectionBefore.selectedClipId,
        selectedClipIds: selectionBefore.selectedClipIds.filter((id: string) => !removedIds.has(id)),
      };
      if (
        selectionAfter.selectedClipIds.length > 0
        && !selectionAfter.selectedClipIds.includes(main.clip.id)
      ) {
        selectionAfter.selectedClipIds.push(main.clip.id);
      }
      const nextTracks = cloneTracksForTimelineUndo(state.tracks.map((track) => ({
        ...track,
        clips: track.clips
          .filter((clip: AudioClip) => !removedIds.has(clip.id))
          .map((clip: AudioClip) => clip.id === main.clip.id
            ? {
                ...cloneTimelineClipDeep(clip),
                takes: combinedTakes.map((take) => standaloneTakeSnapshot(take)),
                activeTakeIndex: clip.activeTakeIndex ?? 0,
              }
            : clip),
      })));
      const backendQueue = { current: Promise.resolve() };

      const applyImplodedState = (
        tracks: Track[],
        selection: ReturnType<typeof cloneTakeSelection>,
        context: string,
      ) => {
        set({
          tracks: cloneTracksForTimelineUndo(tracks),
          ...selection,
          isModified: true,
        });
        enqueueTakeBackendWork(backendQueue, context, async () => {
          await get().syncClipsWithBackend?.();
        });
      };

      commandManager.execute({
        type: "IMPLODE_CLIPS_TO_TAKES",
        description: `Implode ${entries.length} clips into takes`,
        timestamp: Date.now(),
        execute: () => applyImplodedState(nextTracks, selectionAfter, "sync imploded takes"),
        undo: () => applyImplodedState(oldTracks, selectionBefore, "undo imploded takes"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
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
      let persistenceFailed = false;
      set((s) => {
        const updated = withMouseModifierOverride(s.mouseModifiers, context, modifiers, action);
        if (!updated) return {};
        if (!persistMouseModifierOverrides(updated)) {
          persistenceFailed = true;
          return {};
        }
        return { mouseModifiers: updated };
      });
      if (persistenceFailed) {
        get().showToast("The mouse modifier could not be saved to local storage.", "error");
      }
    },
    resetMouseModifiers: () => {
      if (!persistMouseModifierOverrides({})) {
        get().showToast("The mouse modifier reset could not be saved to local storage.", "error");
        return;
      }
      set({ mouseModifiers: {} });
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
      if (!resolvePitchClipTarget(get(), { trackId, clipId })) {
        get().showToast("Choose an available, unlocked audio clip on an unfrozen track to edit pitch.", "info");
        return;
      }
      const epoch = getProjectEpoch();
      set({ showPitchEditor: true, pitchEditorTrackId: trackId, pitchEditorClipId: clipId, pitchEditorFxIndex: fxIndex });
      usePitchEditorStore.getState().open(trackId, clipId, fxIndex);
      void nativeBridge.pitchEditorSession("status").then((status) => {
        const current = get();
        if (epoch !== getProjectEpoch() || !current.showPitchEditor
          || current.pitchEditorTrackId !== trackId || current.pitchEditorClipId !== clipId) return;
        if (status && typeof status === "object" && "state" in status && status.state === "visible")
          void nativeBridge.pitchEditorSession("open");
      }).catch(() => {});
    },
    closePitchEditor: () => {
      set({ showPitchEditor: false, pitchEditorTrackId: null, pitchEditorClipId: null, pitchEditorFxIndex: 0 });
      cancelPitchEditorGesture();
    },
    setLowerZoneHeight: (h) => {
      const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 900;
      const maxHeight = Math.max(180, Math.round(viewportHeight * 0.85));
      set({ lowerZoneHeight: Math.max(180, Math.min(maxHeight, h)) });
    },
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
        const tracks = regions.map((r) => ({
          startTime: r.startTime,
          endTime: r.endTime,
          title: r.name,
          isrc: "",
        }));
        return await nativeBridge.exportDDP(sourceWavPath, outputDir, tracks, catalogNumber);
      } catch (err) {
        console.error("[Store] Failed to export DDP:", err);
        return false;
      }
    },

} satisfies Partial<DAWActions>);
