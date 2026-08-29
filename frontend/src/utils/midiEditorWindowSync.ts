import { nativeBridge, type MixerUISnapshotEnvelope } from "../services/NativeBridge";
import { syncTrackMIDIClipsToBackend } from "./midiClipSerialization";
import { commandManager } from "../store/commands";
import { isClipEditLocked } from "./clipEditLock";
import {
  DEFAULT_PIANO_ROLL_VISIBLE_LANES,
  useDAWStore,
  type MIDIEditRange,
  type MIDIClip,
  type MIDIQuantizeSettings,
  type MidiEditorSession,
  type PianoRollTool,
  type PianoRollVisibleLane,
  type Track,
} from "../store/useDAWStore";
import { type GridSize } from "./snapToGrid";
import { parseMIDINotePairs } from "./midiNotes";

export interface MidiEditorUISnapshot {
  /** Detached CommandManager boundary: previews share a token, commit advances it. */
  editBoundaryToken: string;
  sessionId: string;
  mode: "docked" | "windowed";
  trackId: string | null;
  clipId: string | null;
  tracks: Track[];
  selectedClipIds: string[];
  selectedTrackIds: string[];
  selectedNoteIds: string[];
  midiEditRange: MIDIEditRange | null;
  activeMidiTool: PianoRollTool;
  pianoRollScaleRoot: number;
  pianoRollScaleType: string;
  pianoRollVisibleLanes: PianoRollVisibleLane[];
  pianoRollActiveLaneId: string;
  pianoRollInsertVelocity: number;
  pianoRollAuditionEnabled: boolean;
  stepInputEnabled: boolean;
  stepInputSize: number;
  stepInputPosition: number;
  pixelsPerSecond: number;
  scrollX: number;
  scrollY: number;
  tcpWidth: number;
  snapEnabled: boolean;
  gridSize: GridSize;
  tempo: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  timeSelection: { start: number; end: number } | null;
  projectRange: { start: number; end: number };
  timeSignature: { numerator: number; denominator: number };
  lastMIDIQuantizeSettings: MIDIQuantizeSettings;
}

