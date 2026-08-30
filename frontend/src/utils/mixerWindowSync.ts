import { nativeBridge, type MixerUISnapshotEnvelope } from "../services/NativeBridge";
import {
  useDAWStore,
  type AutomationLane,
  type MixerSnapshot,
  type Track,
} from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { getRegisteredActions, type ActionDef } from "../store/actionRegistry";
import {
  extractInputProfileWindowSnapshot,
  parseInputProfileWindowSnapshot,
  type InputProfileWindowSnapshot,
} from "./inputProfileWindowSync";
import {
  getDetachedMainActionAvailability,
  isDetachedMainActionId,
  setDetachedMainActionAvailability,
} from "./detachedMainActionRouting";
import { windowRole } from "./windowEnvironment";

type MixerTrackState = Omit<Track, "meterLevel" | "peakLevel" | "clipping" | "clips" | "midiClips">;

type MixerPanelPosition = {
  dock: "floating" | "left" | "right" | "bottom" | "tab";
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  tabGroup?: string;
};

export interface MixerUISnapshot extends InputProfileWindowSnapshot {
  /** Detached CommandManager boundary: previews share a token, commit advances it. */
  editBoundaryToken: string;
  availableDetachedMainActionIds: string[];
  tracks: MixerTrackState[];
  selectedTrackIds: string[];
  lastSelectedTrackId: string | null;
  trackGroups: Array<{ id: string; name: string; leadTrackId: string; memberTrackIds: string[]; linkedParams: string[] }>;
  masterVolume: number;
  masterPan: number;
  masterFxCount: number;
  isMasterMuted: boolean;
  masterMono: boolean;
  masterAutomationLanes: AutomationLane[];
  showMasterAutomation: boolean;
  masterAutomationReadEnabled: boolean;
  masterAutomationWriteEnabled: boolean;
  masterAutomationEnabled: boolean;
  automationWriteBehavior: "touch" | "latch" | "overwrite";
  mixerSnapshots: MixerSnapshot[];
  showMixer: boolean;
  detachedPanels: string[];
  panelPositions: {
    mixer: MixerPanelPosition;
  };
}

const windowId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `mixer-window-${Date.now()}-${Math.random().toString(16).slice(2)}`;

let remoteApplyDepth = 0;
let currentRevision = 0;
let lastPublishedSignature = "";
const REMOTE_MIXER_EDIT_IDLE_MS = 180;
let detachedMainActions: ActionDef[] | null = null;

interface MixerTrackControlState {
  volume: number;
  volumeDB: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  armed: boolean;
  fxBypassed: boolean;
}

interface MixerMasterControlState {
  masterVolume: number;
  masterPan: number;
  isMasterMuted: boolean;
  masterMono: boolean;
  masterAutomationLanes: AutomationLane[];
  showMasterAutomation: boolean;
  masterAutomationReadEnabled: boolean;
  masterAutomationWriteEnabled: boolean;
  masterAutomationEnabled: boolean;
  automationWriteBehavior: "touch" | "latch" | "overwrite";
}

interface MixerProjectSnapshot extends MixerMasterControlState {
  trackOrder: string[];
  trackControls: Record<string, MixerTrackControlState>;
  trackGroups: ReturnType<typeof useDAWStore.getState>["trackGroups"];
  mixerSnapshots: MixerSnapshot[];
}

interface MixerEditPatch {
  trackOrder?: string[];
  trackControls?: Record<string, Partial<MixerTrackControlState>>;
  trackGroups?: MixerProjectSnapshot["trackGroups"];
  master?: Partial<MixerMasterControlState>;
  mixerSnapshots?: MixerSnapshot[];
}

interface PendingRemoteMixerEdit {
  boundaryToken: string;
  targetSignature: string;
  before: MixerEditPatch;
  after: MixerEditPatch;
  timer: ReturnType<typeof setTimeout> | null;
}

