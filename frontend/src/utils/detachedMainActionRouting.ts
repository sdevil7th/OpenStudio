import { nativeBridge } from "../services/NativeBridge";
import {
  useDAWStore,
  type MIDIEditRange,
} from "../store/useDAWStore";
import { parseMIDINotePairs } from "./midiNotes";
import { windowRole, windowSessionId } from "./windowEnvironment";

/**
 * Automation commands whose target can be represented authoritatively by a
 * detached request. Lane/point commands are intentionally absent: a detached
 * mixer has no validated lane/point identity and therefore must not claim them.
 */
export const DETACHED_AUTOMATION_ACTION_IDS = new Set<string>([
  "automation.toggleArrangementView",
  "automation.writeBehavior.touch",
  "automation.writeBehavior.latch",
  "automation.writeBehavior.overwrite",
  "automation.selectedTracks.mode.off",
  "automation.selectedTracks.mode.read",
  "automation.selectedTracks.mode.write",
  "automation.selectedTracks.mode.touch",
  "automation.selectedTracks.mode.latch",
  "automation.selectedTracks.toggleOffRead",
  "automation.selectedTracks.toggleLatchRead",
  "automation.selectedTracks.show",
  "automation.selectedTracks.hide",
  "automation.selectedTracks.readOn",
  "automation.selectedTracks.readOff",
  "automation.selectedTracks.writeOn",
  "automation.selectedTracks.writeOff",
  "automation.allTracks.mode.off",
  "automation.allTracks.mode.read",
  "automation.allTracks.mode.touch",
  "automation.allTracks.mode.latch",
  "automation.allTracks.writeOff",
  "automation.allTracks.toggleRead",
  "automation.master.mode.off",
  "automation.master.mode.read",
  "automation.master.mode.write",
  "automation.master.mode.touch",
  "automation.master.mode.latch",
  "automation.master.show",
  "automation.master.hide",
  "automation.master.readOn",
  "automation.master.readOff",
  "automation.master.writeOn",
  "automation.master.writeOff",
  "automation.suspend",
  "automation.resume",
  "track.toggleSelectedAutomationRead",
  "track.toggleSelectedAutomationWrite",
  "automation.showAllSelectedTrackEnvelopes",
  "automation.hideAllSelectedTrackEnvelopes",
  "mixer.toggleMasterAutomationRead",
  "mixer.toggleMasterAutomationWrite",
  "mixer.toggleMasterAutomationLanes",
]);

export function isDetachedAutomationActionId(actionId: string): boolean {
  return DETACHED_AUTOMATION_ACTION_IDS.has(actionId);
}

/**
 * Named compatibility/documentation subset of commands safe to request from a
 * detached WebView. `getDetachedActionOwnership` below is the exhaustive,
 * fail-closed policy for the complete catalog; the main window still resolves
 * `canHandleShortcut` immediately before execution.
 */
export const DETACHED_MAIN_ACTION_IDS = new Set<string>([
  ...DETACHED_AUTOMATION_ACTION_IDS,
  "edit.undo",
  "edit.redo",

  "file.new",
  "file.open",
  "file.openSafeMode",
  "file.save",
  "file.saveAs",
  "file.saveNewVersion",
  "file.closeProject",
  "file.projectSettings",
  "file.render",
  "file.regionRenderMatrix",
  "file.quit",
  "file.settings",
  "project.compare",

  "insert.audioTrack",
  "insert.midiTrack",
  "insert.instrumentTrack",
  "insert.aiTrack",
  "insert.quickAddInstrument",
  "insert.folderTrack",
  "insert.multipleTracks",
  "insert.bus",

  "track.moveSelectedUp",
  "track.moveSelectedDown",
  "track.groupSelectedIntoFolder",
  "track.deleteSelected",
  "track.toggleSelectedMute",
  "track.toggleSelectedSolo",
  "track.duplicateSelected",
  "track.toggleSelectedArm",
  "track.linkSelected",
  "track.unlinkSelected",
  "track.setSelectedColor",
  "track.toggleSelectedFxBypass",
  "track.toggleSelectedMonitor",
  "track.toggleSelectedPhaseInvert",
  "track.moveSelectedToFolder",
  "track.removeSelectedFromFolder",
  "track.toggleSelectedFolders",
  "track.toggleSelectedAutomation",
  "track.toggleSelectedFreeze",
  "track.renderSelectedInPlace",
  "track.loadTemplate",

  "mixer.saveSnapshot",
  "mixer.recallSnapshot",
  "mixer.deleteSnapshot",
  "mixer.toggleMasterMute",
  "mixer.toggleMasterMono",

  "options.toggleItemLock",
  "options.toggleEnvelopeLock",
  "options.toggleTimeSelectionLock",
  "options.toggleGlobalLock",
  "options.moveEnvelopesWithItems",
  "options.rippleOff",
  "options.ripplePerTrack",
  "options.rippleAllTracks",
  "options.recordNormal",
  "options.recordOverdub",
  "options.recordReplace",
]);

