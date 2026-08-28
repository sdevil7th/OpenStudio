/**
 * Action Registry - Centralized registry of all available actions
 * Used by Command Palette, keyboard shortcuts reference, and Actions menu
 */

import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "./commands";
import {
  getMinimumVisibleTrackHeight,
  useDAWStore,
  type AudioClip,
  type MIDIClip,
} from "./useDAWStore";
import { formatShortcut, getShortcutPlatform } from "../utils/platform";
import { createTrackOfType } from "../utils/trackCreation";
import {
  calculateGridInterval,
  GRID_TYPE_MODE_OPTIONS,
  getQuantizePresetById,
  type GridSize,
} from "../utils/snapToGrid";
import {
  collectClipIdsInsideTimeSelection,
  collectTimelineBoundaryTimes,
  resolveAdjacentGridLineTime,
  resolveAdjacentTimelineBoundary,
  type NavigationDirection,
} from "../utils/vendorNavigation";
import {
  getProfileActionBindings,
  getProfileActionScopeAdditions,
} from "../utils/shortcutProfiles";
import { resolveCustomShortcutBindings } from "../utils/customShortcutProfiles";
import { parseMIDINotePairs } from "../utils/midiNotes";
import {
  getVisibleMIDIEventsForClip,
  serializeMIDIClipsForBackend,
} from "../utils/midiClipSerialization";
import {
  getActiveShortcutContext,
  shortcutContextKey,
  type EditShortcutContext,
  type ShortcutHandlerResult,
} from "../utils/shortcutContext";
import { windowRole } from "../utils/windowEnvironment";
import { getTimelineVisibleContentEnd } from "../utils/contextWheelBehaviors";
import {
  isDetachedAutomationActionId,
  publishDetachedMainAction,
} from "../utils/detachedMainActionRouting";
import { resolveTimelinePasteTargets } from "../utils/timelineClipboard";
import {
  canCopyWithinTimelineTimeSelection,
  canCutWithinTimelineTimeSelection,
  canDeleteRazorEditContent,
  canDeleteWithinTimelineTimeSelection,
  canInsertSilenceAtTimelineTimeSelection,
} from "./actions/timeSelectionEditing";
import {
  canExplodeClipTakes,
  canImplodeSelectedClipTakes,
} from "./actions/rendering";

export type ActionShortcutScope =
  | "global"
  | "timeline"
  | "timeline_ruler"
  | "track_control_panel"
  | "mixer"
  | "pitch_editor"
  | "piano_roll"
  | "automation"
  | "browser"
  | "plugin"
  | "modal"
  | "contextual";

export type ActionShortcutWhen =
  | "always"
  | "transport_running"
  | "transport_stopped"
  | "step_input_enabled"
  | "step_input_disabled";

export type DeferredActionReason =
  | "requires_component_state"
  | "requires_runtime_parameter"
  | "requires_undo_support"
  | "not_implemented";

export interface ActionDef {
  id: string;
  name: string;
  category: string;
  shortcut?: string;
  shortcutScope?: ActionShortcutScope;
  /**
   * Some semantic commands are valid in more than one focused surface (for
   * example selected-track mute in both the TCP and Mixer). shortcutScope is
   * retained as the primary/display scope while dispatchers use this complete
   * set when it is present.
   */
  shortcutScopes?: readonly ActionShortcutScope[];
  shortcutAliases?: string[];
  shortcutWhen?: ActionShortcutWhen;
  canHandleShortcut?: () => boolean;
  execute: () => void;
}

/**
 * A stable catalog identity for a visible command that cannot yet be safely
 * exposed to the dispatcher. Keeping these separate from ActionDef prevents
 * Command Palette/toolbar callers from invoking a placeholder no-op.
 */
export interface DeferredActionDef {
  id: string;
  name: string;
  category: string;
  shortcutScope: ActionShortcutScope;
  shortcutScopes?: readonly ActionShortcutScope[];
  shortcut?: string;
  reason: DeferredActionReason;
  reasonDetail: string;
}

export type ScopedActionExecutor = (actionId: string) => ShortcutHandlerResult;

interface ScopedActionExecutorRegistration {
  token: symbol;
  execute: ScopedActionExecutor;
  supportedActionIds?: ReadonlySet<string>;
}

const scopedActionExecutors = new Map<string, ScopedActionExecutorRegistration[]>();

export function isRemoteAutomationActionId(actionId: string): boolean {
  return isDetachedAutomationActionId(actionId);
}

/**
 * Run project-owned automation state in the main window. The role override is
 * intentionally optional so the routing contract can be tested without
 * reloading the whole registry module under a synthetic browser URL.
 */
export function routeAutomationAction(
  actionId: string,
  executeInMain: () => void,
  role: string = windowRole,
): void {
  if (role !== "main") {
    if (isRemoteAutomationActionId(actionId)) {
      publishDetachedMainAction(actionId, role);
    }
    return;
  }
  executeInMain();
}

/** Execute one allowlisted detached command in the authoritative main realm. */
export function executeRemoteAutomationAction(actionId: string): boolean {
  if (windowRole !== "main" || !isRemoteAutomationActionId(actionId)) return false;
  const action = getRegisteredAction(actionId);
  if (!action || (action.canHandleShortcut && !action.canHandleShortcut())) return false;
  action.execute();
  return true;
}

/**
 * Editor actions need the currently focused editor instance to execute (for
 * example, one of multiple detached Piano Rolls). The action remains centrally
 * registered and profileable, while the active surface supplies instance-local
 * state such as the step-input octave or pitch-editor selection.
 */
export function registerScopedActionExecutor(
  context: EditShortcutContext,
  execute: ScopedActionExecutor,
  supportedActionIds?: readonly string[],
): () => void {
  const key = shortcutContextKey(context);
  const token = Symbol(key);
  const registrations = scopedActionExecutors.get(key) ?? [];
  registrations.push({
    token,
    execute,
    supportedActionIds: supportedActionIds ? new Set(supportedActionIds) : undefined,
  });
  scopedActionExecutors.set(key, registrations);

  return () => {
    const current = scopedActionExecutors.get(key);
    if (!current) return;
    const index = current.findIndex((registration) => registration.token === token);
    if (index < 0) return;
    current.splice(index, 1);
    if (current.length === 0) scopedActionExecutors.delete(key);
  };
}

/** Check active-instance capability without executing an editor command. */
export function hasActiveScopedActionExecutor(actionId: string): boolean {
  const key = shortcutContextKey(getActiveShortcutContext());
  const ownsAction = (ownerKey: string) => (scopedActionExecutors.get(ownerKey) || []).some((registration) => (
    registration.supportedActionIds?.has(actionId) === true
  ));
  if (ownsAction(key)) return true;
  // Mirror executeActiveScopedAction's always-mounted shell fallback so a
  // Toolbar/Transport command stays reachable while an editor owns focus.
  return key !== "application" && ownsAction("application");
}

export function executeActiveScopedAction(actionId: string): ShortcutHandlerResult {
  const key = shortcutContextKey(getActiveShortcutContext());
  const executeRegistrations = (
    registrations: readonly ScopedActionExecutorRegistration[] | undefined,
  ): ShortcutHandlerResult => {
    if (!registrations) return "unmatched";
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      const result = registrations[index].execute(actionId);
      if (result !== "unmatched") return result;
    }
    return "unmatched";
  };

  const scopedResult = executeRegistrations(scopedActionExecutors.get(key));
  if (scopedResult !== "unmatched" || key === "application") return scopedResult;

  // Always-mounted shell controls (for example, Transport and Main Toolbar
  // popovers) do not own focus. Their application executor remains available
  // after the user has interacted with an editor-specific surface.
  return executeRegistrations(scopedActionExecutors.get("application"));
}

function activeEditorAction(
  id: string,
  name: string,
  category: string,
  shortcut: string,
  shortcutScope: "piano_roll" | "pitch_editor",
  shortcutAliases?: string[],
  shortcutWhen?: ActionShortcutWhen,
): ActionDef {
  return {
    id,
    name,
    category,
    shortcut,
    shortcutScope,
    shortcutAliases,
    shortcutWhen,
    canHandleShortcut: () => hasActiveScopedActionExecutor(id),
    execute: () => { executeActiveScopedAction(id); },
  };
}

function activeScopedComponentAction(
  id: string,
  name: string,
  category: string,
  shortcutScope: ActionShortcutScope,
  shortcutScopes?: readonly ActionShortcutScope[],
): ActionDef {
  return {
    id,
    name,
    category,
    shortcutScope,
    shortcutScopes,
    canHandleShortcut: () => hasActiveScopedActionExecutor(id),
    execute: () => { executeActiveScopedAction(id); },
  };
}

/** A scoped command that must not consume a chord unless its exact UI owner exists. */
function availableScopedComponentAction(
  id: string,
  name: string,
  category: string,
  shortcutScope: ActionShortcutScope,
  shortcutScopes?: readonly ActionShortcutScope[],
): ActionDef {
  return {
    ...activeScopedComponentAction(id, name, category, shortcutScope, shortcutScopes),
    canHandleShortcut: () => hasActiveScopedActionExecutor(id),
  };
}

const PIANO_ROLL_EDIT_ACTION_IDS = new Set([
  "edit.transpose",
  "edit.velocityScale",
  "edit.transposeUp",
  "edit.transposeDown",
  "edit.transposeOctaveUp",
  "edit.transposeOctaveDown",
  "edit.velocityUp",
  "edit.velocityDown",
  "edit.reverseNotes",
  "edit.invertNotes",
  "edit.snapNotesToScale",
]);

const TIMELINE_VIEW_ACTION_IDS = new Set([
  "view.clipProperties",
  "view.toggleSnap",
  "view.toggleAutoCrossfade",
  "view.zoomToSelection",
  "view.zoomIn",
  "view.zoomOut",
  "view.zoomToFit",
  "view.setLoopToSelection",
  "view.autoScroll",
  "view.freePositioning",
  "view.toggleCrosshair",
]);

function inferActionShortcutScope(action: ActionDef): ActionShortcutScope {
  if (action.shortcutScope) return action.shortcutScope;
  if (PIANO_ROLL_EDIT_ACTION_IDS.has(action.id)) return "piano_roll";
  if (action.id.startsWith("midi.") && action.id !== "midi.panic") return "piano_roll";
  if (action.id.startsWith("edit.")) return "timeline";
  if (action.id.startsWith("navigate.") || action.id.startsWith("tools.")) return "timeline";
  if (TIMELINE_VIEW_ACTION_IDS.has(action.id)) return "timeline";
  if (action.id.startsWith("mixer.")) return "mixer";
  if (action.id.startsWith("track.")) return "track_control_panel";
  return "global";
}

function withResolvedShortcutScope(action: ActionDef): ActionDef {
  const shortcutScope = inferActionShortcutScope(action);
  const shortcutScopes = action.shortcutScopes?.length
    ? Array.from(new Set([shortcutScope, ...action.shortcutScopes]))
    : undefined;
  return { ...action, shortcutScope, shortcutScopes };
}

export function getActionShortcutScopes(
  action: ActionDef,
  profileId?: unknown,
): readonly ActionShortcutScope[] {
  const baseScopes = action.shortcutScopes?.length
    ? action.shortcutScopes
    : [action.shortcutScope ?? "global"];
  if (profileId === undefined) return baseScopes;
  return Array.from(new Set<ActionShortcutScope>([
    ...baseScopes,
    ...getProfileActionScopeAdditions(profileId, action.id),
  ]));
}

function shortcutConditionsOverlap(a?: ActionShortcutWhen, b?: ActionShortcutWhen): boolean {
  if (!a || a === "always" || !b || b === "always") return true;
  if (a === b) return true;
  const exclusivePairs = new Set([
    "step_input_disabled|step_input_enabled",
    "step_input_enabled|step_input_disabled",
    "transport_running|transport_stopped",
    "transport_stopped|transport_running",
  ]);
  return !exclusivePairs.has(`${a}|${b}`);
}

/**
 * Returns the full list of registered actions.
 * Actions reference the store via getState() so they always use current state.
 */