let pendingRemoteMixerEdit: PendingRemoteMixerEdit | null = null;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractMixerProjectSnapshot(
  state = useDAWStore.getState(),
): MixerProjectSnapshot {
  return cloneValue({
    trackOrder: state.tracks.map((track) => track.id),
    trackControls: Object.fromEntries(state.tracks.map((track) => [track.id, {
      volume: track.volume,
      volumeDB: track.volumeDB,
      pan: track.pan,
      muted: track.muted,
      soloed: track.soloed,
      armed: track.armed,
      fxBypassed: track.fxBypassed,
    }])),
    trackGroups: state.trackGroups,
    masterVolume: state.masterVolume,
    masterPan: state.masterPan,
    isMasterMuted: state.isMasterMuted,
    masterMono: state.masterMono,
    masterAutomationLanes: state.masterAutomationLanes,
    showMasterAutomation: state.showMasterAutomation,
    masterAutomationReadEnabled: state.masterAutomationReadEnabled,
    masterAutomationWriteEnabled: state.masterAutomationWriteEnabled,
    masterAutomationEnabled: state.masterAutomationEnabled,
    automationWriteBehavior: state.automationWriteBehavior,
    mixerSnapshots: state.mixerSnapshots,
  });
}

function setTrackPatchValue(
  patch: MixerEditPatch,
  trackId: string,
  values: Partial<MixerTrackControlState>,
): void {
  patch.trackControls ??= {};
  patch.trackControls[trackId] = {
    ...(patch.trackControls[trackId] ?? {}),
    ...cloneValue(values),
  };
}

function buildMixerEdit(
  before: MixerProjectSnapshot,
  after: MixerProjectSnapshot,
): { targetSignature: string; before: MixerEditPatch; after: MixerEditPatch } | null {
  const beforePatch: MixerEditPatch = {};
  const afterPatch: MixerEditPatch = {};
  const targets: string[] = [];
  const trackIds = new Set([...Object.keys(before.trackControls), ...Object.keys(after.trackControls)]);
  for (const trackId of trackIds) {
    const oldTrack = before.trackControls[trackId];
    const nextTrack = after.trackControls[trackId];
    if (!oldTrack || !nextTrack) continue;
    if (oldTrack.volume !== nextTrack.volume || oldTrack.volumeDB !== nextTrack.volumeDB) {
      setTrackPatchValue(beforePatch, trackId, { volume: oldTrack.volume, volumeDB: oldTrack.volumeDB });
      setTrackPatchValue(afterPatch, trackId, { volume: nextTrack.volume, volumeDB: nextTrack.volumeDB });
      targets.push(`track:${trackId}:volume`);
    }
    for (const key of ["pan", "muted", "soloed", "armed", "fxBypassed"] as const) {
      if (oldTrack[key] === nextTrack[key]) continue;
      setTrackPatchValue(beforePatch, trackId, { [key]: oldTrack[key] });
      setTrackPatchValue(afterPatch, trackId, { [key]: nextTrack[key] });
      targets.push(`track:${trackId}:${key}`);
    }
  }

  if (JSON.stringify(before.trackOrder) !== JSON.stringify(after.trackOrder)) {
    beforePatch.trackOrder = cloneValue(before.trackOrder);
    afterPatch.trackOrder = cloneValue(after.trackOrder);
    targets.push("track-order");
  }
  if (JSON.stringify(before.trackGroups) !== JSON.stringify(after.trackGroups)) {
    beforePatch.trackGroups = cloneValue(before.trackGroups);
    afterPatch.trackGroups = cloneValue(after.trackGroups);
    targets.push("track-groups");
  }

  for (const key of [
    "masterVolume",
    "masterPan",
    "isMasterMuted",
    "masterMono",
    "showMasterAutomation",
    "masterAutomationReadEnabled",
    "masterAutomationWriteEnabled",
    "masterAutomationEnabled",
    "automationWriteBehavior",
  ] as const) {
    if (before[key] === after[key]) continue;
    beforePatch.master ??= {};
    afterPatch.master ??= {};
    (beforePatch.master as Record<string, unknown>)[key] = before[key];
    (afterPatch.master as Record<string, unknown>)[key] = after[key];
    targets.push(`master:${key}`);
  }
  if (JSON.stringify(before.masterAutomationLanes) !== JSON.stringify(after.masterAutomationLanes)) {
    beforePatch.master ??= {};
    afterPatch.master ??= {};
    beforePatch.master.masterAutomationLanes = cloneValue(before.masterAutomationLanes);
    afterPatch.master.masterAutomationLanes = cloneValue(after.masterAutomationLanes);
    targets.push("master:automation-lanes");
  }
  if (JSON.stringify(before.mixerSnapshots) !== JSON.stringify(after.mixerSnapshots)) {
    beforePatch.mixerSnapshots = cloneValue(before.mixerSnapshots);
    afterPatch.mixerSnapshots = cloneValue(after.mixerSnapshots);
    targets.push("mixer-snapshots");
  }

  if (targets.length === 0) return null;
  return {
    targetSignature: [...new Set(targets)].sort().join("|"),
    before: beforePatch,
    after: afterPatch,
  };
}