const TRACK_SELECTION_ACTION_PREFIX = "track.";
const MAIN_OWNED_ACTION_PREFIXES = new Set([
  "clip",
  "edit",
  "file",
  "help",
  "insert",
  "mixer",
  "navigate",
  "options",
  "project",
  "script",
  "tools",
  "track",
  "transport",
  "view",
]);
const LOCAL_EDITOR_ACTION_PREFIXES = new Set([
  "browser",
  "fx",
  "midi",
  "modal",
  "pitch",
  "plugin",
]);

export type DetachedActionOwnership =
  | "local-editor"
  | "main-authoritative"
  | "transport-forwarded";
let availableMainActionIds = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, maxLength = 512): string[] | null {
  if (!Array.isArray(value) || value.length > maxLength) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) return null;
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

export interface DetachedMainActionRequest {
  command: "action.execute";
  actionId: string;
  selectedTrackIds: string[];
  selectedClipIds: string[];
  timeSelection: { start: number; end: number } | null;
  sessionId?: string;
}

export interface DetachedLoopRegionRequest {
  command: "transport.setLoopRegion";
  sessionId: string;
  start: number;
  end: number;
}

export interface DetachedMidiQuantizeRequest {
  command: "midi.quantize";
  sessionId: string;
  selectedNoteIds: string[];
  midiEditRange: MIDIEditRange | null;
}

export interface DetachedActionExecutor {
  canHandleShortcut?: () => boolean;
  execute: () => void;
}

export interface ExecuteDetachedMainActionOptions {
  /** Test seam; production accepts these requests only in the main WebView. */
  role?: string;
  /** Commit any live detached gesture before a structural action or undo. */
  flushPendingEdits?: () => void;
}

export function isDetachedMainActionId(actionId: string): boolean {
  const ownership = getDetachedActionOwnership(actionId);
  return ownership === "main-authoritative" || ownership === "transport-forwarded";
}

/**
 * Exhaustive detached-realm ownership policy. Unknown prefixes return null so
 * catalog QA fails closed when a new action family is introduced.
 */
export function getDetachedActionOwnership(actionId: string): DetachedActionOwnership | null {
  if (actionId.startsWith("transport.")) return "transport-forwarded";
  if (DETACHED_MAIN_ACTION_IDS.has(actionId)) return "main-authoritative";
  if (actionId.startsWith("automation.")) {
    return isDetachedAutomationActionId(actionId) ? "main-authoritative" : "local-editor";
  }
  const separator = actionId.indexOf(".");
  if (separator <= 0) return null;
  const prefix = actionId.slice(0, separator);
  if (MAIN_OWNED_ACTION_PREFIXES.has(prefix)) return "main-authoritative";
  if (LOCAL_EDITOR_ACTION_PREFIXES.has(prefix)) return "local-editor";
  return null;
}

export function setDetachedMainActionAvailability(value: unknown): void {
  const parsed = parseStringArray(value) ?? [];
  availableMainActionIds = new Set(parsed.filter(isDetachedMainActionId));
}

export function getDetachedMainActionAvailability(): readonly string[] {
  return [...availableMainActionIds];
}

export function canRouteDetachedMainAction(
  actionId: string,
  locallyAvailable = false,
  role: string = windowRole,
): boolean {
  return role !== "main"
    && isDetachedMainActionId(actionId)
    && (
      actionId === "edit.undo"
      || actionId === "edit.redo"
      || locallyAvailable
      || availableMainActionIds.has(actionId)
    );
}

