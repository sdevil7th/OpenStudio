// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError, toastBridgeError } from "../../utils/bridgeErrorHandler";
import { createDefaultTrack } from "../useDAWStore";
import { syncTrackMIDIClipsToBackend } from "../../utils/midiClipSerialization";
import { buildTrackRenameChanges } from "../../utils/trackRename";
import { buildTrackFolderGroupPlan } from "../../utils/trackFolderGrouping";
import { notifyInstrumentChanged } from "../../utils/fxChain";
import { isClipEditLocked } from "../../utils/clipEditLock";
import {
  getLinkedTrackIds,
  _linkingInProgress,
  _editSnapshots,
  _autoRecordTimers,
  _automationTouchedParams,
  _automationLatchedParams,
  automationTouchKey,
  syncAutomationLaneToBackend,
} from "./storeHelpers";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

interface TrackVolumeBatchEdit {
  trackIds: string[];
  oldValues: Map<string, number>;
}

let activeTrackVolumeBatchEdit: TrackVolumeBatchEdit | null = null;

const trackReorderEditSnapshots = new Map<string, string[]>();
const clipVolumeEditModifiedSnapshots = new Map<string, boolean>();

type BatchTrackBooleanField =
  | "muted"
  | "soloed"
  | "armed"
  | "fxBypassed"
  | "monitorEnabled"
  | "phaseInverted";

interface TrackBooleanBatchOptions {
  field: BatchTrackBooleanField;
  linkedParam?: string;
  type: string;
  description: string;
  eligible?: (track: any, nextValue: boolean) => boolean;
  sync: (track: any, value: boolean) => void;
  afterExecute?: (states: ReadonlyMap<string, boolean>) => void;
}

function selectedExistingTrackIds(state: any): string[] {
  const requested = state.selectedTrackIds?.length > 0
    ? state.selectedTrackIds
    : state.selectedTrackId ? [state.selectedTrackId] : [];
  const requestedSet = new Set<string>(requested);
  return state.tracks
    .map((track: any) => track.id)
    .filter((trackId: string) => requestedSet.has(trackId));
}

function executeSelectedTrackBooleanBatch(
  set: SetFn,
  get: GetFn,
  options: TrackBooleanBatchOptions,
) {
  const state = get();
  const roots = selectedExistingTrackIds(state);
  if (roots.length === 0) return false;

  const oldStates = new Map<string, boolean>();
  const newStates = new Map<string, boolean>();
  const claimedIds = new Set<string>();
  for (const rootId of roots) {
    if (claimedIds.has(rootId)) continue;
    const root = state.tracks.find((track: any) => track.id === rootId);
    if (!root) continue;
    const nextValue = !Boolean(root[options.field]);
    const candidateIds = options.linkedParam
      ? getLinkedTrackIds(rootId, state.trackGroups, options.linkedParam)
      : [rootId];
    for (const trackId of candidateIds) {
      if (claimedIds.has(trackId)) continue;
      const track = state.tracks.find((candidate: any) => candidate.id === trackId);
      if (!track || (options.eligible && !options.eligible(track, nextValue))) continue;
      claimedIds.add(trackId);
      oldStates.set(trackId, Boolean(track[options.field]));
      newStates.set(trackId, nextValue);
    }
  }
  if (newStates.size === 0) return false;

  const applyStates = (values: ReadonlyMap<string, boolean>) => {
    set((current: any) => ({
      tracks: current.tracks.map((track: any) => values.has(track.id)
        ? { ...track, [options.field]: values.get(track.id) }
        : track),
      isModified: true,
    }));
    for (const [trackId, value] of values) {
      const track = get().tracks.find((candidate: any) => candidate.id === trackId);
      if (track) options.sync(track, value);
    }
  };

  commandManager.execute({
    type: options.type,
    description: options.description,
    timestamp: Date.now(),
    execute: () => applyStates(newStates),
    undo: () => applyStates(oldStates),
  });
  options.afterExecute?.(newStates);
  set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
  return true;
}

function applyClipVolumeValue(
  set: SetFn,
  get: GetFn,
  clipId: string,
  volumeDB: number,
) {
  const hasClip = get().tracks.some((track: any) => (
    track.clips.some((clip: any) => clip.id === clipId)
  ));
  if (!hasClip) return false;
  set((state: any) => ({
    tracks: state.tracks.map((track: any) => ({
      ...track,
      clips: track.clips.map((clip: any) => clip.id === clipId
        ? { ...clip, volumeDB }
        : clip),
    })),
    isModified: true,
  }));
  return true;
}

function syncClipVolumeEdit(get: GetFn, context: string) {
  const result = get().syncClipsWithBackend?.();
  if (result && typeof result.catch === "function") {
    result.catch(logBridgeError(context));
  }
}

function sameTrackIdSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((trackId) => right.includes(trackId));
}

function applyExactTrackOrder(set: SetFn, get: GetFn, order: readonly string[]) {
  const currentTracks = get().tracks;
  const currentIds = currentTracks.map((track) => track.id);
  if (!sameTrackIdSet(order, currentIds)) return false;
  const byId = new Map(currentTracks.map((track) => [track.id, track]));
  const nextTracks = order.map((trackId) => byId.get(trackId));
  if (nextTracks.some((track) => !track)) return false;
  set({ tracks: nextTracks, isModified: true });
  nextTracks.forEach((track, index) => {
    nativeBridge.reorderTrack(track.id, index).catch(logBridgeError("track reorder"));
  });
  return true;
}

function buildMovedSelectedTrackOrder(
  tracks: any[],
  selectedTrackIds: readonly string[],
  direction: "up" | "down",
): string[] | null {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const selected = new Set(selectedTrackIds.filter((trackId) => trackById.has(trackId)));
  if (selected.size === 0) return null;

  const ROOT = "\u0000root";
  const parentKeyFor = (track: any) => (
    track.parentFolderId
    && track.parentFolderId !== track.id
    && trackById.has(track.parentFolderId)
      ? track.parentFolderId
      : ROOT
  );
  const childrenByParent = new Map<string, string[]>();
  tracks.forEach((track) => {
    const parentKey = parentKeyFor(track);
    childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) || []), track.id]);
  });

  const effectiveSelection = new Set(selected);
  const addDescendants = (trackId: string, visiting = new Set<string>()) => {
    if (visiting.has(trackId)) return;
    visiting.add(trackId);
    for (const childId of childrenByParent.get(trackId) || []) {
      effectiveSelection.add(childId);
      addDescendants(childId, visiting);
    }
    visiting.delete(trackId);
  };
  selected.forEach((trackId) => {
    if (trackById.get(trackId)?.isFolder) addDescendants(trackId);
  });

  const reorderedChildren = new Map<string, string[]>();
  let changed = false;
  const reorderLevel = (parentKey: string, parentSelected: boolean, visiting = new Set<string>()) => {
    if (visiting.has(parentKey)) return;
    visiting.add(parentKey);
    const siblings = [...(childrenByParent.get(parentKey) || [])];
    if (!parentSelected) {
      if (direction === "up") {
        for (let index = 1; index < siblings.length; index += 1) {
          if (effectiveSelection.has(siblings[index]) && !effectiveSelection.has(siblings[index - 1])) {
            [siblings[index - 1], siblings[index]] = [siblings[index], siblings[index - 1]];
            changed = true;
          }
        }
      } else {
        for (let index = siblings.length - 2; index >= 0; index -= 1) {
          if (effectiveSelection.has(siblings[index]) && !effectiveSelection.has(siblings[index + 1])) {
            [siblings[index], siblings[index + 1]] = [siblings[index + 1], siblings[index]];
            changed = true;
          }
        }
      }
    }
    reorderedChildren.set(parentKey, siblings);
    for (const trackId of siblings) {
      reorderLevel(trackId, effectiveSelection.has(trackId), visiting);
    }
    visiting.delete(parentKey);
  };
  reorderLevel(ROOT, false);
  if (!changed) return null;

  const flattened: string[] = [];
  const visited = new Set<string>();
  const appendLevel = (parentKey: string) => {
    for (const trackId of reorderedChildren.get(parentKey) || childrenByParent.get(parentKey) || []) {
      if (visited.has(trackId)) continue;
      visited.add(trackId);
      flattened.push(trackId);
      appendLevel(trackId);
    }
  };
  appendLevel(ROOT);
  tracks.forEach((track) => {
    if (!visited.has(track.id)) flattened.push(track.id);
  });
  const oldOrder = tracks.map((track) => track.id);
  return oldOrder.every((trackId, index) => trackId === flattened[index]) ? null : flattened;
}

const BUILT_IN_PLUGIN_NAMES = new Set([
  "OpenStudio Piano",
  "OpenStudio Drums",
  "OpenStudio Basic Synth",
  "OpenStudio Clean Guitar",
  "Studio13 Piano",
  "Studio13 Drums",
  "Studio13 Basic Synth",
  "Studio13 Clean Guitar",
  "OpenStudio EQ",
  "OpenStudio Compressor",
  "OpenStudio Gate",
  "OpenStudio Limiter",
  "OpenStudio Delay",
  "OpenStudio Reverb",
  "OpenStudio Chorus",
  "OpenStudio Saturator",
  "OpenStudio NAM Rack",
  "OpenStudio Pitch Correct",
  "S13 EQ",
  "S13 Compressor",
  "S13 Gate",
  "S13 Limiter",
  "S13 Delay",
  "S13 Reverb",
  "S13 Chorus",
  "S13 Saturator",
  "S13 NAM Rack",
  "S13 Pitch Correct",
]);

function isBuiltInPluginPath(pluginPath: string | undefined): boolean {
  return Boolean(pluginPath && BUILT_IN_PLUGIN_NAMES.has(pluginPath));
}

function cloneAudioClip(clip: any): any {
  return {
    ...clip,
    id: crypto.randomUUID(),
    gainEnvelope: clip.gainEnvelope?.map((point: any) => ({ ...point })),
    takes: clip.takes?.map((take: any) => cloneAudioClip(take)),
  };
}

function cloneMidiClip(clip: any): any {
  return {
    ...clip,
    id: crypto.randomUUID(),
    events: clip.events?.map((event: any) => ({ ...event })) ?? [],
    ccEvents: clip.ccEvents?.map((event: any) => ({ ...event })) ?? [],
  };
}

function cloneTrackForDuplication(track: any, newTrackId: string) {
  return {
    ...JSON.parse(JSON.stringify(track)),
    id: newTrackId,
    name: `${track.name} (copy)`,
    meterLevel: 0,
    peakLevel: 0,
    clipping: false,
    suspendedAutomationState: null,
    vcaGroupId: undefined,
    isVCALeader: false,
    clips: track.clips.map((clip: any) => cloneAudioClip(clip)),
    frozenOriginalClips: track.frozenOriginalClips?.map((clip: any) => cloneAudioClip(clip)),
    takes: track.takes?.map((lane: any[]) => lane.map((clip: any) => cloneAudioClip(clip))) ?? [],
    midiClips: track.midiClips.map((clip: any) => cloneMidiClip(clip)),
  };
}

function collectTrackClipIds(track: any): Set<string> {
  const clipIds = new Set<string>();
  for (const clip of track?.clips ?? [])
    clipIds.add(clip.id);
  for (const clip of track?.midiClips ?? [])
    clipIds.add(clip.id);
  return clipIds;
}

async function clearTrackBoundUiBeforeRemoval(state: any, trackId: string, track: any) {
  const clipIds = collectTrackClipIds(track);

  if (state.showPitchEditor
      && (state.pitchEditorTrackId === trackId
          || (state.pitchEditorClipId && clipIds.has(state.pitchEditorClipId)))) {
    state.closePitchEditor();
  }

  if (state.showPianoRoll
      && (state.pianoRollTrackId === trackId
          || (state.pianoRollClipId && clipIds.has(state.pianoRollClipId)))) {
    state.closePianoRoll();
  }

  if (state.showPluginBrowser && state.pluginBrowserTrackId === trackId)
    state.closePluginBrowser();

  if (state.showEnvelopeManager && state.envelopeManagerTrackId === trackId)
    state.closeEnvelopeManager();

  if (state.showChannelStripEQ && state.channelStripEQTrackId === trackId)
    state.closeChannelStripEQ();

  if (state.showTrackRouting && state.trackRoutingTrackId === trackId)
    state.closeTrackRouting();

  if (state.showStemSeparation
      && (state.stemSepTrackId === trackId
          || (state.stemSepClipId && clipIds.has(state.stemSepClipId)))) {
    state.closeStemSeparation();
  }

  if (state.showDynamicSplit && state.dynamicSplitClipId && clipIds.has(state.dynamicSplitClipId))
    state.closeDynamicSplit();

  if (state.showCrossfadeEditor && state.crossfadeEditorClipIds) {
    const [clipA, clipB] = state.crossfadeEditorClipIds;
    if ((clipA && clipIds.has(clipA)) || (clipB && clipIds.has(clipB)))
      state.closeCrossfadeEditor();
  }

  if (state.showClipProperties) {
    const selectedClipIds = [
      ...(state.selectedClipId ? [state.selectedClipId] : []),
      ...(state.selectedClipIds ?? []),
    ];
    if (selectedClipIds.some((clipId: string) => clipIds.has(clipId))) {
      state.toggleClipProperties();
    }
  }

  await nativeBridge.closeAllPluginWindows().catch(() => false);
}

function isMidiInputTrack(track: any) {
  return track.type === "midi" || track.type === "instrument" || track.inputType === "midi";
}

async function ensureMIDIInputDeviceReady(track: any, options?: { openAllWhenUnassigned?: boolean }) {
  if (!isMidiInputTrack(track)) return;

  const deviceName = track.midiInputDevice?.trim();
  if (deviceName) {
    await nativeBridge.openMIDIDevice(deviceName).catch(logBridgeError("midi:openInput"));
    return;
  }

  if (!options?.openAllWhenUnassigned) return;

  const devices = await nativeBridge.getMIDIInputDevices().catch(logBridgeError("midi:getInputDevices"));
  const availableDevices = Array.isArray(devices) ? devices : [];
  for (const availableDevice of availableDevices) {
    await nativeBridge.openMIDIDevice(availableDevice).catch(logBridgeError("midi:openInput"));
  }
}

export async function syncTrackCoreToBackend(track: any, options?: { includeAddTrack?: boolean; openAllMIDIInputs?: boolean }) {
  if (options?.includeAddTrack) {
    await nativeBridge.addTrack(track.id, track.type);
  }

  await nativeBridge.setTrackType(track.id, track.type).catch(() => false);
  await nativeBridge.setTrackRecordArm(track.id, track.armed).catch(() => false);
  await nativeBridge.setTrackInputMonitoring(track.id, track.monitorEnabled).catch(() => false);
  await nativeBridge.setTrackInputChannels(
    track.id,
    track.inputStartChannel ?? 0,
    track.inputChannelCount ?? 2,
  ).catch(() => false);

  if (isMidiInputTrack(track)) {
    await ensureMIDIInputDeviceReady(track, { openAllWhenUnassigned: options?.openAllMIDIInputs });
    await nativeBridge.setTrackMIDIInput(
      track.id,
      track.midiInputDevice || "",
      track.midiChannel ?? 0,
    ).catch(() => false);
  }

  if (track.midiOutputDevice) {
    await nativeBridge.setTrackMIDIOutput(track.id, track.midiOutputDevice).catch(() => false);
  }

  if (track.samplerSamplePath) {
    await nativeBridge.setTrackSamplerSample(track.id, track.samplerSamplePath, track.samplerRootNote ?? 60).catch(() => false);
  } else if (track.type === "instrument" && track.builtInInstrument) {
    const modeMap: Record<string, number> = { synth: 0, piano: 1, drums: 2 };
    await nativeBridge.setBuiltInPluginParam(
      { trackId: track.id, chain: "instrument", fxIndex: -1 },
      "instrumentMode",
      modeMap[track.builtInInstrument] ?? 0,
    ).catch(() => false);
  }
}