function applyMixerEditPatch(value: MixerEditPatch): void {
  const patch = cloneValue(value);
  useDAWStore.setState((state) => {
    let tracks = state.tracks.map((track) => {
      const controls = patch.trackControls?.[track.id];
      return controls ? { ...track, ...controls } : track;
    });
    if (patch.trackOrder) {
      const order = new Map(patch.trackOrder.map((trackId, index) => [trackId, index]));
      const originalOrder = new Map(tracks.map((track, index) => [track.id, index]));
      tracks = [...tracks].sort((left, right) => (
        (order.get(left.id) ?? patch.trackOrder!.length + (originalOrder.get(left.id) ?? 0))
        - (order.get(right.id) ?? patch.trackOrder!.length + (originalOrder.get(right.id) ?? 0))
      ));
    }
    return {
      tracks,
      ...(patch.trackGroups ? { trackGroups: patch.trackGroups } : {}),
      ...(patch.master ?? {}),
      ...(patch.mixerSnapshots ? { mixerSnapshots: patch.mixerSnapshots } : {}),
      isModified: true,
    };
  });

  const currentTracks = new Map(useDAWStore.getState().tracks.map((track) => [track.id, track]));
  for (const [trackId, controls] of Object.entries(patch.trackControls ?? {})) {
    const track = currentTracks.get(trackId);
    if (!track) continue;
    if (controls.volumeDB !== undefined) void nativeBridge.setTrackVolume(trackId, controls.volumeDB);
    if (controls.pan !== undefined) void nativeBridge.setTrackPan(trackId, controls.pan);
    if (controls.muted !== undefined) void nativeBridge.setTrackMute(trackId, controls.muted);
    if (controls.soloed !== undefined) void nativeBridge.setTrackSolo(trackId, controls.soloed);
    if (controls.armed !== undefined) void nativeBridge.setTrackRecordArm(trackId, controls.armed);
    if (controls.fxBypassed !== undefined) {
      for (let index = 0; index < track.inputFxCount; index += 1) {
        void nativeBridge.bypassTrackInputFX(trackId, index, controls.fxBypassed);
      }
      for (let index = 0; index < track.trackFxCount; index += 1) {
        void nativeBridge.bypassTrackFX(trackId, index, controls.fxBypassed);
      }
    }
  }
  if (patch.trackOrder) {
    patch.trackOrder.forEach((trackId, index) => { void nativeBridge.reorderTrack(trackId, index); });
  }
  if (patch.master?.masterVolume !== undefined || patch.master?.isMasterMuted !== undefined) {
    const state = useDAWStore.getState();
    void nativeBridge.setMasterVolume(state.isMasterMuted ? 0 : state.masterVolume);
  }
  if (patch.master?.masterPan !== undefined) void nativeBridge.setMasterPan(patch.master.masterPan);
  if (patch.master?.masterMono !== undefined) void nativeBridge.setMasterMono(patch.master.masterMono);
}