export function getRegisteredActions(): ActionDef[] {
  const s = () => useDAWStore.getState();
  const transposeSelectedMidiNotes = () => {
    const state = s();
    if (!state.pianoRollTrackId || !state.pianoRollClipId || state.selectedNoteIds.length === 0) return;
    const input = prompt("Transpose selected notes by semitones:", "0");
    if (input === null) return;
    const semitones = Number(input);
    if (!Number.isFinite(semitones)) return;
    const roundedSemitones = Math.max(-127, Math.min(127, Math.round(semitones)));
    if (roundedSemitones === 0) return;
    const nextIds = state.moveMIDINotes(
      state.pianoRollTrackId,
      state.pianoRollClipId,
      state.selectedNoteIds,
      0,
      roundedSemitones,
    );
    if (nextIds.length > 0) state.setSelectedNoteIds(nextIds);
  };
  const scaleSelectedMidiVelocity = () => {
    const state = s();
    if (!state.pianoRollTrackId || !state.pianoRollClipId || state.selectedNoteIds.length === 0) return;
    const input = prompt("Scale selected note velocity (percent):", "100");
    if (input === null) return;
    const percent = Number(input);
    if (!Number.isFinite(percent) || percent < 0) return;
    state.scaleSelectedMIDINoteVelocity(
      state.pianoRollTrackId,
      state.pianoRollClipId,
      Math.min(percent, 1000) / 100,
    );
  };
  const selectedTrackIds = () => {
    const state = s();
    const ids = state.selectedTrackIds.length > 0
      ? state.selectedTrackIds
      : state.selectedTrackId ? [state.selectedTrackId] : [];
    return ids.filter((id, index) => ids.indexOf(id) === index);
  };
  const selectedTimelineClips = () => {
    const state = s();
    const ids = state.selectedClipIds.length > 0
      ? state.selectedClipIds
      : state.selectedClipId ? [state.selectedClipId] : [];
    return state.tracks.flatMap((track) => [
      ...track.clips.map((clip) => ({ track, clip, kind: "audio" as const })),
      ...track.midiClips.map((clip) => ({ track, clip, kind: "midi" as const })),
    ]).filter((entry) => ids.includes(entry.clip.id));
  };
  const canSplitAtTimeSelection = () => {
    const state = s();
    const selection = state.timeSelection;
    if (!selection || state.globalLocked || state.lockSettings.items) return false;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= 0.000001) {
      return false;
    }
    const selectedClipIds = new Set(
      state.selectedClipIds.length > 0
        ? state.selectedClipIds
        : state.selectedClipId ? [state.selectedClipId] : [],
    );
    const selectedTrackIds = new Set(state.selectedTrackIds);
    const entries = state.tracks.flatMap((track) => [
      ...track.clips.map((clip) => ({ clip, trackId: track.id, frozen: track.frozen })),
      ...track.midiClips.map((clip) => ({ clip, trackId: track.id, frozen: track.frozen })),
    ]);
    const crossings = entries.filter(({ clip }) => (
      (start > clip.startTime + 0.000001 && start < clip.startTime + clip.duration - 0.000001)
      || (end > clip.startTime + 0.000001 && end < clip.startTime + clip.duration - 0.000001)
    ));
    const selectedClipCrossings = crossings.filter(({ clip }) => selectedClipIds.has(clip.id));
    const selectedTrackCrossings = crossings.filter(({ trackId }) => selectedTrackIds.has(trackId));
    const candidates = selectedClipCrossings.length > 0
      ? selectedClipCrossings
      : selectedTrackCrossings.length > 0
        ? selectedTrackCrossings
        : crossings;
    return candidates.some(({ clip, frozen }) => !frozen && !clip.locked);
  };
  const canSplitAtCurrentTime = () => {
    const state = s();
    const splitTime = state.transport.currentTime;
    if (state.globalLocked || state.lockSettings.items || !Number.isFinite(splitTime)) return false;
    const selectedClipIds = new Set(
      state.selectedClipIds.length > 0
        ? state.selectedClipIds
        : state.selectedClipId ? [state.selectedClipId] : [],
    );
    const selectedTrackIds = new Set(state.selectedTrackIds);
    const crossings = state.tracks.flatMap((track) => [
      ...track.clips.map((clip) => ({ clip, trackId: track.id, frozen: track.frozen })),
      ...track.midiClips.map((clip) => ({ clip, trackId: track.id, frozen: track.frozen })),
    ]).filter(({ clip }) => (
      splitTime > clip.startTime + 0.000001
      && splitTime < clip.startTime + clip.duration - 0.000001
    ));
    const selectedClipCrossings = crossings.filter(({ clip }) => selectedClipIds.has(clip.id));
    const selectedTrackCrossings = crossings.filter(({ trackId }) => selectedTrackIds.has(trackId));
    const candidates = selectedClipCrossings.length > 0
      ? selectedClipCrossings
      : selectedTrackCrossings.length > 0
        ? selectedTrackCrossings
        : crossings;
    return candidates.some(({ clip, frozen }) => !frozen && !clip.locked);
  };
  const hasFiniteTimeSelection = () => {
    const selection = s().timeSelection;
    return Boolean(
      selection
      && Number.isFinite(selection.start)
      && Number.isFinite(selection.end)
      && Math.abs(selection.end - selection.start) > 0.000001
    );
  };
  const hasTimelineProjectExtent = () => {
    const state = s();
    return getTimelineVisibleContentEnd(
      state.tracks,
      state.recordingClips.length > 0 ? state.transport.currentTime : undefined,
    ) > 0.000001;
  };
  const canNudgeSelectedClips = (direction: "left" | "right", fine = false) => {
    const state = s();
    if (state.globalLocked || state.lockSettings.items) return false;
    const eligible = selectedTimelineClips().filter((entry) => !entry.track.frozen && !entry.clip.locked);
    if (eligible.length === 0) return false;
    const amount = fine
      ? 0.01
      : calculateGridInterval(state.transport.tempo, state.timeSignature, state.gridSize);
    if (!Number.isFinite(amount) || amount <= 0) return false;
    return direction === "right"
      || eligible.some((entry) => Math.max(0, entry.clip.startTime - amount) !== entry.clip.startTime);
  };
  const canQuantizeSelectedTimelineClips = () => {
    const state = s();
    if (state.globalLocked || state.lockSettings.items) return false;
    const preset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
    const interval = calculateGridInterval(
      state.transport.tempo,
      state.timeSignature,
      state.gridSize,
      {
        quantizePreset: preset,
        quantizeGridSize: preset.gridSize,
        pixelsPerSecond: state.pixelsPerSecond,
      },
    );
    if (!Number.isFinite(interval) || interval <= 0) return false;
    return selectedTimelineClips().some((entry) => (
      !entry.track.frozen
      && !entry.clip.locked
      && Math.abs(
        Math.max(0, Math.round(entry.clip.startTime / interval) * interval)
          - entry.clip.startTime,
      ) > 0.000001
    ));
  };
  const canPasteTimelineClips = () => {
    const state = s();
    return !state.globalLocked
      && !state.lockSettings.items
      && Number.isFinite(state.transport.currentTime)
      && state.clipboard.clips.length > 0
      && resolveTimelinePasteTargets(
        state.tracks,
        state.selectedTrackIds,
        state.clipboard.clips,
      ).length > 0;
  };
  const selectedTransientAudioClip = (): AudioClip | null => {
    const state = s();
    const entry = selectedTimelineClips().find((candidate) => (
      candidate.kind === "audio"
      && typeof candidate.clip.filePath === "string"
      && candidate.clip.filePath.trim().length > 0
      && Number.isFinite(candidate.clip.startTime)
      && Number.isFinite(candidate.clip.duration)
      && candidate.clip.duration > 0
    ));
    if (!entry || !Number.isFinite(state.transport.currentTime)) return null;
    const sourceTime = state.transport.currentTime
      - entry.clip.startTime
      + (entry.clip.offset || 0);
    return sourceTime >= (entry.clip.offset || 0) - 0.000001
      && sourceTime <= (entry.clip.offset || 0) + entry.clip.duration + 0.000001
      ? entry.clip as AudioClip
      : null;
  };
  const canQuantizeActiveMIDINotes = () => {
    const state = s();
    if (state.globalLocked || state.lockSettings.items || state.selectedNoteIds.length === 0) {
      return false;
    }
    const track = state.tracks.find((candidate) => candidate.id === state.pianoRollTrackId);
    const clip = track?.midiClips.find((candidate) => candidate.id === state.pianoRollClipId);
    if (!track || track.frozen || !clip || clip.locked) return false;
    const selectedIds = new Set(state.selectedNoteIds);
    return parseMIDINotePairs(clip.events, clip.id).some((pair) => selectedIds.has(pair.id));
  };
  const canToggleSelectedPitchEditor = () => {
    const state = s();
    const selected = selectedTimelineClips();
    if (selected.length !== 1) return false;
    const entry = selected[0];
    if (entry.kind !== "audio"
        || entry.track.frozen
        || entry.clip.locked
        || !entry.clip.filePath?.trim()) {
      return false;
    }
    return state.showPitchEditor && state.pitchEditorClipId === entry.clip.id
      ? true
      : !state.globalLocked && !state.lockSettings.items;
  };
  const adjacentGridLineTime = (direction: NavigationDirection) => {
    const state = s();
    const preset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
    const interval = calculateGridInterval(
      state.transport.tempo,
      state.timeSignature,
      state.gridSize,
      {
        quantizePreset: preset,
        quantizeGridSize: preset.gridSize,
        pixelsPerSecond: state.pixelsPerSecond,
      },
    );
    return resolveAdjacentGridLineTime(state.transport.currentTime, interval, direction);
  };
  const adjacentTimelineBoundary = (direction: NavigationDirection) => {
    const state = s();
    const times = collectTimelineBoundaryTimes({
      tracks: state.tracks,
      markers: state.markers,
      timeSelection: state.timeSelection,
    });
    return resolveAdjacentTimelineBoundary(state.transport.currentTime, times, direction);
  };
  const orderedTimelineClipIds = () => {
    const state = s();
    return state.tracks.flatMap((track, trackIndex) => [
      ...track.clips.map((clip, clipIndex) => ({ clip, trackIndex, kindOrder: 0, clipIndex })),
      ...track.midiClips.map((clip, clipIndex) => ({ clip, trackIndex, kindOrder: 1, clipIndex })),
    ]).sort((left, right) => (
      left.clip.startTime - right.clip.startTime
      || left.trackIndex - right.trackIndex
      || left.kindOrder - right.kindOrder
      || left.clipIndex - right.clipIndex
    )).map((entry) => entry.clip.id);
  };
  const canSelectAdjacentClip = (direction: "previous" | "next") => {
    const state = s();
    const anchorId = state.selectedClipId
      && state.selectedClipIds.includes(state.selectedClipId)
      ? state.selectedClipId
      : state.selectedClipIds[0];
    if (!anchorId) return false;
    const orderedIds = orderedTimelineClipIds();
    const currentIndex = orderedIds.indexOf(anchorId);
    const nextIndex = currentIndex + (direction === "next" ? 1 : -1);
    return currentIndex >= 0 && nextIndex >= 0 && nextIndex < orderedIds.length;
  };
  const selectedMidiTimelineClips = () => selectedTimelineClips()
    .filter((entry) => entry.kind === "midi")
    .map((entry) => ({ ...entry, clip: entry.clip as MIDIClip }))
    .filter((entry) => entry.clip.events.length > 0);
  const editableSelectedMidiTimelineClips = () => {
    const state = s();
    if (state.globalLocked || state.lockSettings.items) return [];
    return selectedMidiTimelineClips().filter((entry) => (
      !entry.track.frozen && !entry.clip.locked
    ));
  };
  const runSynchronousCommandBatch = (
    type: string,
    description: string,
    operation: () => void,
    hooks?: { afterExecute?: () => void; afterUndo?: () => void },
  ) => {
    const changed = commandManager.runBatch({ type, description, ...hooks }, operation);
    if (changed) {
      useDAWStore.setState({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
      });
    }
    return changed;
  };
  const applyToAllNotesInSelectedMidiClips = (
    type: string,
    description: string,
    operation: (trackId: string, clipId: string, noteIds: string[]) => string[] | void,
  ) => {
    const state = s();
    const selectionBefore = [...state.selectedNoteIds];
    let nextSelection = [...state.selectedNoteIds];
    const changed = runSynchronousCommandBatch(type, description, () => {
      editableSelectedMidiTimelineClips().forEach((entry) => {
        const noteIds = parseMIDINotePairs(entry.clip.events, entry.clip.id).map((pair) => pair.id);
        if (noteIds.length === 0) return;
        state.setSelectedNoteIds(noteIds);
        const result = operation(entry.track.id, entry.clip.id, noteIds);
        nextSelection = Array.isArray(result)
          ? result
          : [...useDAWStore.getState().selectedNoteIds];
      });
    }, {
      afterExecute: () => state.setSelectedNoteIds(nextSelection),
      afterUndo: () => state.setSelectedNoteIds(selectionBefore),
    });
    if (!changed) state.setSelectedNoteIds(selectionBefore);
  };
  const chooseByNumber = <T,>(title: string, items: readonly T[], label: (item: T) => string): T | undefined => {
    if (items.length === 0) return undefined;
    if (items.length === 1) return items[0];
    const choices = items.map((item, index) => `${index + 1}. ${label(item)}`).join("\n");
    const input = prompt(`${title}\n\n${choices}`, "1");
    if (input === null) return undefined;
    const index = Math.round(Number(input)) - 1;
    return Number.isInteger(index) && index >= 0 && index < items.length
      ? items[index]
      : undefined;
  };
  const isValidCssColor = (value: string) => {
    if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return true;
    return typeof CSS !== "undefined"
      && typeof CSS.supports === "function"
      && CSS.supports("color", value);
  };
  const checkForUpdates = () => {
    void (async () => {
      const result = await nativeBridge.checkForUpdates(true);
      const state = s();
      if (result?.status === "up-to-date") {
        state.showToast("OpenStudio is already up to date.", "success");
        return;
      }
      if (result?.status !== "update-available") {
        state.showToast(result?.message || "Could not check for updates.", "error");
        return;
      }

      const version = result.version || "the latest version";
      const notes = typeof result.notes === "string" && result.notes.trim()
        ? `\n\nRelease notes:\n${result.notes}`
        : "";
      const platformPrompt = result.platform === "macos"
        ? "Download and open the DMG now?"
        : "Download and install it now?";
      if (!confirm(`OpenStudio ${version} is available.${notes}\n\n${platformPrompt}`)) return;

      const installResult = await nativeBridge.downloadAndInstallUpdate(
        result.downloadUrl || "",
        result.version,
        result.sha256,
        result.releasePageUrl,
        result.installerArguments,
        result.size,
      );
      if (installResult?.status === "install-started") {
        state.showToast(installResult.message || "The installer has been opened.", "success");
      } else if (installResult?.status === "release-page-opened") {
        state.showToast("Opened the release page for the latest update.", "info");
      } else {
        state.showToast(installResult?.message || "Update download or installation failed.", "error");
      }
    })();
  };
  const showAbout = () => {
    void nativeBridge.getAppVersion().then((version) => {
      alert(
        `OpenStudio ${version}\n\n`
        + "A hybrid DAW with a JUCE C++ backend and React/TypeScript frontend.",
      );
    });
  };

  const selectedAutomationLane = () => {
    const state = s();
    const target = state.selectedAutomationTarget;
    if (!target) return undefined;
    if (target.kind === "master") {
      return state.masterAutomationLanes.find((lane) => lane.id === target.laneId);
    }
    return state.tracks
      .find((track) => track.id === target.trackId)
      ?.automationLanes.find((lane) => lane.id === target.laneId);
  };
  const hasSelectedAutomationLane = () => Boolean(selectedAutomationLane());
  const hasAnyAutomationLane = () => {
    const state = s();
    return state.masterAutomationLanes.length > 0
      || state.tracks.some((track) => track.automationLanes.length > 0);
  };
  const hasSelectedAutomationPoint = () => {
    const target = s().selectedAutomationTarget;
    return Boolean(target?.pointId && selectedAutomationLane());
  };
  const canEditSelectedAutomationLane = () => (
    hasSelectedAutomationLane() && !s().globalLocked && !s().lockSettings.envelopes
  );
  const canEditAutomationSettings = () => (
    !s().globalLocked && !s().lockSettings.envelopes
  );
  const canEditSelectedAutomationPoint = () => (
    hasSelectedAutomationPoint() && !s().globalLocked && !s().lockSettings.envelopes
  );
  const hasSuspendableAutomation = () => {
    const state = s();
    if (state.globalLocked || state.lockSettings.envelopes) return false;
    return state.tracks.some((track) => (
      !track.suspendedAutomationState
      && (
        track.automationLanes.length > 0
        || track.automationReadEnabled
        || track.automationWriteEnabled
      )
    )) || (
      !state.suspendedMasterAutomationState
      && (
        state.masterAutomationLanes.length > 0
        || state.masterAutomationReadEnabled
        || state.masterAutomationWriteEnabled
      )
    );
  };
  const hasSuspendedAutomation = () => {
    const state = s();
    if (state.globalLocked || state.lockSettings.envelopes) return false;
    return Boolean(
      state.suspendedMasterAutomationState
      || state.tracks.some((track) => track.suspendedAutomationState),
    );
  };
  const automationAction = (
    id: string,
    name: string,
    execute: () => void,
    options: Omit<ActionDef, "id" | "name" | "category" | "execute"> = {},
  ): ActionDef => {
    const { canHandleShortcut, ...rest } = options;
    return {
      id,
      name,
      category: "Automation",
      shortcutScope: "automation",
      ...rest,
      canHandleShortcut: () => (
        (windowRole === "main" || isRemoteAutomationActionId(id))
        && (!canHandleShortcut || canHandleShortcut())
      ),
      execute: () => routeAutomationAction(id, execute),
    };
  };
  const selectedTracks = () => selectedTrackIds();
  const allTracks = () => s().tracks.map((track) => track.id);
  const automationActions: ActionDef[] = [
    automationAction(
      "automation.toggleArrangementView",
      "Show / Hide Arrangement Automation",
      () => s().toggleArrangementAutomationView(),
      {
        shortcut: "A",
        shortcutScope: "timeline",
        shortcutScopes: ["timeline", "automation"],
      },
    ),

    automationAction("automation.writeBehavior.touch", "Set Automation Write Behavior: Touch", () => s().setAutomationWriteBehavior("touch"), { canHandleShortcut: canEditAutomationSettings }),
    automationAction("automation.writeBehavior.latch", "Set Automation Write Behavior: Latch", () => s().setAutomationWriteBehavior("latch"), { canHandleShortcut: canEditAutomationSettings }),
    automationAction("automation.writeBehavior.overwrite", "Set Automation Write Behavior: Overwrite", () => s().setAutomationWriteBehavior("overwrite"), { canHandleShortcut: canEditAutomationSettings }),

    ...(["off", "read", "write", "touch", "latch"] as const).map((mode) => automationAction(
      `automation.selectedTracks.mode.${mode}`,
      `Set Selected Tracks Automation Mode: ${mode[0].toUpperCase()}${mode.slice(1)}`,
      () => s().setTracksAutomationMode(selectedTracks(), mode),
      {
        shortcutScopes: ["automation", "track_control_panel", "mixer"],
        canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
      },
    )),
    automationAction(
      "automation.selectedTracks.toggleOffRead",
      "Toggle Selected Tracks Automation: Off / Read",
      () => s().toggleTracksAutomationModes(selectedTracks(), "off", "read"),
      {
        shortcutScopes: ["automation", "track_control_panel", "mixer"],
        canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
      },
    ),
    automationAction(
      "automation.selectedTracks.toggleLatchRead",
      "Toggle Selected Tracks Automation: Latch / Read",
      () => s().toggleTracksAutomationModes(selectedTracks(), "latch", "read"),
      {
        shortcutScopes: ["automation", "track_control_panel", "mixer"],
        canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
      },
    ),
    ...(["off", "read", "touch", "latch"] as const).map((mode) => automationAction(
      `automation.allTracks.mode.${mode}`,
      `Set All Tracks Automation Mode: ${mode[0].toUpperCase()}${mode.slice(1)}`,
      () => s().setTracksAutomationMode(allTracks(), mode),
      {
        shortcutScopes: ["automation", "track_control_panel", "mixer"],
        canHandleShortcut: () => allTracks().length > 0 && canEditAutomationSettings(),
      },
    )),
    automationAction(
      "automation.allTracks.writeOff",
      "Disable Automation Write on All Tracks",
      () => s().setTracksAutomationWrite(allTracks(), false),
      {
        shortcutScopes: ["automation", "track_control_panel", "mixer"],
        canHandleShortcut: () => allTracks().length > 0 && canEditAutomationSettings(),
      },
    ),
    automationAction(
      "automation.allTracks.toggleRead",
      "Toggle Automation Read on All Tracks",
      () => s().toggleTracksAutomationRead(allTracks()),
      {
        shortcutScopes: ["automation", "track_control_panel", "mixer"],
        canHandleShortcut: () => allTracks().length > 0 && canEditAutomationSettings(),
      },
    ),
    ...(["off", "read", "write", "touch", "latch"] as const).map((mode) => automationAction(
      `automation.master.mode.${mode}`,
      `Set Master Automation Mode: ${mode[0].toUpperCase()}${mode.slice(1)}`,
      () => s().setMasterTrackAutomationMode(mode),
      { shortcutScopes: ["automation", "track_control_panel", "mixer"], canHandleShortcut: canEditAutomationSettings },
    )),
    ...(["off", "read", "write", "touch", "latch"] as const).map((mode) => automationAction(
      `automation.selectedLane.mode.${mode}`,
      `Set Selected Automation Lane Mode: ${mode[0].toUpperCase()}${mode.slice(1)}`,
      () => s().setSelectedAutomationLaneMode(mode),
      { canHandleShortcut: canEditSelectedAutomationLane },
    )),
    {
      id: "automation.lane.selectPrevious",
      name: "Select Previous Automation Lane",
      category: "Automation",
      shortcutScope: "automation",
      canHandleShortcut: hasAnyAutomationLane,
      // Lane selection is transient editor context. It belongs to the focused
      // window rather than the main project realm, including detached mixers.
      execute: () => s().selectAdjacentAutomationLane("previous"),
    },
    {
      id: "automation.lane.selectNext",
      name: "Select Next Automation Lane",
      category: "Automation",
      shortcutScope: "automation",
      canHandleShortcut: hasAnyAutomationLane,
      execute: () => s().selectAdjacentAutomationLane("next"),
    },

    automationAction("automation.selectedTracks.show", "Show Selected Track Envelopes", () => {
      s().setTracksAutomationVisibility(selectedTracks(), true);
    }, {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
    }),
    automationAction("automation.selectedTracks.hide", "Hide Selected Track Envelopes", () => {
      s().setTracksAutomationVisibility(selectedTracks(), false);
    }, {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
    }),
    automationAction("automation.selectedTracks.readOn", "Enable Selected Track Automation Read", () => s().setTracksAutomationRead(selectedTracks(), true), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
    }),
    automationAction("automation.selectedTracks.readOff", "Disable Selected Track Automation Read", () => s().setTracksAutomationRead(selectedTracks(), false), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
    }),
    automationAction("automation.selectedTracks.writeOn", "Enable Selected Track Automation Write", () => s().setTracksAutomationWrite(selectedTracks(), true), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
    }),
    automationAction("automation.selectedTracks.writeOff", "Disable Selected Track Automation Write", () => s().setTracksAutomationWrite(selectedTracks(), false), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: () => selectedTracks().length > 0 && canEditAutomationSettings(),
    }),

    automationAction("automation.master.show", "Show Master Envelopes", () => s().showAllActiveMasterEnvelopes(), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: canEditAutomationSettings,
    }),
    automationAction("automation.master.hide", "Hide Master Envelopes", () => s().hideAllMasterEnvelopes(), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: canEditAutomationSettings,
    }),
    automationAction("automation.master.readOn", "Enable Master Automation Read", () => s().setMasterAutomationRead(true), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: canEditAutomationSettings,
    }),
    automationAction("automation.master.readOff", "Disable Master Automation Read", () => s().setMasterAutomationRead(false), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: canEditAutomationSettings,
    }),
    automationAction("automation.master.writeOn", "Enable Master Automation Write", () => s().setMasterAutomationWrite(true), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: canEditAutomationSettings,
    }),
    automationAction("automation.master.writeOff", "Disable Master Automation Write", () => s().setMasterAutomationWrite(false), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: canEditAutomationSettings,
    }),

    automationAction("automation.selectedLane.show", "Show Selected Automation Lane", () => s().setSelectedAutomationLaneVisibility(true), {
      canHandleShortcut: canEditSelectedAutomationLane,
    }),
    automationAction("automation.selectedLane.hide", "Hide Selected Automation Lane", () => s().setSelectedAutomationLaneVisibility(false), {
      canHandleShortcut: canEditSelectedAutomationLane,
    }),
    automationAction("automation.selectedLane.readOn", "Enable Selected Automation Lane Read", () => s().setSelectedAutomationLaneRead(true), {
      canHandleShortcut: canEditSelectedAutomationLane,
    }),
    automationAction("automation.selectedLane.readOff", "Disable Selected Automation Lane Read", () => s().setSelectedAutomationLaneRead(false), {
      canHandleShortcut: canEditSelectedAutomationLane,
    }),
    automationAction("automation.selectedLane.writeOn", "Enable Selected Automation Lane Write", () => s().setSelectedAutomationLaneWrite(true), {
      canHandleShortcut: canEditSelectedAutomationLane,
    }),
    automationAction("automation.selectedLane.writeOff", "Disable Selected Automation Lane Write", () => s().setSelectedAutomationLaneWrite(false), {
      canHandleShortcut: canEditSelectedAutomationLane,
    }),

    automationAction("automation.point.selectNext", "Select Next Automation Point", () => s().selectAdjacentAutomationPoint("next"), {
      shortcut: "Tab",
      canHandleShortcut: hasSelectedAutomationLane,
    }),
    automationAction("automation.point.selectPrevious", "Select Previous Automation Point", () => s().selectAdjacentAutomationPoint("previous"), {
      shortcut: "Shift+Tab",
      canHandleShortcut: hasSelectedAutomationLane,
    }),
    automationAction("automation.point.deleteSelected", "Delete Selected Automation Point", () => s().deleteSelectedAutomationPoint(), {
      shortcut: "Delete",
      shortcutAliases: ["Backspace"],
      canHandleShortcut: canEditSelectedAutomationPoint,
    }),
    automationAction("automation.point.nudgeTimeLeft", "Nudge Automation Point Time Left", () => s().nudgeSelectedAutomationPoint("time", -1), {
      shortcut: "Left",
      canHandleShortcut: canEditSelectedAutomationPoint,
    }),
    automationAction("automation.point.nudgeTimeRight", "Nudge Automation Point Time Right", () => s().nudgeSelectedAutomationPoint("time", 1), {
      shortcut: "Right",
      canHandleShortcut: canEditSelectedAutomationPoint,
    }),
    automationAction("automation.point.nudgeValueUp", "Nudge Automation Point Value Up", () => s().nudgeSelectedAutomationPoint("value", 1), {
      shortcut: "Up",
      canHandleShortcut: canEditSelectedAutomationPoint,
    }),
    automationAction("automation.point.nudgeValueDown", "Nudge Automation Point Value Down", () => s().nudgeSelectedAutomationPoint("value", -1), {
      shortcut: "Down",
      canHandleShortcut: canEditSelectedAutomationPoint,
    }),
    automationAction("automation.point.addAtPlayhead", "Add Automation Point at Playhead", () => s().addAutomationPointAtPlayhead(), {
      shortcut: "Ctrl+Enter",
      canHandleShortcut: canEditSelectedAutomationLane,
    }),
    automationAction("automation.selectedLane.clear", "Clear Selected Automation Lane", () => s().clearSelectedAutomationLane(), {
      shortcut: "Ctrl+Delete",
      canHandleShortcut: canEditSelectedAutomationLane,
    }),
    automationAction("automation.suspend", "Suspend All Automation", () => s().suspendAutomation(), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: hasSuspendableAutomation,
    }),
    automationAction("automation.resume", "Resume Suspended Automation", () => s().resumeAutomation(), {
      shortcutScopes: ["automation", "track_control_panel", "mixer"],
      canHandleShortcut: hasSuspendedAutomation,
    }),
  ];

  const actions: ActionDef[] = [
    // ===== Transport =====
    { id: "transport.play", name: "Play / Pause", category: "Transport", shortcut: "Space", execute: () => s().togglePlayPause() },
    { id: "transport.pause", name: "Pause in Place", category: "Transport", shortcutWhen: "transport_running", execute: () => s().pause() },
    { id: "transport.stop", name: "Stop", category: "Transport", execute: () => s().stop() },
    { id: "transport.record", name: "Record", category: "Transport", shortcut: "Ctrl+R", canHandleShortcut: () => s().transport.isRecording || Boolean(s().recordSession) || s().tracks.some((t) => t.armed), execute: () => s().toggleRecord() },
    { id: "transport.rewind", name: "Go to Start", category: "Transport", shortcut: "Home", execute: () => s().setCurrentTime(0) },
    { id: "transport.loop", name: "Toggle Loop", category: "Transport", shortcut: "L", execute: () => s().toggleLoop() },
    { id: "transport.metronome", name: "Toggle Metronome", category: "Transport", shortcut: "K", execute: () => { void s().toggleMetronome(); } },
    activeScopedComponentAction("transport.metronomeSettings", "Open Metronome Settings", "Transport", "global"),

    // ===== Navigation =====
    { id: "navigate.nextTransient", name: "Next Transient", category: "Navigation", shortcut: "Tab", shortcutScope: "timeline", canHandleShortcut: () => Boolean(selectedTransientAudioClip()), execute: () => {
      const state = s();
      const clip = selectedTransientAudioClip();
      if (!clip?.filePath) return;
      import("../services/NativeBridge").then(({ nativeBridge }) => {
        nativeBridge.detectTransients(clip.filePath!, 0.3, 50).then((transients: number[]) => {
          const currentTime = state.transport.currentTime - clip.startTime + (clip.offset || 0);
          const next = transients.find(t => t > currentTime + 0.01);
          if (next !== undefined) state.setCurrentTime(clip.startTime + next - (clip.offset || 0));
        });
      });
    }},
    { id: "navigate.prevTransient", name: "Previous Transient", category: "Navigation", shortcut: "Shift+Tab", shortcutScope: "timeline", canHandleShortcut: () => Boolean(selectedTransientAudioClip()), execute: () => {
      const state = s();
      const clip = selectedTransientAudioClip();
      if (!clip?.filePath) return;
      import("../services/NativeBridge").then(({ nativeBridge }) => {
        nativeBridge.detectTransients(clip.filePath!, 0.3, 50).then((transients: number[]) => {
          const currentTime = state.transport.currentTime - clip.startTime + (clip.offset || 0);
          const prev = [...transients].reverse().find(t => t < currentTime - 0.01);
          if (prev !== undefined) state.setCurrentTime(clip.startTime + prev - (clip.offset || 0));
        });
      });
    }},
    { id: "navigate.previousGridLine", name: "Move Playhead to Previous Grid Line", category: "Navigation", shortcutScope: "timeline", canHandleShortcut: () => adjacentGridLineTime("previous") !== null, execute: () => {
      const target = adjacentGridLineTime("previous");
      if (target !== null) void s().seekTo(target);
    }},
    { id: "navigate.nextGridLine", name: "Move Playhead to Next Grid Line", category: "Navigation", shortcutScope: "timeline", canHandleShortcut: () => adjacentGridLineTime("next") !== null, execute: () => {
      const target = adjacentGridLineTime("next");
      if (target !== null) void s().seekTo(target);
    }},
    { id: "navigate.previousBoundary", name: "Move Playhead to Previous Marker, Clip, or Selection Boundary", category: "Navigation", shortcutScope: "timeline", canHandleShortcut: () => adjacentTimelineBoundary("previous") !== null, execute: () => {
      const target = adjacentTimelineBoundary("previous");
      if (target !== null) void s().seekTo(target);
    }},
    { id: "navigate.nextBoundary", name: "Move Playhead to Next Marker, Clip, or Selection Boundary", category: "Navigation", shortcutScope: "timeline", canHandleShortcut: () => adjacentTimelineBoundary("next") !== null, execute: () => {
      const target = adjacentTimelineBoundary("next");
      if (target !== null) void s().seekTo(target);
    }},
    { id: "edit.selectClipsInTimeSelection", name: "Select Clips Inside Time Selection", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => Boolean(s().timeSelection), execute: () => {
      const state = s();
      if (!state.timeSelection) return;
      const clipIds = collectClipIdsInsideTimeSelection(state.tracks, state.timeSelection);
      state.deselectAllTracks();
      state.setSelectedClipIds(clipIds);
    }},

    // ===== Tools =====
    { id: "tools.selectTool", name: "Select Tool", category: "Tools", shortcut: "V", shortcutScope: "timeline", execute: () => s().setToolMode("select") },
    { id: "tools.splitTool", name: "Split Tool", category: "Tools", shortcut: "B", shortcutScope: "timeline", execute: () => s().toggleSplitTool() },
    { id: "tools.muteTool", name: "Mute Tool", category: "Tools", shortcut: "X", shortcutScope: "timeline", execute: () => s().toggleMuteTool() },
    { id: "tools.smartTool", name: "Smart Tool", category: "Tools", shortcut: "Y", shortcutScope: "timeline", execute: () => s().setToolMode("smart") },

    // ===== Edit =====
    { id: "edit.undo", name: "Undo", category: "Edit", shortcut: "Ctrl+Z", shortcutScope: "contextual", canHandleShortcut: () => s().canUndo, execute: () => s().undo() },
    { id: "edit.redo", name: "Redo", category: "Edit", shortcut: "Ctrl+Shift+Z", shortcutAliases: ["Ctrl+Y"], shortcutScope: "contextual", canHandleShortcut: () => s().canRedo, execute: () => s().redo() },
    { id: "edit.cut", name: "Cut Selected Clips", category: "Edit", shortcut: "Ctrl+X", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked
        && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.clip.locked);
    }, execute: () => s().cutSelectedClips() },
    { id: "edit.copy", name: "Copy Selected Clips", category: "Edit", shortcut: "Ctrl+C", shortcutScope: "timeline", canHandleShortcut: () => selectedTimelineClips().length > 0, execute: () => s().copySelectedClips() },
    { id: "edit.paste", name: "Paste Clips", category: "Edit", shortcut: "Ctrl+V", shortcutScope: "timeline", canHandleShortcut: canPasteTimelineClips, execute: () => s().pasteClips() },
    { id: "edit.delete", name: "Delete Selected", category: "Edit", shortcut: "Delete", shortcutAliases: ["Backspace"], shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      if (state.razorEdits.length > 0) {
        return canDeleteRazorEditContent(state);
      }
      if (state.selectedClipIds.length > 0 || Boolean(state.selectedClipId)) {
        return !state.globalLocked
          && !state.lockSettings.items
          && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked);
      }
      if (state.timeSelection) return canDeleteWithinTimelineTimeSelection(state);
      if (state.selectedTrackIds.length > 0 || Boolean(state.selectedTrackId)) {
        return !state.globalLocked;
      }
      return false;
    }, execute: () => {
      const state = s();
      if (state.razorEdits.length > 0) state.deleteRazorEditContent();
      else if (state.selectedClipIds.length > 0 || state.selectedClipId) state.deleteSelectedClips();
      else if (state.timeSelection) state.deleteWithinTimeSelection();
      else if (state.selectedTrackIds.length > 0 || state.selectedTrackId) void state.deleteSelectedTracks();
    }},
    { id: "edit.duplicateClips", name: "Duplicate Selected Clips", category: "Edit", shortcut: "Ctrl+D", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked
        && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked);
    }, execute: () => { s().duplicateSelectedClips(); } },
    { id: "edit.selectAllTracks", name: "Select All Tracks", category: "Edit", shortcut: "Ctrl+A", shortcutScope: "timeline", execute: () => s().selectAllTracks() },
    { id: "edit.selectAllClips", name: "Select All Clips", category: "Edit", shortcut: "Ctrl+Shift+A", shortcutScope: "timeline", execute: () => s().selectAllClips() },
    { id: "edit.deselectAll", name: "Deselect All", category: "Edit", shortcut: "Esc", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return state.selectedTrackIds.length > 0
        || Boolean(state.selectedTrackId)
        || state.selectedClipIds.length > 0
        || Boolean(state.selectedClipId)
        || state.selectedNoteIds.length > 0
        || Boolean(state.selectedAutomationTarget)
        || state.selectedRegionIds.length > 0
        || state.razorEdits.length > 0
        || Boolean(state.midiEditRange)
        || state.pianoRollEditCursorTime !== null
        || (state.midiEditorSessions || []).some((session) => (
          session.selectedNoteIds.length > 0
          || Boolean(session.midiEditRange)
          || session.editCursorTime !== null
        ))
        || (Boolean(state.timeSelection)
          && !state.globalLocked
          && !state.lockSettings.timeSelection);
    }, execute: () => s().deselectAll() },
    { id: "edit.splitAtCursor", name: "Split at Playhead", category: "Edit", shortcut: "S", shortcutScope: "timeline", canHandleShortcut: canSplitAtCurrentTime, execute: () => s().splitClipAtPlayhead() },
    { id: "edit.splitAtSelection", name: "Split at Time Selection", category: "Edit", shortcutScope: "timeline", canHandleShortcut: canSplitAtTimeSelection, execute: () => s().splitAtTimeSelection() },
    { id: "edit.groupClips", name: "Group Selected Clips", category: "Edit", shortcut: "Ctrl+G", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked
        && !state.lockSettings.items
        && selectedTimelineClips().filter((entry) => !entry.track.frozen && !entry.clip.locked).length >= 2;
    }, execute: () => { s().groupSelectedClips(); } },
    { id: "edit.ungroupClips", name: "Ungroup Selected Clips", category: "Edit", shortcut: "Ctrl+Shift+G", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked
        && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => (
          !entry.track.frozen && !entry.clip.locked && Boolean(entry.clip.groupId)
        ));
    }, execute: () => { s().ungroupSelectedClips(); } },
    { id: "edit.normalizeClips", name: "Normalize Selected Clips", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && selectedTimelineClips().some((entry) => (
      entry.kind === "audio"
      && !entry.track.frozen
      && !entry.clip.locked
      && typeof entry.clip.filePath === "string"
      && entry.clip.filePath.trim().length > 0
      && Number.isFinite(entry.clip.offset)
      && entry.clip.offset >= 0
      && Number.isFinite(entry.clip.duration)
      && entry.clip.duration > 0
      && Number.isFinite(entry.clip.volumeDB)
      && entry.clip.importStatus !== "failed"
      && entry.clip.importStatus !== "probing"
      && entry.clip.importStatus !== "preparingPlayback"
    ));
    }, execute: () => { void s().normalizeSelectedClips(); } },
    { id: "edit.deleteRazorContent", name: "Delete Razor Edit Content", category: "Edit", execute: () => s().deleteRazorEditContent() },
    { id: "edit.clearRazorEdits", name: "Clear Razor Edits", category: "Edit", execute: () => s().clearRazorEdits() },
    { id: "edit.muteClips", name: "Toggle Clip Mute", category: "Edit", shortcut: "U", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked);
    }, execute: () => { s().toggleSelectedClipsMuted(); } },
    { id: "edit.muteSelectedClips", name: "Mute Selected Clips", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked && !entry.clip.muted);
    }, execute: () => { s().setSelectedClipsMuted(true); } },
    { id: "edit.unmuteSelectedClips", name: "Unmute Selected Clips", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked && !!entry.clip.muted);
    }, execute: () => { s().setSelectedClipsMuted(false); } },
    { id: "edit.selectPreviousClip", name: "Select Previous Clip", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => canSelectAdjacentClip("previous"), execute: () => { s().selectAdjacentClip("previous"); } },
    { id: "edit.selectNextClip", name: "Select Next Clip", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => canSelectAdjacentClip("next"), execute: () => { s().selectAdjacentClip("next"); } },
    { id: "edit.nudgeLeft", name: "Nudge Clips Left", category: "Edit", shortcut: "Left", shortcutScope: "timeline", canHandleShortcut: () => canNudgeSelectedClips("left"), execute: () => s().nudgeClips("left") },
    { id: "edit.nudgeRight", name: "Nudge Clips Right", category: "Edit", shortcut: "Right", shortcutScope: "timeline", canHandleShortcut: () => canNudgeSelectedClips("right"), execute: () => s().nudgeClips("right") },
    { id: "edit.nudgeLeftFine", name: "Nudge Clips Left (Fine)", category: "Edit", shortcut: "Ctrl+Left", shortcutScope: "timeline", canHandleShortcut: () => canNudgeSelectedClips("left", true), execute: () => s().nudgeClips("left", true) },
    { id: "edit.nudgeRightFine", name: "Nudge Clips Right (Fine)", category: "Edit", shortcut: "Ctrl+Right", shortcutScope: "timeline", canHandleShortcut: () => canNudgeSelectedClips("right", true), execute: () => s().nudgeClips("right", true) },

    // ===== Insert =====
    { id: "insert.audioTrack", name: "New Audio Track", category: "Insert", shortcut: "Ctrl+T", canHandleShortcut: () => !s().globalLocked, execute: () => {
      const state = s();
      state.addTrack({ id: crypto.randomUUID(), name: `Audio ${state.tracks.length + 1}`, type: "audio" });
    }},
    { id: "insert.midiTrack", name: "New MIDI Track", category: "Insert", shortcut: "Ctrl+Shift+T", canHandleShortcut: () => !s().globalLocked, execute: () => {
      const state = s();
      state.addTrack({ id: crypto.randomUUID(), name: `MIDI ${state.tracks.length + 1}`, type: "midi" });
    }},
    { id: "insert.instrumentTrack", name: "Virtual Instrument on New Track", category: "Insert", canHandleShortcut: () => !s().globalLocked, execute: () => {
      void createTrackOfType("instrument", { openInstrumentBrowser: true });
    }},
    { id: "insert.aiTrack", name: "Insert AI Track", category: "Insert", shortcut: "Ctrl+Alt+T", canHandleShortcut: () => !s().globalLocked, execute: () => {
      void createTrackOfType("ai");
    }},
    { id: "insert.quickAddInstrument", name: "Quick Add Instrument Track", category: "Insert", shortcut: "Ctrl+Shift+I", canHandleShortcut: () => !s().globalLocked, execute: () => {
      void createTrackOfType("instrument", { openInstrumentBrowser: true });
    }},
    { id: "insert.folderTrack", name: "New Folder Track", category: "Insert", canHandleShortcut: () => !s().globalLocked, execute: () => {
      const state = s();
      state.createFolderTrack(`Folder ${state.tracks.filter((t: any) => t.isFolder).length + 1}`);
    }},
    { id: "insert.multipleTracks", name: "Insert Multiple Tracks...", category: "Insert", canHandleShortcut: () => !s().globalLocked, execute: () => {
      const countInput = prompt("How many tracks to insert?", "4");
      if (countInput === null) return;
      const count = Math.min(100, Math.max(1, Math.floor(Number(countInput) || 1)));
      const typeInput = prompt("Track type? (audio / midi)", "audio");
      if (typeInput === null) return;
      const trackType = typeInput.trim().toLowerCase() === "midi" ? "midi" : "audio";
      const state = s();
      const startingCount = state.tracks.length;
      void state.addTracksBatch(Array.from({ length: count }, (_, index) => ({
          id: crypto.randomUUID(),
          name: `${trackType === "midi" ? "MIDI" : "Audio"} ${startingCount + index + 1}`,
          type: trackType,
      })));
    }},
    { id: "insert.emptyMidiClip", name: "Insert Empty MIDI Clip", category: "Insert", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && state.tracks.some((track) => (
        !track.frozen && (track.type === "midi" || track.type === "instrument")
      ));
    }, execute: () => {
      const state = s();
      if (state.globalLocked || state.lockSettings.items) return;
      const track = state.tracks.find((candidate) => (
        state.selectedTrackIds.includes(candidate.id)
        && !candidate.frozen
        && (candidate.type === "midi" || candidate.type === "instrument")
      )) || state.tracks.find((candidate) => (
        !candidate.frozen && (candidate.type === "midi" || candidate.type === "instrument")
      ));
      if (!track) return;

      const before = [...track.midiClips];
      const clipId = crypto.randomUUID();
      const clip = {
        id: clipId,
        name: `MIDI Clip ${track.midiClips.length + 1}`,
        startTime: Math.max(0, Number.isFinite(state.transport.currentTime) ? state.transport.currentTime : 0),
        duration: 4,
        offset: 0,
        sourceStart: 0,
        sourceLength: 4,
        loopEnabled: true,
        loopOffset: 0,
        loopLength: 4,
        events: [],
        ccEvents: [],
        color: track.color || "#4361ee",
      };
      const after = [...before, clip];
      const apply = (midiClips: typeof before) => {
        const current = s();
        current.updateTrack(track.id, { midiClips });
        void current.syncMIDITrackToBackend(track.id, { debounce: false });
      };
      state.executeCommand({
        type: "INSERT_EMPTY_MIDI_CLIP",
        description: "Insert empty MIDI clip",
        timestamp: Date.now(),
        execute: () => apply(after),
        undo: () => apply(before),
      });
    }},
    { id: "insert.marker", name: "Add Marker at Playhead", category: "Insert", shortcut: "M", canHandleShortcut: () => !s().globalLocked && !s().lockSettings.markers && Number.isFinite(s().transport.currentTime), execute: () => s().addMarker(s().transport.currentTime) },
    { id: "insert.markerNamed", name: "Add Named Marker", category: "Insert", shortcut: "Shift+M", canHandleShortcut: () => !s().globalLocked && !s().lockSettings.markers && Number.isFinite(s().transport.currentTime), execute: () => {
      const name = prompt("Enter marker name:");
      if (name?.trim()) s().addMarker(s().transport.currentTime, name.trim());
    }},
    { id: "insert.regionFromSelection", name: "Region from Selection", category: "Insert", shortcut: "Shift+R", canHandleShortcut: () => {
      const selection = s().timeSelection;
      return Boolean(
        !s().globalLocked
        && !s().lockSettings.markers
        && selection
        && Number.isFinite(selection.start)
        && Number.isFinite(selection.end)
        && Math.abs(selection.end - selection.start) > 0.000001
      );
    }, execute: () => {
      const state = s();
      if (state.timeSelection) state.addRegion(state.timeSelection.start, state.timeSelection.end);
    }},
    { id: "insert.mediaFile", name: "Import Media File", category: "Insert", shortcut: "Insert", execute: () => {
      const state = s();
      void (async () => {
        const filePath = await nativeBridge.showOpenDialog("Import Audio/Video File");
        if (!filePath) return;

        let targetTrackId = state.selectedTrackIds[0];
        if (!targetTrackId) {
          const firstAudioTrack = state.tracks.find((t) => t.type === "audio");
          if (!firstAudioTrack) {
            alert("No audio track available. Please create an audio track first.");
            return;
          }
          targetTrackId = firstAudioTrack.id;
        }

        try {
          await state.importMedia(filePath, targetTrackId, state.transport.currentTime);
        } catch (error) {
          alert(`Failed to import media: ${error}`);
        }
      })();
    }},

    // ===== View =====
    { id: "view.toggleMixer", name: "Toggle Mixer", category: "View", shortcut: "Ctrl+M", execute: () => s().toggleMixer() },
    { id: "view.togglePianoRoll", name: "Toggle Piano Roll", category: "View", canHandleShortcut: () => hasActiveScopedActionExecutor("view.togglePianoRoll") || s().showPianoRoll || selectedTimelineClips().some((entry) => entry.kind === "midi"), execute: () => {
      if (executeActiveScopedAction("view.togglePianoRoll") !== "unmatched") return;
      const state = s();
      if (state.showPianoRoll) {
        state.closePianoRoll();
        return;
      }
      const entry = selectedTimelineClips().find((candidate) => candidate.kind === "midi");
      if (entry) state.openPianoRoll(entry.track.id, entry.clip.id);
    }},
    { id: "view.toggleMasterTrackTCP", name: "Toggle Master Track in TCP", category: "View", execute: () => s().toggleMasterTrackInTCP() },
    { id: "view.toggleSnap", name: "Toggle Snap", category: "View", execute: () => s().toggleSnap() },
    ...GRID_TYPE_MODE_OPTIONS.map((option): ActionDef => ({
      id: `view.gridType.${option.value.replace(/_/g, "-")}`,
      name: `Grid Type: ${option.label}`,
      category: "View",
      shortcutScope: "timeline",
      shortcutScopes: ["timeline", "piano_roll", "pitch_editor"],
      execute: () => s().setGridSize(option.value as GridSize),
    })),
    { id: "view.toggleAutoCrossfade", name: "Toggle Auto-Crossfade", category: "View", execute: () => s().toggleAutoCrossfade() },
    { id: "view.toggleVirtualKeyboard", name: "Toggle Virtual MIDI Keyboard", category: "View", shortcut: "Alt+B", execute: () => s().toggleVirtualKeyboard() },
    { id: "view.toggleUndoHistory", name: "Toggle Undo History", category: "View", shortcut: "Ctrl+Alt+Z", execute: () => s().toggleUndoHistory() },
    { id: "view.cycleTimecodeMode", name: "Cycle Main Time Display Format", category: "View", execute: () => {
      const state = s();
      const modes = ["time", "beats", "smpte"] as const;
      const currentIndex = modes.indexOf(state.timecodeMode);
      state.setTimecodeMode(modes[(currentIndex + 1) % modes.length]);
    }},
    activeScopedComponentAction("view.openGridQuantizePanel", "Open Grid, Snap, and Quantize Panel", "View", "global"),
    activeScopedComponentAction("edit.applyCurrentQuantize", "Apply Current Quantize Preset", "Edit", "global"),

    // ===== File =====
    { id: "file.new", name: "New Project", category: "File", shortcut: "Ctrl+N", execute: () => { void s().requestNewProject(); } },
    { id: "file.save", name: "Save Project", category: "File", shortcut: "Ctrl+S", execute: () => s().saveProject() },
    { id: "file.saveAs", name: "Save Project As...", category: "File", shortcut: "Ctrl+Shift+S", execute: () => s().saveProject(true) },
    { id: "file.open", name: "Open Project", category: "File", shortcut: "Ctrl+O", execute: () => { void s().requestOpenProject(); } },
    { id: "file.closeProject", name: "Close Project", category: "File", shortcut: "Ctrl+F4", execute: () => { void s().requestCloseProject(); }},
    { id: "file.projectSettings", name: "Project Settings", category: "File", shortcut: "Alt+Enter", execute: () => s().openProjectSettings() },
    { id: "file.render", name: "Render / Export", category: "File", shortcut: "Ctrl+Alt+R", execute: () => s().openRenderModal() },
    { id: "file.quit", name: "Quit", category: "File", shortcut: "Ctrl+Q", execute: () => { void s().requestQuit(); } },
    { id: "file.settings", name: "Audio Settings", category: "File", execute: () => s().openSettings() },
    { id: "project.compare", name: "Compare with Saved Version", category: "File", execute: () => { void s().compareWithSavedProject(); } },
    { id: "file.saveNewVersion", name: "Save New Version", category: "File", execute: () => { void s().saveNewVersion(); } },
    { id: "file.openRecent", name: "Open Recent Project...", category: "File", canHandleShortcut: () => s().recentProjects.length > 0, execute: () => {
      const state = s();
      const projectPath = chooseByNumber("Open recent project (enter number):", state.recentProjects, (path) => path.split(/[/\\]/).pop() || path);
      if (projectPath) void state.requestOpenProject(projectPath);
    }},
    { id: "file.clearRecentProjects", name: "Clear Recent Projects", category: "File", canHandleShortcut: () => s().recentProjects.length > 0, execute: () => s().clearRecentProjects() },
    { id: "file.loadTemplate", name: "New Project from Template...", category: "File", canHandleShortcut: () => s().projectTemplates.length > 0, execute: () => {
      const state = s();
      const choice = chooseByNumber("Choose project template (enter number):", state.projectTemplates.map((template, index) => ({ template, index })), ({ template }) => template.name);
      if (choice) void state.requestLoadTemplate(choice.index);
    }},
    { id: "file.deleteTemplate", name: "Delete Project Template...", category: "File", canHandleShortcut: () => s().projectTemplates.length > 0, execute: () => {
      const state = s();
      const choice = chooseByNumber("Delete project template (enter number):", state.projectTemplates.map((template, index) => ({ template, index })), ({ template }) => template.name);
      if (choice && confirm(`Delete template "${choice.template.name}"?`)) state.deleteTemplate(choice.index);
    }},

    // ===== Options =====
    { id: "options.tapTempo", name: "Tap Tempo", category: "Options", shortcut: "T", execute: () => s().tapTempo() },
    { id: "view.regionMarkerManager", name: "Toggle Region/Marker Manager", category: "View", execute: () => s().toggleRegionMarkerManager() },
    { id: "view.clipProperties", name: "Toggle Clip Properties", category: "View", shortcut: "F2", execute: () => s().toggleClipProperties() },
    { id: "edit.toggleClipLock", name: "Toggle Clip Lock", category: "Edit", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked
        && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen);
    }, execute: () => { s().toggleSelectedClipsLocked(); } },
    { id: "edit.cutWithinSelection", name: "Cut within Time Selection", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => canCutWithinTimelineTimeSelection(s()), execute: () => s().cutWithinTimeSelection() },
    { id: "edit.copyWithinSelection", name: "Copy within Time Selection", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => canCopyWithinTimelineTimeSelection(s()), execute: () => s().copyWithinTimeSelection() },
    { id: "edit.deleteWithinSelection", name: "Delete within Time Selection (Ripple)", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => canDeleteWithinTimelineTimeSelection(s()), execute: () => s().deleteWithinTimeSelection() },
    { id: "edit.insertSilence", name: "Insert Silence", category: "Edit", shortcutScope: "timeline", canHandleShortcut: () => canInsertSilenceAtTimelineTimeSelection(s()), execute: () => s().insertSilenceAtTimeSelection() },
    { id: "view.bigClock", name: "Toggle Big Clock", category: "View", execute: () => s().toggleBigClock() },
    { id: "view.bigClockFormat", name: "Toggle Big Clock Format", category: "View", execute: () => s().toggleBigClockFormat() },
    { id: "view.keyboardShortcuts", name: "Keyboard Shortcuts", category: "View", execute: () => s().toggleKeyboardShortcuts() },
    { id: "help.contextualHelp", name: "Help Reference", category: "Help", shortcut: "F1", execute: () => s().toggleContextualHelp() },
    { id: "help.gettingStarted", name: "Getting Started Guide", category: "Help", execute: () => s().toggleGettingStarted() },
    { id: "help.checkForUpdates", name: "Check for Updates...", category: "Help", execute: checkForUpdates },
    { id: "help.about", name: "About OpenStudio", category: "Help", execute: showAbout },
    { id: "view.commandPalette", name: "Command Palette", category: "View", shortcut: "Ctrl+Shift+P", execute: () => s().toggleCommandPalette() },
    { id: "view.renderQueue", name: "Toggle Render Queue", category: "View", execute: () => s().toggleRenderQueue() },
    { id: "view.clipLauncher", name: "Toggle Clip Launcher", category: "View", execute: () => s().toggleClipLauncher() },
    { id: "view.stepSequencer", name: "Toggle Step Sequencer", category: "View", execute: () => s().toggleStepSequencer() },
    { id: "view.scriptConsole", name: "Toggle Script Console", category: "View", execute: () => s().toggleScriptConsole() },
    { id: "view.aiToolsSetup", name: "Open AI Tools Setup", category: "View", execute: () => s().openAiToolsSetup() },
    { id: "view.customToolbar", name: "Toggle Custom Toolbar...", category: "View", canHandleShortcut: () => s().customToolbars.length > 0, execute: () => {
      const state = s();
      const toolbar = chooseByNumber("Choose custom toolbar (enter number):", state.customToolbars, (item) => item.name);
      if (toolbar) state.toggleToolbarVisibility(toolbar.id);
    }},
    { id: "options.preferences", name: "Preferences", category: "Options", shortcut: "Ctrl+,", execute: () => s().togglePreferences() },
    { id: "options.timecodeSettings", name: "Timecode / Sync Settings", category: "Options", execute: () => s().toggleTimecodeSettings() },
    { id: "options.saveQuantizePreset", name: "Save Current Quantize Preset...", category: "Options", execute: () => {
      const state = s();
      const preset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
      const name = prompt("Quantize preset name:", preset.name);
      if (name?.trim()) state.saveQuantizePreset(name.trim(), preset);
    }},
    { id: "options.renameQuantizePreset", name: "Rename Current Quantize Preset...", category: "Options", canHandleShortcut: () => {
      const state = s();
      return !getQuantizePresetById(state.quantizePresets, state.quantizePresetId).isFactory;
    }, execute: () => {
      const state = s();
      const preset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
      if (preset.isFactory) return;
      const name = prompt("Rename quantize preset:", preset.name);
      if (name?.trim()) state.renameQuantizePreset(preset.id, name.trim());
    }},
    { id: "options.removeQuantizePreset", name: "Remove Current Quantize Preset", category: "Options", canHandleShortcut: () => {
      const state = s();
      return !getQuantizePresetById(state.quantizePresets, state.quantizePresetId).isFactory;
    }, execute: () => {
      const state = s();
      const preset = getQuantizePresetById(state.quantizePresets, state.quantizePresetId);
      if (!preset.isFactory && confirm(`Remove quantize preset "${preset.name}"?`)) {
        state.removeQuantizePreset(preset.id);
      }
    }},
    { id: "options.restoreFactoryQuantizePresets", name: "Restore Factory Quantize Presets", category: "Options", execute: () => s().restoreFactoryQuantizePresets() },
    { id: "options.toggleItemLock", name: "Toggle Item Locking", category: "Options", execute: () => { const state = s(); state.setLockSetting("items", !state.lockSettings.items); } },
    { id: "options.toggleEnvelopeLock", name: "Toggle Envelope Locking", category: "Options", execute: () => { const state = s(); state.setLockSetting("envelopes", !state.lockSettings.envelopes); } },
    { id: "options.toggleTimeSelectionLock", name: "Toggle Time Selection Locking", category: "Options", execute: () => { const state = s(); state.setLockSetting("timeSelection", !state.lockSettings.timeSelection); } },
    { id: "options.recordNormal", name: "Record Mode: Normal", category: "Options", execute: () => s().setRecordMode("normal") },
    { id: "options.recordOverdub", name: "Record Mode: Overdub", category: "Options", execute: () => s().setRecordMode("overdub") },
    { id: "options.recordReplace", name: "Record Mode: Replace", category: "Options", execute: () => s().setRecordMode("replace") },
    { id: "midi.panic", name: "MIDI Panic", category: "Options", shortcut: "Ctrl+Alt+P", execute: () => { void nativeBridge.panicMIDI(); } },
    { id: "options.rippleOff", name: "Ripple Editing: Off", category: "Options", execute: () => s().setRippleMode("off") },
    { id: "options.ripplePerTrack", name: "Ripple Editing: Per Track", category: "Options", execute: () => s().setRippleMode("per_track") },
    { id: "options.rippleAllTracks", name: "Ripple Editing: All Tracks", category: "Options", execute: () => s().setRippleMode("all_tracks") },
    { id: "midi.quantizeLast", name: "MIDI Quantize Using Last Settings", category: "Edit", shortcut: "Q", shortcutScope: "piano_roll", canHandleShortcut: canQuantizeActiveMIDINotes, execute: () => s().quantizeSelectedMIDINotesUsingLast() },
    activeEditorAction("midi.closeEditor", "Close Piano Roll", "MIDI", "Esc", "piano_roll"),
    activeEditorAction("midi.tool.draw", "Piano Roll: Draw Tool", "MIDI Tools", "D", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.select", "Piano Roll: Select Tool", "MIDI Tools", "V", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.erase", "Piano Roll: Erase Tool", "MIDI Tools", "E", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.trim", "Piano Roll: Trim Tool", "MIDI Tools", "T", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.split", "Piano Roll: Split Tool", "MIDI Tools", "B", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.glue", "Piano Roll: Glue Tool", "MIDI Tools", "G", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.mute", "Piano Roll: Mute Tool", "MIDI Tools", "M", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.velocity", "Piano Roll: Velocity Tool", "MIDI Tools", "Y", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.line", "Piano Roll: Line Tool", "MIDI Tools", "L", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.zoom", "Piano Roll: Zoom Tool", "MIDI Tools", "Z", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.pan", "Piano Roll: Pan Tool", "MIDI Tools", "H", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.tool.range", "Piano Roll: Range Tool", "MIDI Tools", "R", "piano_roll", undefined, "step_input_disabled"),
    activeEditorAction("midi.repeatSelection", "Repeat MIDI Selection or Range", "MIDI", "Shift+R", "piano_roll"),
    activeEditorAction("midi.copySelection", "Copy MIDI Selection or Range", "MIDI", "Ctrl+C", "piano_roll"),
    activeEditorAction("midi.cutSelection", "Cut MIDI Selection or Range", "MIDI", "Ctrl+X", "piano_roll"),
    activeEditorAction("midi.pasteSelection", "Paste MIDI Notes or Range", "MIDI", "Ctrl+V", "piano_roll"),
    activeEditorAction("midi.duplicateSelection", "Duplicate MIDI Selection or Range", "MIDI", "Ctrl+D", "piano_roll"),
    activeEditorAction("midi.deleteSelection", "Delete MIDI Selection or Range", "MIDI", "Delete", "piano_roll", ["Backspace"]),
    activeEditorAction("midi.moveLeft", "Move Notes or Step Cursor Left", "MIDI", "Left", "piano_roll"),
    activeEditorAction("midi.moveRight", "Move Notes or Step Cursor Right", "MIDI", "Right", "piano_roll"),
    activeEditorAction("midi.movePitchUp", "Move Notes or Step Octave Up", "MIDI", "Up", "piano_roll"),
    activeEditorAction("midi.movePitchDown", "Move Notes or Step Octave Down", "MIDI", "Down", "piano_roll"),
    activeEditorAction("midi.moveLeftFine", "Move Notes Left by Step Size", "MIDI", "Shift+Left", "piano_roll"),
    activeEditorAction("midi.moveRightFine", "Move Notes Right by Step Size", "MIDI", "Shift+Right", "piano_roll"),
    activeEditorAction("midi.movePitchOctaveUp", "Move Notes Up One Octave", "MIDI", "Shift+Up", "piano_roll"),
    activeEditorAction("midi.movePitchOctaveDown", "Move Notes Down One Octave", "MIDI", "Shift+Down", "piano_roll"),
    activeEditorAction("midi.stepInputC", "Step Input: C", "MIDI Step Input", "C", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputD", "Step Input: D", "MIDI Step Input", "D", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputE", "Step Input: E", "MIDI Step Input", "E", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputF", "Step Input: F", "MIDI Step Input", "F", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputG", "Step Input: G", "MIDI Step Input", "G", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputA", "Step Input: A", "MIDI Step Input", "A", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputB", "Step Input: B", "MIDI Step Input", "B", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputCSharp", "Step Input: C Sharp", "MIDI Step Input", "Shift+C", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputDSharp", "Step Input: D Sharp", "MIDI Step Input", "Shift+D", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputESharp", "Step Input: E Sharp", "MIDI Step Input", "Shift+E", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputFSharp", "Step Input: F Sharp", "MIDI Step Input", "Shift+F", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputGSharp", "Step Input: G Sharp", "MIDI Step Input", "Shift+G", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputASharp", "Step Input: A Sharp", "MIDI Step Input", "Shift+A", "piano_roll", undefined, "step_input_enabled"),
    activeEditorAction("midi.stepInputBSharp", "Step Input: B Sharp", "MIDI Step Input", "Shift+B", "piano_roll", undefined, "step_input_enabled"),
    { id: "midi.resetQuantize", name: "Reset MIDI Quantize", category: "Edit", execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.resetMIDIQuantize(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.freezeQuantize", name: "Freeze MIDI Quantize", category: "Edit", execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.freezeMIDIQuantize(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.toggleStepInput", name: "Toggle Step Input", category: "MIDI", shortcutScope: "piano_roll", execute: () => s().toggleStepInput() },
    { id: "midi.toggleAudition", name: "Toggle MIDI Note Audition", category: "MIDI", shortcutScope: "piano_roll", execute: () => { const state = s(); state.setPianoRollAuditionEnabled(!state.pianoRollAuditionEnabled); } },
    { id: "midi.detachEditor", name: "Detach Piano Roll", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().activeMidiEditorSessionId), execute: () => { const state = s(); if (state.activeMidiEditorSessionId) state.popOutMidiEditorSession(state.activeMidiEditorSessionId); } },
    { id: "midi.dockEditor", name: "Dock Piano Roll", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().activeMidiEditorSessionId), execute: () => { const state = s(); if (state.activeMidiEditorSessionId) state.dockMidiEditorSession(state.activeMidiEditorSessionId); } },
    { id: "midi.invertSelection", name: "Invert MIDI Note Selection", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollClipId), execute: () => { const state = s(); if (state.pianoRollClipId) state.invertMIDISelection(state.pianoRollClipId); } },
    { id: "midi.selectSamePitch", name: "Select Notes with Same Pitch", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollClipId) state.selectMIDINotesByPitch(state.pianoRollClipId); } },
    { id: "midi.humanizeSelected", name: "Humanize Selected Notes", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.humanizeSelectedMIDINotes(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.setSelectedVelocity", name: "Set Selected Note Velocity...", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => {
      const state = s();
      if (!state.pianoRollTrackId || !state.pianoRollClipId) return;
      const input = prompt("Velocity (1-127):", String(state.pianoRollInsertVelocity || 80));
      if (input === null) return;
      const velocity = Math.max(1, Math.min(127, Math.round(Number(input) || 0)));
      state.setSelectedMIDINoteVelocity(state.pianoRollTrackId, state.pianoRollClipId, velocity);
    }},
    { id: "midi.randomizeSelectedVelocity", name: "Randomize Selected Note Velocity...", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => {
      const state = s();
      if (!state.pianoRollTrackId || !state.pianoRollClipId) return;
      const input = prompt("Velocity randomization amount (0-127):", "10");
      if (input === null) return;
      const amount = Math.max(0, Math.min(127, Math.round(Number(input) || 0)));
      state.randomizeSelectedMIDINoteVelocity(state.pianoRollTrackId, state.pianoRollClipId, amount);
    }},
    { id: "midi.setSelectedLength", name: "Set Selected Note Length...", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => {
      const state = s();
      if (!state.pianoRollTrackId || !state.pianoRollClipId) return;
      const input = prompt("Note length in seconds:", String(state.stepInputSize || 0.5));
      if (input === null) return;
      const duration = Number(input);
      if (Number.isFinite(duration) && duration > 0) state.setSelectedMIDINoteLength(state.pianoRollTrackId, state.pianoRollClipId, duration);
    }},
    { id: "midi.legatoSelected", name: "Make Selected Notes Legato", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.legatoSelectedMIDINotes(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.reverseSelected", name: "Reverse Selected Notes", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.reverseSelectedMIDINotes(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.invertSelectedPitches", name: "Invert Selected Note Pitches", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.invertSelectedMIDINotePitches(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.mirrorSelectedPitches", name: "Mirror Selected Note Pitches", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.mirrorSelectedMIDINotePitches(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.toggleSelectedMute", name: "Mute / Unmute Selected Notes", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.toggleSelectedMIDINoteMute(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.cropClipToSelected", name: "Crop MIDI Clip to Selected Notes", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId && s().selectedNoteIds.length > 0), execute: () => { const state = s(); if (state.pianoRollTrackId && state.pianoRollClipId) state.cropMIDIClipToSelectedNotes(state.pianoRollTrackId, state.pianoRollClipId); } },
    { id: "midi.insertChord", name: "Insert MIDI Chord...", category: "MIDI", shortcutScope: "piano_roll", canHandleShortcut: () => Boolean(s().pianoRollTrackId && s().pianoRollClipId), execute: () => {
      const state = s();
      if (!state.pianoRollTrackId || !state.pianoRollClipId) return;
      const rootInput = prompt("Root MIDI note (0-127):", "60");
      if (rootInput === null) return;
      const rootNote = Math.max(0, Math.min(127, Math.round(Number(rootInput) || 60)));
      const chordInput = prompt("Chord type (major / minor / power / diatonic):", "major");
      if (chordInput === null) return;
      const chordType = (["major", "minor", "power", "diatonic"] as const).includes(chordInput as "major")
        ? chordInput as "major" | "minor" | "power" | "diatonic"
        : "major";
      const noteIds = state.insertMIDIChord(
        state.pianoRollTrackId,
        state.pianoRollClipId,
        state.pianoRollEditCursorTime ?? state.stepInputPosition ?? 0,
        rootNote,
        chordType,
      );
      if (noteIds.length > 0) state.setSelectedNoteIds(noteIds);
    }},

    // ===== New Phase 8 Actions =====
    { id: "file.openSafeMode", name: "Open Project (Safe Mode)", category: "File", shortcut: "Ctrl+Shift+O", execute: () => { void s().requestOpenProject(undefined, { bypassFX: true }); } },
    { id: "insert.emptyItem", name: "Insert Empty Item", category: "Insert", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && state.tracks.some((track) => (
        track.type === "audio" && !track.frozen
      ));
    }, execute: () => {
      const state = s();
      if (state.globalLocked || state.lockSettings.items) return;
      const trackId = state.tracks.find((track) => (
        state.selectedTrackIds.includes(track.id) && track.type === "audio" && !track.frozen
      ))?.id || state.tracks.find((track) => track.type === "audio" && !track.frozen)?.id;
      if (trackId) state.addEmptyClip(trackId, state.transport.currentTime, 4);
    }},
    { id: "insert.trackSpacer", name: "Insert Track Spacer Below", category: "Insert", execute: () => {
      const state = s();
      const trackId = state.selectedTrackIds[0] || state.tracks[state.tracks.length - 1]?.id;
      if (trackId) state.addSpacer(trackId);
    }},
    { id: "options.toggleGlobalLock", name: "Toggle Global Lock", category: "Options", execute: () => s().toggleGlobalLock() },
    { id: "options.moveEnvelopesWithItems", name: "Toggle Move Envelopes with Items", category: "Options", execute: () => s().toggleMoveEnvelopesWithItems() },
    { id: "edit.quantizeToGrid", name: "Quantize Selected Clips to Grid", category: "Edit", shortcutScope: "timeline", canHandleShortcut: canQuantizeSelectedTimelineClips, execute: () => { s().quantizeSelectedClips(); } },
    { id: "view.saveScreenset1", name: "Save Screenset 1", category: "View", shortcut: "Ctrl+Shift+1", execute: () => s().saveScreenset(0) },
    { id: "view.saveScreenset2", name: "Save Screenset 2", category: "View", shortcut: "Ctrl+Shift+2", execute: () => s().saveScreenset(1) },
    { id: "view.saveScreenset3", name: "Save Screenset 3", category: "View", shortcut: "Ctrl+Shift+3", execute: () => s().saveScreenset(2) },
    { id: "view.loadScreenset1", name: "Load Screenset 1", category: "View", shortcut: "Ctrl+1", execute: () => s().loadScreenset(0) },
    { id: "view.loadScreenset2", name: "Load Screenset 2", category: "View", shortcut: "Ctrl+2", execute: () => s().loadScreenset(1) },
    { id: "view.loadScreenset3", name: "Load Screenset 3", category: "View", shortcut: "Ctrl+3", execute: () => s().loadScreenset(2) },

    // ===== Phase 9: Audio Engine =====
    {
      id: "edit.reverseClip",
      name: "Reverse Selected Audio Clip",
      category: "Edit",
      shortcutScope: "timeline",
      canHandleShortcut: () => {
        const state = s();
        const entries = selectedTimelineClips();
        return !state.globalLocked
          && !state.lockSettings.items
          && entries.length === 1
          && entries[0].kind === "audio"
          && !entries[0].track.frozen
          && !entries[0].clip.locked
          && Boolean(entries[0].clip.filePath);
      },
      execute: () => {
        const entry = selectedTimelineClips()[0];
        if (entry?.kind === "audio") void s().reverseClip(entry.clip.id);
      },
    },
    { id: "edit.dynamicSplit", name: "Dynamic Split...", category: "Edit", execute: () => s().openDynamicSplit() },
    { id: "options.resetMetronomeSounds", name: "Reset Metronome Sounds", category: "Options", execute: () => { void s().resetMetronomeSounds(); } },

    // ===== Phase 10: Render Pipeline =====
    { id: "file.regionRenderMatrix", name: "Region Render Matrix...", category: "File", execute: () => s().toggleRegionRenderMatrix() },

    // ===== Phase 11: Routing & Mixing =====
    { id: "view.routingMatrix", name: "Routing Matrix", category: "View", execute: () => s().toggleRoutingMatrix() },

    // ===== Phase 12: Media & File Management =====
    { id: "view.mediaExplorer", name: "Toggle Media Explorer", category: "View", execute: () => s().toggleMediaExplorer() },
    { id: "file.cleanProject", name: "Clean Project Directory...", category: "File", execute: () => s().toggleCleanProject() },
    { id: "file.exportMIDI", name: "Export Project MIDI...", category: "File", execute: () => { void s().exportProjectMIDI(); } },
    { id: "file.batchConverter", name: "Batch File Converter...", category: "File", execute: () => s().toggleBatchConverter() },

    // ===== Phase 13: Advanced Editing =====
    {
      id: "edit.explodeTakes",
      name: "Explode Takes to New Tracks",
      category: "Edit",
      shortcutScope: "timeline",
      canHandleShortcut: () => {
        const state = s();
        const ids = state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [];
        return ids.length === 1 && canExplodeClipTakes(state, ids[0]);
      },
      execute: () => {
        const state = s();
        const ids = state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [];
        if (ids.length === 1) void state.explodeTakes(ids[0]);
      },
    },
    {
      id: "edit.implodeTakes",
      name: "Implode Clips into Takes",
      category: "Edit",
      shortcutScope: "timeline",
      canHandleShortcut: () => {
        const state = s();
        const ids = state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [];
        return canImplodeSelectedClipTakes(state, ids);
      },
      execute: () => {
        const state = s();
        const ids = state.selectedClipIds.length > 0
          ? state.selectedClipIds
          : state.selectedClipId ? [state.selectedClipId] : [];
        state.implodeTakes(ids);
      },
    },
    { id: "view.freePositioning", name: "Toggle Free Item Positioning", category: "View", execute: () => s().toggleFreePositioning() },

    // ===== Phase 14: Theming & Customization =====
    { id: "view.themeEditor", name: "Theme Editor...", category: "View", execute: () => s().toggleThemeEditor() },
    { id: "options.themeDark", name: "Theme: Dark", category: "Options", execute: () => s().setTheme("dark") },
    { id: "options.themeLight", name: "Theme: Light", category: "Options", execute: () => s().setTheme("light") },
    { id: "options.themeMidnight", name: "Theme: Midnight", category: "Options", execute: () => s().setTheme("midnight") },
    { id: "options.themeHighContrast", name: "Theme: High Contrast", category: "Options", execute: () => s().setTheme("high-contrast") },
    { id: "options.themeReaperGray", name: "Theme: REAPER Gray", category: "Options", execute: () => s().setTheme("reaper-gray") },
    { id: "options.resetMouseModifiers", name: "Reset Mouse Modifiers", category: "Options", execute: () => s().resetMouseModifiers() },

    // ===== Phase 15: Platform & Extensibility =====
    { id: "view.videoWindow", name: "Toggle Video Window", category: "View", execute: () => s().toggleVideoWindow() },
    { id: "view.scriptEditor", name: "Toggle Script Editor", category: "View", execute: () => s().toggleScriptEditor() },
    { id: "view.toolbarEditor", name: "Toolbar Editor...", category: "View", execute: () => s().toggleToolbarEditor() },
    { id: "file.newTab", name: "New Project Tab", category: "File", execute: () => s().addProjectTab() },

    // ===== Phase 16: Pro Audio & Compatibility =====
    { id: "file.ddpExport", name: "DDP Disc Image Export...", category: "File", execute: () => s().toggleDDPExport() },
    { id: "file.captureOutput", name: "Toggle Capture Output", category: "File", execute: () => { if (s().liveCaptureEnabled) { void s().stopLiveCapture(); } else { void s().startLiveCapture(); } } },
    { id: "options.pluginBridge", name: "Toggle 32-bit Plugin Bridge", category: "Options", execute: () => s().togglePluginBridge() },

    // ===== Sprint 18: Interaction/Workflow =====
    {
      id: "view.zoomToSelection",
      name: "Zoom to Time Selection",
      category: "View",
      shortcut: "Ctrl+Shift+E",
      shortcutScope: "timeline",
      canHandleShortcut: () => hasActiveScopedActionExecutor("view.zoomToSelection") && hasFiniteTimeSelection(),
      execute: () => { executeActiveScopedAction("view.zoomToSelection"); },
    },
    { id: "view.zoomIn", name: "Zoom In", category: "View", shortcut: "Ctrl++", shortcutAliases: ["Ctrl+=", "Ctrl+Shift++"], execute: () => {
      const state = s();
      state.setZoom(Math.min(state.pixelsPerSecond * 1.5, 500));
    }},
    { id: "view.zoomOut", name: "Zoom Out", category: "View", shortcut: "Ctrl+-", execute: () => {
      const state = s();
      state.setZoom(Math.max(state.pixelsPerSecond / 1.5, 10));
    }},
    { id: "view.verticalZoomIn", name: "Vertical Zoom In", category: "View", shortcutScope: "timeline", canHandleShortcut: () => s().trackHeight < 500, execute: () => {
      const state = s();
      state.setTrackHeight(Math.min(500, Math.max(state.trackHeight + 1, state.trackHeight * 1.2)));
    }},
    { id: "view.verticalZoomOut", name: "Vertical Zoom Out", category: "View", shortcutScope: "timeline", canHandleShortcut: () => s().trackHeight > getMinimumVisibleTrackHeight(s().tracks, s().tcpWidth), execute: () => {
      const state = s();
      state.setTrackHeight(state.trackHeight / 1.2);
    }},
    {
      id: "view.zoomToFit",
      name: "Zoom to Full Project",
      category: "View",
      shortcut: "Ctrl+0",
      shortcutScope: "timeline",
      canHandleShortcut: () => hasActiveScopedActionExecutor("view.zoomToFit") && hasTimelineProjectExtent(),
      execute: () => { executeActiveScopedAction("view.zoomToFit"); },
    },
    { id: "view.setLoopToSelection", name: "Set Loop to Selection", category: "View", shortcut: "Ctrl+L", canHandleShortcut: () => Boolean(s().timeSelection), execute: () => {
      if (s().timeSelection) s().setLoopToSelection();
    }},
    { id: "view.autoScroll", name: "Toggle Auto-Scroll During Playback", category: "View", execute: () => s().toggleAutoScroll() },
    { id: "edit.transpose", name: "Transpose Selected Notes", category: "Edit", shortcutScope: "piano_roll", execute: transposeSelectedMidiNotes },
    { id: "edit.velocityScale", name: "Scale Velocity of Selected Notes", category: "Edit", shortcutScope: "piano_roll", execute: scaleSelectedMidiVelocity },

    // ===== MIDI Transform =====
    { id: "edit.transposeUp", name: "Transpose Up (+1 semitone)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, 1); } },
    { id: "edit.transposeDown", name: "Transpose Down (-1 semitone)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, -1); } },
    { id: "edit.transposeOctaveUp", name: "Transpose Octave Up (+12)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, 12); } },
    { id: "edit.transposeOctaveDown", name: "Transpose Octave Down (-12)", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.transposeMIDINotes(st.pianoRollClipId, -12); } },
    { id: "edit.velocityUp", name: "Velocity +10%", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.scaleMIDINoteVelocity(st.pianoRollClipId, 1.1); } },
    { id: "edit.velocityDown", name: "Velocity -10%", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.scaleMIDINoteVelocity(st.pianoRollClipId, 0.9); } },
    { id: "edit.reverseNotes", name: "Reverse MIDI Notes", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.reverseMIDINotes(st.pianoRollClipId); } },
    { id: "edit.invertNotes", name: "Invert MIDI Note Pitches", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollClipId) st.invertMIDINotes(st.pianoRollClipId); } },
    { id: "edit.snapNotesToScale", name: "Snap Selected Notes to Scale", category: "MIDI", execute: () => { const st = s(); if (st.pianoRollTrackId && st.pianoRollClipId) st.snapSelectedMIDINotesToScale(st.pianoRollTrackId, st.pianoRollClipId, st.pianoRollScaleRoot, st.pianoRollScaleType); } },

    // ===== Sprint 19: MIDI + Plugin + Mixing =====
    { id: "midi.transpose", name: "Transpose Notes...", category: "MIDI", shortcutScope: "piano_roll", execute: transposeSelectedMidiNotes },
    activeEditorAction("midi.selectAll", "Select All Notes", "MIDI", "Ctrl+A", "piano_roll"),
    activeScopedComponentAction("midi.deselectAll", "Deselect All Notes", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.selectNextNote", "Select Next Note", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.selectPreviousNote", "Select Previous Note", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.glueSelectedNotes", "Glue Selected Notes", "MIDI", "piano_roll"),
    { id: "view.drumEditor", name: "Toggle Drum Editor", category: "View", execute: () => s().toggleDrumEditor() },
    { id: "insert.busTrack", name: "Insert Bus/Group Track", category: "Insert", canHandleShortcut: () => !s().globalLocked, execute: () => {
      const state = s();
      const id = crypto.randomUUID();
      state.addTrack({ id, name: `Bus ${state.tracks.filter((t: any) => t.type === "bus").length + 1}`, type: "bus" });
    }},
    { id: "view.mediaPool", name: "Toggle Media Pool", category: "View", execute: () => s().toggleMediaPool() },

    // ===== Sprint 20: Cross-Platform + Accessibility =====
    { id: "view.loudnessMeter", name: "Toggle Loudness Meter", category: "View", execute: () => s().toggleLoudnessMeter() },
    { id: "view.phaseCorrelation", name: "Toggle Phase Correlation Meter", category: "View", execute: () => s().togglePhaseCorrelation() },
    { id: "file.archiveSession", name: "Archive Session...", category: "File", execute: () => { void s().archiveSession(); } },
    { id: "file.newFromTemplate", name: "New from Template...", category: "File", execute: () => s().toggleProjectTemplates() },

    // ===== Track / TCP / Mixer Selection =====
    { id: "track.selectAll", name: "Select All Tracks", category: "Track", shortcut: "Ctrl+A", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], execute: () => s().selectAllTracks() },
    { id: "track.deselectAll", name: "Deselect All Tracks", category: "Track", shortcut: "Esc", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], execute: () => s().deselectAllTracks() },
    { id: "track.moveSelectedUp", name: "Move Selected Tracks Up", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => s().canMoveSelectedTracks("up"), execute: () => { s().moveSelectedTracks("up"); } },
    { id: "track.moveSelectedDown", name: "Move Selected Tracks Down", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => s().canMoveSelectedTracks("down"), execute: () => { s().moveSelectedTracks("down"); } },
    { id: "track.groupSelectedIntoFolder", name: "Group Selected Tracks into Folder", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer", "timeline"], canHandleShortcut: () => s().canGroupSelectedTracksIntoFolder(), execute: () => { s().groupSelectedTracksIntoFolder(); } },
    { id: "track.deleteSelected", name: "Delete Selected Tracks", category: "Track", shortcut: "Delete", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().length > 0, execute: () => { void s().deleteSelectedTracks(); } },
    { id: "track.toggleSelectedMute", name: "Mute / Unmute Selected Tracks", category: "Track", shortcut: "M", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => { s().toggleSelectedTracksMute(); } },
    { id: "track.toggleSelectedSolo", name: "Solo / Unsolo Selected Tracks", category: "Track", shortcut: "S", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => { s().toggleSelectedTracksSolo(); } },
    { id: "track.duplicateSelected", name: "Duplicate Selected Tracks", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().length > 0, execute: () => {
      void s().duplicateSelectedTracks();
    }},
    { id: "track.toggleSelectedArm", name: "Arm / Disarm Selected Tracks", category: "Track", shortcut: "R", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => selectedTrackIds().some((id) => {
      const track = s().tracks.find((candidate) => candidate.id === id);
      return Boolean(track && (track.armed || !track.recordSafe));
    }), execute: () => {
      const state = s();
      state.toggleSelectedTracksArmed();
    }},
    { id: "track.linkSelected", name: "Link Selected Tracks", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().length >= 2, execute: () => {
      const ids = selectedTrackIds();
      if (ids.length < 2) return;
      s().addTrackGroup(
        "Group",
        ids[0],
        ids,
        ["volume", "pan", "mute", "solo", "armed", "fxBypass"],
      );
    }},
    { id: "track.unlinkSelected", name: "Unlink Selected Tracks", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().some((id) => s().trackGroups.some((group) => group.memberTrackIds.includes(id))), execute: () => {
      s().unlinkTracksFromGroups(selectedTrackIds());
    }},
    { id: "track.setSelectedColor", name: "Set Selected Track Color...", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().length > 0, execute: () => {
      const ids = selectedTrackIds();
      const firstTrack = s().tracks.find((track) => track.id === ids[0]);
      const color = prompt("Track color (CSS color or #RRGGBB):", firstTrack?.color || "#4361ee")?.trim();
      if (!color) return;
      if (!isValidCssColor(color)) {
        s().showToast("Enter a valid CSS color or hexadecimal color.", "error");
        return;
      }
      s().setTracksColorWithUndo(ids, color);
    }},
    { id: "track.consolidateSelected", name: "Consolidate Selected Track...", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "timeline"], canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && selectedTrackIds().some((id) => {
        const track = state.tracks.find((candidate) => candidate.id === id);
        return Boolean(track && !track.frozen && track.clips.length > 0 && track.clips.every((clip) => !clip.locked));
      });
    }, execute: () => {
      const state = s();
      const trackId = !state.globalLocked && !state.lockSettings.items
        ? selectedTrackIds().find((id) => {
            const track = state.tracks.find((candidate) => candidate.id === id);
            return Boolean(track && !track.frozen && track.clips.length > 0 && track.clips.every((clip) => !clip.locked));
          })
        : undefined;
      if (trackId) void state.consolidateTrack(trackId);
    }},
    { id: "track.toggleSelectedFxBypass", name: "Bypass / Enable Selected Track FX", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer", "plugin"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => { s().toggleSelectedTracksFXBypass(); } },
    { id: "track.toggleSelectedMonitor", name: "Toggle Selected Track Input Monitoring", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => { s().toggleSelectedTracksMonitor(); } },
    { id: "track.toggleSelectedAutomationRead", name: "Toggle Selected Track Automation Read", category: "Automation", shortcutScope: "automation", shortcutScopes: ["automation", "track_control_panel", "mixer"], canHandleShortcut: () => canEditAutomationSettings() && selectedTrackIds().some((id) => {
      const track = s().tracks.find((candidate) => candidate.id === id);
      return Boolean(track && (track.automationLanes.length > 0 || track.automationWriteEnabled));
    }), execute: () => {
      routeAutomationAction("track.toggleSelectedAutomationRead", () => {
        const state = s();
        state.toggleTracksAutomationRead(selectedTrackIds());
      });
    }},
    { id: "track.toggleSelectedAutomationWrite", name: "Toggle Selected Track Automation Write", category: "Automation", shortcutScope: "automation", shortcutScopes: ["automation", "track_control_panel", "mixer"], canHandleShortcut: () => canEditAutomationSettings() && selectedTrackIds().length > 0, execute: () => {
      routeAutomationAction("track.toggleSelectedAutomationWrite", () => {
        const state = s();
        state.toggleTracksAutomationWrite(selectedTrackIds());
      });
    }},
    { id: "track.toggleSelectedPhaseInvert", name: "Toggle Selected Track Phase Invert", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => { s().toggleSelectedTracksPhaseInvert(); } },
    { id: "track.moveSelectedToFolder", name: "Move Selected Tracks to Folder...", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().length > 0 && s().tracks.some((track) => track.isFolder), execute: () => {
      const state = s();
      const ids = selectedTrackIds();
      const folder = chooseByNumber(
        "Move selected tracks to folder (enter number):",
        state.tracks.filter((track) => track.isFolder && !ids.includes(track.id)),
        (track) => track.name,
      );
      if (folder) state.moveTracksToFolder(ids, folder.id);
    }},
    { id: "track.removeSelectedFromFolder", name: "Remove Selected Tracks from Folder", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().some((id) => Boolean(s().tracks.find((track) => track.id === id)?.parentFolderId)), execute: () => {
      s().removeTracksFromFolders(selectedTrackIds());
    }},
    { id: "track.toggleSelectedFolders", name: "Expand / Collapse Selected Folders", category: "Track", shortcutScope: "track_control_panel", canHandleShortcut: () => selectedTrackIds().some((id) => Boolean(s().tracks.find((track) => track.id === id)?.isFolder)), execute: () => {
      const state = s();
      runSynchronousCommandBatch("TOGGLE_SELECTED_FOLDERS", "Expand or collapse selected folders", () => {
        selectedTrackIds().forEach((trackId) => {
          if (state.tracks.find((track) => track.id === trackId)?.isFolder) state.toggleFolderCollapsed(trackId);
        });
      });
    }},
    { id: "track.toggleSelectedAutomation", name: "Show / Hide Selected Track Automation", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer", "automation"], canHandleShortcut: () => canEditAutomationSettings() && selectedTrackIds().length > 0, execute: () => {
      const state = s();
      runSynchronousCommandBatch("TOGGLE_SELECTED_AUTOMATION", "Show or hide selected track automation", () => {
        selectedTrackIds().forEach((trackId) => state.toggleTrackAutomation(trackId));
      });
    }},
    { id: "track.toggleSelectedSpectralView", name: "Toggle Selected Track Waveform / Spectral View", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "timeline"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => {
      const state = s();
      runSynchronousCommandBatch("TOGGLE_SELECTED_SPECTRAL_VIEW", "Toggle selected track spectral view", () => {
        selectedTrackIds().forEach((trackId) => state.toggleSpectralView(trackId));
      });
    }},
    { id: "track.toggleSelectedFreeze", name: "Freeze / Unfreeze Selected Tracks", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && !s().lockSettings.items && selectedTrackIds().some((trackId) => {
      const track = s().tracks.find((candidate) => candidate.id === trackId);
      return Boolean(track && (track.frozen || track.clips.length > 0 || track.midiClips.length > 0));
    }), execute: () => { void s().toggleSelectedTracksFreeze(); } },
    { id: "track.renderSelectedInPlace", name: "Render Selected Track in Place", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer", "timeline"], canHandleShortcut: () => !s().globalLocked && !s().lockSettings.items && selectedTrackIds().some((id) => {
      const track = s().tracks.find((candidate) => candidate.id === id);
      const clips = track ? [...track.clips, ...track.midiClips] : [];
      return Boolean(track && !track.frozen && clips.length > 0 && clips.every((clip) => !clip.locked));
    }), execute: () => {
      const state = s();
      const trackId = selectedTrackIds().find((id) => {
        const track = state.tracks.find((candidate) => candidate.id === id);
        const clips = track ? [...track.clips, ...track.midiClips] : [];
        return Boolean(!state.globalLocked && !state.lockSettings.items && track && !track.frozen && clips.length > 0 && clips.every((clip) => !clip.locked));
      });
      if (trackId) void state.renderTrackInPlace(trackId);
    }},
    { id: "track.saveSelectedAsTemplate", name: "Save Selected Track as Template...", category: "Track", shortcutScope: "track_control_panel", canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => {
      const state = s();
      const track = state.tracks.find((candidate) => candidate.id === selectedTrackIds()[0]);
      if (!track) return;
      const name = prompt("Template name:", track.name);
      if (name?.trim()) state.saveTrackTemplate(track.id, name.trim());
    }},
    { id: "track.loadTemplate", name: "Load Track Template...", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => s().trackTemplates.length > 0, execute: () => {
      const state = s();
      const template = chooseByNumber("Load track template (enter number):", state.trackTemplates, (item) => item.name);
      if (template) state.loadTrackTemplate(template.id);
    }},
    { id: "track.openSelectedEnvelopeManager", name: "Open Selected Track Envelope Manager", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer", "automation"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => {
      const trackId = selectedTrackIds()[0];
      if (trackId) s().openEnvelopeManager(trackId);
    }},
    { id: "track.openSelectedRouting", name: "Open Selected Track Routing", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => {
      const trackId = selectedTrackIds()[0];
      if (trackId) s().openTrackRouting(trackId);
    }},
    { id: "track.openSelectedPluginBrowser", name: "Open Plug-in Browser for Selected Track", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer", "browser"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => {
      const trackId = selectedTrackIds()[0];
      if (trackId) s().openPluginBrowser(trackId);
    }},
    { id: "track.openSelectedChannelEQ", name: "Open Selected Track Channel EQ", category: "Track", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer", "plugin"], canHandleShortcut: () => selectedTrackIds().length > 0, execute: () => {
      const trackId = selectedTrackIds()[0];
      if (trackId) s().openChannelStripEQ(trackId);
    }},
    { id: "automation.showAllSelectedTrackEnvelopes", name: "Show All Active Envelopes on Selected Tracks", category: "Automation", shortcutScope: "automation", shortcutScopes: ["automation", "track_control_panel", "mixer"], canHandleShortcut: () => canEditAutomationSettings() && selectedTrackIds().length > 0, execute: () => {
      routeAutomationAction("automation.showAllSelectedTrackEnvelopes", () => {
        s().setTracksAutomationVisibility(selectedTrackIds(), true);
      });
    }},
    { id: "automation.hideAllSelectedTrackEnvelopes", name: "Hide All Envelopes on Selected Tracks", category: "Automation", shortcutScope: "automation", shortcutScopes: ["automation", "track_control_panel", "mixer"], canHandleShortcut: () => canEditAutomationSettings() && selectedTrackIds().length > 0, execute: () => {
      routeAutomationAction("automation.hideAllSelectedTrackEnvelopes", () => {
        s().setTracksAutomationVisibility(selectedTrackIds(), false);
      });
    }},
    ...automationActions,
    { id: "track.clearSelectedSamplerSample", name: "Clear Selected Track Sampler Sample", category: "Track", shortcutScope: "track_control_panel", canHandleShortcut: () => selectedTrackIds().some((trackId) => Boolean(s().tracks.find((track) => track.id === trackId)?.samplerSamplePath)), execute: () => { void s().clearSelectedTrackSamplerSamples(); } },
    { id: "track.removeSelectedInstrument", name: "Remove Instrument from Selected Track", category: "Track", shortcutScope: "track_control_panel", canHandleShortcut: () => selectedTrackIds().some((trackId) => {
      const track = s().tracks.find((candidate) => candidate.id === trackId);
      return Boolean(track?.instrumentPlugin || track?.builtInInstrument);
    }), execute: () => { void s().removeSelectedTrackInstruments(); } },

    // ===== Pitch Editor =====
    { id: "edit.editPitch", name: "Edit Pitch", category: "Edit", shortcut: "P", shortcutScope: "timeline", canHandleShortcut: canToggleSelectedPitchEditor, execute: () => {
      const state = s();
      const clipId = state.selectedClipIds[0];
      if (!clipId) return;
      const track = state.tracks.find((t: any) => t.clips.some((c: any) => c.id === clipId));
      if (!track || track.type === "midi") return;
      if (state.showPitchEditor && state.pitchEditorClipId === clipId) {
        state.closePitchEditor();
      } else {
        state.openPitchEditor(track.id, clipId, -1);
      }
    }},
    { id: "clip.openSelectedInPianoRoll", name: "Open Selected MIDI Clip in Piano Roll", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => selectedTimelineClips().some((entry) => entry.kind === "midi"), execute: () => {
      const entry = selectedTimelineClips().find((candidate) => candidate.kind === "midi");
      if (entry) s().openPianoRoll(entry.track.id, entry.clip.id);
    }},
    { id: "clip.repeatSelected", name: "Repeat Selected Clips...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked);
    }, execute: () => {
      const countInput = prompt("Number of repeats:", "3");
      if (countInput === null) return;
      const count = Math.max(1, Math.min(128, Math.floor(Number(countInput) || 1)));
      const state = s();
      const selectionBefore = [...state.selectedClipIds];
      const primaryBefore = state.selectedClipId;
      let selectionAfter = selectionBefore;
      let primaryAfter = primaryBefore;
      runSynchronousCommandBatch("REPEAT_SELECTED_CLIPS", `Repeat selected clips ${count} time${count === 1 ? "" : "s"}`, () => {
        selectedTimelineClips().forEach((entry) => state.repeatClip(entry.clip.id, count));
        selectionAfter = [...useDAWStore.getState().selectedClipIds];
        primaryAfter = useDAWStore.getState().selectedClipId;
      }, {
        afterExecute: () => useDAWStore.setState({ selectedClipIds: selectionAfter, selectedClipId: primaryAfter }),
        afterUndo: () => useDAWStore.setState({ selectedClipIds: selectionBefore, selectedClipId: primaryBefore }),
      });
    }},
    { id: "clip.setSelectedColor", name: "Set Selected Clip Color...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked);
    }, execute: () => {
      const entries = selectedTimelineClips();
      const color = prompt("Clip color (CSS color or #RRGGBB):", entries[0]?.clip.color || "#4361ee");
      if (!color?.trim()) return;
      const state = s();
      runSynchronousCommandBatch("SET_SELECTED_CLIP_COLOR", "Set selected clip color", () => {
        entries.forEach((entry) => state.setClipColor(entry.clip.id, color.trim()));
      });
    }},
    { id: "clip.resetSelectedMidiSourceOffset", name: "Reset Selected MIDI Source Offset", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && selectedTimelineClips().some((entry) => (
        entry.kind === "midi" && !entry.track.frozen && !entry.clip.locked
      ));
    }, execute: () => {
      const state = s();
      runSynchronousCommandBatch("RESET_SELECTED_MIDI_SOURCE_OFFSET", "Reset selected MIDI source offset", () => {
        selectedTimelineClips().filter((entry) => entry.kind === "midi").forEach((entry) => {
          state.setMIDIClipSourceWindow(entry.clip.id, { offset: 0, loopOffset: 0 }, "Reset MIDI source offset");
        });
      });
    }},
    { id: "clip.setSelectedMidiSourceLengthToItem", name: "Set Selected MIDI Source Length to Item", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && selectedTimelineClips().some((entry) => (
        entry.kind === "midi" && !entry.track.frozen && !entry.clip.locked
      ));
    }, execute: () => {
      const state = s();
      runSynchronousCommandBatch("SET_SELECTED_MIDI_SOURCE_LENGTH_TO_ITEM", "Set selected MIDI source length to item", () => {
        selectedTimelineClips().filter((entry) => entry.kind === "midi").forEach((entry) => {
          const duration = Math.max(0.01, entry.clip.duration);
          state.setMIDIClipSourceWindow(entry.clip.id, { offset: 0, sourceLength: duration, loopLength: duration }, "Set MIDI source length to item");
        });
      });
    }},
    { id: "clip.setSelectedMidiSourceLengthToContent", name: "Set Selected MIDI Source Length to Content", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && selectedTimelineClips().some((entry) => (
        entry.kind === "midi" && !entry.track.frozen && !entry.clip.locked
      ));
    }, execute: () => {
      const state = s();
      runSynchronousCommandBatch("SET_SELECTED_MIDI_SOURCE_LENGTH_TO_CONTENT", "Set selected MIDI source length to content", () => {
        selectedTimelineClips().filter((entry) => entry.kind === "midi").forEach((entry) => {
          const midiClip = entry.clip;
          const eventEnd = midiClip.events.reduce((end, event) => Math.max(end, Number(event.timestamp) || 0), 0.01);
          const contentEnd = (midiClip.ccEvents ?? []).reduce((end, event) => Math.max(end, Number(event.time) || 0), eventEnd);
          state.setMIDIClipSourceWindow(entry.clip.id, { sourceLength: contentEnd, loopLength: contentEnd }, "Set MIDI source length to content");
        });
      });
    }},
    { id: "clip.setSelectedMidiSourceLength", name: "Set Selected MIDI Source Length...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items && selectedTimelineClips().some((entry) => (
        entry.kind === "midi" && !entry.track.frozen && !entry.clip.locked
      ));
    }, execute: () => {
      const entries = selectedTimelineClips().filter((entry) => entry.kind === "midi");
      const currentLength = entries[0]?.clip.sourceLength || entries[0]?.clip.loopLength || entries[0]?.clip.duration || 1;
      const input = prompt("MIDI source length in seconds:", String(currentLength));
      if (input === null) return;
      const length = Number(input);
      if (!Number.isFinite(length) || length <= 0) return;
      const state = s();
      runSynchronousCommandBatch("SET_SELECTED_MIDI_SOURCE_LENGTH", "Set selected MIDI source length", () => {
        entries.forEach((entry) => state.setMIDIClipSourceWindow(
          entry.clip.id,
          { sourceLength: length, loopLength: length },
          "Set MIDI source length",
        ));
      });
    }},
    { id: "clip.humanizeSelectedMidi", name: "Humanize Selected MIDI Clips", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("HUMANIZE_SELECTED_MIDI_CLIPS", "Humanize selected MIDI clips", (trackId, clipId) => s().humanizeSelectedMIDINotes(trackId, clipId));
    }},
    { id: "clip.quantizeSelectedMidi", name: "Quantize Notes in Selected MIDI Clips", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("QUANTIZE_SELECTED_MIDI_CLIPS", "Quantize selected MIDI clips", (trackId, clipId) => s().quantizeSelectedMIDINotesUsingLast(trackId, clipId));
    }},
    { id: "clip.transposeSelectedMidiUp", name: "Transpose Selected MIDI Clips Up One Semitone", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("TRANSPOSE_SELECTED_MIDI_CLIPS", "Transpose selected MIDI clips up", (trackId, clipId, noteIds) => s().moveMIDINotes(trackId, clipId, noteIds, 0, 1));
    }},
    { id: "clip.transposeSelectedMidiDown", name: "Transpose Selected MIDI Clips Down One Semitone", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("TRANSPOSE_SELECTED_MIDI_CLIPS", "Transpose selected MIDI clips down", (trackId, clipId, noteIds) => s().moveMIDINotes(trackId, clipId, noteIds, 0, -1));
    }},
    { id: "clip.transposeSelectedMidiOctaveUp", name: "Transpose Selected MIDI Clips Up One Octave", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("TRANSPOSE_SELECTED_MIDI_CLIPS", "Transpose selected MIDI clips up one octave", (trackId, clipId, noteIds) => s().moveMIDINotes(trackId, clipId, noteIds, 0, 12));
    }},
    { id: "clip.transposeSelectedMidiOctaveDown", name: "Transpose Selected MIDI Clips Down One Octave", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("TRANSPOSE_SELECTED_MIDI_CLIPS", "Transpose selected MIDI clips down one octave", (trackId, clipId, noteIds) => s().moveMIDINotes(trackId, clipId, noteIds, 0, -12));
    }},
    { id: "clip.setSelectedMidiVelocity", name: "Set Velocity for Selected MIDI Clips...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      const input = prompt("Velocity (1-127):", "80");
      if (input === null) return;
      const velocity = Math.max(1, Math.min(127, Math.round(Number(input) || 0)));
      applyToAllNotesInSelectedMidiClips("SET_SELECTED_MIDI_CLIP_VELOCITY", "Set selected MIDI clip velocity", (trackId, clipId) => {
        s().setSelectedMIDINoteVelocity(trackId, clipId, velocity);
      });
    }},
    { id: "clip.increaseSelectedMidiVelocity", name: "Increase Velocity in Selected MIDI Clips 10%", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("INCREASE_SELECTED_MIDI_CLIP_VELOCITY", "Increase selected MIDI clip velocity", (trackId, clipId) => {
        s().scaleSelectedMIDINoteVelocity(trackId, clipId, 1.1);
      });
    }},
    { id: "clip.decreaseSelectedMidiVelocity", name: "Decrease Velocity in Selected MIDI Clips 10%", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => editableSelectedMidiTimelineClips().length > 0, execute: () => {
      applyToAllNotesInSelectedMidiClips("DECREASE_SELECTED_MIDI_CLIP_VELOCITY", "Decrease selected MIDI clip velocity", (trackId, clipId) => {
        s().scaleSelectedMIDINoteVelocity(trackId, clipId, 0.9);
      });
    }},
    { id: "clip.exportSelectedMidi", name: "Export Selected MIDI Clip...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => selectedTimelineClips().some((entry) => entry.kind === "midi"), execute: () => {
      const entry = selectedTimelineClips().find((candidate) => candidate.kind === "midi");
      if (!entry) return;
      void (async () => {
        const midiClip = entry.clip;
        const filePath = await nativeBridge.showSaveDialog(
          `${midiClip.name || "MIDI Clip"}.mid`,
          "Export MIDI Clip",
          "*.mid;*.midi",
        );
        if (!filePath) return;
        const exported = serializeMIDIClipsForBackend(
          [{ ...midiClip, startTime: 0 }],
          entry.track.midiEffects || [],
        )[0];
        const success = await nativeBridge.exportProjectMIDI(filePath, [{
          name: entry.track.name || "MIDI Track",
          clips: [{
            startTime: 0,
            duration: exported?.duration ?? midiClip.duration,
            events: exported?.events ?? getVisibleMIDIEventsForClip(midiClip),
          }],
        }]);
        s().showToast(success ? "MIDI clip exported" : "Failed to export MIDI clip", success ? "success" : "error");
      })();
    }},
    { id: "clip.renderSelectedInPlace", name: "Render Selected Clip in Place", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => {
      const state = s();
      return !state.globalLocked && !state.lockSettings.items
        && selectedTimelineClips().some((entry) => !entry.track.frozen && !entry.clip.locked);
    }, execute: () => {
      const state = s();
      const clipId = !state.globalLocked && !state.lockSettings.items
        ? selectedTimelineClips().find((entry) => !entry.track.frozen && !entry.clip.locked)?.clip.id
        : undefined;
      if (clipId) void s().renderClipInPlace(clipId);
    }},
    { id: "clip.separateSelectedStems", name: "Separate Selected Audio Clip into Stems...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => selectedTimelineClips().some((entry) => entry.kind === "audio"), execute: () => {
      const entry = selectedTimelineClips().find((candidate) => candidate.kind === "audio");
      if (entry) s().openStemSeparation(entry.track.id, entry.clip.id, entry.clip.name || "Audio", entry.clip.duration);
    }},
    { id: "clip.createAIVariation", name: "Create AI Variation from Selected Clip...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => selectedTimelineClips().some((entry) => entry.kind === "audio"), execute: () => {
      const entry = selectedTimelineClips().find((candidate) => candidate.kind === "audio");
      if (entry) s().openAIClipGeneration(entry.track.id, entry.clip.id, "variation");
    }},
    { id: "clip.inpaintSelection", name: "AI Inpaint Selected Clip Time Selection...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => Boolean(s().timeSelection) && selectedTimelineClips().some((entry) => entry.kind === "audio"), execute: () => {
      const entry = selectedTimelineClips().find((candidate) => candidate.kind === "audio");
      if (entry && s().timeSelection) s().openAIClipGeneration(entry.track.id, entry.clip.id, "inpaint-selection");
    }},
    { id: "clip.continueSelectedWithAI", name: "Continue Selected Clip with AI...", category: "Clip", shortcutScope: "timeline", canHandleShortcut: () => selectedTimelineClips().some((entry) => entry.kind === "audio"), execute: () => {
      const entry = selectedTimelineClips().find((candidate) => candidate.kind === "audio");
      if (entry) s().openAIClipGeneration(entry.track.id, entry.clip.id, "continue-clip");
    }},
    activeEditorAction("pitch.closeEditor", "Close Pitch Editor", "Pitch Editor", "Esc", "pitch_editor"),
    activeEditorAction("pitch.selectAll", "Select All Pitch Notes", "Pitch Editor", "Ctrl+A", "pitch_editor"),
    activeEditorAction("pitch.moveUp", "Move Selected Pitch Up One Semitone", "Pitch Editor", "Up", "pitch_editor"),
    activeEditorAction("pitch.moveDown", "Move Selected Pitch Down One Semitone", "Pitch Editor", "Down", "pitch_editor"),
    activeEditorAction("pitch.moveUpFine", "Move Selected Pitch Up 10 Cents", "Pitch Editor", "Shift+Up", "pitch_editor"),
    activeEditorAction("pitch.moveDownFine", "Move Selected Pitch Down 10 Cents", "Pitch Editor", "Shift+Down", "pitch_editor"),
    activeEditorAction("pitch.correctSelectedToScale", "Correct Selected Pitch Notes to Scale", "Pitch Editor", "Q", "pitch_editor"),
    activeEditorAction("pitch.mergeSelectedNotes", "Merge Selected Pitch Notes", "Pitch Editor", "Ctrl+J", "pitch_editor"),
    activeEditorAction("pitch.tool.select", "Pitch Editor: Select Tool", "Pitch Editor Tools", "1", "pitch_editor"),
    activeEditorAction("pitch.tool.drift", "Pitch Editor: Drift Tool", "Pitch Editor Tools", "2", "pitch_editor"),
    activeEditorAction("pitch.tool.vibrato", "Pitch Editor: Vibrato Tool", "Pitch Editor Tools", "3", "pitch_editor"),
    activeEditorAction("pitch.tool.transition", "Pitch Editor: Transition Tool", "Pitch Editor Tools", "4", "pitch_editor"),
    activeEditorAction("pitch.tool.draw", "Pitch Editor: Draw Tool", "Pitch Editor Tools", "5", "pitch_editor"),
    activeEditorAction("pitch.tool.split", "Pitch Editor: Split Tool", "Pitch Editor Tools", "6", "pitch_editor"),

    // ===== Polyphonic Pitch Detection (Phase 6) =====
    { id: "edit.extractMidi", name: "Convert Audio to MIDI", category: "Edit", execute: () => {
      const state = s();
      const clipId = state.selectedClipIds[0];
      if (!clipId) return;
      const track = state.tracks.find((t: any) => t.clips.some((c: any) => c.id === clipId));
      if (!track || track.type === "midi") return;
      void state.convertAudioClipToMIDI(track.id, clipId);
    }},

    // ===== Sprint 21: Timeline Interaction =====
    { id: "view.toggleCrosshair", name: "Toggle Crosshair Cursor", category: "View", execute: () => s().toggleCrosshair() },

    // ===== Mixer Snapshots & Bus/Group & Templates =====
    { id: "insert.bus", name: "Create Bus from Selected Tracks", category: "Insert", shortcutScope: "track_control_panel", shortcutScopes: ["track_control_panel", "mixer"], canHandleShortcut: () => !s().globalLocked && selectedTrackIds().length > 0, execute: () => { void s().createBusFromSelectedTracks(); } },
    { id: "mixer.saveSnapshot", name: "Save Mixer Snapshot", category: "Mixer", execute: () => {
      const name = prompt("Snapshot name:", `Snapshot ${s().mixerSnapshots.length + 1}`);
      if (name) s().saveMixerSnapshot(name);
    }},
    { id: "mixer.recallSnapshot", name: "Recall Mixer Snapshot...", category: "Mixer", canHandleShortcut: () => s().mixerSnapshots.length > 0, execute: () => {
      const state = s();
      const choice = chooseByNumber("Recall mixer snapshot (enter number):", state.mixerSnapshots.map((snapshot, index) => ({ snapshot, index })), ({ snapshot }) => snapshot.name);
      if (choice) state.recallMixerSnapshot(choice.index);
    }},
    { id: "mixer.deleteSnapshot", name: "Delete Mixer Snapshot...", category: "Mixer", canHandleShortcut: () => s().mixerSnapshots.length > 0, execute: () => {
      const state = s();
      const choice = chooseByNumber("Delete mixer snapshot (enter number):", state.mixerSnapshots.map((snapshot, index) => ({ snapshot, index })), ({ snapshot }) => snapshot.name);
      if (choice && confirm(`Delete mixer snapshot "${choice.snapshot.name}"?`)) state.deleteMixerSnapshot(choice.index);
    }},
    { id: "mixer.toggleMasterMute", name: "Mute / Unmute Master", category: "Mixer", shortcutScope: "mixer", execute: () => s().toggleMasterMute() },
    { id: "mixer.toggleMasterMono", name: "Toggle Master Mono", category: "Mixer", shortcutScope: "mixer", execute: () => s().toggleMasterMono() },
    { id: "mixer.toggleMasterAutomationRead", name: "Toggle Master Automation Read", category: "Automation", shortcutScope: "mixer", shortcutScopes: ["mixer", "track_control_panel", "automation"], canHandleShortcut: canEditAutomationSettings, execute: () => routeAutomationAction("mixer.toggleMasterAutomationRead", () => s().toggleMasterAutomationRead()) },
    { id: "mixer.toggleMasterAutomationWrite", name: "Toggle Master Automation Write", category: "Automation", shortcutScope: "mixer", shortcutScopes: ["mixer", "track_control_panel", "automation"], canHandleShortcut: canEditAutomationSettings, execute: () => routeAutomationAction("mixer.toggleMasterAutomationWrite", () => s().toggleMasterAutomationWrite()) },
    { id: "mixer.toggleMasterAutomationLanes", name: "Show / Hide Master Automation", category: "Automation", shortcutScope: "mixer", shortcutScopes: ["mixer", "track_control_panel", "automation"], canHandleShortcut: canEditAutomationSettings, execute: () => routeAutomationAction("mixer.toggleMasterAutomationLanes", () => s().toggleMasterAutomation()) },
    { id: "mixer.openMasterEnvelopeManager", name: "Open Master Automation Panel", category: "Automation", shortcutScope: "mixer", shortcutScopes: ["mixer", "track_control_panel", "automation"], execute: () => s().openEnvelopeManager("master") },
    { id: "mixer.detach", name: "Detach Mixer", category: "Mixer", shortcutScope: "mixer", canHandleShortcut: () => !s().detachedPanels.includes("mixer"), execute: () => s().detachPanel("mixer") },
    { id: "mixer.attach", name: "Attach Mixer", category: "Mixer", shortcutScope: "mixer", canHandleShortcut: () => s().detachedPanels.includes("mixer"), execute: () => s().attachPanel("mixer") },
    availableScopedComponentAction("mixer.close", "Close Active Mixer", "Mixer", "mixer"),
    activeScopedComponentAction("mixer.openMasterFxChain", "Open Master FX Chain", "FX", "mixer", ["mixer", "track_control_panel", "plugin"]),
    activeScopedComponentAction("mixer.addMonitorFx", "Add Monitoring FX...", "FX", "mixer"),
    activeScopedComponentAction(
      "track.openSelectedFxChain",
      "Open Selected Track FX Chain",
      "FX",
      "track_control_panel",
      ["track_control_panel", "mixer", "plugin"],
    ),
    activeScopedComponentAction("clip.splitAtPointer", "Split Clip at Context Pointer", "Clip", "timeline"),
    activeScopedComponentAction("midi.loopFromSelectedNotes", "Set Loop from Selected MIDI Notes", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.noteProperties", "Selected Note Properties...", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.configureControllerLanes", "Configure MIDI Controller Lanes...", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.toggleGhostReference", "Toggle Ghost / Reference Notes", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.openQuantizePanel", "Open MIDI Quantize Panel", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.quantizeLength", "Quantize Selected MIDI Note Lengths", "MIDI", "piano_roll"),
    activeScopedComponentAction("midi.controllerLine", "Draw Controller Ramp / Step / Curve...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.controllerSineLfo", "Generate Controller Sine LFO...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.controllerTriangleLfo", "Generate Controller Triangle LFO...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.controllerSquareLfo", "Generate Controller Square LFO...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.controllerSawUpLfo", "Generate Controller Saw Up LFO...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.controllerSawDownLfo", "Generate Controller Saw Down LFO...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.controllerTransform", "Scale / Tilt / Stretch Controller Data...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.controllerThin", "Thin Controller Data...", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.copyControllerLane", "Copy Current Controller Lane", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.pasteControllerLane", "Paste Controller Lane", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("midi.clearControllerLane", "Clear Current Controller Lane", "MIDI Controller", "piano_roll"),
    activeScopedComponentAction("pitch.detectKeyScale", "Detect Pitch Editor Key / Scale", "Pitch Editor", "pitch_editor"),
    activeScopedComponentAction("pitch.correctAllToScale", "Correct All Pitch Notes to Scale", "Pitch Editor", "pitch_editor"),
    activeScopedComponentAction("pitch.toggleAB", "Toggle Pitch Correction A/B", "Pitch Editor", "pitch_editor"),
    activeScopedComponentAction("pitch.openCorrectionMacro", "Open Correct Pitch Macro", "Pitch Editor", "pitch_editor"),
    activeScopedComponentAction("fx.removeSelected", "Remove Selected FX", "FX", "plugin"),
    activeScopedComponentAction("fx.toggleSelectedBypass", "Bypass / Enable Selected FX", "FX", "plugin"),
    activeScopedComponentAction("fx.openSelectedEditor", "Open Selected FX Editor", "FX", "plugin"),
    activeScopedComponentAction("fx.toggleSelectedAB", "Toggle Selected FX A/B", "FX", "plugin"),
    activeScopedComponentAction("fx.reloadSelectedScript", "Reload Selected Script FX", "FX", "plugin"),
    activeScopedComponentAction("fx.toggleSelectedParameters", "Show / Hide Selected FX Parameters", "FX", "plugin"),
    activeScopedComponentAction("fx.toggleSelectedPresets", "Show / Hide Selected FX Presets", "FX", "plugin"),
    activeScopedComponentAction("fx.openInstrumentEditor", "Open Track Instrument Editor", "FX", "plugin"),
    activeScopedComponentAction("fx.removeInstrument", "Remove Track Instrument", "FX", "plugin"),
    activeScopedComponentAction("fx.add", "Add FX...", "FX", "plugin"),
    availableScopedComponentAction("fx.close", "Close Active FX Chain or Editor", "FX", "plugin"),
    activeScopedComponentAction("browser.focusSearch", "Focus Browser Search", "Browser", "browser"),
    activeScopedComponentAction("browser.toggleFavorites", "Toggle Favorite Plug-ins Filter", "Browser", "browser"),
    activeScopedComponentAction("browser.openUserEffectsFolder", "Open User JSFX Effects Folder", "Browser", "browser"),
    activeScopedComponentAction("browser.toggleScanFolders", "Show / Hide Plug-in Scan Folders", "Browser", "browser"),
    activeScopedComponentAction("browser.addScanFolder", "Add Plug-in Scan Folder...", "Browser", "browser"),
    activeScopedComponentAction("browser.scanPlugins", "Scan Plug-ins", "Browser", "browser"),
    activeScopedComponentAction("browser.deepScanPlugins", "Deep Scan Plug-ins", "Browser", "browser"),
    activeScopedComponentAction("browser.removeCurrentInstrument", "Remove Current Instrument", "Browser", "browser"),
    activeScopedComponentAction("browser.mediaNavigateUp", "Media Explorer: Go to Parent Folder", "Browser", "browser"),
    activeScopedComponentAction("browser.mediaToggleRecent", "Media Explorer: Toggle Recent Folders", "Browser", "browser"),
    activeScopedComponentAction("browser.mediaFocusFilter", "Media Explorer: Focus Filter", "Browser", "browser"),
    availableScopedComponentAction("browser.close", "Close Active Browser", "Browser", "browser"),
    {
      ...availableScopedComponentAction("modal.close", "Close Active Dialog", "Modal", "modal"),
      shortcut: "Esc",
    },
    {
      ...availableScopedComponentAction("script.runCurrent", "Run Current Script", "Script", "modal"),
      shortcut: "Ctrl+Enter",
    },
    availableScopedComponentAction("script.saveCurrent", "Save Current Script...", "Script", "modal"),
    availableScopedComponentAction("script.clearConsole", "Clear Script Console", "Script", "modal"),
    availableScopedComponentAction("script.refreshFiles", "Refresh Script Files", "Script", "modal"),
    availableScopedComponentAction("script.openFolder", "Open Scripts Folder", "Script", "modal"),
    availableScopedComponentAction("script.showEditorTab", "Show Saved Scripts", "Script", "modal"),
    availableScopedComponentAction("script.showFilesTab", "Show Script Files", "Script", "modal"),
    activeScopedComponentAction("track.openSelectedNotes", "Open Selected Track Notes", "Track", "track_control_panel"),
    activeScopedComponentAction("track.loadSelectedSamplerSample", "Load Sampler Sample on Selected Track...", "Track", "track_control_panel"),
    { id: "file.saveAsTemplate", name: "Save as Template...", category: "File", execute: () => {
      const name = prompt("Template name:");
      if (name) s().saveAsTemplate(name);
    }},
  ];

  return actions.map(withResolvedShortcutScope);
}

