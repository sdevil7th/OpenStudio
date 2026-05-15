import { nativeBridge, type MixerUISnapshotEnvelope } from "../services/NativeBridge";
import { syncTrackMIDIClipsToBackend } from "./midiClipSerialization";
import { commandManager } from "../store/commands";
import {
  DEFAULT_PIANO_ROLL_VISIBLE_LANES,
  useDAWStore,
  type MIDIEditRange,
  type MIDIQuantizeSettings,
  type MidiEditorSession,
  type PianoRollTool,
  type PianoRollVisibleLane,
  type Track,
} from "../store/useDAWStore";
import { type GridSize } from "./snapToGrid";

export interface MidiEditorUISnapshot {
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

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getSnapshotSignature(snapshot: MidiEditorUISnapshot): string {
  return JSON.stringify(snapshot);
}

function normaliseEnvelope(
  value: any,
): MixerUISnapshotEnvelope<MidiEditorUISnapshot> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if ("payload" in value && "originWindowId" in value) {
    return value as MixerUISnapshotEnvelope<MidiEditorUISnapshot>;
  }

  return {
    originWindowId: "",
    revision: 0,
    payload: value as MidiEditorUISnapshot,
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

function mergeSessionTrackIntoMainTrack(
  existingTrack: Track,
  incomingTrack: Track,
  clipId: string | null,
): Track {
  if (!clipId) {
    return existingTrack;
  }

  const incomingClip = (incomingTrack.midiClips || []).find((clip) => clip.id === clipId);
  if (!incomingClip) {
    return existingTrack;
  }

  const hasExistingClip = (existingTrack.midiClips || []).some((clip) => clip.id === clipId);
  return {
    ...existingTrack,
    midiClips: hasExistingClip
      ? existingTrack.midiClips.map((clip) => clip.id === clipId ? cloneSnapshot(incomingClip) : clip)
    : [...existingTrack.midiClips, cloneSnapshot(incomingClip)],
  };
}

function findTrackIdForMidiClip(tracks: Track[], clipId: string | null | undefined): string | null {
  if (!clipId) return null;
  return tracks.find((track) => (track.midiClips || []).some((clip) => clip.id === clipId))?.id ?? null;
}

function trackWithMidiClip(tracks: Track[], clipId: string | null | undefined): Track | null {
  if (!clipId) return null;
  return tracks.find((track) => (track.midiClips || []).some((clip) => clip.id === clipId)) ?? null;
}

function replaceMidiClipInTracks(tracks: Track[], trackId: string, clipId: string, nextClip: any): Track[] {
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

export function applyMidiEditorUISnapshot(snapshot: MidiEditorUISnapshot): void {
  useDAWStore.setState((state) => {
    const incomingTracks = cloneSnapshot(snapshot.tracks || []);
    const incomingTrack = trackWithMidiClip(incomingTracks, snapshot.clipId) ?? incomingTracks[0] ?? null;
    const resolvedMainTrackId = currentWindowRole === "main"
      ? findTrackIdForMidiClip(state.tracks, snapshot.clipId)
      : snapshot.trackId || null;
    const incomingClip = incomingTrack && snapshot.clipId
      ? (incomingTrack.midiClips || []).find((clip) => clip.id === snapshot.clipId)
      : null;
    const existingMainTrack = currentWindowRole === "main" && resolvedMainTrackId
      ? state.tracks.find((track) => track.id === resolvedMainTrackId)
      : null;
    const existingMainClip = existingMainTrack && snapshot.clipId
      ? (existingMainTrack.midiClips || []).find((clip) => clip.id === snapshot.clipId)
      : null;
    const shouldPushDetachedUndo =
      currentWindowRole === "main"
      && snapshot.mode === "windowed"
      && Boolean(resolvedMainTrackId && snapshot.clipId && incomingClip && existingMainClip)
      && snapshotValue(incomingClip) !== snapshotValue(existingMainClip);

    if (currentWindowRole === "main" && snapshot.clipId && !resolvedMainTrackId) {
      const remainingSessions = (state.midiEditorSessions || []).filter((session) => session.sessionId !== snapshot.sessionId);
      const dockedId = state.dockedMidiEditorSessionId === snapshot.sessionId ? null : state.dockedMidiEditorSessionId;
      const activeId = state.activeMidiEditorSessionId === snapshot.sessionId
        ? (dockedId || remainingSessions[0]?.sessionId || null)
        : state.activeMidiEditorSessionId;
      return {
        midiEditorSessions: remainingSessions,
        dockedMidiEditorSessionId: dockedId,
        activeMidiEditorSessionId: activeId,
        showPianoRoll: Boolean(dockedId),
      };
    }

    const tracks = currentWindowRole === "main"
      ? state.tracks.map((track) => {
        if (!resolvedMainTrackId || track.id !== resolvedMainTrackId || !incomingTrack) {
          return track;
        }

        return mergeSessionTrackIntoMainTrack(track, incomingTrack, snapshot.clipId);
      })
      : incomingTracks;

    const nextSession: MidiEditorSession = {
      sessionId: snapshot.sessionId,
      trackId: resolvedMainTrackId || snapshot.trackId || "",
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

    const withoutReplacedDocked = snapshot.mode === "docked"
      ? (state.midiEditorSessions || []).filter((session) =>
        session.sessionId === snapshot.sessionId || session.sessionId !== state.dockedMidiEditorSessionId,
      )
      : (state.midiEditorSessions || []);
    const sessions = withoutReplacedDocked.some((session) => session.sessionId === snapshot.sessionId)
      ? withoutReplacedDocked.map((session) => session.sessionId === snapshot.sessionId ? nextSession : session)
      : [...withoutReplacedDocked, nextSession];

    const shouldApplyGlobals =
      currentWindowRole !== "main" ||
      snapshot.mode === "docked" ||
      state.activeMidiEditorSessionId === snapshot.sessionId;

    const transport = currentWindowRole === "main"
      ? state.transport
      : {
        ...state.transport,
        tempo: snapshot.tempo,
        loopEnabled: snapshot.loopEnabled ?? state.transport.loopEnabled,
        loopStart: snapshot.loopStart ?? state.transport.loopStart,
        loopEnd: snapshot.loopEnd ?? state.transport.loopEnd,
      };

    if (shouldPushDetachedUndo && resolvedMainTrackId && snapshot.clipId && incomingClip && existingMainClip) {
      const trackId = resolvedMainTrackId;
      const clipId = snapshot.clipId;
      const oldClip = cloneSnapshot(existingMainClip);
      const newClip = cloneSnapshot(incomingClip);
      commandManager.push({
        type: "MIDI_DETACHED_EDIT",
        description: "Edit MIDI clip from detached editor",
        timestamp: Date.now(),
        execute: () => {
          useDAWStore.setState((current) => ({
            tracks: replaceMidiClipInTracks(current.tracks, trackId, clipId, newClip),
            isModified: true,
            canUndo: commandManager.canUndo(),
            canRedo: commandManager.canRedo(),
          }));
          syncTrackById(trackId);
        },
        undo: () => {
          useDAWStore.setState((current) => ({
            tracks: replaceMidiClipInTracks(current.tracks, trackId, clipId, oldClip),
            isModified: true,
            canUndo: commandManager.canUndo(),
            canRedo: commandManager.canRedo(),
          }));
          syncTrackById(trackId);
        },
      });
    }

    return {
      tracks,
      midiEditorSessions: sessions,
      activeMidiEditorSessionId: shouldApplyGlobals ? snapshot.sessionId : state.activeMidiEditorSessionId,
      dockedMidiEditorSessionId: snapshot.mode === "docked" ? snapshot.sessionId : state.dockedMidiEditorSessionId,
      showPianoRoll: snapshot.mode === "docked" ? true : state.showPianoRoll,
      ...(shouldApplyGlobals ? {
        pianoRollTrackId: resolvedMainTrackId || snapshot.trackId,
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
      } : {}),
      selectedClipIds: snapshot.selectedClipIds,
      selectedTrackIds: snapshot.selectedTrackIds,
      selectedTrackId: snapshot.selectedTrackIds[0] ?? state.selectedTrackId,
      transport,
      canUndo: commandManager.canUndo(),
      canRedo: commandManager.canRedo(),
      snapEnabled: snapshot.snapEnabled ?? state.snapEnabled,
      gridSize: snapshot.gridSize ?? state.gridSize,
      timeSelection: snapshot.timeSelection,
      projectRange: snapshot.projectRange,
      timeSignature: snapshot.timeSignature,
      lastMIDIQuantizeSettings: snapshot.lastMIDIQuantizeSettings,
    };
  });
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
  };
}