export function flushPendingMixerRemoteEdit(): boolean {
  const pending = pendingRemoteMixerEdit;
  if (!pending) return false;
  pendingRemoteMixerEdit = null;
  if (pending.timer) clearTimeout(pending.timer);
  if (JSON.stringify(pending.before) === JSON.stringify(pending.after)) return false;

  const before = cloneValue(pending.before);
  const after = cloneValue(pending.after);
  commandManager.push({
    type: "DETACHED_MIXER_EDIT",
    description: "Edit mixer from detached window",
    timestamp: Date.now(),
    execute: () => applyMixerEditPatch(after),
    undo: () => applyMixerEditPatch(before),
  });
  useDAWStore.setState({
    isModified: true,
    canUndo: commandManager.canUndo(),
    canRedo: commandManager.canRedo(),
  });
  return true;
}

export function cancelPendingMixerRemoteEdit(): void {
  if (pendingRemoteMixerEdit?.timer) clearTimeout(pendingRemoteMixerEdit.timer);
  pendingRemoteMixerEdit = null;
}

function queueRemoteMixerUndo(
  before: MixerProjectSnapshot,
  after: MixerProjectSnapshot,
  boundaryToken: string,
): void {
  if (pendingRemoteMixerEdit && pendingRemoteMixerEdit.boundaryToken !== boundaryToken) {
    flushPendingMixerRemoteEdit();
  }
  const edit = buildMixerEdit(before, after);
  // A commit normally publishes only the new boundary token because its final
  // value was already sent as a preview. The token change above must still
  // flush that completed gesture even when there is no state diff here.
  if (!edit) return;
  if (pendingRemoteMixerEdit && pendingRemoteMixerEdit.targetSignature !== edit.targetSignature) {
    flushPendingMixerRemoteEdit();
  }
  if (!pendingRemoteMixerEdit) {
    pendingRemoteMixerEdit = { ...edit, boundaryToken, timer: null };
  } else {
    pendingRemoteMixerEdit.after = edit.after;
    if (pendingRemoteMixerEdit.timer) clearTimeout(pendingRemoteMixerEdit.timer);
  }
  pendingRemoteMixerEdit.timer = setTimeout(
    flushPendingMixerRemoteEdit,
    REMOTE_MIXER_EDIT_IDLE_MS,
  );
}

function serialiseTrack(track: Track): MixerTrackState {
  const { meterLevel, peakLevel, clipping, clips, midiClips, ...rest } = track;
  void meterLevel;
  void peakLevel;
  void clipping;
  void clips;
  void midiClips;
  return rest;
}

function getSnapshotSignature(snapshot: MixerUISnapshot): string {
  return JSON.stringify(snapshot);
}

function getAvailableDetachedMainActionIds(): string[] {
  // Action definitions are static and their handlers/availability predicates
  // read current Zustand state when invoked. Cache only the small detached
  // subset so the 60 fps transport updates do not rebuild the full registry.
  detachedMainActions ??= getRegisteredActions().filter((action) => (
    isDetachedMainActionId(action.id)
  ));
  return windowRole === "main"
    ? detachedMainActions.filter((action) => (
      !action.canHandleShortcut || action.canHandleShortcut()
    )).map((action) => action.id)
    : [...getDetachedMainActionAvailability()];
}

function actionAvailabilityEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((actionId, index) => actionId === right[index]);
}

type MixerStoreState = ReturnType<typeof useDAWStore.getState>;
type MixerUISyncDependencies = readonly unknown[];