function trackAutomationReadEnabled(track: any): boolean {
  if (typeof track?.automationReadEnabled === "boolean") return track.automationReadEnabled;
  if (typeof track?.automationEnabled === "boolean") return track.automationEnabled;
  return (track?.automationLanes?.length ?? 0) > 0;
}

async function restoreTrackFxChain(sourceTrackId: string, newTrackId: string, isInputFX: boolean) {
  const getFx = isInputFX ? nativeBridge.getTrackInputFX.bind(nativeBridge) : nativeBridge.getTrackFX.bind(nativeBridge);
  const addFx = isInputFX ? nativeBridge.addTrackInputFX.bind(nativeBridge) : nativeBridge.addTrackFX.bind(nativeBridge);
  const bypassFx = isInputFX ? nativeBridge.bypassTrackInputFX.bind(nativeBridge) : nativeBridge.bypassTrackFX.bind(nativeBridge);
  const sourceFx = await getFx(sourceTrackId).catch(() => []);

  for (let i = 0; i < sourceFx.length; i++) {
    const pluginPath = sourceFx[i]?.pluginPath;
    if (!pluginPath) continue;
    const success = isBuiltInPluginPath(pluginPath)
      ? await nativeBridge.addTrackBuiltInFX(newTrackId, pluginPath, isInputFX).catch(() => false)
      : await addFx(newTrackId, pluginPath, false).catch(() => false);
    if (!success) continue;
    const pluginState = await nativeBridge.getPluginState(sourceTrackId, i, isInputFX).catch(() => null);
    if (pluginState) {
      await nativeBridge.setPluginState(newTrackId, i, isInputFX, pluginState).catch(() => false);
    }
    if (sourceFx[i]?.bypassed) {
      await bypassFx(newTrackId, i, true).catch(() => false);
    }
  }

  return sourceFx.length;
}

async function syncDuplicatedTrackToBackend(sourceTrack: any, newTrack: any, insertIndex: number) {
  await syncTrackCoreToBackend(newTrack);
  await nativeBridge.reorderTrack(newTrack.id, insertIndex).catch(() => false);
  await nativeBridge.setTrackVolume(newTrack.id, newTrack.volumeDB).catch(() => false);
  await nativeBridge.setTrackPan(newTrack.id, newTrack.pan).catch(() => false);
  await nativeBridge.setTrackMute(newTrack.id, newTrack.muted).catch(() => false);
  await nativeBridge.setTrackSolo(newTrack.id, newTrack.soloed).catch(() => false);
  await nativeBridge.setTrackRecordSafe(newTrack.id, newTrack.recordSafe).catch(() => false);
  await nativeBridge.setTrackPhaseInvert(newTrack.id, !!newTrack.phaseInverted).catch(() => false);
  await nativeBridge.setTrackStereoWidth(newTrack.id, newTrack.stereoWidth ?? 100).catch(() => false);
  await nativeBridge.setTrackMasterSendEnabled(newTrack.id, newTrack.masterSendEnabled ?? true).catch(() => false);
  await nativeBridge.setTrackOutputChannels(
    newTrack.id,
    newTrack.outputStartChannel ?? 0,
    newTrack.outputChannelCount ?? 2,
  ).catch(() => false);
  await nativeBridge.setTrackPlaybackOffset(newTrack.id, newTrack.playbackOffsetMs ?? 0).catch(() => false);
  await nativeBridge.setTrackChannelCount(newTrack.id, newTrack.trackChannelCount ?? 2).catch(() => false);

  for (const clip of newTrack.clips) {
    if (!clip.filePath) continue;
    await nativeBridge.addPlaybackClip(
      newTrack.id,
      clip.filePath,
      clip.startTime,
      clip.duration,
      clip.offset || 0,
      clip.volumeDB || 0,
      clip.fadeIn || 0,
      clip.fadeOut || 0,
      clip.id,
      clip.pitchCorrectionSourceFilePath,
      clip.pitchCorrectionSourceOffset,
    ).catch(() => false);
  }

  if (newTrack.midiClips.length > 0) {
    await syncTrackMIDIClipsToBackend(newTrack.id, newTrack.midiClips, newTrack.midiEffects || []).catch(() => false);
  }

  for (const [sendIndex, send] of (newTrack.sends ?? []).entries()) {
    const createdIndex = await nativeBridge.addTrackSend(newTrack.id, send.destTrackId).catch(() => sendIndex);
    const resolvedIndex = typeof createdIndex === "number" && createdIndex >= 0 ? createdIndex : sendIndex;
    await nativeBridge.setTrackSendLevel(newTrack.id, resolvedIndex, send.level).catch(() => false);
    await nativeBridge.setTrackSendPan(newTrack.id, resolvedIndex, send.pan).catch(() => false);
    await nativeBridge.setTrackSendEnabled(newTrack.id, resolvedIndex, send.enabled).catch(() => false);
    await nativeBridge.setTrackSendPreFader(newTrack.id, resolvedIndex, send.preFader).catch(() => false);
    await nativeBridge.setTrackSendPhaseInvert(newTrack.id, resolvedIndex, send.phaseInvert).catch(() => false);
  }

  const inputFxCount = await restoreTrackFxChain(sourceTrack.id, newTrack.id, true);
  const trackFxCount = await restoreTrackFxChain(sourceTrack.id, newTrack.id, false);

  if (newTrack.fxBypassed) {
    for (let i = 0; i < inputFxCount; i++) {
      await nativeBridge.bypassTrackInputFX(newTrack.id, i, true).catch(() => false);
    }
    for (let i = 0; i < trackFxCount; i++) {
      await nativeBridge.bypassTrackFX(newTrack.id, i, true).catch(() => false);
    }
  }

  for (const lane of newTrack.automationLanes) {
    syncAutomationLaneToBackend(newTrack.id, lane);
  }
  if (!trackAutomationReadEnabled(newTrack)) {
    for (const lane of newTrack.automationLanes) {
      await nativeBridge.setAutomationMode(newTrack.id, lane.param, "off").catch(() => false);
    }
  }
}

async function captureTrackFxSlots(trackId: string, isInputFX: boolean) {
  const slots = isInputFX
    ? await nativeBridge.getTrackInputFX(trackId)
    : await nativeBridge.getTrackFX(trackId);
  return Promise.all((slots || []).map(async (slot: any, index: number) => ({
    pluginPath: slot?.pluginPath || "",
    bypassed: Boolean(slot?.bypassed),
    precisionOverride: slot?.precisionOverride === "float32" ? "float32" : "auto",
    state: await nativeBridge.getPluginState(trackId, index, isInputFX).catch(() => ""),
  })));
}

async function captureTrackExternalState(track: any) {
  const [inputFX, trackFX, instrumentState] = await Promise.all([
    captureTrackFxSlots(track.id, true),
    captureTrackFxSlots(track.id, false),
    track.instrumentPlugin
      ? nativeBridge.getInstrumentState(track.id).catch(() => "")
      : Promise.resolve(""),
  ]);
  if (inputFX.length < (track.inputFxCount || 0) || inputFX.some((slot) => !slot.pluginPath)) {
    throw new Error(`Cannot capture every input FX slot for ${track.name}`);
  }
  if (trackFX.length < (track.trackFxCount || 0) || trackFX.some((slot) => !slot.pluginPath)) {
    throw new Error(`Cannot capture every track FX slot for ${track.name}`);
  }
  return { inputFX, trackFX, instrumentState };
}

async function restoreCapturedTrackFxSlots(trackId: string, slots: any[], isInputFX: boolean) {
  for (const slot of slots) {
    const added = isBuiltInPluginPath(slot.pluginPath)
      ? await nativeBridge.addTrackBuiltInFX(trackId, slot.pluginPath, isInputFX).catch(() => false)
      : isInputFX
        ? await nativeBridge.addTrackInputFX(trackId, slot.pluginPath, false).catch(() => false)
        : await nativeBridge.addTrackFX(trackId, slot.pluginPath, false).catch(() => false);
    if (!added) throw new Error(`Could not restore plug-in ${slot.pluginPath}`);
    const restoredIndex = isInputFX
      ? (await nativeBridge.getTrackInputFX(trackId)).length - 1
      : (await nativeBridge.getTrackFX(trackId)).length - 1;
    if (slot.state) {
      const restored = await nativeBridge.setPluginState(
        trackId,
        restoredIndex,
        isInputFX,
        slot.state,
      );
      if (!restored) throw new Error(`Could not restore plug-in state for ${slot.pluginPath}`);
    }
    if (slot.bypassed) {
      await (isInputFX
        ? nativeBridge.bypassTrackInputFX(trackId, restoredIndex, true)
        : nativeBridge.bypassTrackFX(trackId, restoredIndex, true));
    }
    if (slot.precisionOverride === "float32") {
      await nativeBridge.setTrackPluginPrecisionOverride(
        trackId,
        restoredIndex,
        isInputFX,
        "float32",
      ).catch(() => false);
    }
  }
}

async function restoreRemovedTrackToBackend(
  track: any,
  insertIndex: number,
  externalState: any,
  backendAlreadyAdded = false,
) {
  await syncTrackCoreToBackend(track, { includeAddTrack: !backendAlreadyAdded });
  await nativeBridge.setTrackVolume(track.id, track.volumeDB).catch(() => false);
  await nativeBridge.setTrackPan(track.id, track.pan).catch(() => false);
  await nativeBridge.setTrackMute(track.id, track.muted).catch(() => false);
  await nativeBridge.setTrackSolo(track.id, track.soloed).catch(() => false);
  await nativeBridge.setTrackRecordSafe(track.id, track.recordSafe).catch(() => false);
  await nativeBridge.setTrackPhaseInvert(track.id, Boolean(track.phaseInverted)).catch(() => false);
  await nativeBridge.setTrackStereoWidth(track.id, track.stereoWidth ?? 100).catch(() => false);
  await nativeBridge.setTrackMasterSendEnabled(track.id, track.masterSendEnabled ?? true).catch(() => false);
  await nativeBridge.setTrackOutputChannels(
    track.id,
    track.outputStartChannel ?? 0,
    track.outputChannelCount ?? 2,
  ).catch(() => false);
  await nativeBridge.setTrackPlaybackOffset(track.id, track.playbackOffsetMs ?? 0).catch(() => false);
  await nativeBridge.setTrackChannelCount(track.id, track.trackChannelCount ?? 2).catch(() => false);

  if (track.instrumentPlugin) {
    const loaded = await nativeBridge.loadInstrument(track.id, track.instrumentPlugin);
    if (!loaded) throw new Error(`Could not restore instrument on ${track.name}`);
    if (externalState.instrumentState) {
      const restored = await nativeBridge.setInstrumentState(track.id, externalState.instrumentState);
      if (!restored) throw new Error(`Could not restore instrument state on ${track.name}`);
    }
    if (track.instrumentPrecisionOverride === "float32") {
      await nativeBridge.setInstrumentPrecisionOverride(track.id, "float32").catch(() => false);
    }
  }

  for (const clip of track.clips) {
    if (!clip.filePath) continue;
    await nativeBridge.addPlaybackClip(
      track.id,
      clip.filePath,
      clip.startTime,
      clip.duration,
      clip.offset || 0,
      clip.volumeDB || 0,
      clip.fadeIn || 0,
      clip.fadeOut || 0,
      clip.id,
      clip.pitchCorrectionSourceFilePath,
      clip.pitchCorrectionSourceOffset,
    ).catch(() => false);
  }
  if (track.midiClips.length > 0) {
    await syncTrackMIDIClipsToBackend(track.id, track.midiClips, track.midiEffects || []);
  }
  for (const [sendIndex, send] of (track.sends || []).entries()) {
    const createdIndex = await nativeBridge.addTrackSend(track.id, send.destTrackId).catch(() => sendIndex);
    const resolvedIndex = typeof createdIndex === "number" && createdIndex >= 0 ? createdIndex : sendIndex;
    await nativeBridge.setTrackSendLevel(track.id, resolvedIndex, send.level).catch(() => false);
    await nativeBridge.setTrackSendPan(track.id, resolvedIndex, send.pan).catch(() => false);
    await nativeBridge.setTrackSendEnabled(track.id, resolvedIndex, send.enabled).catch(() => false);
    await nativeBridge.setTrackSendPreFader(track.id, resolvedIndex, send.preFader).catch(() => false);
    await nativeBridge.setTrackSendPhaseInvert(track.id, resolvedIndex, send.phaseInvert).catch(() => false);
  }
  await restoreCapturedTrackFxSlots(track.id, externalState.inputFX, true);
  await restoreCapturedTrackFxSlots(track.id, externalState.trackFX, false);
  for (const lane of track.automationLanes || []) syncAutomationLaneToBackend(track.id, lane);
  if (!trackAutomationReadEnabled(track)) {
    for (const lane of track.automationLanes || []) {
      await nativeBridge.setAutomationMode(track.id, lane.param, "off").catch(() => false);
    }
  }
  await nativeBridge.reorderTrack(track.id, insertIndex).catch(() => false);
}