const DEFERRED_ACTIONS: readonly DeferredActionDef[] = [];

export function getDeferredActions(): readonly DeferredActionDef[] {
  return DEFERRED_ACTIONS;
}

export interface ActionShortcutConflict {
  shortcut: string;
  scope: ActionShortcutScope;
  actionIds: readonly [string, string];
}

/** Invalid same-precedence factory conflicts. Global-to-surface shadowing is intentional. */
export function getActionShortcutConflicts(): ActionShortcutConflict[] {
  const actions = getRegisteredActions();
  const conflicts: ActionShortcutConflict[] = [];

  for (let leftIndex = 0; leftIndex < actions.length; leftIndex += 1) {
    const left = actions[leftIndex];
    const leftShortcuts = [left.shortcut, ...(left.shortcutAliases ?? [])]
      .filter((shortcut): shortcut is string => typeof shortcut === "string" && shortcut.length > 0 && !shortcut.includes("("));
    if (leftShortcuts.length === 0) continue;

    for (let rightIndex = leftIndex + 1; rightIndex < actions.length; rightIndex += 1) {
      const right = actions[rightIndex];
      if (!shortcutConditionsOverlap(left.shortcutWhen, right.shortcutWhen)) continue;
      const sharedScopes = getActionShortcutScopes(left).filter((scope) => getActionShortcutScopes(right).includes(scope));
      if (sharedScopes.length === 0) continue;
      const rightShortcuts = [right.shortcut, ...(right.shortcutAliases ?? [])]
        .filter((shortcut): shortcut is string => typeof shortcut === "string" && shortcut.length > 0 && !shortcut.includes("("));

      for (const leftShortcut of leftShortcuts) {
        if (!rightShortcuts.some((shortcut) => shortcut.toLowerCase() === leftShortcut.toLowerCase())) continue;
        sharedScopes.forEach((scope) => conflicts.push({
          shortcut: leftShortcut,
          scope,
          actionIds: [left.id, right.id],
        }));
      }
    }
  }

  return conflicts.sort((a, b) => `${a.scope}:${a.shortcut}:${a.actionIds.join(":")}`.localeCompare(`${b.scope}:${b.shortcut}:${b.actionIds.join(":")}`));
}