/**
 * Keep hot runtime state (playhead, meters, automation display values) out of
 * the retained-window payload path. Detached action availability has its own
 * lightweight selector below, so future canHandleShortcut dependencies do not
 * need to be duplicated manually in this list.
 */
function selectMixerUISyncDependencies(state: MixerStoreState): MixerUISyncDependencies {
  return [
    // State carried by MixerUISnapshot.
    state.keyboardShortcutProfileId,
    state.mouseBehaviorProfileId,
    state.customKeyboardProfiles,
    state.activeCustomKeyboardProfileId,
    state.customShortcuts,
    state.mouseModifiers,
    state.tracks,
    state.selectedTrackIds,
    state.lastSelectedTrackId,
    state.trackGroups,
    state.masterVolume,
    state.masterPan,
    state.masterFxCount,
    state.isMasterMuted,
    state.masterMono,
    state.masterAutomationLanes,
    state.showMasterAutomation,
    state.masterAutomationReadEnabled,
    state.masterAutomationWriteEnabled,
    state.masterAutomationEnabled,
    state.automationWriteBehavior,
    state.mixerSnapshots,
    state.showMixer,
    state.detachedPanels,
    state.panelPositions,
  ];
}

function mixerUISyncDependenciesEqual(
  left: MixerUISyncDependencies,
  right: MixerUISyncDependencies,
): boolean {
  return left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown, maxLength = 512): value is string[] {
  return Array.isArray(value)
    && value.length <= maxLength
    && value.every((entry) => isBoundedString(entry));
}

function isValidAutomationLanes(value: unknown): value is AutomationLane[] {
  if (!Array.isArray(value) || value.length > 4096) return false;
  return value.every((lane) => {
    if (!isRecord(lane)
      || !isBoundedString(lane.id)
      || !isBoundedString(lane.param)
      || !Array.isArray(lane.points)
      || lane.points.length > 1_000_000) return false;
    return lane.points.every((point) => (
      isRecord(point)
      && isFiniteNumber(point.time)
      && isFiniteNumber(point.value)
      && (point.id === undefined || isBoundedString(point.id))
    ));
  });
}

/** Reject malformed or structurally ambiguous packets before store mutation. */
export function parseMixerUISnapshot(value: unknown): MixerUISnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.tracks) || value.tracks.length > 512) return null;
  if (!isBoundedString(value.editBoundaryToken, 1024) || value.editBoundaryToken.length === 0) return null;
  const trackIds = new Set<string>();
  for (const track of value.tracks) {
    if (!isRecord(track) || !isBoundedString(track.id) || track.id.length === 0) return null;
    if (trackIds.has(track.id)) return null;
    trackIds.add(track.id);
    if (!isFiniteNumber(track.volume)
      || !isFiniteNumber(track.volumeDB)
      || !isFiniteNumber(track.pan)) return null;
    for (const key of ["muted", "soloed", "armed", "fxBypassed"]) {
      if (typeof track[key] !== "boolean") return null;
    }
    if (!isValidAutomationLanes(track.automationLanes)) return null;
  }
  if (!isStringArray(value.selectedTrackIds)
    || !value.selectedTrackIds.every((trackId) => trackIds.has(trackId))) return null;
  if (value.lastSelectedTrackId !== null
    && (!isBoundedString(value.lastSelectedTrackId) || !trackIds.has(value.lastSelectedTrackId))) {
    return null;
  }
  if (!Array.isArray(value.trackGroups) || value.trackGroups.length > 512) return null;
  for (const group of value.trackGroups) {
    if (!isRecord(group)
      || !isBoundedString(group.id)
      || !isBoundedString(group.name, 4096)
      || !isBoundedString(group.leadTrackId)
      || !trackIds.has(group.leadTrackId)
      || !isStringArray(group.memberTrackIds)
      || !group.memberTrackIds.every((trackId) => trackIds.has(trackId))
      || !isStringArray(group.linkedParams)) return null;
  }
  for (const key of ["masterVolume", "masterPan", "masterFxCount"]) {
    if (!isFiniteNumber(value[key])) return null;
  }
  for (const key of [
    "isMasterMuted",
    "masterMono",
    "showMasterAutomation",
    "masterAutomationReadEnabled",
    "masterAutomationWriteEnabled",
    "masterAutomationEnabled",
    "showMixer",
  ]) {
    if (typeof value[key] !== "boolean") return null;
  }
  if (!isValidAutomationLanes(value.masterAutomationLanes)) return null;
  if (!Array.isArray(value.mixerSnapshots) || value.mixerSnapshots.length > 4096) return null;
  if (!isStringArray(value.detachedPanels, 64)) return null;
  if (!isRecord(value.panelPositions) || !isRecord(value.panelPositions.mixer)) return null;
  return value as unknown as MixerUISnapshot;
}