export function createDetachedMainActionRequest(
  actionId: string,
  selectedTrackIds = useDAWStore.getState().selectedTrackIds,
): DetachedMainActionRequest | null {
  if (!isDetachedMainActionId(actionId)) return null;
  const state = useDAWStore.getState();
  const parsedSelection = parseStringArray(selectedTrackIds);
  const selectedClipIds = parseStringArray(state.selectedClipIds);
  const timeSelection = state.timeSelection && Number.isFinite(state.timeSelection.start)
    && Number.isFinite(state.timeSelection.end)
    && state.timeSelection.start >= 0
    && state.timeSelection.end >= state.timeSelection.start
    ? { ...state.timeSelection }
    : null;
  if (!parsedSelection || !selectedClipIds) return null;
  return {
    command: "action.execute",
    actionId,
    selectedTrackIds: parsedSelection,
    selectedClipIds,
    timeSelection,
    ...(windowSessionId ? { sessionId: windowSessionId } : {}),
  };
}

export function parseDetachedMainActionRequest(
  value: unknown,
): DetachedMainActionRequest | null {
  if (!isRecord(value) || value.command !== "action.execute") return null;
  const actionId = typeof value.actionId === "string" ? value.actionId : "";
  if (!isDetachedMainActionId(actionId)) return null;
  const selectedTrackIds = parseStringArray(value.selectedTrackIds);
  if (!selectedTrackIds) return null;
  const selectedClipIds = value.selectedClipIds === undefined
    ? []
    : parseStringArray(value.selectedClipIds, 4096);
  if (!selectedClipIds) return null;
  const timeSelection = value.timeSelection === null || value.timeSelection === undefined
    ? null
    : isRecord(value.timeSelection)
      && typeof value.timeSelection.start === "number"
      && typeof value.timeSelection.end === "number"
      && Number.isFinite(value.timeSelection.start)
      && Number.isFinite(value.timeSelection.end)
      && value.timeSelection.start >= 0
      && value.timeSelection.end >= value.timeSelection.start
      ? { start: value.timeSelection.start, end: value.timeSelection.end }
      : undefined;
  if (timeSelection === undefined) return null;
  const sessionId = typeof value.sessionId === "string" && value.sessionId.length <= 512
    ? value.sessionId
    : undefined;
  return {
    command: "action.execute",
    actionId,
    selectedTrackIds,
    selectedClipIds,
    timeSelection,
    sessionId,
  };
}

/**
 * Validate and execute an allowlisted action against the authoritative store.
 * Track selection is supplied explicitly by the requesting window, filtered
 * against the main project, and restored if the action cannot actually run.
 */
export function executeDetachedMainActionRequest(
  value: unknown,
  resolveAction: (actionId: string) => DetachedActionExecutor | undefined,
  options: ExecuteDetachedMainActionOptions = {},
): boolean {
  if ((options.role ?? windowRole) !== "main") return false;
  const request = parseDetachedMainActionRequest(value);
  if (!request) return false;
  if (
    request.actionId === "edit.deleteRazorContent"
    || request.actionId === "edit.clearRazorEdits"
    || (
      request.actionId === "edit.delete"
      && request.selectedClipIds.length === 0
      && request.timeSelection === null
    )
  ) return false;

  options.flushPendingEdits?.();
  const action = resolveAction(request.actionId);
  if (!action) return false;

  let previousSelection: {
    selectedTrackIds: string[];
    selectedTrackId: string | null;
    lastSelectedTrackId: string | null;
    selectedClipIds: string[];
    selectedClipId: string | null;
    timeSelection: { start: number; end: number } | null;
  } | null = null;
  if (
    actionUsesDetachedTrackSelection(request.actionId)
    || actionUsesDetachedTimelineSelection(request.actionId)
  ) {
    const state = useDAWStore.getState();
    const validTrackIds = new Set(state.tracks.map((track) => track.id));
    const selectedTrackIds = request.selectedTrackIds.filter((trackId) => validTrackIds.has(trackId));
    const validClipIds = new Set(state.tracks.flatMap((track) => [
      ...track.clips.map((clip) => clip.id),
      ...track.midiClips.map((clip) => clip.id),
    ]));
    const selectedClipIds = request.selectedClipIds.filter((clipId) => validClipIds.has(clipId));
    previousSelection = {
      selectedTrackIds: state.selectedTrackIds,
      selectedTrackId: state.selectedTrackId,
      lastSelectedTrackId: state.lastSelectedTrackId,
      selectedClipIds: state.selectedClipIds,
      selectedClipId: state.selectedClipId,
      timeSelection: state.timeSelection,
    };
    useDAWStore.setState({
      ...(actionUsesDetachedTrackSelection(request.actionId) ? {
        selectedTrackIds,
        selectedTrackId: selectedTrackIds[0] ?? null,
        lastSelectedTrackId: selectedTrackIds[selectedTrackIds.length - 1] ?? null,
      } : {}),
      ...(actionUsesDetachedTimelineSelection(request.actionId) ? {
        selectedClipIds,
        selectedClipId: selectedClipIds[0] ?? null,
        timeSelection: request.timeSelection,
      } : {}),
    });
  }

  if (action.canHandleShortcut && !action.canHandleShortcut()) {
    if (previousSelection) useDAWStore.setState(previousSelection);
    return false;
  }

  action.execute();
  return true;
}