export function getRegisteredAction(actionId: string): ActionDef | undefined {
  return getRegisteredActions().find((action) => action.id === actionId);
}

/** Execute one registry command while preserving a focused surface's chord ownership on no-op. */
export function executeAvailableRegisteredAction(actionId: string): ShortcutHandlerResult {
  const action = getRegisteredAction(actionId);
  if (!action || (action.canHandleShortcut && !action.canHandleShortcut())) {
    return "claimed_noop";
  }
  action.execute();
  return "handled";
}

export function getActionShortcut(actionId: string): string | undefined {
  return getRegisteredAction(actionId)?.shortcut;
}

export function getEffectiveActionShortcut(actionId: string): string | undefined {
  const state = useDAWStore.getState();
  const platform = getShortcutPlatform();
  const customShortcuts = resolveCustomShortcutBindings(
    state.customShortcuts,
    actionId,
    platform,
  );
  if (customShortcuts !== undefined) return customShortcuts[0] ?? "";

  const profileShortcuts = getProfileActionBindings(
    state.keyboardShortcutProfileId,
    actionId,
    platform,
  );
  // A profile-owned empty list is an intentional unbind (for example when a
  // source DAW uses OpenStudio's factory key for a different command). Keep
  // display helpers in parity with the dispatcher instead of falling through
  // to the factory shortcut.
  if (profileShortcuts !== undefined) return profileShortcuts[0] ?? "";

  return getActionShortcut(actionId);
}