function normaliseEnvelope(
  value: any,
): MixerUISnapshotEnvelope<MixerUISnapshot> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const envelope = "payload" in value && "originWindowId" in value
    ? value as MixerUISnapshotEnvelope<MixerUISnapshot>
    : {
      originWindowId: "",
      revision: 0,
      payload: value as MixerUISnapshot,
    };

  const payload = parseMixerUISnapshot(envelope.payload);
  if (!payload) return null;
  return {
    originWindowId: isBoundedString(envelope.originWindowId) ? envelope.originWindowId : "",
    revision: isFiniteNumber(envelope.revision) ? envelope.revision : 0,
    payload,
  };
}

export function extractMixerUISnapshot(state = useDAWStore.getState()): MixerUISnapshot {
  const mixerPosition = state.panelPositions.mixer ?? {
    dock: "bottom",
    x: 0,
    y: 0,
    width: 1280,
    height: 540,
    visible: false,
  };

  return {
    ...extractInputProfileWindowSnapshot(state),
    editBoundaryToken: `${windowId}:${commandManager.getRevision()}`,
    availableDetachedMainActionIds: getAvailableDetachedMainActionIds(),
    tracks: state.tracks.map(serialiseTrack),
    selectedTrackIds: state.selectedTrackIds,
    lastSelectedTrackId: state.lastSelectedTrackId,
    trackGroups: state.trackGroups,
    masterVolume: state.masterVolume,
    masterPan: state.masterPan,
    masterFxCount: state.masterFxCount,
    isMasterMuted: state.isMasterMuted,
    masterMono: state.masterMono,
    masterAutomationLanes: state.masterAutomationLanes,
    showMasterAutomation: state.showMasterAutomation,
    masterAutomationReadEnabled: state.masterAutomationReadEnabled,
    masterAutomationWriteEnabled: state.masterAutomationWriteEnabled,
    masterAutomationEnabled: state.masterAutomationEnabled,
    automationWriteBehavior: state.automationWriteBehavior,
    mixerSnapshots: state.mixerSnapshots,
    showMixer: state.showMixer,
    detachedPanels: state.detachedPanels,
    panelPositions: {
      mixer: {
        dock: mixerPosition.dock,
        x: mixerPosition.x,
        y: mixerPosition.y,
        width: mixerPosition.width,
        height: mixerPosition.height,
        visible: mixerPosition.visible,
        tabGroup: mixerPosition.tabGroup,
      },
    },
  };
}

interface ApplyMixerUISnapshotOptions {
  preserveTrackStructure?: boolean;
}

function mergeRemoteMixerControls(current: Track, remote: MixerTrackState): Track {
  // The detached mixer owns only controls it actually renders. In particular,
  // never accept takes, freeze backups, routing graphs, or any clip-bearing
  // property from the intentionally stripped track replica.
  return {
    ...current,
    volume: remote.volume,
    volumeDB: remote.volumeDB,
    pan: remote.pan,
    muted: remote.muted,
    soloed: remote.soloed,
    armed: remote.armed,
    fxBypassed: remote.fxBypassed,
  };
}