export function publishDetachedMainAction(
  actionId: string,
  role: string = windowRole,
): boolean {
  if (role === "main") return false;
  const request = createDetachedMainActionRequest(actionId);
  if (!request) return false;
  void nativeBridge.publishAppCommand(request);
  return true;
}

export function parseDetachedLoopRegionRequest(
  value: unknown,
): DetachedLoopRegionRequest | null {
  if (!isRecord(value) || value.command !== "transport.setLoopRegion") return null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
  const start = typeof value.start === "number" ? value.start : Number.NaN;
  const end = typeof value.end === "number" ? value.end : Number.NaN;
  if (!sessionId || sessionId.length > 512) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  return { command: "transport.setLoopRegion", sessionId, start, end };
}

/** Apply a detached Piano Roll loop request only to its still-live clip. */
export function applyDetachedLoopRegionRequest(value: unknown, role: string = windowRole): boolean {
  if (role !== "main") return false;
  const request = parseDetachedLoopRegionRequest(value);
  if (!request) return false;
  const state = useDAWStore.getState();
  const session = state.midiEditorSessions.find((candidate) => candidate.sessionId === request.sessionId);
  if (!session || session.mode !== "windowed") return false;
  const track = state.tracks.find((candidate) => candidate.id === session.trackId);
  const clip = track?.midiClips.find((candidate) => candidate.id === session.clipId);
  if (!clip) return false;
  const clipStart = clip.startTime;
  const clipEnd = clip.startTime + clip.duration;
  const epsilon = 1e-6;
  if (request.start < clipStart - epsilon || request.end > clipEnd + epsilon) return false;
  state.setLoopRegion(request.start, request.end);
  return true;
}

export function publishDetachedLoopRegion(
  start: number,
  end: number,
  sessionId: string = windowSessionId,
): boolean {
  if (windowRole === "main") return false;
  const request = parseDetachedLoopRegionRequest({
    command: "transport.setLoopRegion",
    sessionId,
    start,
    end,
  });
  if (!request) return false;
  void nativeBridge.publishAppCommand(request);
  return true;
}

function parseMidiEditRange(value: unknown): MIDIEditRange | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { startTime, endTime, minNote, maxNote, includeCC } = value;
  if (
    typeof startTime !== "number"
    || typeof endTime !== "number"
    || typeof minNote !== "number"
    || typeof maxNote !== "number"
    || !Number.isFinite(startTime)
    || !Number.isFinite(endTime)
    || !Number.isFinite(minNote)
    || !Number.isFinite(maxNote)
    || startTime < 0
    || endTime < startTime
    || minNote < 0
    || maxNote > 127
    || minNote > maxNote
    || typeof includeCC !== "boolean"
  ) return undefined;
  return { startTime, endTime, minNote, maxNote, includeCC };
}

export function parseDetachedMidiQuantizeRequest(
  value: unknown,
): DetachedMidiQuantizeRequest | null {
  if (!isRecord(value) || value.command !== "midi.quantize") return null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
  const selectedNoteIds = parseStringArray(value.selectedNoteIds, 1_000_000);
  const midiEditRange = parseMidiEditRange(value.midiEditRange);
  if (!sessionId || sessionId.length > 512 || !selectedNoteIds || midiEditRange === undefined) {
    return null;
  }
  return { command: "midi.quantize", sessionId, selectedNoteIds, midiEditRange };
}