export const trackActions = (set: SetFn, get: GetFn) => ({
    addTrack: (trackData, options = {}) => {
      if (get().globalLocked) return;
      const requestedType = trackData.type || "audio";
      const newTrack = createDefaultTrack(
        trackData.id,
        trackData.name,
        trackData.color,
        requestedType,
        get().tracks,
      );
      const fullTrack = { ...newTrack, ...trackData };
      if (get().tracks.some((track) => track.id === fullTrack.id)) {
        console.warn(`[DAW] Ignoring duplicate addTrack for existing track id: ${fullTrack.id}`);
        return;
      }

      let hasExecutedOnce = false;

      const command: Command = {
        type: "ADD_TRACK",
        description: `Add track "${trackData.name}"`,
        timestamp: Date.now(),
        execute: () => {
          let inserted = false;
          set((state) => {
            if (state.tracks.some((track) => track.id === fullTrack.id)) {
              console.warn(`[DAW] Ignoring duplicate addTrack execute for existing track id: ${fullTrack.id}`);
              return state;
            }

            inserted = true;
            const insertAfter = (trackData as any).insertAfterTrackId as string | undefined;
            if (insertAfter) {
              const idx = state.tracks.findIndex((t) => t.id === insertAfter);
              if (idx >= 0) {
                const newTracks = [...state.tracks];
                newTracks.splice(idx + 1, 0, fullTrack);
                return { tracks: newTracks };
              }
            }
            return { tracks: [...state.tracks, fullTrack] };
          });

          if (!inserted) {
            return;
          }

          const includeAddTrack = !(options.backendAlreadyCreated && !hasExecutedOnce);
          hasExecutedOnce = true;
          syncTrackCoreToBackend(fullTrack, { includeAddTrack })
            .catch((e) =>
              console.error("[DAW] Failed to sync new track with backend:", e),
            );
        },
        undo: () => {
          nativeBridge.removeTrack(trackData.id).catch((e) =>
            console.error("[DAW] Failed to sync removeTrack with backend:", e),
          );
          set((state) => ({
            tracks: state.tracks.filter((t) => t.id !== trackData.id),
            selectedTrackId:
              state.selectedTrackId === trackData.id ? null : state.selectedTrackId,
            selectedTrackIds: state.selectedTrackIds.filter((id) => id !== trackData.id),
            lastSelectedTrackId:
              state.lastSelectedTrackId === trackData.id ? null : state.lastSelectedTrackId,
          }));
        },
      };

      if (options.recordUndo === false) {
        command.execute();
      } else {
        commandManager.execute(command);
        set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      }
    },

    addTracksBatch: async (trackDataEntries) => {
      if (!Array.isArray(trackDataEntries) || trackDataEntries.length === 0) return [];
      const state = get();
      if (state.globalLocked) return [];
      const requestedIds = trackDataEntries.map((entry) => entry.id);
      if (new Set(requestedIds).size !== requestedIds.length
          || requestedIds.some((trackId) => state.tracks.some((track) => track.id === trackId))) {
        return [];
      }
      const newTracks = trackDataEntries.map((trackData, index) => {
        const requestedType = trackData.type || "audio";
        const defaults = createDefaultTrack(
          trackData.id,
          trackData.name,
          trackData.color,
          requestedType,
          [...state.tracks, ...trackDataEntries.slice(0, index)],
        );
        return { ...defaults, ...trackData };
      });
      const selectionBefore = {
        selectedTrackId: state.selectedTrackId,
        selectedTrackIds: [...state.selectedTrackIds],
        lastSelectedTrackId: state.lastSelectedTrackId,
      };

      const globalLockAbort = new Error("Global Lock enabled while inserting tracks");
      const addAll = async (respectGlobalLock = false) => {
        if (respectGlobalLock && get().globalLocked) return false;
        if (requestedIds.some((trackId) => get().tracks.some((track) => track.id === trackId))) return;
        const addedIds: string[] = [];
        try {
          for (const track of newTracks) {
            const addedId = await nativeBridge.addTrack(track.id, track.type);
            if (!addedId) throw new Error(`Backend rejected track ${track.id}`);
            addedIds.push(track.id);
            if (respectGlobalLock && get().globalLocked) throw globalLockAbort;
            await syncTrackCoreToBackend(track, { includeAddTrack: false });
            if (respectGlobalLock && get().globalLocked) throw globalLockAbort;
          }
          if (respectGlobalLock && get().globalLocked) throw globalLockAbort;
          set((current) => ({
            tracks: [...current.tracks, ...newTracks],
            isModified: true,
          }));
          for (const [index, track] of get().tracks.entries()) {
            await nativeBridge.reorderTrack(track.id, index).catch(() => false);
          }
        } catch (error) {
          await Promise.all(addedIds.map((trackId) => nativeBridge.removeTrack(trackId).catch(() => false)));
          throw error;
        }
        return true;
      };
      const removeAll = async () => {
        set((current) => ({
          tracks: current.tracks.filter((track) => !requestedIds.includes(track.id)),
          ...selectionBefore,
          isModified: true,
        }));
        for (const trackId of [...requestedIds].reverse()) {
          await nativeBridge.removeTrack(trackId).catch(() => false);
        }
      };

      try {
        const added = await addAll(true);
        if (!added) return [];
      } catch (error) {
        if (error === globalLockAbort) return [];
        toastBridgeError("Insert multiple tracks")(
          error instanceof Error ? error : new Error("Could not insert every requested track"),
        );
        return [];
      }

      let backendQueue = Promise.resolve();
      const enqueue = (description: string, work: () => Promise<void>) => {
        backendQueue = backendQueue.then(work, work).catch(logBridgeError(description));
      };
      commandManager.push({
        type: "ADD_TRACKS_BATCH",
        description: `Insert ${newTracks.length} tracks`,
        timestamp: Date.now(),
        execute: () => enqueue("redo insert multiple tracks", () => addAll(false)),
        undo: () => enqueue("undo insert multiple tracks", removeAll),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return requestedIds;
    },

    clearSelectedTrackSamplerSamples: async () => {
      const invocationState = get();
      const targetIds = selectedExistingTrackIds(invocationState).filter((trackId) =>
        Boolean(invocationState.tracks.find((track) => track.id === trackId)?.samplerSamplePath));
      const snapshots = targetIds.map((trackId) => {
        const track = invocationState.tracks.find((candidate) => candidate.id === trackId);
        return {
          trackId,
          type: track.type,
          samplePath: track.samplerSamplePath,
          rootNote: track.samplerRootNote ?? 60,
          sourceType: track.samplerSourceType,
        };
      });
      if (snapshots.length === 0) return false;

      const syncTargets = async () => {
        for (const { trackId } of snapshots) {
          await get().syncMIDITrackToBackend?.(trackId, { debounce: false });
        }
      };
      const clearAll = async () => {
        const cleared: typeof snapshots = [];
        try {
          for (const snapshot of snapshots) {
            const success = await nativeBridge.clearTrackSamplerSample(snapshot.trackId);
            if (!success) throw new Error(`Could not clear sampler on ${snapshot.trackId}`);
            cleared.push(snapshot);
          }
        } catch (error) {
          for (const snapshot of [...cleared].reverse()) {
            await nativeBridge.setTrackSamplerSample(
              snapshot.trackId,
              snapshot.samplePath,
              snapshot.rootNote,
            ).catch(() => false);
          }
          throw error;
        }
        set((current) => ({
          tracks: current.tracks.map((track) => snapshots.some((snapshot) => snapshot.trackId === track.id)
            ? {
                ...track,
                samplerSamplePath: undefined,
                samplerSourceType: undefined,
              }
            : track),
          isModified: true,
        }));
        await syncTargets();
      };
      const restoreAll = async () => {
        const restored: typeof snapshots = [];
        try {
          for (const snapshot of snapshots) {
            const success = await nativeBridge.setTrackSamplerSample(
              snapshot.trackId,
              snapshot.samplePath,
              snapshot.rootNote,
            );
            if (!success) throw new Error(`Could not restore sampler on ${snapshot.trackId}`);
            restored.push(snapshot);
          }
        } catch (error) {
          for (const snapshot of [...restored].reverse()) {
            await nativeBridge.clearTrackSamplerSample(snapshot.trackId).catch(() => false);
          }
          throw error;
        }
        const byId = new Map(snapshots.map((snapshot) => [snapshot.trackId, snapshot]));
        set((current) => ({
          tracks: current.tracks.map((track) => {
            const snapshot = byId.get(track.id);
            return snapshot
              ? {
                  ...track,
                  type: snapshot.type,
                  samplerSamplePath: snapshot.samplePath,
                  samplerRootNote: snapshot.rootNote,
                  samplerSourceType: snapshot.sourceType,
                }
              : track;
          }),
          isModified: true,
        }));
        await syncTargets();
      };

      try {
        await clearAll();
      } catch (error) {
        toastBridgeError("Clear selected sampler samples")(
          error instanceof Error ? error : new Error("Could not clear every selected sampler"),
        );
        return false;
      }
      let resourceQueue = Promise.resolve();
      const enqueue = (description: string, work: () => Promise<void>) => {
        resourceQueue = resourceQueue.then(work, work).catch(logBridgeError(description));
      };
      commandManager.push({
        type: "CLEAR_SELECTED_SAMPLER_SAMPLES",
        description: snapshots.length === 1
          ? "Clear selected sampler sample"
          : `Clear sampler samples from ${snapshots.length} selected tracks`,
        timestamp: Date.now(),
        execute: () => enqueue("redo clear selected samplers", clearAll),
        undo: () => enqueue("undo clear selected samplers", restoreAll),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    removeSelectedTrackInstruments: async () => {
      const invocationState = get();
      const targetIds = selectedExistingTrackIds(invocationState).filter((trackId) => {
        const track = invocationState.tracks.find((candidate) => candidate.id === trackId);
        return Boolean(track?.instrumentPlugin || track?.builtInInstrument);
      });
      if (targetIds.length === 0) return false;
      const snapshots = await Promise.all(targetIds.map(async (trackId) => {
        const track = invocationState.tracks.find((candidate) => candidate.id === trackId);
        return {
          trackId,
          type: track.type,
          instrumentPlugin: track.instrumentPlugin,
          builtInInstrument: track.builtInInstrument,
          samplerSamplePath: track.samplerSamplePath,
          state: track.instrumentPlugin
            ? await nativeBridge.getInstrumentState(trackId).catch(() => "")
            : "",
        };
      }));
      const modeMap: Record<string, number> = { synth: 0, piano: 1, drums: 2 };
      const restoreNative = async (snapshot) => {
        await nativeBridge.setTrackType(snapshot.trackId, snapshot.type || "instrument");
        if (snapshot.instrumentPlugin) {
          const loaded = await nativeBridge.loadInstrument(snapshot.trackId, snapshot.instrumentPlugin);
          if (!loaded) throw new Error(`Could not restore instrument on ${snapshot.trackId}`);
          if (snapshot.state) {
            const restored = await nativeBridge.setInstrumentState(snapshot.trackId, snapshot.state);
            if (!restored) throw new Error(`Could not restore instrument state on ${snapshot.trackId}`);
          }
        } else if (snapshot.builtInInstrument) {
          const restored = await nativeBridge.setBuiltInPluginParam(
            { trackId: snapshot.trackId, chain: "instrument", fxIndex: -1 },
            "instrumentMode",
            modeMap[snapshot.builtInInstrument] ?? 0,
          );
          if (!restored) throw new Error(`Could not restore built-in instrument on ${snapshot.trackId}`);
        }
      };
      const removeNative = async (snapshot) => {
        if (snapshot.instrumentPlugin) {
          const removed = await nativeBridge.removeInstrument(snapshot.trackId);
          if (!removed) throw new Error(`Could not remove instrument on ${snapshot.trackId}`);
        } else {
          const type = snapshot.samplerSamplePath ? "instrument" : "midi";
          const changed = await nativeBridge.setTrackType(snapshot.trackId, type);
          if (!changed) throw new Error(`Could not remove built-in instrument on ${snapshot.trackId}`);
        }
      };
      const syncTargets = async () => {
        for (const snapshot of snapshots) {
          await get().syncMIDITrackToBackend?.(snapshot.trackId, { debounce: false });
          notifyInstrumentChanged({ trackId: snapshot.trackId, instrumentPlugin: get().tracks.find((track) => track.id === snapshot.trackId)?.instrumentPlugin });
        }
      };
      const removeAll = async () => {
        const removed: typeof snapshots = [];
        try {
          for (const snapshot of snapshots) {
            await removeNative(snapshot);
            removed.push(snapshot);
          }
        } catch (error) {
          for (const snapshot of [...removed].reverse()) {
            await restoreNative(snapshot).catch(() => false);
          }
          throw error;
        }
        const ids = new Set(snapshots.map((snapshot) => snapshot.trackId));
        set((current) => ({
          tracks: current.tracks.map((track) => ids.has(track.id)
            ? {
                ...track,
                type: track.samplerSamplePath ? "instrument" : "midi",
                instrumentPlugin: undefined,
                builtInInstrument: undefined,
              }
            : track),
          isModified: true,
        }));
        await syncTargets();
      };
      const restoreAll = async () => {
        const restored: typeof snapshots = [];
        try {
          for (const snapshot of snapshots) {
            await restoreNative(snapshot);
            restored.push(snapshot);
          }
        } catch (error) {
          for (const snapshot of [...restored].reverse()) {
            await removeNative(snapshot).catch(() => false);
          }
          throw error;
        }
        const byId = new Map(snapshots.map((snapshot) => [snapshot.trackId, snapshot]));
        set((current) => ({
          tracks: current.tracks.map((track) => {
            const snapshot = byId.get(track.id);
            return snapshot
              ? {
                  ...track,
                  type: snapshot.type,
                  instrumentPlugin: snapshot.instrumentPlugin,
                  builtInInstrument: snapshot.builtInInstrument,
                }
              : track;
          }),
          isModified: true,
        }));
        await syncTargets();
      };

      try {
        await removeAll();
      } catch (error) {
        toastBridgeError("Remove selected instruments")(
          error instanceof Error ? error : new Error("Could not remove every selected instrument"),
        );
        return false;
      }
      let resourceQueue = Promise.resolve();
      const enqueue = (description: string, work: () => Promise<void>) => {
        resourceQueue = resourceQueue.then(work, work).catch(logBridgeError(description));
      };
      commandManager.push({
        type: "REMOVE_SELECTED_INSTRUMENTS",
        description: snapshots.length === 1
          ? "Remove selected instrument"
          : `Remove instruments from ${snapshots.length} selected tracks`,
        timestamp: Date.now(),
        execute: () => enqueue("redo remove selected instruments", removeAll),
        undo: () => enqueue("undo remove selected instruments", restoreAll),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    toggleSelectedTracksFreeze: async (requestedTrackIds?: string[]) => {
      const invocationState = get();
      if (invocationState.globalLocked || invocationState.lockSettings?.items) return false;
      const requestedSet = requestedTrackIds ? new Set(requestedTrackIds) : null;
      const selectedIds = requestedSet
        ? invocationState.tracks
            .map((track) => track.id)
            .filter((trackId) => requestedSet.has(trackId))
        : selectedExistingTrackIds(invocationState);
      const targetIds = selectedIds.filter((trackId) => {
        const track = invocationState.tracks.find((candidate) => candidate.id === trackId);
        return Boolean(track && (track.frozen || track.clips.length > 0 || track.midiClips.length > 0));
      });
      if (targetIds.length === 0) return false;
      const lockAbort = new Error("Freeze cancelled because item editing became locked");
      const invocationLocked = () => Boolean(get().globalLocked || get().lockSettings?.items);

      const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
      const originalById = new Map(targetIds.map((trackId) => {
        const track = invocationState.tracks.find((candidate) => candidate.id === trackId);
        return [trackId, clone(track)];
      }));
      const invocationRefs = new Map(targetIds.map((trackId) => [
        trackId,
        invocationState.tracks.find((candidate) => candidate.id === trackId),
      ]));
      let externalById: Map<string, any>;
      try {
        externalById = new Map(await Promise.all(targetIds.map(async (trackId) => {
          const original = originalById.get(trackId);
          const [inputFX, trackFX] = await Promise.all([
            nativeBridge.getTrackInputFX(trackId),
            nativeBridge.getTrackFX(trackId),
          ]);
          if (inputFX.length < (original.inputFxCount || 0)
              || trackFX.length < (original.trackFxCount || 0)) {
            throw new Error(`Could not capture every FX bypass state on ${original.name}`);
          }
          return [trackId, {
            inputBypass: inputFX.map((slot) => Boolean(slot?.bypassed)),
            trackBypass: trackFX.map((slot) => Boolean(slot?.bypassed)),
          }];
        })));
      } catch (error) {
        toastBridgeError("Freeze selected tracks")(
          error instanceof Error ? error : new Error("Could not capture selected track processing state"),
        );
        return false;
      }
      if (invocationLocked()) return false;

      const captureEditorRealm = (state) => ({
        midiEditorSessions: (state.midiEditorSessions || []).map((session) => ({
          ...session,
          selectedNoteIds: [...(session.selectedNoteIds || [])],
          visibleLanes: (session.visibleLanes || []).map((lane) => ({ ...lane })),
        })),
        activeMidiEditorSessionId: state.activeMidiEditorSessionId,
        dockedMidiEditorSessionId: state.dockedMidiEditorSessionId,
        detachedPanels: [...(state.detachedPanels || [])],
        showPianoRoll: state.showPianoRoll,
        pianoRollTrackId: state.pianoRollTrackId,
        pianoRollClipId: state.pianoRollClipId,
        selectedNoteIds: [...(state.selectedNoteIds || [])],
        midiEditRange: state.midiEditRange ? { ...state.midiEditRange } : null,
        pianoRollEditCursorTime: state.pianoRollEditCursorTime,
      });
      const editorWithSessions = (before, sessions) => {
        const sessionIds = new Set(sessions.map((session) => session.sessionId));
        const dockedId = sessionIds.has(before.dockedMidiEditorSessionId)
          ? before.dockedMidiEditorSessionId
          : null;
        const activeId = sessionIds.has(before.activeMidiEditorSessionId)
          ? before.activeMidiEditorSessionId
          : (dockedId || sessions[0]?.sessionId || null);
        const active = sessions.find((session) => session.sessionId === activeId);
        return {
          ...before,
          midiEditorSessions: sessions,
          activeMidiEditorSessionId: activeId,
          dockedMidiEditorSessionId: dockedId,
          detachedPanels: sessions.some((session) => session.mode === "windowed")
            ? before.detachedPanels
            : before.detachedPanels.filter((panelId) => panelId !== "midiEditor"),
          showPianoRoll: Boolean(dockedId),
          pianoRollTrackId: active?.trackId || null,
          pianoRollClipId: active?.clipId || null,
          selectedNoteIds: [...(active?.selectedNoteIds || [])],
          midiEditRange: active?.midiEditRange ? { ...active.midiEditRange } : null,
          pianoRollEditCursorTime: active?.editCursorTime ?? null,
        };
      };
      let editorBefore: any = null;
      let editorAfter: any = null;
      const frozenClipIds = (original) => new Set([
        ...(original.frozen ? original.frozenOriginalClips || [] : original.clips || []),
        ...(original.frozen ? original.frozenOriginalMIDIClips || [] : original.midiClips || []),
      ].map((clip) => clip.id));

      const setFXBypassStates = async (trackId, inputStates, trackStates) => {
        for (const [index, bypassed] of inputStates.entries()) {
          const success = await nativeBridge.bypassTrackInputFX(trackId, index, bypassed);
          if (!success) throw new Error(`Could not set input FX bypass on ${trackId}`);
        }
        for (const [index, bypassed] of trackStates.entries()) {
          const success = await nativeBridge.bypassTrackFX(trackId, index, bypassed);
          if (!success) throw new Error(`Could not set track FX bypass on ${trackId}`);
        }
      };
      const frozenTrackSnapshot = (original, result, external) => {
        const sourceAudio = clone(original.frozen ? original.frozenOriginalClips || [] : original.clips || []);
        const sourceMIDI = clone(original.frozen ? original.frozenOriginalMIDIClips || [] : original.midiClips || []);
        const previousFreezeClip = original.frozen ? original.clips?.[0] : null;
        const freezeClip = {
          ...(previousFreezeClip || {}),
          id: previousFreezeClip?.id || `${original.id}_freeze`,
          filePath: result.filePath,
          name: `${original.name} (frozen)`,
          startTime: result.startTime ?? previousFreezeClip?.startTime ?? 0,
          duration: result.duration ?? previousFreezeClip?.duration ?? 0,
          offset: 0,
          color: previousFreezeClip?.color || "#60a5fa",
          volumeDB: 0,
          fadeIn: 0,
          fadeOut: 0,
          sampleRate: result.sampleRate,
        };
        return {
          ...clone(original),
          frozen: true,
          freezeFilePath: result.filePath,
          frozenOriginalClips: sourceAudio,
          frozenOriginalMIDIClips: sourceMIDI,
          frozenOriginalFxBypassed: original.frozen
            ? (original.frozenOriginalFxBypassed ?? false)
            : Boolean(original.fxBypassed),
          frozenInputFXBypassSnapshot: original.frozen
            ? (original.frozenInputFXBypassSnapshot || external.inputBypass)
            : external.inputBypass,
          frozenTrackFXBypassSnapshot: original.frozen
            ? (original.frozenTrackFXBypassSnapshot || external.trackBypass)
            : external.trackBypass,
          fxBypassed: true,
          clips: [freezeClip],
          midiClips: [],
        };
      };
      const unfrozenTrackSnapshot = (original) => original.frozen
        ? {
            ...clone(original),
            frozen: false,
            freezeFilePath: undefined,
            frozenOriginalClips: undefined,
            frozenOriginalMIDIClips: undefined,
            frozenOriginalFxBypassed: undefined,
            frozenInputFXBypassSnapshot: undefined,
            frozenTrackFXBypassSnapshot: undefined,
            fxBypassed: original.frozenOriginalFxBypassed ?? false,
            clips: clone(original.frozenOriginalClips || []),
            midiClips: clone(original.frozenOriginalMIDIClips || []),
          }
        : clone(original);

      const transition = async (toggled: boolean, verifyInvocation = false) => {
        const desiredFrozen = new Map(targetIds.map((trackId) => {
          const original = originalById.get(trackId);
          return [trackId, toggled ? !original.frozen : Boolean(original.frozen)];
        }));
        // Start the native state reads before changing freeze state, but do not
        // await them here.  This lets undo/redo issue their native freeze call
        // synchronously while still capturing the pre-transition bypass state
        // for rollback.
        const transitionExternalPromise = Promise.all(targetIds.map(async (trackId) => {
          const [inputFX, trackFX] = await Promise.all([
            nativeBridge.getTrackInputFX(trackId),
            nativeBridge.getTrackFX(trackId),
          ]);
          return [trackId, {
            inputBypass: inputFX.map((slot) => Boolean(slot?.bypassed)),
            trackBypass: trackFX.map((slot) => Boolean(slot?.bypassed)),
          }] as const;
        }));
        let transitionExternal = new Map<string, { inputBypass: boolean[]; trackBypass: boolean[] }>();
        if (verifyInvocation && invocationLocked()) throw lockAbort;
        const renderResults = new Map<string, any>();
        const transitionedTrackIds: string[] = [];
        const rollbackNativeTransitions = async () => {
          if (transitionExternal.size === 0) {
            transitionExternal = new Map(await transitionExternalPromise.catch(() => []));
          }
          for (const trackId of [...transitionedTrackIds].reverse()) {
            const original = originalById.get(trackId);
            if (original?.frozen) {
              await nativeBridge.freezeTrack(trackId).catch(() => null);
            } else {
              await nativeBridge.unfreezeTrack(trackId).catch(() => false);
            }
          }
          for (const [trackId, external] of transitionExternal) {
            await setFXBypassStates(trackId, external.inputBypass, external.trackBypass).catch(() => undefined);
          }
        };
        try {
          for (const trackId of targetIds) {
            if (verifyInvocation && invocationLocked()) throw lockAbort;
            if (desiredFrozen.get(trackId)) {
              const result = await nativeBridge.freezeTrack(trackId);
              if (!result?.success || !result.filePath) {
                throw new Error(result?.error || `Could not freeze ${trackId}`);
              }
              renderResults.set(trackId, result);
              transitionedTrackIds.push(trackId);
            } else {
              const original = originalById.get(trackId);
              const external = externalById.get(trackId);
              const unfreezePromise = nativeBridge.unfreezeTrack(trackId);
              // Restoring the processing graph is part of the same native
              // transition.  Start it immediately so a synchronous undo also
              // leaves no interval where the UI is unfrozen but FX remain
              // bypassed.
              const restoreFXPromise = setFXBypassStates(
                trackId,
                original.frozenInputFXBypassSnapshot || external.inputBypass,
                original.frozenTrackFXBypassSnapshot || external.trackBypass,
              );
              const success = await unfreezePromise;
              if (!success) throw new Error(`Could not unfreeze ${trackId}`);
              transitionedTrackIds.push(trackId);
              await restoreFXPromise;
            }
            if (verifyInvocation && invocationLocked()) throw lockAbort;
          }
          transitionExternal = new Map(await transitionExternalPromise);
          if (verifyInvocation && targetIds.some((trackId) =>
            get().tracks.find((track) => track.id === trackId) !== invocationRefs.get(trackId))) {
            throw new Error("A selected track changed while freeze rendering was in progress");
          }
        } catch (error) {
          await rollbackNativeTransitions();
          throw error;
        }

        const tracksPrior = get().tracks;
        const editorPrior = captureEditorRealm(get());
        if (!editorBefore) {
          editorBefore = editorPrior;
          const affectedWindowed = new Set<string>();
          for (const session of editorBefore.midiEditorSessions) {
            const original = originalById.get(session.trackId);
            if (desiredFrozen.get(session.trackId) && original && frozenClipIds(original).has(session.clipId)
                && session.mode === "windowed") {
              affectedWindowed.add(session.sessionId);
            }
          }
          const safeBeforeSessions = editorBefore.midiEditorSessions.filter(
            (session) => !affectedWindowed.has(session.sessionId),
          );
          editorBefore = editorWithSessions(editorBefore, safeBeforeSessions);
          const afterSessions = safeBeforeSessions.filter((session) => !desiredFrozen.get(session.trackId));
          editorAfter = editorWithSessions(editorBefore, afterSessions);
        }
        const currentEditor = captureEditorRealm(get());
        const windowedToClose = currentEditor.midiEditorSessions.filter((session) =>
          session.mode === "windowed" && desiredFrozen.get(session.trackId));
        const closedWindowSessions: any[] = [];
        for (const trackId of targetIds) {
          if (!desiredFrozen.get(trackId)) continue;
          const original = originalById.get(trackId);
          if (get().showPitchEditor
              && get().pitchEditorTrackId === trackId
              && frozenClipIds(original).has(get().pitchEditorClipId)) {
            get().closePitchEditor?.();
          }
        }

        const nextById = new Map(targetIds.map((trackId) => {
          const original = originalById.get(trackId);
          return [trackId, desiredFrozen.get(trackId)
            ? frozenTrackSnapshot(original, renderResults.get(trackId), externalById.get(trackId))
            : unfrozenTrackSnapshot(original)];
        }));
        try {
          for (const session of windowedToClose) {
            const closed = await nativeBridge.closeMidiEditorWindow(session.sessionId, "sourceFreeze").catch(() => false);
            if (closed) closedWindowSessions.push(session);
            if (verifyInvocation && invocationLocked()) throw lockAbort;
          }
          if (verifyInvocation && invocationLocked()) throw lockAbort;
          set((current) => ({
            tracks: current.tracks.map((track) => nextById.get(track.id) || track),
            ...(toggled ? editorAfter : editorBefore),
            isModified: true,
          }));
          await get().syncClipsWithBackend();
          if (verifyInvocation && invocationLocked()) throw lockAbort;
          for (const trackId of targetIds) {
            const original = originalById.get(trackId);
            const external = externalById.get(trackId);
            if (desiredFrozen.get(trackId)) {
              await setFXBypassStates(
                trackId,
                external.inputBypass.map(() => true),
                external.trackBypass.map(() => true),
              );
            }
            if (verifyInvocation && invocationLocked()) throw lockAbort;
          }
        } catch (error) {
          set({ tracks: tracksPrior, ...editorPrior, isModified: true });
          await get().syncClipsWithBackend().catch(() => undefined);
          await rollbackNativeTransitions();
          for (const session of closedWindowSessions) {
            await nativeBridge.openMidiEditorWindow(session.sessionId).catch(() => false);
          }
          throw error;
        }
      };

      try {
        await transition(true, true);
      } catch (error) {
        if (error !== lockAbort) {
          toastBridgeError("Freeze selected tracks")(
            error instanceof Error ? error : new Error("Could not freeze or unfreeze every selected track"),
          );
        }
        return false;
      }
      const toggledById = new Map(targetIds.map((trackId) => [
        trackId,
        clone(get().tracks.find((track) => track.id === trackId)),
      ]));
      const applyFrontendSnapshot = (trackSnapshots, editorSnapshot) => {
        set((current) => ({
          tracks: current.tracks.map((track) => trackSnapshots.get(track.id) || track),
          ...editorSnapshot,
          isModified: true,
        }));
      };
      let resourceQueue: Promise<void> | null = null;
      const enqueue = (description: string, work: () => Promise<void>) => {
        const run = resourceQueue
          ? resourceQueue.then(work, work)
          : work();
        const settled = run.catch(logBridgeError(description));
        resourceQueue = settled;
        void settled.finally(() => {
          if (resourceQueue === settled) resourceQueue = null;
        });
      };
      commandManager.push({
        type: "TOGGLE_SELECTED_TRACKS_FREEZE",
        description: targetIds.length === 1
          ? "Freeze or unfreeze selected track"
          : `Freeze or unfreeze ${targetIds.length} selected tracks`,
        timestamp: Date.now(),
        execute: () => {
          applyFrontendSnapshot(toggledById, editorAfter);
          enqueue("redo freeze selected tracks", () => transition(true));
        },
        undo: () => {
          applyFrontendSnapshot(originalById, editorBefore);
          enqueue("undo freeze selected tracks", () => transition(false));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    // Single-track UI entry points share the exact transactional freeze path
    // used by profile shortcuts instead of maintaining a second, partial model.
    freezeTrack: (trackId) => {
      const track = get().tracks.find((candidate) => candidate.id === trackId);
      if (!track || track.frozen) return;
      void get().toggleSelectedTracksFreeze([trackId]);
    },

    unfreezeTrack: (trackId) => {
      const track = get().tracks.find((candidate) => candidate.id === trackId);
      if (!track || !track.frozen) return;
      void get().toggleSelectedTracksFreeze([trackId]);
    },

    duplicateTrack: async (trackId) => {
      const state = get();
      const sourceTrack = state.tracks.find((t) => t.id === trackId);
      if (!sourceTrack || state.globalLocked) return;

      const sourceTrackIndex = state.tracks.findIndex((t) => t.id === trackId);
      const newTrackId = crypto.randomUUID();
      const duplicatedTrack = cloneTrackForDuplication(sourceTrack, newTrackId);
      const selectionBefore = {
        selectedTrackId: state.selectedTrackId,
        selectedTrackIds: [...state.selectedTrackIds],
        lastSelectedTrackId: state.lastSelectedTrackId,
      };

      const applyDuplicate = async (respectGlobalLock = false) => {
        const canApply = () => !respectGlobalLock || (
          !get().globalLocked
          && get().tracks.find((track) => track.id === trackId) === sourceTrack
        );
        if (!canApply()) return false;
        if (get().tracks.some((track) => track.id === newTrackId)) return;
        const added = await nativeBridge.addTrack(newTrackId, duplicatedTrack.type);
        if (!added) throw new Error(`Backend rejected duplicate track ${newTrackId}`);
        if (!canApply()) {
          await nativeBridge.removeTrack(newTrackId).catch(() => false);
          return false;
        }
        set((s) => {
          if (!canApply()) return s;
          if (s.tracks.some((track) => track.id === newTrackId)) return s;
          const tracks = [...s.tracks];
          const currentSourceIndex = tracks.findIndex((track) => track.id === trackId);
          const insertIndex = currentSourceIndex >= 0
            ? currentSourceIndex + 1
            : Math.min(sourceTrackIndex + 1, tracks.length);
          tracks.splice(insertIndex, 0, duplicatedTrack);
          return {
            tracks,
            selectedTrackId: newTrackId,
            selectedTrackIds: [newTrackId],
            lastSelectedTrackId: newTrackId,
            isModified: true,
          };
        });
        const insertedIndex = get().tracks.findIndex((track) => track.id === newTrackId);
        await syncDuplicatedTrackToBackend(
          sourceTrack,
          duplicatedTrack,
          insertedIndex >= 0 ? insertedIndex : sourceTrackIndex + 1,
        );
        if (!canApply()) {
          set((current) => ({
            tracks: current.tracks.filter((track) => track.id !== newTrackId),
            ...selectionBefore,
          }));
          await nativeBridge.removeTrack(newTrackId).catch(() => false);
          return false;
        }
        return true;
      };

      const removeDuplicate = async () => {
        const currentTrack = get().tracks.find((track) => track.id === newTrackId);
        if (currentTrack) {
          await clearTrackBoundUiBeforeRemoval(get(), newTrackId, currentTrack);
        }
        set((s) => ({
          tracks: s.tracks.filter((track) => track.id !== newTrackId),
          ...selectionBefore,
          isModified: true,
        }));
        await nativeBridge.removeTrack(newTrackId).catch(() => false);
      };

      try {
        if (!await applyDuplicate(true)) return;
        commandManager.push({
          type: "DUPLICATE_TRACK",
          description: `Duplicate track "${sourceTrack.name}"`,
          timestamp: Date.now(),
          execute: () => {
            void applyDuplicate(false).catch(toastBridgeError("Redo duplicate track"));
          },
          undo: () => {
            void removeDuplicate().catch(toastBridgeError("Undo duplicate track"));
          },
        });
        set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      } catch (error) {
        console.error("[DAW] Failed to fully duplicate track:", error);
        await nativeBridge.removeTrack(newTrackId).catch(() => false);
        set((s) => ({
          tracks: s.tracks.filter((t) => t.id !== newTrackId),
          selectedTrackId: s.selectedTrackId === newTrackId ? sourceTrack.id : s.selectedTrackId,
          selectedTrackIds: s.selectedTrackIds.filter((id) => id !== newTrackId),
          lastSelectedTrackId: s.lastSelectedTrackId === newTrackId ? sourceTrack.id : s.lastSelectedTrackId,
        }));
        toastBridgeError("Duplicate track")(
          error instanceof Error ? error : new Error("Failed to duplicate track"),
        );
      }
    },

    duplicateSelectedTracks: async () => {
      const state = get();
      if (state.globalLocked) return [];
      const sourceIds = selectedExistingTrackIds(state);
      if (sourceIds.length === 0) return [];

      const sources = sourceIds
        .map((trackId) => state.tracks.find((track) => track.id === trackId))
        .filter(Boolean);
      if (sources.length === 0) return [];

      const idMap = new Map(sources.map((sourceTrack) => [sourceTrack.id, crypto.randomUUID()]));
      const duplicates = sources.map((sourceTrack) => {
        const duplicate = cloneTrackForDuplication(sourceTrack, idMap.get(sourceTrack.id));
        if (duplicate.parentFolderId && idMap.has(duplicate.parentFolderId)) {
          duplicate.parentFolderId = idMap.get(duplicate.parentFolderId);
        }
        return { sourceTrack, duplicate };
      });
      const duplicateIds = duplicates.map(({ duplicate }) => duplicate.id);
      const globalLockAbort = new Error("Global Lock enabled while duplicating tracks");
      const selectionBefore = {
        selectedTrackId: state.selectedTrackId,
        selectedTrackIds: [...state.selectedTrackIds],
        lastSelectedTrackId: state.lastSelectedTrackId,
      };

      const insertDuplicates = (tracks: any[]) => tracks.flatMap((track) => {
        const entry = duplicates.find(({ sourceTrack }) => sourceTrack.id === track.id);
        return entry ? [track, entry.duplicate] : [track];
      });

      const applyDuplicates = async (respectGlobalLock = false) => {
        const canApply = () => !respectGlobalLock || (
          !get().globalLocked
          && sources.every((sourceTrack) => (
            get().tracks.find((track) => track.id === sourceTrack.id) === sourceTrack
          ))
        );
        if (!canApply()) return false;
        if (duplicateIds.some((trackId) => get().tracks.some((track) => track.id === trackId))) return;
        const addedIds: string[] = [];
        try {
          for (const { duplicate } of duplicates) {
            const added = await nativeBridge.addTrack(duplicate.id, duplicate.type);
            if (!added) throw new Error(`Backend rejected duplicate track ${duplicate.id}`);
            addedIds.push(duplicate.id);
            if (!canApply()) throw globalLockAbort;
          }
          if (!canApply()) throw globalLockAbort;
          set((current) => ({
            tracks: insertDuplicates(current.tracks),
            selectedTrackId: duplicateIds[duplicateIds.length - 1] || null,
            selectedTrackIds: duplicateIds,
            lastSelectedTrackId: duplicateIds[duplicateIds.length - 1] || null,
            isModified: true,
          }));
          for (const { sourceTrack, duplicate } of duplicates) {
            const insertIndex = get().tracks.findIndex((track) => track.id === duplicate.id);
            await syncDuplicatedTrackToBackend(sourceTrack, duplicate, insertIndex);
            if (!canApply()) throw globalLockAbort;
          }
          return true;
        } catch (error) {
          set((current) => ({
            tracks: current.tracks.filter((track) => !duplicateIds.includes(track.id)),
            ...selectionBefore,
          }));
          await Promise.all(addedIds.map((trackId) => nativeBridge.removeTrack(trackId).catch(() => false)));
          throw error;
        }
      };

      const removeDuplicates = async () => {
        const current = get();
        for (const { duplicate } of duplicates) {
          const currentTrack = current.tracks.find((track) => track.id === duplicate.id);
          if (currentTrack) await clearTrackBoundUiBeforeRemoval(get(), duplicate.id, currentTrack);
        }
        set((next) => ({
          tracks: next.tracks.filter((track) => !duplicateIds.includes(track.id)),
          ...selectionBefore,
          isModified: true,
        }));
        await Promise.all(duplicateIds.map((trackId) => nativeBridge.removeTrack(trackId).catch(() => false)));
      };

      try {
        if (!await applyDuplicates(true)) return [];
        commandManager.push({
          type: "DUPLICATE_SELECTED_TRACKS",
          description: `Duplicate ${duplicates.length} selected track${duplicates.length === 1 ? "" : "s"}`,
          timestamp: Date.now(),
          execute: () => {
            void applyDuplicates(false).catch(toastBridgeError("Redo duplicate selected tracks"));
          },
          undo: () => {
            void removeDuplicates().catch(toastBridgeError("Undo duplicate selected tracks"));
          },
        });
        set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        return duplicateIds;
      } catch (error) {
        if (error !== globalLockAbort) {
          toastBridgeError("Duplicate selected tracks")(
            error instanceof Error ? error : new Error("Failed to duplicate selected tracks"),
          );
        }
        return [];
      }
    },

    removeTrack: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track || state.globalLocked) return;

      // Capture full track data and its index for undo
      const trackSnapshot = JSON.parse(JSON.stringify(track)) as Track;
      const trackIndex = state.tracks.findIndex((t) => t.id === id);

      const command: Command = {
        type: "REMOVE_TRACK",
        description: `Remove track "${track.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          await clearTrackBoundUiBeforeRemoval(get(), id, trackSnapshot);

          // Clear clips from backend playback engine
          for (const clip of trackSnapshot.clips) {
            if (clip.filePath) {
              await nativeBridge.removePlaybackClipById(id, clip.id).catch(() => {});
            }
          }
          await nativeBridge.removeTrack(id).catch(() => {});
          set((s) => ({
            tracks: s.tracks.filter((t) => t.id !== id),
            selectedTrackId: s.selectedTrackId === id ? null : s.selectedTrackId,
            selectedTrackIds: s.selectedTrackIds.filter((trackId) => trackId !== id),
            lastSelectedTrackId: s.lastSelectedTrackId === id ? null : s.lastSelectedTrackId,
            selectedClipId: s.selectedClipId && collectTrackClipIds(trackSnapshot).has(s.selectedClipId) ? null : s.selectedClipId,
            selectedClipIds: s.selectedClipIds.filter((clipId) => !collectTrackClipIds(trackSnapshot).has(clipId)),
            metronomeTrackId: s.metronomeTrackId === id ? null : s.metronomeTrackId,
          }));
        },
        undo: async () => {
          // Re-add track to backend
          await nativeBridge.addTrack(id, trackSnapshot.type).catch(() => {});
          // Restore track at original position
          set((s) => {
            const newTracks = [...s.tracks];
            newTracks.splice(Math.min(trackIndex, newTracks.length), 0, trackSnapshot);
            return { tracks: newTracks };
          });
          // Re-add clips to backend
          for (const clip of trackSnapshot.clips) {
            if (clip.filePath) {
              await nativeBridge.addPlaybackClip(
                id, clip.filePath, clip.startTime, clip.duration,
                clip.offset || 0, clip.volumeDB || 0, clip.fadeIn || 0, clip.fadeOut || 0,
                clip.id,
              ).catch(() => {});
            }
          }
          // Restore backend track order
          nativeBridge.reorderTrack(id, trackIndex).catch(() => {});
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    updateTrack: (id, updates) => {
      set((state) => ({
        tracks: state.tracks.map((t) => {
          if (t.id === id) {
            // If color is being updated, also update all clips to match
            const updatedTrack = { ...t, ...updates };
            if (updates.color) {
              updatedTrack.clips = t.clips.map((clip) => ({
                ...clip,
                color: updates.color!,
              }));
            }
            return updatedTrack;
          }
          return t;
        }),
      }));
    },

    setTracksColorWithUndo: (trackIds, color) => {
      if (get().globalLocked) return;
      const normalizedColor = String(color || "").trim();
      if (!normalizedColor) return;
      const targetIds = Array.from(new Set(trackIds)).filter((trackId) =>
        get().tracks.some((track) => track.id === trackId),
      );
      if (targetIds.length === 0) return;

      const before = new Map(targetIds.map((trackId) => {
        const track = get().tracks.find((candidate) => candidate.id === trackId);
        return [trackId, {
          color: track?.color,
          clipColors: new Map((track?.clips || []).map((clip) => [clip.id, clip.color])),
          midiClipColors: new Map((track?.midiClips || []).map((clip) => [clip.id, clip.color])),
        }];
      }));

      const applyColor = () => set((state) => ({
        tracks: state.tracks.map((track) => targetIds.includes(track.id)
          ? {
              ...track,
              color: normalizedColor,
              clips: track.clips.map((clip) => ({ ...clip, color: normalizedColor })),
              midiClips: track.midiClips.map((clip) => ({ ...clip, color: normalizedColor })),
            }
          : track),
        isModified: true,
      }));
      const restoreColor = () => set((state) => ({
        tracks: state.tracks.map((track) => {
          const snapshot = before.get(track.id);
          if (!snapshot) return track;
          return {
            ...track,
            color: snapshot.color,
            clips: track.clips.map((clip) => snapshot.clipColors.has(clip.id)
              ? { ...clip, color: snapshot.clipColors.get(clip.id) }
              : clip),
            midiClips: track.midiClips.map((clip) => snapshot.midiClipColors.has(clip.id)
              ? { ...clip, color: snapshot.midiClipColors.get(clip.id) }
              : clip),
          };
        }),
        isModified: true,
      }));

      commandManager.execute({
        type: "SET_TRACK_COLOR",
        description: targetIds.length === 1 ? "Set track color" : `Set ${targetIds.length} track colors`,
        timestamp: Date.now(),
        execute: applyColor,
        undo: restoreColor,
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    renameTracks: (trackIds, baseName) => {
      const changes = buildTrackRenameChanges(get().tracks, trackIds, baseName);
      if (changes.length === 0) return;

      const oldNames = new Map(changes.map((change) => [change.id, change.oldName]));
      const newNames = new Map(changes.map((change) => [change.id, change.newName]));
      const applyNames = (names: Map<string, string>) => {
        set((state) => ({
          tracks: state.tracks.map((track) => {
            const name = names.get(track.id);
            return name === undefined ? track : { ...track, name };
          }),
          isModified: true,
        }));
      };

      commandManager.execute({
        type: "RENAME_TRACKS",
        description: changes.length === 1
          ? `Rename track to "${changes[0].newName}"`
          : `Rename ${changes.length} tracks`,
        timestamp: Date.now(),
        execute: () => applyNames(newNames),
        undo: () => applyNames(oldNames),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    setTrackMIDIEffects: (trackId, midiEffects) => {
      const track = get().tracks.find((t) => t.id === trackId);
      if (!track) return;
      const oldEffects = (track.midiEffects || []).map((effect: any) => ({ ...effect }));
      const nextEffects = (midiEffects || []).map((effect: any) => ({ ...effect }));
      const applyEffects = (effects: any[]) => {
        set((state) => ({
          tracks: state.tracks.map((candidate) =>
            candidate.id === trackId ? { ...candidate, midiEffects: effects.map((effect) => ({ ...effect })) } : candidate,
          ),
          isModified: true,
        }));
        const latestTrack = get().tracks.find((candidate) => candidate.id === trackId);
        if (latestTrack && (latestTrack.type === "midi" || latestTrack.type === "instrument")) {
          void syncTrackMIDIClipsToBackend(trackId, latestTrack.midiClips || [], effects).catch(logBridgeError("midi fx sync"));
        }
      };

      applyEffects(nextEffects);
      commandManager.push({
        type: "UPDATE_TRACK",
        description: `Update MIDI FX on "${track.name}"`,
        timestamp: Date.now(),
        execute: () => applyEffects(nextEffects),
        undo: () => applyEffects(oldEffects),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    setTrackNotes: (trackId, notes) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const oldNotes = track.notes || "";
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, notes } : t,
        ),
      }));
      const command: Command = {
        type: "UPDATE_TRACK",
        description: `Set track notes on "${track.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, notes } : t,
            ),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === trackId ? { ...t, notes: oldNotes } : t,
            ),
          }));
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    beginTrackReorderEdit: (trackId) => {
      if (get().globalLocked) return;
      if (trackReorderEditSnapshots.has(trackId)) return;
      const order = get().tracks.map((track) => track.id);
      if (!order.includes(trackId)) return;
      trackReorderEditSnapshots.set(trackId, order);
    },

    previewTrackReorder: (trackId, direction) => {
      if (!trackReorderEditSnapshots.has(trackId)) return false;
      if (get().globalLocked) {
        const oldOrder = trackReorderEditSnapshots.get(trackId);
        trackReorderEditSnapshots.delete(trackId);
        if (oldOrder) applyExactTrackOrder(set, get, oldOrder);
        return false;
      }
      const currentTracks = get().tracks;
      const currentIndex = currentTracks.findIndex((track) => track.id === trackId);
      const nextIndex = currentIndex + (direction < 0 ? -1 : direction > 0 ? 1 : 0);
      if (
        currentIndex < 0
        || nextIndex < 0
        || nextIndex >= currentTracks.length
        || nextIndex === currentIndex
      ) {
        return false;
      }
      const nextTracks = [...currentTracks];
      const [moved] = nextTracks.splice(currentIndex, 1);
      nextTracks.splice(nextIndex, 0, moved);
      set({ tracks: nextTracks, isModified: true });
      nativeBridge.reorderTrack(trackId, nextIndex).catch(logBridgeError("track reorder preview"));
      return true;
    },

    commitTrackReorderEdit: (trackId) => {
      const oldOrder = trackReorderEditSnapshots.get(trackId);
      trackReorderEditSnapshots.delete(trackId);
      if (!oldOrder) return;
      if (get().globalLocked) {
        applyExactTrackOrder(set, get, oldOrder);
        return;
      }
      const newOrder = get().tracks.map((track) => track.id);
      if (!sameTrackIdSet(oldOrder, newOrder)) return;
      if (oldOrder.every((id, index) => id === newOrder[index])) return;

      commandManager.push({
        type: "REORDER_TRACK",
        description: "Reorder track",
        timestamp: Date.now(),
        execute: () => {
          applyExactTrackOrder(set, get, newOrder);
        },
        undo: () => {
          applyExactTrackOrder(set, get, oldOrder);
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reorderTrack: (activeId, overId) => {
      const state = get();
      if (state.globalLocked) return;
      const oldIndex = state.tracks.findIndex((t) => t.id === activeId);
      const newIndex = state.tracks.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return;

      const command: Command = {
        type: "REORDER_TRACK",
        description: "Reorder track",
        timestamp: Date.now(),
        execute: () => {
          set((s) => {
            const oi = s.tracks.findIndex((t) => t.id === activeId);
            const ni = s.tracks.findIndex((t) => t.id === overId);
            if (oi === -1 || ni === -1) return s;
            const newTracks = [...s.tracks];
            const [moved] = newTracks.splice(oi, 1);
            newTracks.splice(ni, 0, moved);
            nativeBridge.reorderTrack(activeId, ni);
            return { tracks: newTracks };
          });
        },
        undo: () => {
          set((s) => {
            const ci = s.tracks.findIndex((t) => t.id === activeId);
            if (ci === -1) return s;
            const newTracks = [...s.tracks];
            const [moved] = newTracks.splice(ci, 1);
            newTracks.splice(Math.min(oldIndex, newTracks.length), 0, moved);
            nativeBridge.reorderTrack(activeId, oldIndex);
            return { tracks: newTracks };
          });
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    reorderMultipleTracks: (trackIds, overId) => {
      if (get().globalLocked) return;
      set((state) => {
        // Find the target position (where the drop target is)
        const overIndex = state.tracks.findIndex((t) => t.id === overId);
        if (overIndex === -1) return state;

        // Extract selected tracks in their original relative order
        const selectedTracks = state.tracks.filter((t) => trackIds.includes(t.id));
        const remainingTracks = state.tracks.filter((t) => !trackIds.includes(t.id));

        // Find where to insert in the remaining array
        let insertIndex = remainingTracks.findIndex((t) => t.id === overId);
        if (insertIndex === -1) {
          // overId was a selected track — insert at the original position
          insertIndex = Math.min(overIndex, remainingTracks.length);
        } else {
          // Determine drag direction: if first selected was above over target, we're moving down
          const firstSelectedIndex = state.tracks.findIndex((t) => trackIds.includes(t.id));
          if (firstSelectedIndex < overIndex) {
            insertIndex++; // Insert AFTER the over item when moving down
          }
        }

        // Insert all selected tracks at the target position
        const newTracks = [...remainingTracks];
        newTracks.splice(insertIndex, 0, ...selectedTracks);

        // Sync backend for each moved track
        newTracks.forEach((track, i) => {
          nativeBridge.reorderTrack(track.id, i);
        });

        return { tracks: newTracks };
      });
    },

    canMoveSelectedTracks: (direction) => {
      const state = get();
      if (state.globalLocked) return false;
      const selectedIds = state.selectedTrackIds.length > 0
        ? state.selectedTrackIds
        : state.selectedTrackId ? [state.selectedTrackId] : [];
      return Boolean(buildMovedSelectedTrackOrder(state.tracks, selectedIds, direction));
    },

    moveSelectedTracks: (direction) => {
      const state = get();
      if (state.globalLocked) return false;
      const selectedIds = state.selectedTrackIds.length > 0
        ? state.selectedTrackIds
        : state.selectedTrackId ? [state.selectedTrackId] : [];
      const oldOrder = state.tracks.map((track) => track.id);
      const newOrder = buildMovedSelectedTrackOrder(state.tracks, selectedIds, direction);
      if (!newOrder) return false;

      commandManager.execute({
        type: "MOVE_SELECTED_TRACKS",
        description: `Move selected tracks ${direction}`,
        timestamp: Date.now(),
        execute: () => { applyExactTrackOrder(set, get, newOrder); },
        undo: () => { applyExactTrackOrder(set, get, oldOrder); },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    canGroupSelectedTracksIntoFolder: () => {
      const state = get();
      if (state.globalLocked) return false;
      const selectedIds = selectedExistingTrackIds(state);
      let candidateId = "__openstudio_group_candidate__";
      while (state.tracks.some((track) => track.id === candidateId)) {
        candidateId += "_";
      }
      return Boolean(buildTrackFolderGroupPlan(state.tracks, selectedIds, candidateId));
    },

    groupSelectedTracksIntoFolder: () => {
      const state = get();
      if (state.globalLocked) return false;
      const selectedIds = selectedExistingTrackIds(state);
      const folderId = crypto.randomUUID();
      const plan = buildTrackFolderGroupPlan(state.tracks, selectedIds, folderId);
      if (!plan) return false;

      const existingNames = new Set(state.tracks.map((track) => track.name));
      let groupNumber = 1;
      while (existingNames.has(`Group ${groupNumber}`)) groupNumber += 1;
      const folderTrack = {
        ...createDefaultTrack(folderId, `Group ${groupNumber}`, undefined, "audio", state.tracks),
        isFolder: true,
        folderCollapsed: false,
        icon: "folder",
        parentFolderId: plan.parentFolderId,
      };
      const selectedRoots = new Set(plan.selectedRootIds);
      const oldTracks = [...state.tracks];
      const nextById = new Map(state.tracks.map((track) => [
        track.id,
        selectedRoots.has(track.id)
          ? { ...track, parentFolderId: folderId }
          : track,
      ]));
      nextById.set(folderId, folderTrack);
      const newTracks = plan.orderedTrackIds.map((trackId) => nextById.get(trackId));
      if (newTracks.some((track) => !track)) return false;

      // Backend work is serialized so an immediate undo cannot race a still
      // pending add and leave a ghost track behind in the audio engine.
      let backendQueue = Promise.resolve();
      const enqueueBackend = (description: string, work: () => Promise<unknown>) => {
        backendQueue = backendQueue
          .then(work, work)
          .then(() => undefined)
          .catch(logBridgeError(description));
      };
      const reorderBackend = async (tracks: any[]) => {
        for (const [index, track] of tracks.entries()) {
          await nativeBridge.reorderTrack(track.id, index);
        }
      };
      const applyGroup = () => {
        set({ tracks: newTracks, isModified: true });
        enqueueBackend("group selected tracks", async () => {
          await syncTrackCoreToBackend(folderTrack, { includeAddTrack: true });
          await reorderBackend(newTracks);
        });
      };
      const removeGroup = () => {
        set({ tracks: oldTracks, isModified: true });
        enqueueBackend("undo group selected tracks", async () => {
          await nativeBridge.removeTrack(folderId);
          await reorderBackend(oldTracks);
        });
      };

      commandManager.execute({
        type: "GROUP_SELECTED_TRACKS_INTO_FOLDER",
        description: plan.selectedRootIds.length === 1
          ? "Group selected track into folder"
          : `Group ${plan.selectedRootIds.length} selected tracks into folder`,
        timestamp: Date.now(),
        execute: applyGroup,
        undo: removeGroup,
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    },

    selectTrack: (id, modifiers) => {
      if (id === null) {
        // Deselect all
        set({
          selectedTrackId: null,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
        });
        return;
      }

      const state = get();
      const { shift, ctrl } = modifiers || {};

      if (shift && state.lastSelectedTrackId) {
        // Range selection: select all tracks between lastSelectedTrackId and id
        const trackIds = state.tracks.map((t) => t.id);
        const lastIndex = trackIds.indexOf(state.lastSelectedTrackId);
        const currentIndex = trackIds.indexOf(id);
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const rangeIds = trackIds.slice(start, end + 1);
          // Merge with existing selection
          const newSelection = [
            ...new Set([...state.selectedTrackIds, ...rangeIds]),
          ];
          set({ selectedTrackIds: newSelection, selectedTrackId: id });
        }
      } else if (ctrl) {
        // Toggle selection: add or remove from selection
        const isSelected = state.selectedTrackIds.includes(id);
        if (isSelected) {
          const newSelection = state.selectedTrackIds.filter(
            (tid) => tid !== id,
          );
          set({
            selectedTrackIds: newSelection,
            selectedTrackId:
              newSelection.length > 0
                ? newSelection[newSelection.length - 1]
                : null,
            lastSelectedTrackId: id,
          });
        } else {
          set({
            selectedTrackIds: [...state.selectedTrackIds, id],
            selectedTrackId: id,
            lastSelectedTrackId: id,
          });
        }
      } else {
        // Single selection: replace selection with this track + all linked group members
        const linkedIds = getLinkedTrackIds(id, state.trackGroups);
        set({
          selectedTrackId: id,
          selectedTrackIds: linkedIds,
          lastSelectedTrackId: id,
        });
      }
    },

    selectAllTracks: () => {
      const state = get();
      const allIds = state.tracks.map((t) => t.id);
      set({
        selectedTrackIds: allIds,
        selectedTrackId: allIds.length > 0 ? allIds[0] : null,
      });
    },

    deselectAllTracks: () => {
      set({
        selectedTrackId: null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
      });
    },

    deselectAll: () => {
      set((state) => ({
        selectedTrackId: null,
        selectedTrackIds: [],
        lastSelectedTrackId: null,
        selectedClipId: null,
        selectedClipIds: [],
        selectedNoteIds: [],
        selectedAutomationTarget: null,
        selectedRegionIds: [],
        timeSelection: state.globalLocked || state.lockSettings?.timeSelection
          ? state.timeSelection
          : null,
        razorEdits: [],
        midiEditRange: null,
        pianoRollEditCursorTime: null,
        midiEditorSessions: (state.midiEditorSessions || []).map((session) => ({
          ...session,
          selectedNoteIds: [],
          midiEditRange: null,
          editCursorTime: null,
        })),
      }));
    },

    deleteSelectedTracks: async () => {
      const state = get();
      if (state.globalLocked) return;
      const selectedIds = new Set(selectedExistingTrackIds(state));
      if (selectedIds.size === 0) return;

      // Deleting a folder removes its complete subtree. This prevents dangling
      // parentFolderId values and mirrors the visible TCP hierarchy.
      let addedDescendant = true;
      while (addedDescendant) {
        addedDescendant = false;
        for (const track of state.tracks) {
          if (track.parentFolderId && selectedIds.has(track.parentFolderId) && !selectedIds.has(track.id)) {
            selectedIds.add(track.id);
            addedDescendant = true;
          }
        }
      }

      const removedEntries = state.tracks.flatMap((track, index) => (
        selectedIds.has(track.id) ? [{ track, index }] : []
      ));
      if (removedEntries.length === 0) return;

      let externalByTrackId: Map<string, any>;
      try {
        externalByTrackId = new Map(await Promise.all(removedEntries.map(async ({ track }) => [
          track.id,
          await captureTrackExternalState(track),
        ])));
      } catch (error) {
        toastBridgeError("Delete selected tracks")(
          error instanceof Error ? error : new Error("Could not capture track state for undo"),
        );
        return;
      }
      // External plug-in capture can await native dialogs/bridges.  A newly
      // enabled Global Lock or a replaced target invalidates this user
      // invocation, while undo/redo below intentionally remains replayable.
      if (get().globalLocked || removedEntries.some(({ track }) => (
        get().tracks.find((candidate) => candidate.id === track.id) !== track
      ))) return;

      const tracksBefore = JSON.parse(JSON.stringify(state.tracks));
      const trackGroupsBefore = JSON.parse(JSON.stringify(state.trackGroups));
      const selectionBefore = {
        selectedTrackId: state.selectedTrackId,
        selectedTrackIds: [...state.selectedTrackIds],
        lastSelectedTrackId: state.lastSelectedTrackId,
        selectedClipId: state.selectedClipId,
        selectedClipIds: [...state.selectedClipIds],
        selectedAutomationTarget: state.selectedAutomationTarget
          ? { ...state.selectedAutomationTarget }
          : null,
        metronomeTrackId: state.metronomeTrackId,
        midiEditorSessions: (state.midiEditorSessions || []).map((session) => ({
          ...session,
          selectedNoteIds: [...(session.selectedNoteIds || [])],
          visibleLanes: (session.visibleLanes || []).map((lane) => ({ ...lane })),
        })),
        activeMidiEditorSessionId: state.activeMidiEditorSessionId,
        dockedMidiEditorSessionId: state.dockedMidiEditorSessionId,
        detachedPanels: [...(state.detachedPanels || [])],
        showPianoRoll: state.showPianoRoll,
        pianoRollTrackId: state.pianoRollTrackId,
        pianoRollClipId: state.pianoRollClipId,
        selectedNoteIds: [...(state.selectedNoteIds || [])],
        midiEditRange: state.midiEditRange ? { ...state.midiEditRange } : null,
        pianoRollEditCursorTime: state.pianoRollEditCursorTime,
      };
      const removedClipIds = new Set<string>();
      for (const { track } of removedEntries) {
        for (const clipId of collectTrackClipIds(track)) removedClipIds.add(clipId);
      }
      const removedWindowedSessionIds = new Set(
        selectionBefore.midiEditorSessions
          .filter((session) => session.mode === "windowed"
            && (selectedIds.has(session.trackId) || removedClipIds.has(session.clipId)))
          .map((session) => session.sessionId),
      );
      const undoSessions = selectionBefore.midiEditorSessions.filter(
        (session) => !removedWindowedSessionIds.has(session.sessionId),
      );
      const undoSessionIds = new Set(undoSessions.map((session) => session.sessionId));
      const undoDockedSessionId = undoSessionIds.has(selectionBefore.dockedMidiEditorSessionId)
        ? selectionBefore.dockedMidiEditorSessionId
        : null;
      const undoActiveSessionId = undoSessionIds.has(selectionBefore.activeMidiEditorSessionId)
        ? selectionBefore.activeMidiEditorSessionId
        : (undoDockedSessionId || undoSessions[0]?.sessionId || null);
      const undoActiveSession = undoSessions.find(
        (session) => session.sessionId === undoActiveSessionId,
      );
      const selectionForUndo = removedWindowedSessionIds.size === 0
        ? selectionBefore
        : {
            ...selectionBefore,
            midiEditorSessions: undoSessions,
            activeMidiEditorSessionId: undoActiveSessionId,
            dockedMidiEditorSessionId: undoDockedSessionId,
            detachedPanels: undoSessions.some((session) => session.mode === "windowed")
              ? selectionBefore.detachedPanels
              : selectionBefore.detachedPanels.filter((panelId) => panelId !== "midiEditor"),
            showPianoRoll: Boolean(undoDockedSessionId),
            pianoRollTrackId: undoActiveSession?.trackId || null,
            pianoRollClipId: undoActiveSession?.clipId || null,
            selectedNoteIds: [...(undoActiveSession?.selectedNoteIds || [])],
            midiEditRange: undoActiveSession?.midiEditRange
              ? { ...undoActiveSession.midiEditRange }
              : null,
            pianoRollEditCursorTime: undoActiveSession?.editCursorTime ?? null,
          };

      const applyRemoval = async () => {
        const current = get();
        for (const sessionId of removedWindowedSessionIds) {
          await nativeBridge.closeMidiEditorWindow(sessionId, "sourceTrackDelete").catch(() => false);
        }
        for (const { track } of removedEntries) {
          const currentTrack = current.tracks.find((candidate) => candidate.id === track.id);
          if (currentTrack) await clearTrackBoundUiBeforeRemoval(get(), track.id, currentTrack);
        }

        const remainingSessions = (get().midiEditorSessions || [])
          .filter((session) => !selectedIds.has(session.trackId) && !removedClipIds.has(session.clipId));
        const remainingSessionIds = new Set(remainingSessions.map((session) => session.sessionId));
        const dockedMidiEditorSessionId = remainingSessionIds.has(get().dockedMidiEditorSessionId)
          ? get().dockedMidiEditorSessionId
          : null;
        const activeMidiEditorSessionId = remainingSessionIds.has(get().activeMidiEditorSessionId)
          ? get().activeMidiEditorSessionId
          : (dockedMidiEditorSessionId || remainingSessions[0]?.sessionId || null);
        const activeSession = remainingSessions.find(
          (session) => session.sessionId === activeMidiEditorSessionId,
        );
        const hasWindowedSession = remainingSessions.some((session) => session.mode === "windowed");

        set((currentState) => ({
          tracks: currentState.tracks
            .filter((track) => !selectedIds.has(track.id))
            .map((track) => ({
              ...track,
              sends: (track.sends || []).filter((send) => !selectedIds.has(send.destTrackId)),
            })),
          trackGroups: currentState.trackGroups.flatMap((group) => {
            const memberTrackIds = group.memberTrackIds.filter((trackId) => !selectedIds.has(trackId));
            if (memberTrackIds.length < 2) return [];
            return [{
              ...group,
              memberTrackIds,
              leadTrackId: memberTrackIds.includes(group.leadTrackId)
                ? group.leadTrackId
                : memberTrackIds[0],
            }];
          }),
          selectedTrackId: null,
          selectedTrackIds: [],
          lastSelectedTrackId: null,
          selectedClipId: currentState.selectedClipId && removedClipIds.has(currentState.selectedClipId)
            ? null
            : currentState.selectedClipId,
          selectedClipIds: currentState.selectedClipIds.filter((clipId) => !removedClipIds.has(clipId)),
          selectedAutomationTarget: currentState.selectedAutomationTarget?.kind === "track"
            && selectedIds.has(currentState.selectedAutomationTarget.trackId)
            ? null
            : currentState.selectedAutomationTarget,
          metronomeTrackId: currentState.metronomeTrackId && selectedIds.has(currentState.metronomeTrackId)
            ? null
            : currentState.metronomeTrackId,
          midiEditorSessions: remainingSessions,
          activeMidiEditorSessionId,
          dockedMidiEditorSessionId,
          detachedPanels: hasWindowedSession
            ? currentState.detachedPanels
            : currentState.detachedPanels.filter((panelId) => panelId !== "midiEditor"),
          showPianoRoll: Boolean(dockedMidiEditorSessionId),
          pianoRollTrackId: activeSession?.trackId || null,
          pianoRollClipId: activeSession?.clipId || null,
          selectedNoteIds: activeSession?.selectedNoteIds || [],
          midiEditRange: activeSession?.midiEditRange || null,
          pianoRollEditCursorTime: activeSession?.editCursorTime ?? null,
          isModified: true,
        }));

        // Remove children before parents so native routing never observes a
        // dangling child relationship during the operation.
        for (const { track } of [...removedEntries].reverse()) {
          for (const clip of track.clips) {
            if (clip.filePath) {
              await nativeBridge.removePlaybackClipById(track.id, clip.id).catch(() => false);
            }
          }
          await nativeBridge.removeTrack(track.id).catch(() => false);
        }
      };

      const restoreRemoval = async () => {
        set({
          tracks: JSON.parse(JSON.stringify(tracksBefore)),
          trackGroups: JSON.parse(JSON.stringify(trackGroupsBefore)),
          ...selectionForUndo,
          isModified: true,
        });
        for (const { track } of removedEntries) {
          const added = await nativeBridge.addTrack(track.id, track.type).catch(() => false);
          if (!added) throw new Error(`Could not restore track ${track.name}`);
        }
        for (const { track, index } of removedEntries) {
          await restoreRemovedTrackToBackend(
            track,
            index,
            externalByTrackId.get(track.id),
            true,
          );
        }
        for (const [index, track] of tracksBefore.entries()) {
          await nativeBridge.reorderTrack(track.id, index).catch(() => false);
        }
      };

      await applyRemoval();
      commandManager.push({
        type: "DELETE_SELECTED_TRACKS",
        description: `Delete ${removedEntries.length} selected track${removedEntries.length === 1 ? "" : "s"}`,
        timestamp: Date.now(),
        execute: () => {
          void applyRemoval().catch(toastBridgeError("Redo delete selected tracks"));
        },
        undo: () => {
          void restoreRemoval().catch(toastBridgeError("Undo delete selected tracks"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    // ========== Track Audio Controls ==========
    setTrackVolume: async (id, volumeDB) => {
      if (!Number.isFinite(volumeDB)) return;
      if (_linkingInProgress.has("vol_" + id)) return;
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, get().trackGroups, "volume");
      const nextVolumeDB = Math.max(-60, Math.min(12, volumeDB));
      const changedIds = linkedIds.filter((trackId) => (
        get().tracks.find((candidate) => candidate.id === trackId)?.volumeDB !== nextVolumeDB
      ));
      if (changedIds.length === 0) return;
      const linear = Math.pow(10, nextVolumeDB / 20);

      // Batch update all linked tracks in a single set()
      set((state) => ({
        tracks: state.tracks.map((t) =>
          changedIds.includes(t.id) ? { ...t, volumeDB: nextVolumeDB, volume: Math.min(1, linear) } : t,
        ),
        isModified: true,
      }));

      // Bridge calls for each linked track
      for (const tid of changedIds) {
        _linkingInProgress.add("vol_" + tid);
        nativeBridge.setTrackVolume(tid, nextVolumeDB);
        const linkedTrack = get().tracks.find((t) => t.id === tid);
        if (trackAutomationReadEnabled(linkedTrack)
            && linkedTrack?.automationWriteEnabled) {
          get().setAutomationWriteValue?.(tid, "volume", Math.max(0, Math.min(1, (nextVolumeDB + 60) / 72)));
        }
      }
      for (const tid of changedIds) _linkingInProgress.delete("vol_" + tid);

    },

    setTrackPan: async (id, pan) => {
      if (!Number.isFinite(pan)) return;
      if (_linkingInProgress.has("pan_" + id)) return;
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, get().trackGroups, "pan");
      const nextPan = Math.max(-1, Math.min(1, pan));
      const changedIds = linkedIds.filter((trackId) => (
        get().tracks.find((candidate) => candidate.id === trackId)?.pan !== nextPan
      ));
      if (changedIds.length === 0) return;

      set((state) => ({
        tracks: state.tracks.map((t) => (changedIds.includes(t.id) ? { ...t, pan: nextPan } : t)),
        isModified: true,
      }));

      for (const tid of changedIds) {
        _linkingInProgress.add("pan_" + tid);
        nativeBridge.setTrackPan(tid, nextPan);
        const linkedTrack = get().tracks.find((t) => t.id === tid);
        if (trackAutomationReadEnabled(linkedTrack)
            && linkedTrack?.automationWriteEnabled) {
          get().setAutomationWriteValue?.(tid, "pan", Math.max(0, Math.min(1, (nextPan + 1) / 2)));
        }
      }
      for (const tid of changedIds) _linkingInProgress.delete("pan_" + tid);

    },

    toggleTrackMute: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "mute");
      const newMuted = !track.muted;
      // Capture old states for undo
      const oldStates = new Map<string, boolean>();
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) oldStates.set(tid, t.muted);
      }

      const command: Command = {
        type: "TOGGLE_TRACK_MUTE",
        description: newMuted ? "Mute track(s)" : "Unmute track(s)",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              linkedIds.includes(t.id) ? { ...t, muted: newMuted } : t,
            ),
          }));
          for (const tid of linkedIds) nativeBridge.setTrackMute(tid, newMuted);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldStates.get(t.id);
              return old !== undefined ? { ...t, muted: old } : t;
            }),
          }));
          for (const [tid, val] of oldStates) nativeBridge.setTrackMute(tid, val);
        },
      };

      commandManager.execute(command);
      for (const tid of linkedIds) {
        const t = get().tracks.find((candidate) => candidate.id === tid);
        if (t?.automationWriteEnabled) {
          get().beginAutomationParamTouch?.(tid, "mute");
          get().setAutomationWriteValue?.(tid, "mute", newMuted ? 1 : 0);
          get().recordAutomationWriteTick?.(Date.now());
          get().endAutomationParamTouch?.(tid, "mute");
        }
      }
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackSolo: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "solo");
      const newSoloed = !track.soloed;
      const oldStates = new Map<string, boolean>();
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        if (t) oldStates.set(tid, t.soloed);
      }

      const command: Command = {
        type: "TOGGLE_TRACK_SOLO",
        description: newSoloed ? "Solo track(s)" : "Unsolo track(s)",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              linkedIds.includes(t.id) ? { ...t, soloed: newSoloed } : t,
            ),
          }));
          for (const tid of linkedIds) nativeBridge.setTrackSolo(tid, newSoloed);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldStates.get(t.id);
              return old !== undefined ? { ...t, soloed: old } : t;
            }),
          }));
          for (const [tid, val] of oldStates) nativeBridge.setTrackSolo(tid, val);
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackArmed: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      // Record-safe: prevent arming
      if (track.recordSafe && !track.armed) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "armed");
      const newArmed = !track.armed;

      // Filter out record-safe tracks from linked set when trying to arm
      const effectiveIds = newArmed
        ? linkedIds.filter((tid) => !state.tracks.find((t) => t.id === tid)?.recordSafe)
        : linkedIds;
      if (effectiveIds.length === 0) return;

      const oldStates = new Map<string, boolean>();
      for (const tid of effectiveIds) {
        const candidate = state.tracks.find((t) => t.id === tid);
        if (candidate) oldStates.set(tid, candidate.armed);
      }
      const newStates = new Map(effectiveIds.map((tid) => [tid, newArmed]));

      const applyArmedStates = async (armedStates: Map<string, boolean>) => {
        set((s) => ({
          tracks: s.tracks.map((candidate) => {
            const armed = armedStates.get(candidate.id);
            return armed === undefined ? candidate : { ...candidate, armed };
          }),
          isModified: true,
        }));
        for (const [tid, armed] of armedStates) {
          const updatedTrack = get().tracks.find((candidate) => candidate.id === tid);
          if (armed && updatedTrack && isMidiInputTrack(updatedTrack)) {
            await syncTrackCoreToBackend(updatedTrack, {
              includeAddTrack: true,
              openAllMIDIInputs: true,
            }).catch(logBridgeError("track arm"));
          } else {
            await nativeBridge.setTrackRecordArm(tid, armed).catch(logBridgeError("track arm"));
          }
        }
      };

      await applyArmedStates(newStates);
      commandManager.push({
        type: "TOGGLE_TRACK_ARM",
        description: newArmed ? "Arm track(s)" : "Disarm track(s)",
        timestamp: Date.now(),
        execute: () => {
          void applyArmedStates(newStates).catch(logBridgeError("redo track arm"));
        },
        undo: () => {
          void applyArmedStates(oldStates).catch(logBridgeError("undo track arm"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackFXBypass: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "fxBypass");
      const newBypassed = !track.fxBypassed;
      const oldStates = new Map<string, boolean>();
      for (const tid of linkedIds) {
        const candidate = state.tracks.find((t) => t.id === tid);
        if (candidate) oldStates.set(tid, candidate.fxBypassed);
      }
      const newStates = new Map(linkedIds.map((tid) => [tid, newBypassed]));
      const applyBypassStates = async (bypassStates: Map<string, boolean>) => {
        set((s) => ({
          tracks: s.tracks.map((candidate) => {
            const bypassed = bypassStates.get(candidate.id);
            return bypassed === undefined ? candidate : { ...candidate, fxBypassed: bypassed };
          }),
          isModified: true,
        }));
        for (const [tid, bypassed] of bypassStates) {
          const linkedTrack = get().tracks.find((candidate) => candidate.id === tid);
          if (!linkedTrack) continue;
          for (let i = 0; i < linkedTrack.inputFxCount; i++) {
            await nativeBridge.bypassTrackInputFX(tid, i, bypassed).catch(logBridgeError("track input FX bypass"));
          }
          for (let i = 0; i < linkedTrack.trackFxCount; i++) {
            await nativeBridge.bypassTrackFX(tid, i, bypassed).catch(logBridgeError("track FX bypass"));
          }
        }
      };

      await applyBypassStates(newStates);
      commandManager.push({
        type: "TOGGLE_TRACK_FX_BYPASS",
        description: newBypassed ? "Bypass track FX" : "Enable track FX",
        timestamp: Date.now(),
        execute: () => {
          void applyBypassStates(newStates).catch(logBridgeError("redo track FX bypass"));
        },
        undo: () => {
          void applyBypassStates(oldStates).catch(logBridgeError("undo track FX bypass"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleTrackMonitor: async (id) => {
      const state = get();
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return;

      const newMonitor = !track.monitorEnabled;
      const applyMonitor = async (monitorEnabled: boolean) => {
        set((s) => ({
          tracks: s.tracks.map((candidate) =>
            candidate.id === id ? { ...candidate, monitorEnabled } : candidate,
          ),
          isModified: true,
        }));
        await nativeBridge.setTrackInputMonitoring(id, monitorEnabled).catch(logBridgeError("track monitoring"));
      };

      await applyMonitor(newMonitor);
      commandManager.push({
        type: "TOGGLE_TRACK_MONITOR",
        description: newMonitor ? "Enable track monitoring" : "Disable track monitoring",
        timestamp: Date.now(),
        execute: () => {
          void applyMonitor(newMonitor).catch(logBridgeError("redo track monitoring"));
        },
        undo: () => {
          void applyMonitor(track.monitorEnabled).catch(logBridgeError("undo track monitoring"));
        },
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleSelectedTracksMute: () => executeSelectedTrackBooleanBatch(set, get, {
      field: "muted",
      linkedParam: "mute",
      type: "TOGGLE_SELECTED_TRACKS_MUTE",
      description: "Toggle selected track mute",
      sync: (track, muted) => {
        void nativeBridge.setTrackMute(track.id, muted).catch(logBridgeError("selected track mute"));
      },
      afterExecute: (states) => {
        for (const [trackId, muted] of states) {
          const track = get().tracks.find((candidate) => candidate.id === trackId);
          if (!track?.automationWriteEnabled) continue;
          get().beginAutomationParamTouch?.(trackId, "mute");
          get().setAutomationWriteValue?.(trackId, "mute", muted ? 1 : 0);
          get().recordAutomationWriteTick?.(Date.now());
          get().endAutomationParamTouch?.(trackId, "mute");
        }
      },
    }),

    toggleSelectedTracksSolo: () => executeSelectedTrackBooleanBatch(set, get, {
      field: "soloed",
      linkedParam: "solo",
      type: "TOGGLE_SELECTED_TRACKS_SOLO",
      description: "Toggle selected track solo",
      sync: (track, soloed) => {
        void nativeBridge.setTrackSolo(track.id, soloed).catch(logBridgeError("selected track solo"));
      },
    }),

    toggleSelectedTracksArmed: () => executeSelectedTrackBooleanBatch(set, get, {
      field: "armed",
      linkedParam: "armed",
      type: "TOGGLE_SELECTED_TRACKS_ARM",
      description: "Toggle selected track record arm",
      eligible: (track, armed) => !armed || !track.recordSafe,
      sync: (track, armed) => {
        if (armed && isMidiInputTrack(track)) {
          void syncTrackCoreToBackend(track, {
            includeAddTrack: true,
            openAllMIDIInputs: true,
          }).catch(logBridgeError("selected track arm"));
        } else {
          void nativeBridge.setTrackRecordArm(track.id, armed).catch(logBridgeError("selected track arm"));
        }
      },
    }),

    toggleSelectedTracksFXBypass: () => executeSelectedTrackBooleanBatch(set, get, {
      field: "fxBypassed",
      linkedParam: "fxBypass",
      type: "TOGGLE_SELECTED_TRACKS_FX_BYPASS",
      description: "Toggle selected track FX bypass",
      sync: (track, bypassed) => {
        for (let index = 0; index < track.inputFxCount; index += 1) {
          void nativeBridge.bypassTrackInputFX(track.id, index, bypassed)
            .catch(logBridgeError("selected track input FX bypass"));
        }
        for (let index = 0; index < track.trackFxCount; index += 1) {
          void nativeBridge.bypassTrackFX(track.id, index, bypassed)
            .catch(logBridgeError("selected track FX bypass"));
        }
      },
    }),

    toggleSelectedTracksMonitor: () => executeSelectedTrackBooleanBatch(set, get, {
      field: "monitorEnabled",
      type: "TOGGLE_SELECTED_TRACKS_MONITOR",
      description: "Toggle selected track input monitoring",
      sync: (track, monitorEnabled) => {
        void nativeBridge.setTrackInputMonitoring(track.id, monitorEnabled)
          .catch(logBridgeError("selected track monitoring"));
      },
    }),

    toggleSelectedTracksPhaseInvert: () => executeSelectedTrackBooleanBatch(set, get, {
      field: "phaseInverted",
      type: "TOGGLE_SELECTED_TRACKS_PHASE",
      description: "Toggle selected track phase invert",
      sync: (track, phaseInverted) => {
        void nativeBridge.setTrackPhaseInvert(track.id, phaseInverted)
          .catch(logBridgeError("selected track phase invert"));
      },
    }),

    setTrackInput: async (id, startChannel, channelCount) => {
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === id
            ? {
                ...t,
                inputStartChannel: startChannel,
                inputChannelCount: channelCount,
              }
            : t,
        ),
      }));

      await nativeBridge.setTrackInputChannels(id, startChannel, channelCount);
    },

    setTrackMidiPitchBendRange: (id, up, down = up, linked = true) => {
      const track = get().tracks.find((t) => t.id === id);
      if (!track) return;

      const oldRange = {
        midiPitchBendRangeUp: track.midiPitchBendRangeUp ?? 2,
        midiPitchBendRangeDown: track.midiPitchBendRangeDown ?? track.midiPitchBendRangeUp ?? 2,
        midiPitchBendRangeLinked: track.midiPitchBendRangeLinked ?? true,
      };
      const nextRange = {
        midiPitchBendRangeUp: Math.max(1, Math.min(24, Math.round(up))),
        midiPitchBendRangeDown: Math.max(1, Math.min(24, Math.round(linked ? up : down))),
        midiPitchBendRangeLinked: linked,
      };

      const applyRange = (range) => set((state) => ({
        tracks: state.tracks.map((candidate) =>
          candidate.id === id ? { ...candidate, ...range } : candidate,
        ),
        isModified: true,
      }));

      applyRange(nextRange);
      commandManager.push({
        type: "SET_TRACK_MIDI_PITCH_BEND_RANGE",
        description: "Set MIDI pitch bend range",
        timestamp: Date.now(),
        execute: () => applyRange(nextRange),
        undo: () => applyRange(oldRange),
      });
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    },

    // ========== Continuous Edit Begin/Commit (for undo/redo of fader drags) ==========
    beginTrackVolumeEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "volume");
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        const key = "vol_" + tid;
        if (t && !_editSnapshots.has(key)) {
          _editSnapshots.set(key, t.volumeDB);
          get().beginAutomationParamTouch?.(tid, "volume");
        }
      }
    },
    commitTrackVolumeEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "volume");

      // Collect old/new values for all linked tracks
      const changes: Array<{ tid: string; oldVal: number; newVal: number }> = [];
      for (const tid of linkedIds) {
        const key = "vol_" + tid;
        const oldVal = _editSnapshots.get(key);
        _editSnapshots.delete(key);
        if (oldVal === undefined) continue;
        const t = state.tracks.find((tr) => tr.id === tid);
        if (!t || t.volumeDB === oldVal) continue;
        changes.push({ tid, oldVal, newVal: t.volumeDB });
      }
      const endTouched = () => {
        for (const tid of linkedIds) {
          const t = get().tracks.find((tr) => tr.id === tid);
          get().endAutomationParamTouch?.(tid, "volume");
        }
      };

      if (changes.length === 0) {
        endTouched();
        return;
      }

      const command: Command = {
        type: "SET_TRACK_VOLUME",
        description: "Adjust track volume",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, volumeDB: c.newVal, volume: Math.min(1, Math.pow(10, c.newVal / 20)) } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackVolume(c.tid, c.newVal);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, volumeDB: c.oldVal, volume: Math.min(1, Math.pow(10, c.oldVal / 20)) } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackVolume(c.tid, c.oldVal);
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

      endTouched();
    },
    beginTrackVolumeBatchEdit: (trackIds) => {
      if (activeTrackVolumeBatchEdit) get().commitTrackVolumeBatchEdit();

      const state = get();
      const requestedIds = new Set(trackIds);
      const expandedIds = new Set<string>();
      for (const candidate of state.tracks) {
        if (!requestedIds.has(candidate.id)) continue;
        for (const linkedId of getLinkedTrackIds(candidate.id, state.trackGroups, "volume")) {
          if (state.tracks.some((track) => track.id === linkedId)) expandedIds.add(linkedId);
        }
      }

      // Preserve project order and include every linked member exactly once.
      const eligibleIds = state.tracks
        .map((track) => track.id)
        .filter((trackId) => expandedIds.has(trackId));
      if (eligibleIds.length === 0) return false;

      activeTrackVolumeBatchEdit = {
        trackIds: eligibleIds,
        oldValues: new Map(eligibleIds.map((trackId) => [
          trackId,
          state.tracks.find((track) => track.id === trackId).volumeDB,
        ])),
      };
      for (const trackId of eligibleIds) {
        get().beginAutomationParamTouch?.(trackId, "volume");
      }
      return true;
    },
    adjustTrackVolumeBatch: (deltaDB) => {
      const session = activeTrackVolumeBatchEdit;
      if (!session || !Number.isFinite(deltaDB) || deltaDB === 0) return false;

      const state = get();
      const nextValues = new Map<string, number>();
      for (const trackId of session.trackIds) {
        const track = state.tracks.find((candidate) => candidate.id === trackId);
        if (!track) continue;
        const nextValue = Math.max(-60, Math.min(12, track.volumeDB + deltaDB));
        if (nextValue !== track.volumeDB) nextValues.set(trackId, nextValue);
      }
      if (nextValues.size === 0) return false;

      set((current) => ({
        tracks: current.tracks.map((track) => {
          const volumeDB = nextValues.get(track.id);
          return volumeDB === undefined
            ? track
            : {
                ...track,
                volumeDB,
                volume: Math.min(1, Math.pow(10, volumeDB / 20)),
              };
        }),
      }));
      for (const [trackId, volumeDB] of nextValues) {
        nativeBridge.setTrackVolume(trackId, volumeDB);
        const track = get().tracks.find((candidate) => candidate.id === trackId);
        if (trackAutomationReadEnabled(track) && track?.automationWriteEnabled) {
          get().setAutomationWriteValue?.(
            trackId,
            "volume",
            Math.max(0, Math.min(1, (volumeDB + 60) / 72)),
          );
        }
      }
      return true;
    },
    commitTrackVolumeBatchEdit: () => {
      const session = activeTrackVolumeBatchEdit;
      if (!session) return false;
      activeTrackVolumeBatchEdit = null;

      const state = get();
      const changes = session.trackIds.flatMap((trackId) => {
        const oldVal = session.oldValues.get(trackId);
        const track = state.tracks.find((candidate) => candidate.id === trackId);
        return oldVal === undefined || !track || track.volumeDB === oldVal
          ? []
          : [{ trackId, oldVal, newVal: track.volumeDB }];
      });
      const endTouches = () => {
        for (const trackId of session.trackIds) {
          get().endAutomationParamTouch?.(trackId, "volume");
        }
      };
      if (changes.length === 0) {
        endTouches();
        return false;
      }

      const applyValues = (key: "oldVal" | "newVal") => {
        const values = new Map(changes.map((change) => [change.trackId, change[key]]));
        set((current) => ({
          tracks: current.tracks.map((track) => {
            const volumeDB = values.get(track.id);
            return volumeDB === undefined
              ? track
              : {
                  ...track,
                  volumeDB,
                  volume: Math.min(1, Math.pow(10, volumeDB / 20)),
                };
          }),
        }));
        for (const [trackId, volumeDB] of values) {
          nativeBridge.setTrackVolume(trackId, volumeDB);
        }
      };

      commandManager.execute({
        type: "SET_TRACK_VOLUMES",
        description: changes.length === 1
          ? "Adjust track volume"
          : `Adjust ${changes.length} track volumes`,
        timestamp: Date.now(),
        execute: () => applyValues("newVal"),
        undo: () => applyValues("oldVal"),
      });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      endTouches();
      return true;
    },
    beginTrackPanEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "pan");
      for (const tid of linkedIds) {
        const t = state.tracks.find((tr) => tr.id === tid);
        const key = "pan_" + tid;
        if (t && !_editSnapshots.has(key)) {
          _editSnapshots.set(key, t.pan);
          get().beginAutomationParamTouch?.(tid, "pan");
        }
      }
    },
    commitTrackPanEdit: (id) => {
      const state = get();
      const linkedIds = getLinkedTrackIds(id, state.trackGroups, "pan");

      const changes: Array<{ tid: string; oldVal: number; newVal: number }> = [];
      for (const tid of linkedIds) {
        const key = "pan_" + tid;
        const oldVal = _editSnapshots.get(key);
        _editSnapshots.delete(key);
        if (oldVal === undefined) continue;
        const t = state.tracks.find((tr) => tr.id === tid);
        if (!t || t.pan === oldVal) continue;
        changes.push({ tid, oldVal, newVal: t.pan });
      }
      const endTouched = () => {
        for (const tid of linkedIds) {
          const t = get().tracks.find((tr) => tr.id === tid);
          get().endAutomationParamTouch?.(tid, "pan");
        }
      };

      if (changes.length === 0) {
        endTouched();
        return;
      }

      const command: Command = {
        type: "SET_TRACK_PAN",
        description: "Adjust track pan",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, pan: c.newVal } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackPan(c.tid, c.newVal);
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const c = changes.find((ch) => ch.tid === t.id);
              return c ? { ...t, pan: c.oldVal } : t;
            }),
          }));
          for (const c of changes) nativeBridge.setTrackPan(c.tid, c.oldVal);
        },
      };
      commandManager.push(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });

      endTouched();
    },
    beginClipVolumeEdit: (clipId) => {
      const key = "clipVol_" + clipId;
      if (_editSnapshots.has(key)) return;
      const state = get();
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip && !isClipEditLocked(state, clip)) {
          _editSnapshots.set(key, clip.volumeDB);
          clipVolumeEditModifiedSnapshots.set(clipId, Boolean(state.isModified));
          break;
        }
      }
    },
    commitClipVolumeEdit: (clipId) => {
      const key = "clipVol_" + clipId;
      const oldValue = _editSnapshots.get(key);
      _editSnapshots.delete(key);
      clipVolumeEditModifiedSnapshots.delete(clipId);
      if (oldValue === undefined) return;
      let newValue = oldValue;
      for (const track of get().tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) { newValue = clip.volumeDB; break; }
      }
      if (newValue === oldValue) return;
      const command: Command = {
        type: "SET_CLIP_VOLUME",
        description: "Adjust clip volume",
        timestamp: Date.now(),
        execute: () => {
          if (applyClipVolumeValue(set, get, clipId, newValue)) {
            syncClipVolumeEdit(get, "redo clip volume");
          }
        },
        undo: () => {
          if (applyClipVolumeValue(set, get, clipId, oldValue)) {
            syncClipVolumeEdit(get, "undo clip volume");
          }
        },
      };
      commandManager.push(command);
      syncClipVolumeEdit(get, "clip volume");
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },
    cancelClipVolumeEdit: (clipId) => {
      const key = "clipVol_" + clipId;
      const oldValue = _editSnapshots.get(key);
      const wasModified = clipVolumeEditModifiedSnapshots.get(clipId);
      _editSnapshots.delete(key);
      clipVolumeEditModifiedSnapshots.delete(clipId);
      if (oldValue === undefined) return false;
      let restored = false;
      set((state) => ({
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => {
            if (clip.id !== clipId) return clip;
            restored = true;
            return { ...clip, volumeDB: oldValue };
          }),
        })),
        isModified: wasModified ?? state.isModified,
      }));
      return restored;
    },

});