export function applyMixerUISnapshot(
  snapshot: MixerUISnapshot,
  options: ApplyMixerUISnapshotOptions = {},
): void {
  if (windowRole !== "main") {
    setDetachedMainActionAvailability(snapshot.availableDetachedMainActionIds);
  }
  useDAWStore.setState((state) => {
    // The main window owns profile selection. Detached windows may consume the
    // retained profile, but a stale replica must never roll the main profile
    // back while publishing a mixer gesture.
    const inputProfileState = windowRole === "main" && options.preserveTrackStructure
      ? null
      : parseInputProfileWindowSnapshot(snapshot);
    const existingTracks = new Map(state.tracks.map((track) => [track.id, track]));

    const remoteTrackIds = snapshot.tracks.map((track) => track.id);
    const uniqueRemoteTrackIds = new Set(remoteTrackIds);
    const canApplyTrackStructure = !options.preserveTrackStructure || (
      uniqueRemoteTrackIds.size === remoteTrackIds.length
      && remoteTrackIds.length === state.tracks.length
      && state.tracks.every((track) => uniqueRemoteTrackIds.has(track.id))
    );
    const tracks = (canApplyTrackStructure ? snapshot.tracks : state.tracks.map(serialiseTrack)).map((remoteTrack) => {
      const currentTrack = existingTracks.get(remoteTrack.id);
      if (options.preserveTrackStructure && currentTrack) {
        return mergeRemoteMixerControls(currentTrack, remoteTrack);
      }
      return {
        ...(currentTrack ?? {
          meterLevel: 0,
          peakLevel: 0,
          clipping: false,
          clips: [],
          midiClips: [],
        }),
        ...remoteTrack,
        meterLevel: currentTrack?.meterLevel ?? 0,
        peakLevel: currentTrack?.peakLevel ?? 0,
        clipping: currentTrack?.clipping ?? false,
        clips: currentTrack?.clips ?? [],
        midiClips: currentTrack?.midiClips ?? [],
      } as Track;
    });

    const validTrackIds = new Set(tracks.map((track) => track.id));
    const selectedTrackIds = Array.isArray(snapshot.selectedTrackIds)
      ? snapshot.selectedTrackIds.filter((id) => typeof id === "string" && validTrackIds.has(id))
      : [];
    return {
      ...(inputProfileState ?? {}),
      tracks,
      selectedTrackIds,
      selectedTrackId: selectedTrackIds[0] ?? null,
      lastSelectedTrackId:
        (snapshot.lastSelectedTrackId && validTrackIds.has(snapshot.lastSelectedTrackId)
          ? snapshot.lastSelectedTrackId
          : null) ??
        selectedTrackIds[selectedTrackIds.length - 1] ??
        null,
      trackGroups: canApplyTrackStructure ? snapshot.trackGroups : state.trackGroups,
      masterVolume: snapshot.masterVolume,
      masterPan: snapshot.masterPan,
      masterFxCount: options.preserveTrackStructure ? state.masterFxCount : snapshot.masterFxCount,
      isMasterMuted: snapshot.isMasterMuted,
      masterMono: snapshot.masterMono,
      masterAutomationLanes: snapshot.masterAutomationLanes,
      showMasterAutomation: snapshot.showMasterAutomation,
      masterAutomationReadEnabled:
        snapshot.masterAutomationReadEnabled ?? snapshot.masterAutomationEnabled,
      masterAutomationWriteEnabled: snapshot.masterAutomationWriteEnabled ?? false,
      masterAutomationEnabled:
        snapshot.masterAutomationReadEnabled ?? snapshot.masterAutomationEnabled,
      automationWriteBehavior: snapshot.automationWriteBehavior ?? state.automationWriteBehavior,
      mixerSnapshots: snapshot.mixerSnapshots,
      showMixer: snapshot.showMixer,
      detachedPanels: snapshot.detachedPanels,
      panelPositions: {
        ...state.panelPositions,
        mixer: {
          ...state.panelPositions.mixer,
          ...snapshot.panelPositions.mixer,
        },
      },
    };
  });
}