/** Platform-formatted shortcut for display (e.g. "Cmd+Z" on Mac, "Ctrl+Z" on Windows). */
export function getDisplayShortcut(actionId: string): string | undefined {
  const s = getActionShortcut(actionId);
  return s ? formatShortcut(s) : undefined;
}

/** Platform-formatted effective shortcut (custom override + platform formatting) for display. */
export function getDisplayEffectiveShortcut(actionId: string): string | undefined {
  const s = getEffectiveActionShortcut(actionId);
  if (s === undefined) return undefined;
  return s ? formatShortcut(s) : "";
}

export function getActionShortcutScope(actionId: string): ActionShortcutScope | undefined {
  return getRegisteredAction(actionId)?.shortcutScope;
}

export function getActionShortcutScopeLabel(scope?: ActionShortcutScope): string {
  switch (scope) {
    case "timeline": return "Timeline";
    case "timeline_ruler": return "Timeline Ruler";
    case "track_control_panel": return "Track Control Panel";
    case "mixer": return "Mixer";
    case "pitch_editor": return "Pitch Editor";
    case "piano_roll": return "Piano Roll";
    case "automation": return "Automation";
    case "browser": return "Browser";
    case "plugin": return "Plug-in";
    case "modal": return "Modal";
    case "contextual": return "Contextual";
    case "global":
    default:
      return "Global";
  }
}

export function getGlobalShortcutConflicts(): string[] {
  const owners = new Map<string, string>();
  const conflicts = new Set<string>();

  for (const action of getRegisteredActions()) {
    if ((action.shortcutScope ?? "global") !== "global") continue;
    const shortcuts = [action.shortcut, ...(action.shortcutAliases ?? [])].filter(
      (shortcut): shortcut is string => Boolean(shortcut)
    );

    for (const shortcut of shortcuts) {
      if (shortcut.includes("(")) continue;
      const existing = owners.get(shortcut);
      if (existing && existing !== action.id) {
        conflicts.add(`${shortcut}: ${existing}, ${action.id}`);
      } else {
        owners.set(shortcut, action.id);
      }
    }
  }

  return [...conflicts].sort();
}