export function publishDetachedMidiQuantize(
  sessionId: string,
  selectedNoteIds: readonly string[],
  midiEditRange: MIDIEditRange | null,
): boolean {
  if (windowRole === "main") return false;
  const request = parseDetachedMidiQuantizeRequest({
    command: "midi.quantize",
    sessionId,
    selectedNoteIds: [...selectedNoteIds],
    midiEditRange,
  });
  if (!request) return false;
  void nativeBridge.publishAppCommand(request);
  return true;
}

export function isLiveDetachedMidiSessionId(
  sessionId: string,
  role: string = windowRole,
): boolean {
  if (role !== "main" || !sessionId) return false;
  const state = useDAWStore.getState();
  const session = state.midiEditorSessions.find((candidate) => (
    candidate.sessionId === sessionId && candidate.mode === "windowed"
  ));
  if (!session) return false;
  return Boolean(state.tracks
    .find((track) => track.id === session.trackId)
    ?.midiClips.some((clip) => clip.id === session.clipId));
}

/** Quantize only the validated selection owned by the sending MIDI session. */
export function applyDetachedMidiQuantizeRequest(
  value: unknown,
  role: string = windowRole,
): boolean {
  if (role !== "main") return false;
  const request = parseDetachedMidiQuantizeRequest(value);
  if (!request || !isLiveDetachedMidiSessionId(request.sessionId, role)) return false;

  const before = useDAWStore.getState();
  const session = before.midiEditorSessions.find((candidate) => candidate.sessionId === request.sessionId)!;
  const clip = before.tracks
    .find((track) => track.id === session.trackId)
    ?.midiClips.find((candidate) => candidate.id === session.clipId);
  if (!clip) return false;

  const pairs = parseMIDINotePairs(clip.events, clip.id);
  const validNoteIds = new Set(pairs.map((pair) => pair.id));
  if (request.selectedNoteIds.some((noteId) => !validNoteIds.has(noteId))) return false;

  const selectedNoteIds = request.selectedNoteIds.length > 0
    ? request.selectedNoteIds
    : request.midiEditRange
      ? pairs
        .filter((pair) => (
          pair.startTime <= request.midiEditRange!.endTime
          && pair.startTime + pair.duration >= request.midiEditRange!.startTime
          && pair.noteNumber >= request.midiEditRange!.minNote
          && pair.noteNumber <= request.midiEditRange!.maxNote
        ))
        .map((pair) => pair.id)
      : [];
  if (selectedNoteIds.length === 0) return false;

  const previousSelection = [...before.selectedNoteIds];
  const previousRange = before.midiEditRange ? { ...before.midiEditRange } : null;
  useDAWStore.setState({
    selectedNoteIds: [...selectedNoteIds],
    midiEditRange: request.midiEditRange ? { ...request.midiEditRange } : null,
  });

  const nextIds = useDAWStore.getState().quantizeSelectedMIDINotesUsingLast(
    session.trackId,
    session.clipId,
  );
  useDAWStore.setState((state) => ({
    selectedNoteIds: previousSelection,
    midiEditRange: previousRange,
    midiEditorSessions: state.midiEditorSessions.map((candidate) => (
      candidate.sessionId === request.sessionId
        ? {
          ...candidate,
          selectedNoteIds: [...nextIds],
          midiEditRange: request.midiEditRange ? { ...request.midiEditRange } : null,
          updatedAt: Date.now(),
        }
        : candidate
    )),
  }));
  return nextIds.length > 0;
}

export function actionUsesDetachedTrackSelection(actionId: string): boolean {
  return actionId.startsWith(TRACK_SELECTION_ACTION_PREFIX)
    || actionId.startsWith("automation.selectedTracks.")
    || actionId === "automation.showAllSelectedTrackEnvelopes"
    || actionId === "automation.hideAllSelectedTrackEnvelopes"
    || actionId === "insert.bus";
}

export function actionUsesDetachedTimelineSelection(actionId: string): boolean {
  if (actionId === "edit.undo" || actionId === "edit.redo") return false;
  return actionId.startsWith("edit.")
    || actionId.startsWith("clip.")
    || actionId.startsWith("navigate.");
}