const windowId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `midi-editor-window-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const currentWindowRole =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("window") ?? "main"
    : "main";

let remoteApplyDepth = 0;
let currentRevision = 0;
const lastPublishedSignatures = new Map<string, string>();
const REMOTE_MIDI_EDIT_IDLE_MS = 180;

interface PendingRemoteMidiEdit {
  boundaryToken: string;
  sessionId: string;
  trackId: string;
  clipId: string;
  targetSignature: string;
  before: MIDIClip;
  after: MIDIClip;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingRemoteMidiEdits = new Map<string, PendingRemoteMidiEdit>();

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getSnapshotSignature(snapshot: MidiEditorUISnapshot): string {
  return JSON.stringify(snapshot);
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

function isStringArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxLength
    && value.every((entry) => isBoundedString(entry, 512));
}

function isValidMidiEditRange(value: unknown): value is MIDIEditRange | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.startTime)
    && isFiniteNumber(value.endTime)
    && isFiniteNumber(value.minNote)
    && isFiniteNumber(value.maxNote)
    && value.startTime >= 0
    && value.endTime >= value.startTime
    && value.minNote >= 0
    && value.maxNote <= 127
    && value.minNote <= value.maxNote
    && typeof value.includeCC === "boolean";
}

const MIDI_EVENT_TYPES = new Set([
  "noteOn",
  "noteOff",
  "cc",
  "pitchBend",
  "programChange",
  "channelPressure",
  "polyPressure",
]);

function isValidMidiEvent(value: unknown): boolean {
  if (!isRecord(value) || !isFiniteNumber(value.timestamp) || value.timestamp < 0) return false;
  if (typeof value.type !== "string" || !MIDI_EVENT_TYPES.has(value.type)) return false;
  for (const key of [
    "channel",
    "note",
    "velocity",
    "releaseVelocity",
    "controller",
    "value",
    "pitchBend",
    "pressure",
    "slide",
    "probability",
    "chance",
    "playCount",
    "velocityVariance",
    "centOffset",
  ]) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  }
  return value.muted === undefined || typeof value.muted === "boolean";
}

function isValidMidiCCEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.cc) || !isFiniteNumber(value.time) || !isFiniteNumber(value.value)) return false;
  for (const key of ["channel", "probability", "chance", "playCount"]) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  }
  return value.interpolation === undefined
    || ["step", "linear", "curve", "parabola"].includes(String(value.interpolation));
}

function isValidMidiClip(value: unknown): value is MIDIClip {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.id) || value.id.length === 0) return false;
  if (!isBoundedString(value.name, 4096) || !isBoundedString(value.color, 256)) return false;
  if (!isFiniteNumber(value.startTime) || value.startTime < 0) return false;
  if (!isFiniteNumber(value.duration) || value.duration < 0) return false;
  for (const key of ["offset", "sourceStart", "sourceLength", "loopOffset", "loopLength"]) {
    if (value[key] !== undefined && (!isFiniteNumber(value[key]) || (value[key] as number) < 0)) return false;
  }
  for (const key of ["loopEnabled", "muted", "locked"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  if (!Array.isArray(value.events) || value.events.length > 1_000_000) return false;
  if (!value.events.every(isValidMidiEvent)) return false;
  if (value.ccEvents !== undefined) {
    if (!Array.isArray(value.ccEvents) || value.ccEvents.length > 1_000_000) return false;
    if (!value.ccEvents.every(isValidMidiCCEvent)) return false;
  }
  if (value.quantizeBackup !== undefined) {
    if (!isRecord(value.quantizeBackup) || !Array.isArray(value.quantizeBackup.events)) return false;
    if (value.quantizeBackup.events.length > 1_000_000
      || !value.quantizeBackup.events.every(isValidMidiEvent)) return false;
    if (value.quantizeBackup.ccEvents !== undefined
      && (!Array.isArray(value.quantizeBackup.ccEvents)
        || value.quantizeBackup.ccEvents.length > 1_000_000
        || !value.quantizeBackup.ccEvents.every(isValidMidiCCEvent))) return false;
  }
  return true;
}

export function parseMidiEditorUISnapshot(value: unknown): MidiEditorUISnapshot | null {
  if (!isRecord(value)) return null;
  if (!isBoundedString(value.editBoundaryToken, 1024) || value.editBoundaryToken.length === 0) return null;
  if (!isBoundedString(value.sessionId) || value.sessionId.length === 0) return null;
  if (value.mode !== "docked" && value.mode !== "windowed") return null;
  if (value.trackId !== null && !isBoundedString(value.trackId)) return null;
  if (value.clipId !== null && !isBoundedString(value.clipId)) return null;
  if (!Array.isArray(value.tracks) || value.tracks.length > 1) return null;
  for (const track of value.tracks) {
    if (!isRecord(track) || !isBoundedString(track.id) || !Array.isArray(track.midiClips)) return null;
    if (track.midiClips.length > 4096 || !track.midiClips.every(isValidMidiClip)) return null;
  }
  if (value.trackId && value.tracks.length > 0 && value.tracks[0].id !== value.trackId) return null;
  if (value.clipId && value.tracks.length > 0
    && !(value.tracks[0] as { midiClips: MIDIClip[] }).midiClips.some((clip) => clip.id === value.clipId)) {
    return null;
  }
  if (!isStringArray(value.selectedClipIds, 4096)
    || !isStringArray(value.selectedTrackIds, 512)
    || !isStringArray(value.selectedNoteIds, 1_000_000)) return null;
  if (!isValidMidiEditRange(value.midiEditRange)) return null;
  if (!isBoundedString(value.activeMidiTool, 64)
    || !isBoundedString(value.pianoRollScaleType, 128)
    || !isBoundedString(value.pianoRollActiveLaneId, 512)
    || !isBoundedString(value.gridSize, 64)) return null;
  for (const key of [
    "pianoRollScaleRoot",
    "pianoRollInsertVelocity",
    "stepInputSize",
    "stepInputPosition",
    "pixelsPerSecond",
    "scrollX",
    "scrollY",
    "tcpWidth",
    "tempo",
    "loopStart",
    "loopEnd",
  ]) {
    if (!isFiniteNumber(value[key])) return null;
  }
  for (const key of ["pianoRollAuditionEnabled", "stepInputEnabled", "snapEnabled", "loopEnabled"]) {
    if (typeof value[key] !== "boolean") return null;
  }
  if (!Array.isArray(value.pianoRollVisibleLanes) || value.pianoRollVisibleLanes.length > 64) return null;
  return value as unknown as MidiEditorUISnapshot;
}

function normaliseEnvelope(
  value: any,
): MixerUISnapshotEnvelope<MidiEditorUISnapshot> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const envelope = "payload" in value && "originWindowId" in value
    ? value as MixerUISnapshotEnvelope<unknown>
    : { originWindowId: "", revision: 0, payload: value };
  const payload = parseMidiEditorUISnapshot(envelope.payload);
  if (!payload) return null;
  return {
    originWindowId: isBoundedString(envelope.originWindowId) ? envelope.originWindowId : "",
    revision: isFiniteNumber(envelope.revision) ? envelope.revision : 0,
    payload,
  };
}

function cloneVisibleLanes(lanes?: readonly PianoRollVisibleLane[]) {
  return (lanes?.length ? lanes : DEFAULT_PIANO_ROLL_VISIBLE_LANES).map((lane) => ({ ...lane }));
}

function sessionFromState(state: ReturnType<typeof useDAWStore.getState>, sessionId?: string | null): MidiEditorSession | null {
  const sessions = state.midiEditorSessions || [];
  if (sessionId) {
    const direct = sessions.find((session) => session.sessionId === sessionId);
    if (direct) return direct;
  }
  if (state.activeMidiEditorSessionId) {
    const active = sessions.find((session) => session.sessionId === state.activeMidiEditorSessionId);
    if (active) return active;
  }
  if (state.pianoRollTrackId && state.pianoRollClipId) {
    return {
      sessionId: "legacy-active-midi-editor",
      trackId: state.pianoRollTrackId,
      clipId: state.pianoRollClipId,
      mode: state.showPianoRoll ? "docked" : "windowed",
      selectedNoteIds: state.selectedNoteIds,
      midiEditRange: state.midiEditRange,
      editCursorTime: state.pianoRollEditCursorTime,
      activeTool: state.activeMidiTool,
      visibleLanes: cloneVisibleLanes(state.pianoRollVisibleLanes),
      activeLaneId: state.pianoRollActiveLaneId,
      scrollY: 0,
      windowPixelsPerSecond: state.pixelsPerSecond,
      windowScrollX: state.scrollX,
      openedAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  return null;
}

function tracksForSession(state: ReturnType<typeof useDAWStore.getState>, session: MidiEditorSession | null): Track[] {
  if (!session) return [];
  const track = state.tracks.find((candidate) => candidate.id === session.trackId);
  return track ? [cloneSnapshot(track)] : [];
}

function trackWithMidiClip(tracks: Track[], clipId: string | null | undefined): Track | null {
  if (!clipId) return null;
  return tracks.find((track) => (track.midiClips || []).some((clip) => clip.id === clipId)) ?? null;
}

function replaceMidiClipInTracks(tracks: Track[], trackId: string, clipId: string, nextClip: MIDIClip): Track[] {
  return tracks.map((track) =>
    track.id === trackId
      ? {
        ...track,
        midiClips: (track.midiClips || []).map((clip) => clip.id === clipId ? cloneSnapshot(nextClip) : clip),
      }
      : track,
  );
}

function syncTrackById(trackId: string): void {
  const track = useDAWStore.getState().tracks.find((candidate) => candidate.id === trackId);
  if (track) {
    void syncTrackMIDIClipsToBackend(track.id, track.midiClips || [], track.midiEffects || []);
  }
}

function snapshotValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * A detached Piano Roll owns only the editable MIDI source payload. Timeline
 * placement, identity, locking, grouping, colour, and mute state remain owned
 * by the authoritative main window and must survive stale detached snapshots.
 */
function mergeEditableMidiClipContent(
  existingClip: MIDIClip,
  incomingClip: MIDIClip,
): MIDIClip {
  return {
    ...existingClip,
    events: cloneSnapshot(incomingClip.events),
    ccEvents: incomingClip.ccEvents === undefined
      ? undefined
      : cloneSnapshot(incomingClip.ccEvents),
    quantizeBackup: incomingClip.quantizeBackup === undefined
      ? undefined
      : cloneSnapshot(incomingClip.quantizeBackup),
  };
}

function pendingMidiEditKey(sessionId: string, trackId: string, clipId: string): string {
  return `${sessionId}\u0000${trackId}\u0000${clipId}`;
}

function applyMidiClipSnapshot(trackId: string, clipId: string, clip: MIDIClip): void {
  useDAWStore.setState((state) => {
    const track = state.tracks.find((candidate) => candidate.id === trackId);
    const currentClip = track?.midiClips.find((candidate) => candidate.id === clipId);
    if (!currentClip) return state;
    return {
      tracks: replaceMidiClipInTracks(
        state.tracks,
        trackId,
        clipId,
        mergeEditableMidiClipContent(currentClip, clip),
      ),
      isModified: true,
    };
  });
  syncTrackById(trackId);
}

function restorePendingMidiRemoteEdit(pending: PendingRemoteMidiEdit): void {
  const state = useDAWStore.getState();
  const track = state.tracks.find((candidate) => candidate.id === pending.trackId);
  const currentClip = track?.midiClips.find((candidate) => candidate.id === pending.clipId);
  if (!currentClip) return;
  useDAWStore.setState({
    tracks: replaceMidiClipInTracks(
      state.tracks,
      pending.trackId,
      pending.clipId,
      mergeEditableMidiClipContent(currentClip, pending.before),
    ),
  });
  syncTrackById(pending.trackId);
}

function cancelPendingMidiRemoteEditForTarget(
  sessionId: string,
  trackId: string,
  clipId: string,
  restorePreview: boolean,
): boolean {
  const key = pendingMidiEditKey(sessionId, trackId, clipId);
  const pending = pendingRemoteMidiEdits.get(key);
  if (!pending) return false;
  if (pending.timer) clearTimeout(pending.timer);
  pendingRemoteMidiEdits.delete(key);
  if (restorePreview) {
    // Content-only restore intentionally preserves a lock/freeze or timeline
    // mutation that may have been made in the main window during the gesture.
    restorePendingMidiRemoteEdit(pending);
  }
  return true;
}

function midiEventFieldTarget(field: string): string {
  if (field === "timestamp") return "time";
  if (field === "note") return "pitch";
  if (field === "velocity" || field === "releaseVelocity") return "velocity";
  return field;
}

function collectArrayEditTargets(
  before: readonly Record<string, unknown>[],
  after: readonly Record<string, unknown>[],
  prefix: string,
): string[] {
  if (before.length !== after.length) return [`${prefix}:structure`];
  const targets: string[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const oldValue = before[index] ?? {};
    const nextValue = after[index] ?? {};
    const keys = new Set([...Object.keys(oldValue), ...Object.keys(nextValue)]);
    for (const key of keys) {
      if (snapshotValue(oldValue[key]) === snapshotValue(nextValue[key])) continue;
      targets.push(`${prefix}:${index}:${midiEventFieldTarget(key)}`);
    }
  }
  return targets;
}

function deriveMidiEditTarget(before: MIDIClip, after: MIDIClip): string {
  const targets = [
    ...collectArrayEditTargets(
      before.events as unknown as Record<string, unknown>[],
      after.events as unknown as Record<string, unknown>[],
      "events",
    ),
    ...collectArrayEditTargets(
      (before.ccEvents ?? []) as unknown as Record<string, unknown>[],
      (after.ccEvents ?? []) as unknown as Record<string, unknown>[],
      "cc",
    ),
  ];
  for (const key of [
    "name",
    "startTime",
    "duration",
    "offset",
    "sourceStart",
    "sourceLength",
    "loopEnabled",
    "loopOffset",
    "loopLength",
    "color",
    "groupId",
    "muted",
    "locked",
    "quantizeBackup",
  ] as const) {
    if (snapshotValue(before[key]) !== snapshotValue(after[key])) targets.push(`clip:${key}`);
  }
  return [...new Set(targets)].sort().join("|") || "clip:unknown";
}

function pushPendingMidiRemoteEdit(pending: PendingRemoteMidiEdit): boolean {
  if (pending.timer) clearTimeout(pending.timer);
  if (snapshotValue(pending.before) === snapshotValue(pending.after)) return false;
  const before = cloneSnapshot(pending.before);
  const after = cloneSnapshot(pending.after);
  const { trackId, clipId } = pending;
  commandManager.push({
    type: "MIDI_DETACHED_EDIT",
    description: "Edit MIDI clip from detached editor",
    timestamp: Date.now(),
    execute: () => applyMidiClipSnapshot(trackId, clipId, after),
    undo: () => applyMidiClipSnapshot(trackId, clipId, before),
  });
  return true;
}

export function flushPendingMidiRemoteEdits(): number {
  const pendingEdits = [...pendingRemoteMidiEdits.values()];
  pendingRemoteMidiEdits.clear();
  let pushed = 0;
  for (const pending of pendingEdits) {
    const state = useDAWStore.getState();
    const track = state.tracks.find((candidate) => candidate.id === pending.trackId);
    const clip = track?.midiClips.find((candidate) => candidate.id === pending.clipId);
    if (!track || !clip || track.frozen || isClipEditLocked(state, clip)) {
      if (pending.timer) clearTimeout(pending.timer);
      restorePendingMidiRemoteEdit(pending);
      continue;
    }
    if (pushPendingMidiRemoteEdit(pending)) pushed += 1;
  }
  if (pushed > 0) {
    useDAWStore.setState({
      isModified: true,
      canUndo: commandManager.canUndo(),
      canRedo: commandManager.canRedo(),
    });
  }
  return pushed;
}

export function cancelPendingMidiRemoteEdits(): void {
  for (const pending of pendingRemoteMidiEdits.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingRemoteMidiEdits.clear();
}

function queueRemoteMidiUndo(
  sessionId: string,
  trackId: string,
  clipId: string,
  beforeClip: MIDIClip,
  afterClip: MIDIClip,
  boundaryToken: string,
): void {
  const key = pendingMidiEditKey(sessionId, trackId, clipId);
  const targetSignature = deriveMidiEditTarget(beforeClip, afterClip);
  let existing = pendingRemoteMidiEdits.get(key);
  if (existing && (
    existing.boundaryToken !== boundaryToken
    || existing.targetSignature !== targetSignature
  )) {
    pendingRemoteMidiEdits.delete(key);
    if (pushPendingMidiRemoteEdit(existing)) {
      useDAWStore.setState({
        isModified: true,
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    }
    existing = undefined;
  }
  if (!existing && snapshotValue(beforeClip) === snapshotValue(afterClip)) return;
  if (existing?.timer) clearTimeout(existing.timer);
  const pending: PendingRemoteMidiEdit = existing ?? {
    boundaryToken,
    sessionId,
    trackId,
    clipId,
    targetSignature,
    before: cloneSnapshot(beforeClip),
    after: cloneSnapshot(afterClip),
    timer: null,
  };
  pending.after = cloneSnapshot(afterClip);
  pending.timer = setTimeout(flushPendingMidiRemoteEdits, REMOTE_MIDI_EDIT_IDLE_MS);
  pendingRemoteMidiEdits.set(key, pending);
}

export function extractMidiEditorUISnapshot(
  state = useDAWStore.getState(),
  sessionId?: string | null,
): MidiEditorUISnapshot | null {
  const session = sessionFromState(state, sessionId);
  if (!session) return null;

  const isDetachedSession = session.mode === "windowed";
  const useGlobalEditorState =
    currentWindowRole !== "main" ||
    (session.mode === "docked" && session.sessionId === state.activeMidiEditorSessionId);
  return {
    editBoundaryToken: `${windowId}:${commandManager.getRevision()}`,
    sessionId: session.sessionId,
    mode: session.mode,
    trackId: session.trackId,
    clipId: session.clipId,
    tracks: tracksForSession(state, session),
    selectedClipIds: state.selectedClipIds,
    selectedTrackIds: state.selectedTrackIds,
    selectedNoteIds: useGlobalEditorState
      ? state.selectedNoteIds
      : session.selectedNoteIds,
    midiEditRange: useGlobalEditorState
      ? state.midiEditRange
      : session.midiEditRange,
    activeMidiTool: session.activeTool || state.activeMidiTool,
    pianoRollScaleRoot: state.pianoRollScaleRoot,
    pianoRollScaleType: state.pianoRollScaleType,
    pianoRollVisibleLanes: cloneVisibleLanes(
      useGlobalEditorState
        ? state.pianoRollVisibleLanes
        : session.visibleLanes,
    ),
    pianoRollActiveLaneId: useGlobalEditorState
      ? state.pianoRollActiveLaneId
      : session.activeLaneId,
    pianoRollInsertVelocity: state.pianoRollInsertVelocity,
    pianoRollAuditionEnabled: state.pianoRollAuditionEnabled,
    stepInputEnabled: state.stepInputEnabled,
    stepInputSize: state.stepInputSize,
    stepInputPosition: state.stepInputPosition,
    pixelsPerSecond: isDetachedSession ? session.windowPixelsPerSecond : state.pixelsPerSecond,
    scrollX: isDetachedSession ? session.windowScrollX : state.scrollX,
    scrollY: session.scrollY,
    tcpWidth: state.tcpWidth,
    snapEnabled: state.snapEnabled,
    gridSize: state.gridSize,
    tempo: state.transport.tempo,
    loopEnabled: state.transport.loopEnabled,
    loopStart: state.transport.loopStart,
    loopEnd: state.transport.loopEnd,
    timeSelection: state.timeSelection,
    projectRange: state.projectRange,
    timeSignature: state.timeSignature,
    lastMIDIQuantizeSettings: state.lastMIDIQuantizeSettings,
  };
}

export function extractAllMidiEditorUISnapshots(
  state = useDAWStore.getState(),
  sessionId?: string | null,
): MidiEditorUISnapshot[] {
  if (sessionId) {
    const snapshot = extractMidiEditorUISnapshot(state, sessionId);
    return snapshot ? [snapshot] : [];
  }
  const sessions = state.midiEditorSessions || [];
  if (sessions.length === 0) {
    const snapshot = extractMidiEditorUISnapshot(state);
    return snapshot ? [snapshot] : [];
  }
  return sessions
    .map((session) => extractMidiEditorUISnapshot(state, session.sessionId))
    .filter((snapshot): snapshot is MidiEditorUISnapshot => Boolean(snapshot));
}

export function applyMidiEditorUISnapshot(snapshot: MidiEditorUISnapshot): boolean {
  const parsedSnapshot = parseMidiEditorUISnapshot(snapshot);
  if (!parsedSnapshot) return false;
  snapshot = parsedSnapshot;

  const beforeState = useDAWStore.getState();
  const incomingTracks = cloneSnapshot(snapshot.tracks || []);
  const incomingTrack = trackWithMidiClip(incomingTracks, snapshot.clipId) ?? incomingTracks[0] ?? null;
  const incomingClip = incomingTrack && snapshot.clipId
    ? (incomingTrack.midiClips || []).find((clip) => clip.id === snapshot.clipId) ?? null
    : null;

  if (currentWindowRole === "main") {
    const liveSession = beforeState.midiEditorSessions.find((session) => (
      session.sessionId === snapshot.sessionId && session.mode === "windowed"
    ));
    const exactTarget = Boolean(
      liveSession
      && snapshot.mode === "windowed"
      && snapshot.trackId
      && snapshot.clipId
      && snapshot.trackId === liveSession.trackId
      && snapshot.clipId === liveSession.clipId
      && incomingTrack?.id === liveSession.trackId
      && incomingClip?.id === liveSession.clipId,
    );
    if (!exactTarget || !liveSession || !snapshot.trackId || !snapshot.clipId || !incomingClip) {
      if (snapshot.trackId && snapshot.clipId) {
        cancelPendingMidiRemoteEditForTarget(
          snapshot.sessionId,
          snapshot.trackId,
          snapshot.clipId,
          true,
        );
      }
      return false;
    }

    const liveTrack = beforeState.tracks.find((track) => track.id === liveSession.trackId);
    const liveClip = liveTrack?.midiClips.find((clip) => clip.id === liveSession.clipId);
    if (!liveTrack || !liveClip) {
      cancelPendingMidiRemoteEditForTarget(
        snapshot.sessionId,
        liveSession.trackId,
        liveSession.clipId,
        true,
      );
      return false;
    }
    if (liveTrack.frozen || isClipEditLocked(beforeState, liveClip)) {
      cancelPendingMidiRemoteEditForTarget(
        snapshot.sessionId,
        liveSession.trackId,
        liveSession.clipId,
        true,
      );
      return false;
    }

    const nextClip = mergeEditableMidiClipContent(liveClip, incomingClip);
    const validNoteIds = new Set(
      parseMIDINotePairs(nextClip.events, nextClip.id).map((pair) => pair.id),
    );
    const selectedNoteIds = snapshot.selectedNoteIds.filter((noteId) => validNoteIds.has(noteId));
    const shouldApplyGlobals = beforeState.activeMidiEditorSessionId === snapshot.sessionId;
    const nextSession: MidiEditorSession = {
      ...liveSession,
      selectedNoteIds,
      midiEditRange: snapshot.midiEditRange,
      activeTool: snapshot.activeMidiTool,
      visibleLanes: cloneVisibleLanes(snapshot.pianoRollVisibleLanes),
      activeLaneId: snapshot.pianoRollActiveLaneId || "velocity",
      scrollY: snapshot.scrollY || 0,
      windowPixelsPerSecond: snapshot.pixelsPerSecond,
      windowScrollX: snapshot.scrollX,
      updatedAt: Date.now(),
    };

    useDAWStore.setState((state) => ({
      tracks: replaceMidiClipInTracks(
        state.tracks,
        liveSession.trackId,
        liveSession.clipId,
        nextClip,
      ),
      midiEditorSessions: state.midiEditorSessions.map((session) => (
        session.sessionId === snapshot.sessionId ? nextSession : session
      )),
      ...(shouldApplyGlobals ? {
        pianoRollTrackId: liveSession.trackId,
        pianoRollClipId: liveSession.clipId,
        selectedNoteIds,
        midiEditRange: snapshot.midiEditRange,
        activeMidiTool: snapshot.activeMidiTool,
        pianoRollVisibleLanes: cloneVisibleLanes(snapshot.pianoRollVisibleLanes),
        pianoRollActiveLaneId: snapshot.pianoRollActiveLaneId,
        pianoRollInsertVelocity: snapshot.pianoRollInsertVelocity,
        pianoRollAuditionEnabled: snapshot.pianoRollAuditionEnabled,
        stepInputEnabled: snapshot.stepInputEnabled,
        stepInputSize: snapshot.stepInputSize,
        stepInputPosition: snapshot.stepInputPosition,
      } : {}),
      // Timeline/TCP selection, transport, loop, time selection, and clip
      // structure are all authoritative in the main realm.
      canUndo: commandManager.canUndo(),
      canRedo: commandManager.canRedo(),
      snapEnabled: snapshot.snapEnabled,
      gridSize: snapshot.gridSize,
      lastMIDIQuantizeSettings: snapshot.lastMIDIQuantizeSettings,
    }));

    if (snapshotValue(liveClip) !== snapshotValue(nextClip)) {
      syncTrackById(liveSession.trackId);
    }
    queueRemoteMidiUndo(
      snapshot.sessionId,
      liveSession.trackId,
      liveSession.clipId,
      liveClip,
      nextClip,
      snapshot.editBoundaryToken,
    );
    return true;
  }

  // Detached realms hydrate from the main window's full, authoritative view.
  // They never use this branch to mutate the main project.
  const resolvedTrackId = snapshot.trackId || null;
  useDAWStore.setState((state) => {
    const nextSession: MidiEditorSession = {
      sessionId: snapshot.sessionId,
      trackId: resolvedTrackId || "",
      clipId: snapshot.clipId || "",
      mode: snapshot.mode,
      selectedNoteIds: snapshot.selectedNoteIds || [],
      midiEditRange: snapshot.midiEditRange || null,
      editCursorTime: null,
      activeTool: snapshot.activeMidiTool,
      visibleLanes: cloneVisibleLanes(snapshot.pianoRollVisibleLanes),
      activeLaneId: snapshot.pianoRollActiveLaneId || "velocity",
      scrollY: snapshot.scrollY || 0,
      windowPixelsPerSecond: snapshot.pixelsPerSecond,
      windowScrollX: snapshot.scrollX,
      openedAt: state.midiEditorSessions?.find((session) => session.sessionId === snapshot.sessionId)?.openedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    const sessions = (state.midiEditorSessions || []).some((session) => session.sessionId === snapshot.sessionId)
      ? state.midiEditorSessions.map((session) => session.sessionId === snapshot.sessionId ? nextSession : session)
      : [...(state.midiEditorSessions || []), nextSession];
    return {
      tracks: incomingTracks,
      midiEditorSessions: sessions,
      activeMidiEditorSessionId: snapshot.sessionId,
      dockedMidiEditorSessionId: snapshot.mode === "docked" ? snapshot.sessionId : state.dockedMidiEditorSessionId,
      showPianoRoll: snapshot.mode === "docked" ? true : state.showPianoRoll,
      pianoRollTrackId: resolvedTrackId,
      pianoRollClipId: snapshot.clipId,
      selectedNoteIds: snapshot.selectedNoteIds,
      midiEditRange: snapshot.midiEditRange,
      activeMidiTool: snapshot.activeMidiTool,
      pianoRollVisibleLanes: cloneVisibleLanes(snapshot.pianoRollVisibleLanes),
      pianoRollActiveLaneId: snapshot.pianoRollActiveLaneId,
      pianoRollInsertVelocity: snapshot.pianoRollInsertVelocity,
      pianoRollAuditionEnabled: snapshot.pianoRollAuditionEnabled,
      stepInputEnabled: snapshot.stepInputEnabled,
      stepInputSize: snapshot.stepInputSize,
      stepInputPosition: snapshot.stepInputPosition,
      pixelsPerSecond: snapshot.pixelsPerSecond,
      scrollX: snapshot.scrollX,
      selectedClipIds: snapshot.selectedClipIds,
      selectedTrackIds: snapshot.selectedTrackIds,
      selectedTrackId: snapshot.selectedTrackIds[0] ?? state.selectedTrackId,
      transport: {
        ...state.transport,
        tempo: snapshot.tempo,
        loopEnabled: snapshot.loopEnabled,
        loopStart: snapshot.loopStart,
        loopEnd: snapshot.loopEnd,
      },
      canUndo: commandManager.canUndo(),
      canRedo: commandManager.canRedo(),
      snapEnabled: snapshot.snapEnabled,
      gridSize: snapshot.gridSize,
      timeSelection: snapshot.timeSelection,
      projectRange: snapshot.projectRange,
      timeSignature: snapshot.timeSignature,
      lastMIDIQuantizeSettings: snapshot.lastMIDIQuantizeSettings,
    };
  });
  return true;
}

export async function publishMidiEditorSessionSnapshot(sessionId: string): Promise<void> {
  const payload = extractMidiEditorUISnapshot(useDAWStore.getState(), sessionId);
  if (!payload) return;

  lastPublishedSignatures.set(sessionId, getSnapshotSignature(payload));
  currentRevision += 1;
  await nativeBridge.publishMidiEditorUISnapshot(sessionId, {
    originWindowId: windowId,
    revision: currentRevision,
    payload,
  });
}

export async function publishCurrentMidiEditorUISnapshot(): Promise<void> {
  const snapshots = extractAllMidiEditorUISnapshots();
  await Promise.all(snapshots.map((snapshot) => publishMidiEditorSessionSnapshot(snapshot.sessionId)));
}

export async function hydrateMidiEditorUISnapshotFromNative(sessionId?: string | null): Promise<boolean> {
  const rawSnapshot = await nativeBridge.getMidiEditorUISnapshot<
    MixerUISnapshotEnvelope<MidiEditorUISnapshot> | MidiEditorUISnapshot | null
  >(sessionId || undefined);
  const envelope = normaliseEnvelope(rawSnapshot);
  if (!envelope) {
    return false;
  }

  currentRevision = Math.max(currentRevision, envelope.revision ?? 0);
  lastPublishedSignatures.set(envelope.payload.sessionId, getSnapshotSignature(envelope.payload));
  remoteApplyDepth += 1;
  try {
    applyMidiEditorUISnapshot(envelope.payload);
  } finally {
    remoteApplyDepth -= 1;
  }
  return true;
}

export function startMidiEditorUISync(sessionId?: string | null): () => void {
  const publishSnapshots = (snapshots: MidiEditorUISnapshot[]) => {
    if (remoteApplyDepth > 0) {
      return;
    }

    snapshots.forEach((snapshot) => {
      const signature = getSnapshotSignature(snapshot);
      if (signature === lastPublishedSignatures.get(snapshot.sessionId)) {
        return;
      }

      lastPublishedSignatures.set(snapshot.sessionId, signature);
      currentRevision += 1;
      void nativeBridge.publishMidiEditorUISnapshot(snapshot.sessionId, {
        originWindowId: windowId,
        revision: currentRevision,
        payload: snapshot,
      });
    });
  };

  publishSnapshots(extractAllMidiEditorUISnapshots(useDAWStore.getState(), sessionId));

  const unsubscribeStore = useDAWStore.subscribe(
    (state) => extractAllMidiEditorUISnapshots(state, sessionId),
    publishSnapshots,
  );

  const unsubscribeRemote = nativeBridge.subscribe("midiEditorUISync", (value) => {
    const envelope = normaliseEnvelope(value);
    if (!envelope || envelope.originWindowId === windowId) {
      return;
    }
    if (sessionId && envelope.payload.sessionId !== sessionId) {
      return;
    }

    currentRevision = Math.max(currentRevision, envelope.revision ?? 0);
    lastPublishedSignatures.set(envelope.payload.sessionId, getSnapshotSignature(envelope.payload));
    remoteApplyDepth += 1;
    try {
      applyMidiEditorUISnapshot(envelope.payload);
    } finally {
      queueMicrotask(() => {
        remoteApplyDepth = Math.max(0, remoteApplyDepth - 1);
      });
    }
  });

  return () => {
    unsubscribeStore();
    unsubscribeRemote();
    if (currentWindowRole === "main") flushPendingMidiRemoteEdits();
    else cancelPendingMidiRemoteEdits();
  };
}