/** Apply one detached mixer packet in main while collecting one idle-burst undo. */
export function applyRemoteMixerUISnapshot(snapshot: MixerUISnapshot): void {
  const before = extractMixerProjectSnapshot();
  applyMixerUISnapshot(snapshot, { preserveTrackStructure: true });
  const after = extractMixerProjectSnapshot();
  queueRemoteMixerUndo(before, after, snapshot.editBoundaryToken);
}

export async function publishCurrentMixerUISnapshot(): Promise<void> {
  const payload = extractMixerUISnapshot();
  lastPublishedSignature = getSnapshotSignature(payload);
  currentRevision += 1;
  await nativeBridge.publishMixerUISnapshot({
    originWindowId: windowId,
    revision: currentRevision,
    payload,
  });
}

export async function hydrateMixerUISnapshotFromNative(): Promise<boolean> {
  const rawSnapshot = await nativeBridge.getMixerUISnapshot<
    MixerUISnapshotEnvelope<MixerUISnapshot> | MixerUISnapshot | null
  >();
  const envelope = normaliseEnvelope(rawSnapshot);
  if (!envelope) {
    return false;
  }

  currentRevision = Math.max(currentRevision, envelope.revision ?? 0);
  lastPublishedSignature = getSnapshotSignature(envelope.payload);
  remoteApplyDepth += 1;
  try {
    applyMixerUISnapshot(envelope.payload);
  } finally {
    remoteApplyDepth -= 1;
  }
  return true;
}

export function startMixerUISync(): () => void {
  void publishCurrentMixerUISnapshot();

  const publishIfChanged = () => {
    if (remoteApplyDepth > 0) return;

    const snapshot = extractMixerUISnapshot();
    const signature = getSnapshotSignature(snapshot);
    if (signature === lastPublishedSignature) return;

    lastPublishedSignature = signature;
    currentRevision += 1;
    void nativeBridge.publishMixerUISnapshot({
      originWindowId: windowId,
      revision: currentRevision,
      payload: snapshot,
    });
  };

  const unsubscribeStore = useDAWStore.subscribe(
    selectMixerUISyncDependencies,
    publishIfChanged,
    { equalityFn: mixerUISyncDependenciesEqual },
  );

  // This selector may run for hot store updates, but it compares only the
  // compact set of currently executable action IDs. Full mixer serialisation
  // and native publication happen only when that set actually changes.
  const unsubscribeActionAvailability = windowRole === "main"
    ? useDAWStore.subscribe(
      () => getAvailableDetachedMainActionIds(),
      publishIfChanged,
      { equalityFn: actionAvailabilityEqual },
    )
    : () => {};

  const unsubscribeRemote = nativeBridge.subscribe("mixerUISync", (value) => {
    const envelope = normaliseEnvelope(value);
    if (!envelope || envelope.originWindowId === windowId) {
      return;
    }

    currentRevision = Math.max(currentRevision, envelope.revision ?? 0);
    lastPublishedSignature = getSnapshotSignature(envelope.payload);
    remoteApplyDepth += 1;
    try {
      if (windowRole === "main") applyRemoteMixerUISnapshot(envelope.payload);
      else applyMixerUISnapshot(envelope.payload);
    } finally {
      queueMicrotask(() => {
        remoteApplyDepth = Math.max(0, remoteApplyDepth - 1);
      });
    }
  });

  return () => {
    unsubscribeStore();
    unsubscribeActionAvailability();
    unsubscribeRemote();
    if (windowRole === "main") flushPendingMixerRemoteEdit();
    else cancelPendingMixerRemoteEdit();
  };
}
