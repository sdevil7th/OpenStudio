import { create } from "zustand";
import { nativeBridge, PitchNoteData, PitchContourData, type PitchCorrectionCompletionData, type PitchCorrectionRenderMode, type PitchPreviewRoutingStatus } from "../services/NativeBridge";
import { useDAWStore } from "./useDAWStore";
import { logBridgeError } from "../utils/bridgeErrorHandler";

export type PitchEditorTool = "select" | "pitch" | "drift" | "vibrato" | "transition" | "draw" | "split";
export type PitchSnapMode = "off" | "chromatic" | "scale";
// Keep disabled until the active final-render backend declares explicit formant control.
export const PITCH_EDITOR_FORMANT_EDITING_ENABLED = false;
export type PitchEditorApplyState =
  | "idle"
  | "queued"
  | "processing"
  | "preview_processing"
  | "preview_ready"
  | "final_processing"
  | "done"
  | "error";

export type PitchAnalysisPhase = "idle" | "loading" | "analyzing";

export type PitchRenderCoverageState = "pending" | "preview_ready" | "hq_ready";

export type PitchRenderCoverageKind = "edited" | "edit_island" | "left_neighbor_tail" | "right_neighbor_head";

export interface PitchRenderCoverageRange {
  startTime: number;
  endTime: number;
  state: PitchRenderCoverageState;
  kind?: PitchRenderCoverageKind;
  noteId?: string;
}

// Scale interval templates
export const SCALE_INTERVALS: Record<string, number[]> = {
  chromatic:       [0,1,2,3,4,5,6,7,8,9,10,11],
  major:           [0,2,4,5,7,9,11],
  natural_minor:   [0,2,3,5,7,8,10],
  harmonic_minor:  [0,2,3,5,7,8,11],
  melodic_minor:   [0,2,3,5,7,9,11],
  dorian:          [0,2,3,5,7,9,10],
  mixolydian:      [0,2,4,5,7,9,10],
  phrygian:        [0,1,3,5,7,8,10],
  lydian:          [0,2,4,6,7,9,11],
  locrian:         [0,1,3,5,6,8,10],
  pentatonic_major:[0,2,4,7,9],
  pentatonic_minor:[0,3,5,7,10],
  blues:           [0,3,5,6,7,10],
  whole_tone:      [0,2,4,6,8,10],
  diminished:      [0,2,3,5,6,8,9,11],
};

function buildScaleNotes(key: number, type: string): boolean[] {
  const intervals = SCALE_INTERVALS[type] || SCALE_INTERVALS.chromatic;
  const notes = new Array(12).fill(false);
  for (const interval of intervals) {
    notes[(key + interval) % 12] = true;
  }
  return notes;
}

interface UndoEntry {
  description: string;
  notes: PitchNoteData[];
  selectedNoteIds: string[];
}

function clonePitchNotes(notes: PitchNoteData[]): PitchNoteData[] {
  return JSON.parse(JSON.stringify(notes));
}

function filterSelectedNoteIdsForNotes(selectedNoteIds: string[], notes: PitchNoteData[]): string[] {
  if (selectedNoteIds.length === 0 || notes.length === 0) return [];
  const validIds = new Set(notes.map((note) => note.id));
  return selectedNoteIds.filter((id) => validIds.has(id));
}

function pitchNotesEqual(a: PitchNoteData[], b: PitchNoteData[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const REFERENCE_COLORS = ["#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#14b8a6"];

export interface ReferenceTrack {
  trackId: string;
  clipId: string;
  trackName: string;
  color: string;
  contour: PitchContourData | null;
  notes: PitchNoteData[];
  visible: boolean;
}

interface PitchEditorState {
  // Data
  trackId: string | null;
  clipId: string | null;
  fxIndex: number;
  clipStartTime: number;  // clip's start time in project (seconds) — set once in open()
  clipDuration: number;   // clip's duration (seconds) — set once in open()
  /** Path to the original (pre-correction) audio file, captured once when the editor opens.
   *  Analysis MUST always use this path so that pitch frames match the original audio that
   *  applyPitchCorrection() processes.  After applyPitchCorrection(), clip.filePath in the
   *  DAW store is updated to the corrected _pcN.wav file — but using that for analysis would
   *  give corrected-audio pitch values as detectedPitch, causing wrong ratios on subsequent
   *  edits (E4 frames applied to C4 audio = garbage output). */
  originalClipFilePath: string | null;
  /** The clip's file offset (seconds) at editor-open time. After correction clip.offset is
   *  reset to 0 (corrected file always starts at 0), but the original file still needs the
   *  original offset to seek to the right position for analysis. */
  originalClipOffset: number;
  contour: PitchContourData | null;
  notes: PitchNoteData[];
  isAnalyzing: boolean;
  analysisPhase: PitchAnalysisPhase;
  isApplying: boolean;
  progressPercent: number;   // 0-100, for analysis/correction progress display
  progressLabel: string;     // e.g. "Analyzing..." or "Applying correction..."
  applyState: PitchEditorApplyState;
  applyMessage: string;
  lastApplyRequestId: string | null;
  renderCoverage: PitchRenderCoverageRange[];
  activeLogicalRequestId: string | null;

  // Selection & tool
  selectedNoteIds: string[];
  tool: PitchEditorTool;
  snapMode: PitchSnapMode;

  // Viewport
  scrollX: number; // seconds offset
  scrollY: number; // MIDI note offset (bottom of viewport)
  zoomX: number;   // pixels per second
  zoomY: number;   // pixels per semitone

  // Undo
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // Actions
  open: (trackId: string, clipId: string, fxIndex: number) => void;
  close: () => void;
  analyze: (viewStartTime?: number, viewEndTime?: number) => Promise<void>;
  setTool: (tool: PitchEditorTool) => void;
  setSnapMode: (mode: PitchSnapMode) => void;
  selectNote: (noteId: string, addToSelection?: boolean) => void;
  selectAll: () => void;
  deselectAll: () => void;
  setSelectedNoteIds: (ids: string[]) => void;

  // Note editing (with undo)
  beginInteractivePreview: (noteId: string) => void;
  endInteractivePreview: () => void;
  updateNote: (noteId: string, changes: Partial<PitchNoteData>) => void;
  commitNoteEdit: () => void;  // Call on mouseup/drag-end to trigger auto-apply
  updateSelectedNotes: (changes: Partial<PitchNoteData>) => void;
  moveSelectedPitch: (semitones: number) => void;
  splitNote: (noteId: string, time: number) => void;
  correctSelectedToScale: () => void;
  correctAllToScale: () => void;

  // Undo/redo
  undo: () => void;
  redo: () => void;
  pushUndo: (description: string) => void;

  // Viewport
  setScrollX: (x: number) => void;
  setScrollY: (y: number) => void;
  setZoomX: (z: number) => void;
  setZoomY: (z: number) => void;

  // Apply
  applyCorrection: () => Promise<void>;
  previewCorrection: () => Promise<void>;

  // Multi-track reference
  referenceTracks: ReferenceTrack[];
  addReferenceTrack: (trackId: string, clipId: string, trackName: string) => Promise<void>;
  removeReferenceTrack: (trackId: string) => void;
  toggleReferenceVisibility: (trackId: string) => void;

  // Scale/key
  scaleKey: number;           // 0=C, 1=C#, ..., 11=B
  scaleType: string;          // "chromatic" | "major" | etc.
  scaleNotes: boolean[];      // 12 booleans, which semitone classes are in scale

  // Inspector
  inspectorExpanded: boolean;

  // Global formant shift (applied additively to all notes on correction)
  globalFormantCents: number;  // -386 to +386 cents
  setGlobalFormantCents: (cents: number) => void;

  // Correct Pitch macro
  showCorrectPitchModal: boolean;

  // Scale actions
  setScale: (key: number, type: string) => void;
  autoDetectScale: () => void;
  toggleInspector: () => void;
  toggleCorrectPitchModal: () => void;

  // Inspector editing actions
  setNoteFormant: (noteId: string, semitones: number) => void;
  setNoteGain: (noteId: string, dB: number) => void;
  setNoteModulation: (noteId: string, percent: number) => void;
  setNoteDrift: (noteId: string, percent: number) => void;
  setNoteTransition: (noteId: string, inMs: number, outMs: number) => void;

  // Macro correction
  applyCorrectPitchMacro: (pitchCenter: number, pitchDrift: number, useScale: boolean) => void;

  // Merge notes
  mergeNotes: (noteIds: string[]) => void;

  // Draw pitch tool — write freehand pitch curve into note's pitchDrift
  drawPitchOnNote: (noteId: string, clipTime: number, midiPitch: number) => void;
  beginDrawPitch: () => void;
  commitDrawPitch: () => void;

  // A/B comparison
  abCompareMode: boolean;       // true = playing original (bypass correction)
  toggleABCompare: () => void;
}

// Tracks the active pitchAnalysisComplete listener so stale listeners from
// previous analyze() calls can be cancelled before subscribing a new one.
// Without this, a stale listener fires for the next analysis result,
// doubling the notes and corrupting pitch correction data.
let _pitchAnalysisUnsubscribe: (() => void) | null = null;
let _deferredAnalysisRange: { start?: number; end?: number } | null = null;
let _noteHqApplyInFlight = false;
let _analysisRunSeq = 0;

let _pitchCorrectionRequestSeq = 0;
let _logicalApplySeq = 0;
let _activePitchCorrectionRequestId: string | null = null;
let _applyStateResetTimer: ReturnType<typeof setTimeout> | null = null;
let _rollingPreviewRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let _fullClipHqTimer: ReturnType<typeof setTimeout> | null = null;
let _dawTransportSubscriptionInitialized = false;
let _editRevision = 0;
let _requestedApplyRevision = 0;
let _appliedRevision = 0;
type PitchApplyRenderStage = "single" | "preview_segment" | "full_clip_hq" | "note_hq";
type PitchPreviewMonitorMode = "none" | "scrub" | "clip_live_preview";
let _interactivePreviewNoteId: string | null = null;
let _interactivePreviewActive = false;
let _activePitchPreviewMonitorMode: PitchPreviewMonitorMode = "none";
let _dirtyPitchNoteIds = new Set<string>();
const _requestRevisionById = new Map<string, number>();
interface PendingPreviewSegment {
  startSec: number;
  endSec: number;
  index: number;
}
interface ApplyRequestSummary {
  noteCount: number;
  pitchEdits: number;
  noteFormantEdits: number;
  gainEdits: number;
  driftEdits: number;
  vibratoEdits: number;
  hasPitch: boolean;
  hasFormant: boolean;
  hasOther: boolean;
  mode: "none" | "pitch-only" | "formant-only" | "mixed";
  globalFormantCents: number;
  globalFormantSemitones: number;
}
interface PitchCorrectionRequestMeta {
  clipId: string;
  trackId: string;
  requestId: string;
  logicalRequestId: string;
  revision: number;
  stage: PitchApplyRenderStage;
  renderMode: PitchCorrectionRenderMode;
  notes: PitchNoteData[];
  frames?: PitchContourData["frames"];
  globalFormantSt: number;
  summary: ApplyRequestSummary;
  windowStartSec?: number;
  windowEndSec?: number;
  coverageRanges?: PitchRenderCoverageRange[];
  requestGroupId: string;
  segmentIndex?: number;
}
const _requestMetaById = new Map<string, PitchCorrectionRequestMeta>();

// Auto-apply debounce — fires 300ms after the last note mutation so playback
// swaps to a fresh note-local HQ render without requiring a manual Apply click.
let _autoApplyTimer: ReturnType<typeof setTimeout> | null = null;
// Throttle timer for real-time pitch preview during drag (max ~12fps, fast enough to feel live).
let _dragPreviewThrottle: ReturnType<typeof setTimeout> | null = null;
const FORMANT_LOG_PREFIX = "[pitchEditor.formant]";
const PREVIEW_SEGMENT_DURATION_SEC = 10;
const MAX_PREVIEW_SEGMENT_CONCURRENCY = 2;
const AUTO_BAKE_LOOKBEHIND_SEC = 0.25;
const AUTO_BAKE_LOOKAHEAD_SEC = 2.5;
const MAX_NEIGHBOR_LINK_GAP_SEC = 0.18;
let _activePreviewRequestGroupId: string | null = null;
let _pendingPreviewSegments: PendingPreviewSegment[] = [];
let _runningPreviewSegmentJobs = 0;
let _stagedPreviewBase: Omit<PitchCorrectionRequestMeta, "requestId" | "stage" | "renderMode" | "windowStartSec" | "windowEndSec" | "segmentIndex"> | null = null;

function shouldLogPitchEditorFormant() {
  const win = window as Window & { __S13_DEBUG_FORMANT__?: boolean; location?: { hostname?: string } };
  const host = win.location?.hostname ?? "";
  return win.__S13_DEBUG_FORMANT__ === true || host === "localhost" || host === "127.0.0.1";
}

function shouldCaptureAppFinalPitchContext(routeSuspect = false) {
  if (routeSuspect) return true;
  const win = window as Window & {
    __JUCE__?: { backend?: { capturePitchAppFinalContext?: unknown } };
    __S13_CAPTURE_APP_FINAL_PITCH__?: boolean;
  };
  if (win.__S13_CAPTURE_APP_FINAL_PITCH__ === false) return false;
  if (win.__S13_CAPTURE_APP_FINAL_PITCH__ === true) return true;
  try {
    const stored = window.localStorage?.getItem("s13.pitch.captureAppFinal");
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    // Ignore storage failures and fall through to native capability detection.
  }
  return typeof win.__JUCE__?.backend?.capturePitchAppFinalContext === "function";
}

function logPitchEditorFormant(message: string, extra?: Record<string, unknown>) {
  if (!shouldLogPitchEditorFormant()) return;
  if (extra) console.log(FORMANT_LOG_PREFIX, message, extra);
  else console.log(FORMANT_LOG_PREFIX, message);
}

function warnPitchEditorFormant(message: string, extra?: Record<string, unknown>) {
  if (extra) console.warn(FORMANT_LOG_PREFIX, message, extra);
  else console.warn(FORMANT_LOG_PREFIX, message);
}

function errorPitchEditorFormant(message: string, extra?: Record<string, unknown>) {
  if (extra) console.error(FORMANT_LOG_PREFIX, message, extra);
  else console.error(FORMANT_LOG_PREFIX, message);
}

function clearApplyStateResetTimer() {
  if (_applyStateResetTimer) {
    clearTimeout(_applyStateResetTimer);
    _applyStateResetTimer = null;
  }
}

function clearRollingPreviewRefreshTimer() {
  if (_rollingPreviewRefreshTimer) {
    clearTimeout(_rollingPreviewRefreshTimer);
    _rollingPreviewRefreshTimer = null;
  }
}

function clearFullClipHqTimer() {
  if (_fullClipHqTimer) {
    clearTimeout(_fullClipHqTimer);
    _fullClipHqTimer = null;
  }
}

function clearStagedPreviewQueue() {
  _activePreviewRequestGroupId = null;
  _pendingPreviewSegments = [];
  _runningPreviewSegmentJobs = 0;
  _stagedPreviewBase = null;
  clearFullClipHqTimer();
}

function deferPitchAnalysis(start?: number, end?: number, reason = "hq_priority") {
  _deferredAnalysisRange = { start, end };
  logPitchEditorFormant("pitch analysis deferred", { start: start ?? null, end: end ?? null, reason });
}

function cancelActivePitchAnalysisForHq() {
  _analysisRunSeq += 1;
  if (_pitchAnalysisUnsubscribe) {
    _pitchAnalysisUnsubscribe();
    _pitchAnalysisUnsubscribe = null;
  }
  usePitchEditorStore.setState((prev) => (
    prev.isAnalyzing
      ? { ...prev, isAnalyzing: false, analysisPhase: "idle", progressPercent: 0, progressLabel: "" }
      : prev
  ));
}

function retryDeferredPitchAnalysis() {
  if (_noteHqApplyInFlight || !_deferredAnalysisRange) return;
  const deferred = _deferredAnalysisRange;
  _deferredAnalysisRange = null;
  window.setTimeout(() => {
    usePitchEditorStore.getState().analyze(deferred.start, deferred.end);
  }, 0);
}

function finishNoteHqPriority(logicalRequestId?: string) {
  if (logicalRequestId && _activePitchCorrectionRequestId && _activePitchCorrectionRequestId !== logicalRequestId) {
    return;
  }
  if (!_noteHqApplyInFlight) return;
  _noteHqApplyInFlight = false;
  retryDeferredPitchAnalysis();
}

function markDirtyPitchNotes(noteIds: Iterable<string>) {
  for (const noteId of noteIds) {
    if (noteId) _dirtyPitchNoteIds.add(noteId);
  }
}

function replaceDirtyPitchNotes(noteIds: Iterable<string>) {
  _dirtyPitchNoteIds.clear();
  markDirtyPitchNotes(noteIds);
}

function resetApplyRevisions() {
  _editRevision = 0;
  _requestedApplyRevision = 0;
  _appliedRevision = 0;
  _interactivePreviewNoteId = null;
  _interactivePreviewActive = false;
  _activePitchPreviewMonitorMode = "none";
  _dirtyPitchNoteIds.clear();
  _requestRevisionById.clear();
  _requestMetaById.clear();
  _activePitchCorrectionRequestId = null;
  clearStagedPreviewQueue();
}

function markPitchEditorDirty(reason: string, extra?: Record<string, unknown>) {
  _editRevision += 1;
  logPitchEditorFormant("pitch editor state marked dirty", {
    reason,
    editRevision: _editRevision,
    requestedApplyRevision: _requestedApplyRevision,
    appliedRevision: _appliedRevision,
    ...extra,
  });
}

function consumeRequestRevision(requestId?: string | null) {
  if (!requestId) return null;
  const revision = _requestRevisionById.get(requestId) ?? null;
  _requestRevisionById.delete(requestId);
  return revision;
}

function setApplyStatus(
  state: PitchEditorApplyState,
  message: string,
  requestId?: string | null,
  options?: { autoClearMs?: number },
) {
  clearApplyStateResetTimer();
  usePitchEditorStore.setState((prev) => ({
    applyState: state,
    applyMessage: message,
    lastApplyRequestId: requestId !== undefined ? requestId : prev.lastApplyRequestId,
    isApplying: state === "queued"
      || state === "processing"
      || state === "preview_processing"
      || state === "final_processing",
  }));
  logPitchEditorFormant("apply state changed", { state, message, requestId: requestId ?? _activePitchCorrectionRequestId });
  if (options?.autoClearMs && state === "done") {
    _applyStateResetTimer = setTimeout(() => {
      usePitchEditorStore.setState((prev) => {
        if (prev.applyState !== "done") return prev;
        return {
          ...prev,
          applyState: "idle",
          applyMessage: "",
          lastApplyRequestId: null,
          isApplying: false,
        };
      });
      logPitchEditorFormant("apply state auto-cleared");
      _applyStateResetTimer = null;
    }, options.autoClearMs);
  }
}

function getEffectivePitchEditorGlobalFormantSt(globalFormantSt: number) {
  return PITCH_EDITOR_FORMANT_EDITING_ENABLED ? globalFormantSt : 0;
}

function getPitchCorrectionFailureMessage(data?: {
  hardFailReason?: string;
  fallbackReason?: string;
  pitchRenderBackendFailureCode?: string;
}) {
  const reason = (data?.hardFailReason || data?.fallbackReason || "").trim();
  return reason || "Pitch/formant apply failed";
}

function sanitizePitchEditorNotesForApply(notes: PitchNoteData[]) {
  const formantSanitizedNotes = PITCH_EDITOR_FORMANT_EDITING_ENABLED
    ? cloneNotesSnapshot(notes)
    : notes.map((note) => ({ ...note, formantShift: 0 }));
  return formantSanitizedNotes.map(applySampleMatchDownshiftDefaults);
}

function summarizeApplyRequest(notes: PitchNoteData[], globalFormantSt: number): ApplyRequestSummary {
  const effectiveGlobalFormantSt = getEffectivePitchEditorGlobalFormantSt(globalFormantSt);
  const effectiveNotes = PITCH_EDITOR_FORMANT_EDITING_ENABLED ? notes : sanitizePitchEditorNotesForApply(notes);
  let pitchEdits = 0;
  let noteFormantEdits = 0;
  let gainEdits = 0;
  let driftEdits = 0;
  let vibratoEdits = 0;
  for (const note of effectiveNotes) {
    if (Math.abs(note.correctedPitch - note.detectedPitch) > 0.01) pitchEdits++;
    if (Math.abs(note.formantShift) > 0.01) noteFormantEdits++;
    if (Math.abs(note.gain) > 0.01) gainEdits++;
    if (note.driftCorrectionAmount > 0.01) driftEdits++;
    if (Math.abs(note.vibratoDepth - 1.0) > 0.01) vibratoEdits++;
  }
  const hasGlobalFormant = Math.abs(effectiveGlobalFormantSt) > 0.01;
  let mode: "none" | "pitch-only" | "formant-only" | "mixed" = "none";
  const hasPitch = pitchEdits > 0;
  const hasFormant = hasGlobalFormant || noteFormantEdits > 0;
  const hasOther = gainEdits > 0 || driftEdits > 0 || vibratoEdits > 0;
  if (hasPitch && !hasFormant && !hasOther) mode = "pitch-only";
  else if (!hasPitch && hasFormant && !hasOther) mode = "formant-only";
  else if (hasPitch || hasFormant || hasOther) mode = "mixed";
  return {
    noteCount: notes.length,
    pitchEdits,
    noteFormantEdits,
    gainEdits,
    driftEdits,
    vibratoEdits,
    hasPitch,
    hasFormant,
    hasOther,
    globalFormantCents: Math.round(effectiveGlobalFormantSt * 100),
    globalFormantSemitones: effectiveGlobalFormantSt,
    mode,
  };
}

function cloneNotesSnapshot(notes: PitchNoteData[]) {
  return notes.map((note) => ({ ...note }));
}

function cloneFramesSnapshot(frames?: PitchContourData["frames"]) {
  if (!frames) return undefined;
  return JSON.parse(JSON.stringify(frames)) as PitchContourData["frames"];
}

const DRAW_VOICED_TOLERANCE_SEC = 0.04;
const IMMEDIATE_NEIGHBOR_SMOOTH_MS = 10;
const NOTE_HQ_DEFAULT_TRANSITION_IN_MS = 40;
const NOTE_HQ_DEFAULT_TRANSITION_OUT_MS = 60;
const NOTE_HQ_HARD_BOUNDARY_TRANSITION_IN_MS = 24;
const NOTE_HQ_HARD_BOUNDARY_TRANSITION_OUT_MS = 40;
const NOTE_HQ_SOFT_BOUNDARY_TRANSITION_MS = 80;
const NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_THRESHOLD_ST = -2.0;
const NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_VIBRATO_DEPTH = 0.70;
const NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_TRANSITION_IN_MS = 80;
const NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_TRANSITION_OUT_MS = 100;
const NOTE_HQ_NEXT_HEAD_OWNERSHIP_MS = 40;
const MAX_NOTE_HQ_TRANSITION_MS = 140;
const MAX_EDIT_ISLAND_GAP_SEC = 0.08;
const NOTE_HQ_INTERNAL_ISLAND_RAMP_MS = 32;

function noteHasPitchStyleEdit(note: PitchNoteData) {
  return Math.abs(note.correctedPitch - note.detectedPitch) > 0.01
    || note.driftCorrectionAmount > 0.01
    || Math.abs(note.vibratoDepth - 1.0) > 0.01
    || (Array.isArray(note.pitchDrift) && note.pitchDrift.some((v) => Math.abs(v) > 0.01));
}

function noteHasRenderableEdit(note: PitchNoteData) {
  return noteHasPitchStyleEdit(note)
    || Math.abs(note.gain) > 0.01
    || (PITCH_EDITOR_FORMANT_EDITING_ENABLED && Math.abs(note.formantShift) > 0.01);
}

function getNoteEffectiveTransitionMs(note: PitchNoteData, edge: "in" | "out") {
  const explicitMs = edge === "in" ? note.transitionIn : note.transitionOut;
  return explicitMs > 0 ? explicitMs : 0;
}

function getNoteHqBoundaryTransitionFloorMs(note: PitchNoteData, edge: "in" | "out") {
  if (isSampleMatchDownshift(note)) {
    return edge === "in"
      ? NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_TRANSITION_IN_MS
      : NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_TRANSITION_OUT_MS;
  }

  const kind = edge === "in" ? note.entryBoundaryKind : note.exitBoundaryKind;
  if (kind === "hard_word_like") {
    return edge === "in" ? NOTE_HQ_HARD_BOUNDARY_TRANSITION_IN_MS : NOTE_HQ_HARD_BOUNDARY_TRANSITION_OUT_MS;
  }
  if (kind === "soft_legato") {
    return NOTE_HQ_SOFT_BOUNDARY_TRANSITION_MS;
  }
  return edge === "in" ? NOTE_HQ_DEFAULT_TRANSITION_IN_MS : NOTE_HQ_DEFAULT_TRANSITION_OUT_MS;
}

function getNoteEffectiveStart(note: Pick<PitchNoteData, "startTime" | "effectiveStartTime">) {
  return note.effectiveStartTime ?? note.startTime;
}

function getNoteEffectiveEnd(note: Pick<PitchNoteData, "endTime" | "effectiveEndTime">) {
  return note.effectiveEndTime ?? note.endTime;
}

function getNoteWordGroupId(note: Pick<PitchNoteData, "id" | "wordGroupId">) {
  return note.wordGroupId && note.wordGroupId.trim().length > 0 ? note.wordGroupId : note.id;
}

function notesShareWordGroup(
  left: Pick<PitchNoteData, "id" | "wordGroupId">,
  right: Pick<PitchNoteData, "id" | "wordGroupId">,
) {
  return getNoteWordGroupId(left) === getNoteWordGroupId(right);
}

function getPitchShiftSemitones(note: Pick<PitchNoteData, "correctedPitch" | "detectedPitch">) {
  return note.correctedPitch - note.detectedPitch;
}

function isSampleMatchDownshift(note: Pick<PitchNoteData, "correctedPitch" | "detectedPitch">) {
  return getPitchShiftSemitones(note) <= NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_THRESHOLD_ST;
}

function applySampleMatchDownshiftDefaults(note: PitchNoteData): PitchNoteData {
  if (!isSampleMatchDownshift(note) || Math.abs(note.vibratoDepth - 1.0) > 0.01) {
    return note;
  }
  return {
    ...note,
    vibratoDepth: NOTE_HQ_SAMPLE_MATCH_DOWNSHIFT_VIBRATO_DEPTH,
  };
}

function sharesTransitionPair(
  left: Pick<PitchNoteData, "startTime" | "endTime" | "effectiveStartTime" | "effectiveEndTime" | "correctedPitch" | "detectedPitch" | "transitionIn" | "transitionOut">,
  right: Pick<PitchNoteData, "startTime" | "endTime" | "effectiveStartTime" | "effectiveEndTime" | "correctedPitch" | "detectedPitch" | "transitionIn" | "transitionOut">,
) {
  const gapSec = right.startTime - left.endTime;
  return gapSec <= MAX_NEIGHBOR_LINK_GAP_SEC
    || getNoteEffectiveStart(right) <= getNoteEffectiveEnd(left) + MAX_NEIGHBOR_LINK_GAP_SEC;
}

function normalizePitchNote(note: PitchNoteData): PitchNoteData {
  const effectiveStartTime = Math.max(0, note.startTime - getNoteEffectiveTransitionMs(note, "in") / 1000);
  const effectiveEndTime = Math.max(note.endTime, note.endTime + getNoteEffectiveTransitionMs(note, "out") / 1000);
  return {
    ...note,
    wordGroupId: getNoteWordGroupId(note),
    effectiveStartTime,
    effectiveEndTime,
  };
}

function normalizePitchNotes(notes: PitchNoteData[]) {
  return notes
    .map((note) => normalizePitchNote(note))
    .sort((a, b) => a.startTime - b.startTime);
}

function expandDirtyPitchNoteIdsWithNeighbors(noteIds: Iterable<string>, notes: PitchNoteData[]) {
  const sortedNotes = [...notes].sort((a, b) => a.startTime - b.startTime);
  const dirtyIds = new Set<string>();
  for (const noteId of noteIds) {
    if (noteId) dirtyIds.add(noteId);
  }

  for (let index = 0; index < sortedNotes.length; index += 1) {
    const note = sortedNotes[index];
    if (!dirtyIds.has(note.id)) continue;

    const prev = sortedNotes[index - 1];
    if (prev && sharesTransitionPair(prev, note)) {
      dirtyIds.add(prev.id);
    }

    const next = sortedNotes[index + 1];
    if (next && sharesTransitionPair(note, next)) {
      dirtyIds.add(next.id);
    }
  }

  return dirtyIds;
}

function isVoicedAtClipTime(contour: PitchContourData | null, clipTime: number) {
  const frames = contour?.frames;
  if (!frames || frames.times.length === 0) return true;

  let closestIndex = -1;
  let closestDt = Number.POSITIVE_INFINITY;
  for (let i = 0; i < frames.times.length; i++) {
    const dt = Math.abs(frames.times[i] - clipTime);
    if (dt < closestDt) {
      closestDt = dt;
      closestIndex = i;
    }
  }

  if (closestIndex < 0 || closestDt > DRAW_VOICED_TOLERANCE_SEC) return false;
  return Boolean(frames.voiced[closestIndex]) && (frames.midi[closestIndex] ?? 0) > 0 && (frames.confidence[closestIndex] ?? 0) >= 0.15;
}

function buildLogicalApplyRequestId(clipId: string) {
  return `${clipId}:apply:${++_logicalApplySeq}`;
}

function buildStageRequestId(logicalRequestId: string, stage: PitchApplyRenderStage) {
  return `${logicalRequestId}:${stage}:${++_pitchCorrectionRequestSeq}`;
}

function buildPreviewSegmentRanges(clipDuration: number, playheadSec: number): PendingPreviewSegment[] {
  const totalSegments = Math.max(1, Math.ceil(clipDuration / PREVIEW_SEGMENT_DURATION_SEC));
  const startIndex = Math.max(0, Math.min(totalSegments - 1, Math.floor(playheadSec / PREVIEW_SEGMENT_DURATION_SEC)));
  const orderedIndices = [
    ...Array.from({ length: totalSegments - startIndex }, (_, i) => startIndex + i),
    ...Array.from({ length: startIndex }, (_, i) => i),
  ];
  return orderedIndices.map((index) => ({
    index,
    startSec: index * PREVIEW_SEGMENT_DURATION_SEC,
    endSec: Math.min(clipDuration, (index + 1) * PREVIEW_SEGMENT_DURATION_SEC),
  }));
}

function setRenderCoverage(ranges: PitchRenderCoverageRange[], logicalRequestId: string | null) {
  usePitchEditorStore.setState((prev) => ({
    ...prev,
    renderCoverage: ranges,
    activeLogicalRequestId: logicalRequestId,
  }));
}

function updateRenderCoverageRange(startTime: number, endTime: number, state: PitchRenderCoverageState) {
  usePitchEditorStore.setState((prev) => ({
    ...prev,
    renderCoverage: prev.renderCoverage.map((range) => (
      Math.abs(range.startTime - startTime) < 0.001 && Math.abs(range.endTime - endTime) < 0.001
        ? { ...range, state }
        : range
    )),
  }));
}

function markAllRenderCoverage(state: PitchRenderCoverageState, logicalRequestId: string) {
  usePitchEditorStore.setState((prev) => {
    if (prev.activeLogicalRequestId !== logicalRequestId) return prev;
    return {
      ...prev,
      renderCoverage: prev.renderCoverage.map((range) => ({ ...range, state })),
    };
  });
}

function registerRequestMeta(meta: PitchCorrectionRequestMeta) {
  _requestRevisionById.set(meta.requestId, meta.revision);
  _requestMetaById.set(meta.requestId, meta);
}

function consumeRequestMeta(requestId?: string | null) {
  if (!requestId) return null;
  const meta = _requestMetaById.get(requestId) ?? null;
  _requestMetaById.delete(requestId);
  return meta;
}

function hasRequestedFormantWork(notes: PitchNoteData[], globalFormantSt: number) {
  if (!PITCH_EDITOR_FORMANT_EDITING_ENABLED) return false;
  return Math.abs(globalFormantSt) > 0.01
    || notes.some((n) => Math.abs(n.formantShift) > 0.01);
}

function hasRealtimePitchPreviewWork(notes: PitchNoteData[], globalFormantSt: number) {
  void globalFormantSt;
  return notes.some((n) => Math.abs(n.correctedPitch - n.detectedPitch) > 0.01);
}

function buildEditedNoteWindow(notes: PitchNoteData[], clipDuration: number) {
  const edited = notes.filter((note) => noteHasRenderableEdit(note));
  if (edited.length === 0) return null;

  const sortedNotes = [...notes].sort((a, b) => a.startTime - b.startTime);
  const noteIndexById = new Map(sortedNotes.map((note, index) => [note.id, index] as const));
  const editedIdSet = new Set(edited.map((note) => note.id));
  const dirtyEditedIds = [..._dirtyPitchNoteIds].filter((id) => editedIdSet.has(id) && noteIndexById.has(id));
  const focusIdSet = new Set(dirtyEditedIds.length > 0 ? dirtyEditedIds : edited.map((note) => note.id));
  const focusIndices = [...focusIdSet]
    .map((id) => noteIndexById.get(id) ?? -1)
    .filter((index) => index >= 0);

  if (focusIndices.length === 0) return null;

  const coverageRanges: PitchRenderCoverageRange[] = [];
  const requestNotes = new Map<string, PitchNoteData>();

  const upsertRequestNote = (note: PitchNoteData, patch?: Partial<PitchNoteData>) => {
    const existing = requestNotes.get(note.id) ?? { ...note };
    const merged = applySampleMatchDownshiftDefaults({ ...existing, ...patch });
    requestNotes.set(note.id, merged);
    return merged;
  };

  const addCoverageRange = (
    startTime: number,
    endTime: number,
    kind: PitchRenderCoverageKind,
    noteId: string,
  ) => {
    const clampedStart = Math.max(0, Math.min(clipDuration, startTime));
    const clampedEnd = Math.max(clampedStart, Math.min(clipDuration, endTime));
    if (clampedEnd - clampedStart < 0.0005) return;
    coverageRanges.push({
      startTime: clampedStart,
      endTime: clampedEnd,
      state: "pending",
      kind,
      noteId,
    });
  };

  const sortedFocusIndices = [...new Set(focusIndices)].sort((a, b) => a - b);
  const islands: number[][] = [];
  for (const index of sortedFocusIndices) {
    const note = sortedNotes[index];
    if (!note || !noteHasRenderableEdit(note)) continue;

    const previousIsland = islands[islands.length - 1];
    const previousIndex = previousIsland?.[previousIsland.length - 1];
    const previousNote = previousIndex !== undefined ? sortedNotes[previousIndex] : null;
    const joinsPrevious = Boolean(previousNote)
      && (
        notesShareWordGroup(previousNote!, note)
        || index === previousIndex! + 1
        || note.startTime - previousNote!.endTime <= MAX_EDIT_ISLAND_GAP_SEC
      );

    if (!previousIsland || !joinsPrevious) {
      islands.push([index]);
    } else {
      previousIsland.push(index);
    }
  }

  for (const island of islands) {
    const firstIndex = island[0];
    const lastIndex = island[island.length - 1];
    const firstNote = sortedNotes[firstIndex];
    const lastNote = sortedNotes[lastIndex];
    if (!firstNote || !lastNote) continue;

    const prev = sortedNotes[firstIndex - 1];
    const next = sortedNotes[lastIndex + 1];
    const usePrev = Boolean(prev && sharesTransitionPair(prev, firstNote));
    const useNext = Boolean(next && sharesTransitionPair(lastNote, next));

    const entryTransitionMs = Math.min(MAX_NOTE_HQ_TRANSITION_MS, Math.max(
      getNoteEffectiveTransitionMs(firstNote, "in"),
      getNoteHqBoundaryTransitionFloorMs(firstNote, "in"),
      usePrev ? IMMEDIATE_NEIGHBOR_SMOOTH_MS : 0,
    ));
    const exitTransitionMs = Math.min(MAX_NOTE_HQ_TRANSITION_MS, Math.max(
      getNoteEffectiveTransitionMs(lastNote, "out"),
      getNoteHqBoundaryTransitionFloorMs(lastNote, "out"),
      useNext ? Math.max(IMMEDIATE_NEIGHBOR_SMOOTH_MS, NOTE_HQ_NEXT_HEAD_OWNERSHIP_MS) : 0,
    ));

    for (let localIndex = 0; localIndex < island.length; localIndex += 1) {
      const noteIndex = island[localIndex];
      const editedNote = sortedNotes[noteIndex];
      const previousEdited = localIndex > 0 ? sortedNotes[island[localIndex - 1]] : null;
      const nextEdited = localIndex + 1 < island.length ? sortedNotes[island[localIndex + 1]] : null;
      const previousShiftDiff = previousEdited
        ? Math.abs(getPitchShiftSemitones(previousEdited) - getPitchShiftSemitones(editedNote))
        : 0;
      const nextShiftDiff = nextEdited
        ? Math.abs(getPitchShiftSemitones(nextEdited) - getPitchShiftSemitones(editedNote))
        : 0;
      const internalInMs = previousEdited && previousShiftDiff > 0.01 ? NOTE_HQ_INTERNAL_ISLAND_RAMP_MS : 0;
      const internalOutMs = nextEdited && nextShiftDiff > 0.01 ? NOTE_HQ_INTERNAL_ISLAND_RAMP_MS : 0;
      const transitionInMs = localIndex === 0 ? entryTransitionMs : internalInMs;
      const transitionOutMs = localIndex === island.length - 1 ? exitTransitionMs : internalOutMs;
      const effectiveStartTime = Math.max(0, editedNote.startTime - transitionInMs / 1000);
      const effectiveEndTime = Math.min(clipDuration, editedNote.endTime + transitionOutMs / 1000);

      upsertRequestNote(editedNote, {
        transitionIn: transitionInMs,
        transitionOut: transitionOutMs,
        effectiveStartTime,
        effectiveEndTime,
      });
    }

    const islandStart = Math.max(0, firstNote.startTime - entryTransitionMs / 1000);
    const islandEnd = Math.min(clipDuration, lastNote.endTime + exitTransitionMs / 1000);
    addCoverageRange(islandStart, islandEnd, "edit_island", firstNote.id);

    if (usePrev && prev) {
      upsertRequestNote(prev, {
        transitionIn: 0,
        transitionOut: 0,
        effectiveStartTime: prev.startTime,
        effectiveEndTime: prev.endTime,
      });
      addCoverageRange(islandStart, firstNote.startTime, "left_neighbor_tail", prev.id);
    }

    if (useNext && next) {
      upsertRequestNote(next, {
        transitionIn: 0,
        transitionOut: 0,
        effectiveStartTime: next.startTime,
        effectiveEndTime: next.endTime,
      });
      addCoverageRange(lastNote.endTime, islandEnd, "right_neighbor_head", next.id);
    }
  }

  if (coverageRanges.length === 0 || requestNotes.size === 0) {
    return null;
  }

  const mergedCoverage = coverageRanges
    .slice()
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  let windowStartSec = mergedCoverage[0].startTime;
  let windowEndSec = mergedCoverage[0].endTime;
  for (const range of mergedCoverage) {
    windowStartSec = Math.min(windowStartSec, range.startTime);
    windowEndSec = Math.max(windowEndSec, range.endTime);
  }

  return {
    requestNotes: [...requestNotes.values()].sort((a, b) => a.startTime - b.startTime),
    windowStartSec: Math.max(0, windowStartSec),
    windowEndSec: Math.min(clipDuration, windowEndSec),
    coverageRanges: mergedCoverage,
  };
}

function buildInteractivePreviewPayload(note: PitchNoteData, globalFormantSt: number) {
  const semitoneDelta = note.correctedPitch - note.detectedPitch;
  const pitchRatio = Math.pow(2, semitoneDelta / 12);
  const previewStartSec = Math.max(0, getNoteEffectiveStart(note) - 0.04);
  const previewEndSec = Math.max(previewStartSec + 0.05, getNoteEffectiveEnd(note) + 0.04);
  return {
    pitchSegments: [{
      startTime: note.startTime,
      endTime: note.endTime,
      pitchRatio,
    }],
    globalFormantSemitones: getEffectivePitchEditorGlobalFormantSt(globalFormantSt),
    previewStartSec,
    previewEndSec,
    allowReplacingCorrectedSource: _interactivePreviewActive === true,
  };
}

function startPitchScrubPreviewForNote(noteId: string) {
  const { trackId, clipId, notes, contour } = usePitchEditorStore.getState();
  if (!trackId || !clipId) return;
  const note = notes.find((candidate) => candidate.id === noteId);
  if (!note) return;
  nativeBridge.startPitchScrubPreview(trackId, clipId, note, contour?.frames)
    .catch(logBridgeError("startPitchScrubPreview"));
}

function clearTransientPitchPreview(clipId: string, reason: string) {
  nativeBridge.stopPitchScrubPreview(clipId).catch(logBridgeError("stopPitchScrubPreview"));
  nativeBridge.clearClipPitchPreview(clipId).catch(logBridgeError("clearClipPitchPreview"));
  _activePitchPreviewMonitorMode = "none";
  logPitchEditorFormant("cleared transient pitch preview", { clipId, reason });
}

function clearRenderedPreviewForInteractiveEdit(clipId: string, reason: string) {
  nativeBridge.clearClipRenderedPreviewSegments(clipId).catch(logBridgeError("clearClipRenderedPreviewSegments"));
  logPitchEditorFormant("cleared rendered pitch preview for interactive edit", { clipId, reason });
}

function isCleanNoteHqFinalRoute(status: PitchPreviewRoutingStatus | null) {
  return Boolean(status)
    && status?.monitorMode === "corrected_source"
    && status.correctedSourceActive === true
    && status.renderedSegmentActive === false
    && status.clipLivePreviewActive === false
    && status.scrubPreviewActive === false;
}

function routeSummary(status: PitchPreviewRoutingStatus | null) {
  if (!status) return null;
  return {
    monitorMode: status.monitorMode,
    correctedSourceActive: status.correctedSourceActive,
    renderedSegmentActive: status.renderedSegmentActive,
    clipLivePreviewActive: status.clipLivePreviewActive,
    scrubPreviewActive: status.scrubPreviewActive,
  };
}

async function clearAllPitchPreviewRoutes(clipId: string, reason: string) {
  _activePitchPreviewMonitorMode = "none";
  await nativeBridge.clearAllPitchPreviewRoutes(clipId).catch(logBridgeError("clearAllPitchPreviewRoutes"));
  logPitchEditorFormant("cleared all pitch preview routes", { clipId, reason });
}

async function clearCorrectedSourcePreviewRoutesBeforePlayback(clipId: string) {
  let status: PitchPreviewRoutingStatus | null = null;
  try {
    status = await nativeBridge.getPitchPreviewRoutingStatus(clipId);
  } catch (err) {
    warnPitchEditorFormant("transport-start route query failed", {
      clipId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!status?.correctedSourceActive) return;
  const previewRouteActive = status.renderedSegmentActive
    || status.clipLivePreviewActive
    || status.scrubPreviewActive;
  if (!previewRouteActive) return;

  warnPitchEditorFormant("transport start found corrected source with stale pitch preview route; clearing", {
    clipId,
    route: routeSummary(status),
  });
  await clearAllPitchPreviewRoutes(clipId, "transport_start_corrected_source");
}

function pathWithSuffix(filePath: string, suffix: string, extension: string) {
  const slashIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dotIndex = filePath.lastIndexOf(".");
  const base = dotIndex > slashIndex ? filePath.slice(0, dotIndex) : filePath;
  return `${base}${suffix}${extension}`;
}

function safeCaptureToken(value: string | undefined | null) {
  const raw = value && value.trim().length > 0 ? value : `${Date.now()}`;
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(-72);
}

async function captureAppFinalPitchContext(
  meta: PitchCorrectionRequestMeta,
  data: PitchCorrectionCompletionData,
  routeBeforeRepair: PitchPreviewRoutingStatus | null,
  routeAfterRepair: PitchPreviewRoutingStatus | null,
  routeSuspect: boolean,
) {
  if (!data.outputFile || !shouldCaptureAppFinalPitchContext(routeSuspect)) return;

  const editedNotes = meta.notes.filter((note) => Math.abs(note.correctedPitch - note.detectedPitch) > 0.01);
  if (editedNotes.length === 0) return;

  const state = usePitchEditorStore.getState();
  const clipDuration = state.clipDuration || Math.max(...editedNotes.map(getNoteEffectiveEnd));
  const noteStartSec = Math.max(0, Math.min(...editedNotes.map(getNoteEffectiveStart)));
  const noteEndSec = Math.max(noteStartSec, Math.max(...editedNotes.map(getNoteEffectiveEnd)));
  const contextStartSec = Math.max(0, noteStartSec - 0.5);
  const contextEndSec = Math.min(clipDuration, noteEndSec + 0.6);
  const durationSec = Math.max(0.25, contextEndSec - contextStartSec);
  const projectStartSec = state.clipStartTime + contextStartSec;
  const token = safeCaptureToken(meta.logicalRequestId || meta.requestId);
  const wavPath = pathWithSuffix(data.outputFile, `_appfinal_${token}_context`, ".wav");
  const routeJsonPath = pathWithSuffix(data.outputFile, `_appfinal_${token}_route`, ".json");
  const shifts = editedNotes.map((note) => note.correctedPitch - note.detectedPitch);
  const editedNoteDiagnostics = editedNotes.map((note) => ({
    id: note.id,
    startTime: note.startTime,
    endTime: note.endTime,
    effectiveStartTime: getNoteEffectiveStart(note),
    effectiveEndTime: getNoteEffectiveEnd(note),
    detectedPitch: note.detectedPitch,
    correctedPitch: note.correctedPitch,
    requestedShiftSemitones: note.correctedPitch - note.detectedPitch,
    pitchDrift: note.pitchDrift ?? null,
    vibratoDepth: note.vibratoDepth ?? null,
    vibratoRate: note.vibratoRate ?? null,
    formantShift: note.formantShift ?? null,
    gainDb: note.gain ?? null,
  }));

  const capture = await nativeBridge.capturePitchAppFinalContext({
    trackId: meta.trackId,
    clipId: meta.clipId,
    startTime: projectStartSec,
    duration: durationSec,
    wavPath,
    routeJsonPath,
    sampleRate: 44100,
    metadata: {
      requestId: meta.requestId,
      logicalRequestId: meta.logicalRequestId,
      renderMode: data.renderMode ?? meta.renderMode,
      outputFile: data.outputFile,
      routeSuspect,
      routeBeforeRepair: routeSummary(routeBeforeRepair),
      routeAfterRepair: routeSummary(routeAfterRepair),
      postApplyRouteStatus: routeSummary(data.postApplyRouteStatus ?? null),
      clipContextStartSec: contextStartSec,
      clipContextEndSec: contextEndSec,
      projectStartSec,
      noteStartSec,
      noteEndSec,
      snapMode: state.snapMode,
      scaleType: state.scaleType,
      chromaticSnapActive: state.snapMode === "chromatic",
      exactRelativeShiftRequested: data.targetShiftSemitones ?? null,
      editedNoteCount: editedNotes.length,
      editedNotes: editedNoteDiagnostics,
      requestedShiftSemitonesMin: Math.min(...shifts),
      requestedShiftSemitonesMax: Math.max(...shifts),
      actualRequestedShiftSemitones: data.actualRequestedShiftSemitones ?? null,
      requestedShiftErrorCents: data.requestedShiftErrorCents ?? null,
      actualRendererBranch: data.actualRendererBranch ?? null,
      formantCurveUsed: data.formantCurveUsed ?? null,
      backendAppFinalRouteReportPath: data.appFinalRouteReportPath ?? null,
      backendAppFinalBakedContextPath: data.appFinalBakedContextPath ?? null,
      backendAppFinalPlaybackContextPath: data.appFinalPlaybackContextPath ?? null,
      backendAppFinalParityReportPath: data.appFinalParityReportPath ?? null,
      backendAppFinalParityReport: data.appFinalParityReport ?? null,
    },
  });

  const debugPaths = {
    backendBakedContextPath: data.appFinalBakedContextPath ?? data.appFinalBakedCapture?.filePath ?? null,
    backendPlaybackContextPath: data.appFinalPlaybackContextPath ?? data.appFinalCapture?.capture?.filePath ?? null,
    backendParityReportPath: data.appFinalParityReportPath ?? null,
    backendRouteReportPath: data.appFinalRouteReportPath ?? null,
    frontendBakedCorrectedPath: capture?.bakedCorrectedPath ?? null,
    frontendLivePlaybackContextPath: capture?.livePlaybackPath ?? capture?.capture?.filePath ?? wavPath,
    frontendOfflineRenderContextPath: capture?.offlineRenderPath ?? null,
    frontendComparisonReportPath: capture?.comparisonReportPath ?? null,
    frontendRouteReportPath: capture?.routeReportPath ?? routeJsonPath,
  };

  logPitchEditorFormant("app-final pitch context capture finished", {
    clipId: meta.clipId,
    requestId: meta.requestId,
    success: capture?.success ?? false,
    ...debugPaths,
    routeBefore: routeSummary(capture?.routeBefore ?? null),
    routeAfter: routeSummary(capture?.routeAfter ?? null),
  });
  console.info("[pitchEditor] Last app-final pitch debug capture", debugPaths);
  useDAWStore.getState().showToast("Pitch debug capture written; paths are in the console", "success");
}

async function verifyNoteHqFinalRoute(
  meta: PitchCorrectionRequestMeta,
  data: PitchCorrectionCompletionData,
  reason: string,
  captureIfEnabled: boolean,
) {
  let routeBeforeRepair: PitchPreviewRoutingStatus | null = null;
  try {
    routeBeforeRepair = await nativeBridge.getPitchPreviewRoutingStatus(meta.clipId);
  } catch (err) {
    warnPitchEditorFormant("note-HQ final route query failed", {
      clipId: meta.clipId,
      requestId: meta.requestId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    if (reason === "immediate") {
      setApplyStatus("error", "HQ note route verification failed", meta.logicalRequestId, { autoClearMs: 2600 });
      useDAWStore.getState().showToast("Pitch note route verification failed", "error");
    }
    return;
  }

  const wasClean = isCleanNoteHqFinalRoute(routeBeforeRepair);
  let routeAfterRepair = routeBeforeRepair;
  if (!wasClean) {
    warnPitchEditorFormant("note-HQ final route was not clean; clearing stale pitch preview routes", {
      clipId: meta.clipId,
      requestId: meta.requestId,
      logicalRequestId: meta.logicalRequestId,
      reason,
      route: routeSummary(routeBeforeRepair),
    });
    await clearAllPitchPreviewRoutes(meta.clipId, `note_hq_route_repair:${reason}`);
    routeAfterRepair = await nativeBridge.getPitchPreviewRoutingStatus(meta.clipId).catch(() => null);
    const repaired = isCleanNoteHqFinalRoute(routeAfterRepair);
    setApplyStatus(
      repaired ? "done" : "error",
      repaired ? "HQ note render ready (route repaired)" : "HQ note render route suspect",
      meta.logicalRequestId,
      { autoClearMs: repaired ? 1800 : 3200 },
    );
    if (reason === "immediate") {
      useDAWStore.getState().showToast(
        repaired ? "Pitch note render ready" : "Pitch note route still suspect",
        repaired ? "success" : "error",
      );
    }
    logPitchEditorFormant("note-HQ final route repair result", {
      clipId: meta.clipId,
      requestId: meta.requestId,
      reason,
      repaired,
      routeAfter: routeSummary(routeAfterRepair),
    });
  } else {
    logPitchEditorFormant("note-HQ final route verified", {
      clipId: meta.clipId,
      requestId: meta.requestId,
      reason,
      route: routeSummary(routeBeforeRepair),
    });
    if (reason === "immediate") {
      setApplyStatus("done", "HQ note render ready", meta.logicalRequestId, { autoClearMs: 1800 });
      useDAWStore.getState().showToast("Pitch note render ready", "success");
    }
  }

  if (captureIfEnabled || !wasClean) {
    await captureAppFinalPitchContext(meta, data, routeBeforeRepair, routeAfterRepair, !wasClean);
  }
}

function scheduleNoteHqFinalRouteVerification(meta: PitchCorrectionRequestMeta, data: PitchCorrectionCompletionData) {
  void verifyNoteHqFinalRoute(meta, data, "immediate", true);
  window.setTimeout(() => {
    void verifyNoteHqFinalRoute(meta, data, "late_250ms", false);
  }, 250);
  window.setTimeout(() => {
    void verifyNoteHqFinalRoute(meta, data, "late_1000ms", false);
  }, 1000);
}

function resolvePitchPreviewMonitorMode(): PitchPreviewMonitorMode {
  if (!_interactivePreviewActive || !_interactivePreviewNoteId) {
    return "none";
  }
  return useDAWStore.getState().transport.isPlaying ? "clip_live_preview" : "scrub";
}

function buildAutoBakeWindow() {
  const pitchState = usePitchEditorStore.getState();
  const transport = useDAWStore.getState().transport;
  const clipDuration = pitchState.clipDuration || 0;
  const clipTime = Math.max(0, Math.min(clipDuration, transport.currentTime - pitchState.clipStartTime));
  return {
    windowStartSec: Math.max(0, clipTime - AUTO_BAKE_LOOKBEHIND_SEC),
    windowEndSec: Math.min(clipDuration, clipTime + AUTO_BAKE_LOOKAHEAD_SEC),
    clipTime,
    isPlaying: transport.isPlaying,
  };
}

/** Legacy rolling preview path. Pitch/formant preview now prefers rendered segments. */
function sendPitchPreviewMap(reason: "edit" | "transport" | "sync" = "edit") {
  const { clipId, notes, globalFormantCents } = usePitchEditorStore.getState();
  if (!clipId) return;
  const globalFormantSt = getEffectivePitchEditorGlobalFormantSt(globalFormantCents / 100);
  const monitorMode = resolvePitchPreviewMonitorMode();
  const previewNote = _interactivePreviewActive && _interactivePreviewNoteId
    ? notes.find((note) => note.id === _interactivePreviewNoteId) ?? null
    : null;
  if (!previewNote || Math.abs(previewNote.correctedPitch - previewNote.detectedPitch) <= 0.01) {
    clearTransientPitchPreview(clipId, reason);
    logPitchEditorFormant("cleared live drag preview", {
      clipId,
      reason,
      requestedGlobalFormantSemitones: globalFormantSt,
      activeInteractivePreview: _interactivePreviewActive,
      previewNoteId: _interactivePreviewNoteId,
    });
    return;
  }

  if (monitorMode === "scrub") {
    const pitchRatio = Math.pow(2, (previewNote.correctedPitch - previewNote.detectedPitch) / 12);
    if (_activePitchPreviewMonitorMode !== "scrub") {
      startPitchScrubPreviewForNote(previewNote.id);
    }
    nativeBridge.updatePitchScrubPreview(clipId, pitchRatio).catch(logBridgeError("updatePitchScrubPreview"));
    nativeBridge.clearClipPitchPreview(clipId).catch(logBridgeError("clearClipPitchPreview"));
    _activePitchPreviewMonitorMode = "scrub";
    logPitchEditorFormant("updated dedicated scrub preview", {
      clipId,
      reason,
      previewNoteId: previewNote.id,
      pitchRatio,
    });
    return;
  }

  if (monitorMode !== "clip_live_preview") {
    clearTransientPitchPreview(clipId, reason);
    return;
  }

  nativeBridge.stopPitchScrubPreview(clipId).catch(logBridgeError("stopPitchScrubPreview"));
  const payload = buildInteractivePreviewPayload(previewNote, globalFormantSt);
  nativeBridge.setClipPitchPreview(clipId, payload).catch(logBridgeError("setClipPitchPreview"));
  _activePitchPreviewMonitorMode = "clip_live_preview";
  logPitchEditorFormant("updated live drag preview", {
    clipId,
    reason,
    previewNoteId: previewNote.id,
    previewStartSec: payload.previewStartSec,
    previewEndSec: payload.previewEndSec,
    pitchRatio: payload.pitchSegments[0]?.pitchRatio ?? 1,
  });
}

function scheduleRollingPreviewRefresh() {
  if (_rollingPreviewRefreshTimer) return;
  _rollingPreviewRefreshTimer = setTimeout(() => {
    _rollingPreviewRefreshTimer = null;
    const { clipId, notes, globalFormantCents } = usePitchEditorStore.getState();
    if (!clipId) return;
    if (!useDAWStore.getState().transport.isPlaying) return;
    if (!hasRealtimePitchPreviewWork(notes, globalFormantCents / 100)) return;
    sendPitchPreviewMap("transport");
  }, 250);
}

function ensureDAWTransportSubscription() {
  if (_dawTransportSubscriptionInitialized) return;
  _dawTransportSubscriptionInitialized = true;

  useDAWStore.subscribe(
    (state) => ({ currentTime: state.transport.currentTime, isPlaying: state.transport.isPlaying }),
    (transport, prevTransport) => {
      const pitchState = usePitchEditorStore.getState();
      if (!pitchState.clipId) return;
      const globalFormantSt = pitchState.globalFormantCents / 100;
      if (!hasRealtimePitchPreviewWork(pitchState.notes, globalFormantSt)) return;

      if (transport.isPlaying) {
        if (!prevTransport?.isPlaying && !_interactivePreviewActive) {
          void clearCorrectedSourcePreviewRoutesBeforePlayback(pitchState.clipId);
        }
        if (_interactivePreviewActive) {
          sendPitchPreviewMap("transport");
        }
        scheduleRollingPreviewRefresh();
      } else if (prevTransport?.isPlaying) {
        if (_interactivePreviewActive) {
          sendPitchPreviewMap("transport");
          return;
        }
        // Transport just stopped. If edits were skipped during playback (preview-only
        // mode for pitch-only edits), bake them now so the corrected file is up to date
        // before the user renders or exports.
        if (_editRevision > _appliedRevision) {
          logPitchEditorFormant("transport stopped with pending edits; scheduling bake", {
            clipId: pitchState.clipId,
            currentTime: transport.currentTime,
            editRevision: _editRevision,
            appliedRevision: _appliedRevision,
          });
          scheduleAutoApply(200);
        } else {
          logPitchEditorFormant("transport stopped; no pending edits to bake", {
            clipId: pitchState.clipId,
            editRevision: _editRevision,
            appliedRevision: _appliedRevision,
          });
        }
      }
    },
    {
      equalityFn: (a, b) => a.isPlaying === b.isPlaying && Math.abs(a.currentTime - b.currentTime) < 0.2,
    },
  );
}

function applyPitchCorrectionResultToClip(clipId: string, outputFile: string, restored: boolean) {
  useDAWStore.setState((s) => ({
    tracks: s.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.id !== clipId) return clip;

        const sourceFilePath = clip.pitchCorrectionSourceFilePath ?? clip.filePath;
        const sourceOffset = clip.pitchCorrectionSourceOffset ?? clip.offset ?? 0;

        if (restored) {
          return {
            ...clip,
            filePath: sourceFilePath,
            offset: sourceOffset,
            pitchCorrectionSourceFilePath: undefined,
            pitchCorrectionSourceOffset: undefined,
          };
        }

        return {
          ...clip,
          filePath: outputFile,
          offset: 0,
          pitchCorrectionSourceFilePath: sourceFilePath,
          pitchCorrectionSourceOffset: sourceOffset,
        };
      }),
    })),
  }));
}

function isCurrentRevision(revision: number) {
  return revision === _editRevision;
}

function dispatchNativePitchCorrection(meta: PitchCorrectionRequestMeta) {
  const effectiveNotes = sanitizePitchEditorNotesForApply(meta.notes);
  const effectiveGlobalFormantSt = getEffectivePitchEditorGlobalFormantSt(meta.globalFormantSt);
  registerRequestMeta(meta);
  const statusRequestId = meta.logicalRequestId;
  _activePitchCorrectionRequestId = statusRequestId;
  if (meta.stage === "note_hq" || meta.stage === "full_clip_hq" || meta.stage === "single") {
    clearTransientPitchPreview(meta.clipId, `dispatch:${meta.stage}`);
  }
  if (meta.stage === "note_hq") {
    clearStagedPreviewQueue();
    clearRenderedPreviewForInteractiveEdit(meta.clipId, "dispatch:note_hq");
  }

  if (meta.stage === "preview_segment") {
    if (usePitchEditorStore.getState().applyState !== "final_processing") {
      setApplyStatus("preview_processing", getRenderedPreviewStatusMessage("preview_processing", false), statusRequestId);
    }
  } else if (meta.stage === "full_clip_hq") {
    setApplyStatus("final_processing", getRenderedPreviewStatusMessage("final_processing", false), statusRequestId);
  } else {
    setApplyStatus("processing", "Applying...", statusRequestId);
  }

  logPitchEditorFormant("dispatching pitch correction request", {
    clipId: meta.clipId,
    trackId: meta.trackId,
    requestId: meta.requestId,
    logicalRequestId: meta.logicalRequestId,
    renderMode: meta.renderMode,
    requestRevision: meta.revision,
    windowStartSec: meta.windowStartSec ?? null,
    windowEndSec: meta.windowEndSec ?? null,
    ...meta.summary,
  });

  nativeBridge.applyPitchCorrection(
    meta.trackId,
    meta.clipId,
    effectiveNotes,
    meta.frames,
    meta.requestId,
    effectiveGlobalFormantSt,
    meta.windowStartSec,
    meta.windowEndSec,
    meta.renderMode,
    meta.requestGroupId,
  ).then((result) => {
    if (result) return;

    consumeRequestRevision(meta.requestId);
    consumeRequestMeta(meta.requestId);
    if (_activePitchCorrectionRequestId === meta.logicalRequestId) {
      _activePitchCorrectionRequestId = null;
    }
    if (meta.stage === "note_hq") {
      finishNoteHqPriority(meta.logicalRequestId);
    }
    setApplyStatus("error", "Failed", meta.logicalRequestId);
    useDAWStore.getState().showToast("Pitch/formant apply failed", "error");
    warnPitchEditorFormant("apply request was not queued", {
      clipId: meta.clipId,
      requestId: meta.requestId,
      logicalRequestId: meta.logicalRequestId,
      renderMode: meta.renderMode,
    });
  }).catch((err) => {
    consumeRequestRevision(meta.requestId);
    consumeRequestMeta(meta.requestId);
    if (_activePitchCorrectionRequestId === meta.logicalRequestId) {
      _activePitchCorrectionRequestId = null;
    }
    if (meta.stage === "note_hq") {
      finishNoteHqPriority(meta.logicalRequestId);
    }
    setApplyStatus("error", "Failed", meta.logicalRequestId);
    useDAWStore.getState().showToast("Pitch/formant apply failed", "error");
    errorPitchEditorFormant("applyPitchCorrection call failed", {
      clipId: meta.clipId,
      requestId: meta.requestId,
      logicalRequestId: meta.logicalRequestId,
      renderMode: meta.renderMode,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function dispatchSingleApplyRequest(
  trackId: string,
  clipId: string,
  notes: PitchNoteData[],
  frames: PitchContourData["frames"] | undefined,
  globalFormantSt: number,
  requestRevision: number,
  summary: ApplyRequestSummary,
  logicalRequestId: string,
  windowStartSec?: number,
  windowEndSec?: number,
) {
  const requestId = buildStageRequestId(logicalRequestId, "single");
  dispatchNativePitchCorrection({
    clipId,
    trackId,
    requestId,
    logicalRequestId,
    revision: requestRevision,
    stage: "single",
    renderMode: "single",
    notes: cloneNotesSnapshot(notes),
    frames: cloneFramesSnapshot(frames),
    globalFormantSt,
    summary,
    windowStartSec,
    windowEndSec,
    requestGroupId: logicalRequestId,
  });
}

function dispatchNoteHqApplyRequest(
  trackId: string,
  clipId: string,
  notes: PitchNoteData[],
  frames: PitchContourData["frames"] | undefined,
  globalFormantSt: number,
  requestRevision: number,
  summary: ApplyRequestSummary,
  logicalRequestId: string,
  windowStartSec?: number,
  windowEndSec?: number,
  coverageRanges?: PitchRenderCoverageRange[],
) {
  const requestId = buildStageRequestId(logicalRequestId, "note_hq");
  _noteHqApplyInFlight = true;
  cancelActivePitchAnalysisForHq();
  if (coverageRanges && coverageRanges.length > 0) {
    setRenderCoverage(coverageRanges.map((range) => ({ ...range, state: "pending" })), logicalRequestId);
  } else if (windowStartSec !== undefined && windowEndSec !== undefined) {
    setRenderCoverage([{
      startTime: windowStartSec,
      endTime: windowEndSec,
      state: "pending",
    }], logicalRequestId);
  } else {
    setRenderCoverage([], logicalRequestId);
  }
  dispatchNativePitchCorrection({
    clipId,
    trackId,
    requestId,
    logicalRequestId,
    revision: requestRevision,
    stage: "note_hq",
    renderMode: "note_hq",
    notes: cloneNotesSnapshot(notes),
    frames: cloneFramesSnapshot(frames),
    globalFormantSt,
    summary,
    windowStartSec,
    windowEndSec,
    coverageRanges: coverageRanges?.map((range) => ({ ...range })),
    requestGroupId: logicalRequestId,
  });
}

function dispatchNextPreviewSegments() {
  if (!_stagedPreviewBase || _activePreviewRequestGroupId !== _stagedPreviewBase.logicalRequestId) return;
  while (_runningPreviewSegmentJobs < MAX_PREVIEW_SEGMENT_CONCURRENCY && _pendingPreviewSegments.length > 0) {
    const segment = _pendingPreviewSegments.shift();
    if (!segment) return;
    _runningPreviewSegmentJobs += 1;
    dispatchNativePitchCorrection({
      ..._stagedPreviewBase,
      requestId: buildStageRequestId(_stagedPreviewBase.logicalRequestId, "preview_segment"),
      stage: "preview_segment",
      renderMode: "preview_segment",
      windowStartSec: segment.startSec,
      windowEndSec: segment.endSec,
      requestGroupId: _stagedPreviewBase.logicalRequestId,
      segmentIndex: segment.index,
    });
  }
}

function getRenderedPreviewStatusMessage(state: PitchEditorApplyState, previewCoverageComplete: boolean) {
  switch (state) {
    case "preview_processing":
      return "Rendering preview near playhead...";
    case "preview_ready":
      return previewCoverageComplete ? "Rendered preview ready" : "Previewing rendered audio";
    case "final_processing":
      return "Refining full clip render...";
    case "done":
      return "Previewing rendered audio";
    default:
      return "Rendered preview";
  }
}

function dispatchStagedRenderedApply(
  trackId: string,
  clipId: string,
  notes: PitchNoteData[],
  frames: PitchContourData["frames"] | undefined,
  globalFormantSt: number,
  requestRevision: number,
  summary: ApplyRequestSummary,
  logicalRequestId: string,
) {
  const { clipDuration, clipStartTime } = usePitchEditorStore.getState();
  const transport = useDAWStore.getState().transport;
  const playheadSec = Math.max(0, Math.min(clipDuration || 0, transport.currentTime - clipStartTime));
  const previewSegments = buildPreviewSegmentRanges(clipDuration || 0, playheadSec);
  nativeBridge.clearClipRenderedPreviewSegments(clipId).catch(logBridgeError("clearClipRenderedPreviewSegments"));
  setRenderCoverage(previewSegments.map((segment) => ({
    startTime: segment.startSec,
    endTime: segment.endSec,
    state: "pending",
  })), logicalRequestId);

  _activePreviewRequestGroupId = logicalRequestId;
  _pendingPreviewSegments = [...previewSegments];
  _runningPreviewSegmentJobs = 0;
  _stagedPreviewBase = {
    clipId,
    trackId,
    logicalRequestId,
    revision: requestRevision,
    notes: cloneNotesSnapshot(notes),
    frames: cloneFramesSnapshot(frames),
    globalFormantSt,
    summary,
    requestGroupId: logicalRequestId,
  };
  dispatchNextPreviewSegments();
  clearFullClipHqTimer();
  _fullClipHqTimer = setTimeout(() => {
    if (!_stagedPreviewBase || _stagedPreviewBase.logicalRequestId !== logicalRequestId) return;
    dispatchNativePitchCorrection({
      ..._stagedPreviewBase,
      requestId: buildStageRequestId(logicalRequestId, "full_clip_hq"),
      stage: "full_clip_hq",
      renderMode: "full_clip_hq",
      requestGroupId: logicalRequestId,
    });
  }, 1000);
}

const _deferredPitchEditorHelpers = [
  hasRequestedFormantWork,
  buildAutoBakeWindow,
  dispatchStagedRenderedApply,
];
void _deferredPitchEditorHelpers;

function scheduleAutoApply(delayMs = 300) {
  if (_autoApplyTimer) clearTimeout(_autoApplyTimer);
  const { notes, globalFormantCents, clipId } = usePitchEditorStore.getState();
  const globalFormantSt = globalFormantCents / 100;
  const requestSummary = summarizeApplyRequest(notes, globalFormantSt);
  const queuedRevision = _editRevision;
  if (clipId) {
    logPitchEditorFormant("auto-apply queued", {
      clipId,
      editRevision: queuedRevision,
      requestedApplyRevision: _requestedApplyRevision,
      appliedRevision: _appliedRevision,
      ...requestSummary,
    });
    setApplyStatus("queued", "Queued...");
  }
  _autoApplyTimer = setTimeout(async () => {
    _autoApplyTimer = null;
    const { trackId, clipId, notes, contour, globalFormantCents, clipDuration } = usePitchEditorStore.getState();
    if (!trackId || !clipId) return;
    if (_editRevision <= _appliedRevision) {
      logPitchEditorFormant("skipping auto-apply because edit revision is already applied", {
        clipId,
        editRevision: _editRevision,
        appliedRevision: _appliedRevision,
      });
      return;
    }
    if (_requestedApplyRevision >= _editRevision) {
      logPitchEditorFormant("skipping auto-apply because current edit revision is already requested", {
        clipId,
        editRevision: _editRevision,
        requestedApplyRevision: _requestedApplyRevision,
        activeRequestId: _activePitchCorrectionRequestId,
      });
      return;
    }
    const globalFormantSt = globalFormantCents / 100;
    const requestSummary = summarizeApplyRequest(notes, globalFormantSt);
    // Ensure the clip is registered in the playback engine before applying.
    // Clear the legacy live stretcher preview path. We now prefer rendered preview
    // segments so playback matches the offline/native engine more closely.
    sendPitchPreviewMap("sync");
    try {
      await useDAWStore.getState().syncClipsWithBackend();
    } catch (e) {
      console.warn("[pitchEditor] syncClipsWithBackend failed before apply:", e);
    }
    // ALWAYS send ALL notes to the backend. The backend reads from the ORIGINAL
    // audio file every time (so corrections don't compound through the vocoder).
    // If we only sent dirty notes, the backend would only correct those notes and
    // write the rest from the original — destroying all previous corrections.
    const requestRevision = _editRevision;
    _requestedApplyRevision = requestRevision;
    const logicalRequestId = buildLogicalApplyRequestId(clipId);
    const editedNoteWindow = buildEditedNoteWindow(notes, clipDuration || 0);
    if (requestSummary.mode === "none") {
      setRenderCoverage([], null);
      nativeBridge.clearClipRenderedPreviewSegments(clipId).catch(logBridgeError("clearClipRenderedPreviewSegments"));
      dispatchSingleApplyRequest(
        trackId,
        clipId,
        notes,
        contour?.frames,
        globalFormantSt,
        requestRevision,
        requestSummary,
        logicalRequestId,
      );
      return;
    }
    logPitchEditorFormant("dispatching auto-bake request", {
      clipId,
      logicalRequestId,
      requestRevision,
      renderMode: "note_hq",
      windowStartSec: editedNoteWindow?.windowStartSec ?? null,
      windowEndSec: editedNoteWindow?.windowEndSec ?? null,
      ...requestSummary,
    });

    clearStagedPreviewQueue();
    dispatchNoteHqApplyRequest(
      trackId,
      clipId,
      editedNoteWindow?.requestNotes ?? notes,
      contour?.frames,
      globalFormantSt,
      requestRevision,
      requestSummary,
      logicalRequestId,
      editedNoteWindow?.windowStartSec,
      editedNoteWindow?.windowEndSec,
      editedNoteWindow?.coverageRanges,
    );
  }, delayMs);
}

/** Wrapper: send real-time preview immediately + queue high-quality WORLD correction. */
function onNotesChanged() {
  markPitchEditorDirty("notesChanged");
  sendPitchPreviewMap("edit");
  scheduleAutoApply();
}

export const usePitchEditorStore = create<PitchEditorState>()((set, get) => ({
  trackId: null,
  clipId: null,
  fxIndex: 0,
  clipStartTime: 0,
  clipDuration: 0,
  originalClipFilePath: null,
  originalClipOffset: 0,
  contour: null,
  notes: [],
  isAnalyzing: false,
  analysisPhase: "idle",
  isApplying: false,
  progressPercent: 0,
  progressLabel: "",
  applyState: "idle",
  applyMessage: "",
  lastApplyRequestId: null,
  renderCoverage: [],
  activeLogicalRequestId: null,
  selectedNoteIds: [],
  tool: "select",
  snapMode: "chromatic",
  scrollX: 0,
  scrollY: 48, // C3
  zoomX: 200,  // pixels per second
  zoomY: 32,   // pixels per semitone (increased for finer drag control)
  undoStack: [],
  redoStack: [],
  referenceTracks: [],
  scaleKey: 0,
  scaleType: "chromatic",
  scaleNotes: new Array(12).fill(true),
  inspectorExpanded: true,
  globalFormantCents: 0,
  showCorrectPitchModal: false,
  abCompareMode: false,

  open: (trackId, clipId, fxIndex) => {
    ensureDAWTransportSubscription();
    resetApplyRevisions();
    const dawState = useDAWStore.getState();
    const track = dawState.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    const resolvedStart = clip?.startTime ?? 0;
    const resolvedDuration = clip?.duration ?? 0;
    if (!track || !clip) console.warn("[pitchEditor.open] track or clip not found: trackId=%s clipId=%s", trackId, clipId);
    set({
      trackId,
      clipId,
      fxIndex,
      clipStartTime: resolvedStart,
      clipDuration: resolvedDuration,
      // Capture the original file path and offset NOW, before any corrections update
      // clip.filePath / clip.offset.  All analysis calls must use these so pitch frames
      // stay in sync with the original audio that applyPitchCorrection() always processes.
      originalClipFilePath: clip?.pitchCorrectionSourceFilePath ?? clip?.filePath ?? null,
      originalClipOffset: clip?.pitchCorrectionSourceOffset ?? clip?.offset ?? 0,
      contour: null,
      notes: [],
      selectedNoteIds: [],
      undoStack: [],
      redoStack: [],
      referenceTracks: [],
      isAnalyzing: false,
      analysisPhase: "loading",
      isApplying: false,
      progressPercent: 0,
      progressLabel: "Loading clip...",
      applyState: "idle",
      applyMessage: "",
      lastApplyRequestId: null,
      renderCoverage: [],
      activeLogicalRequestId: null,
      scrollY: 48, // Reset to middle C, will be auto-fit after analysis
      globalFormantCents: 0,
    });
  },

  close: () => {
    // Clear real-time pitch preview when closing the editor
    const { clipId } = get();
    if (clipId) {
      clearTransientPitchPreview(clipId, "close");
      nativeBridge.clearClipRenderedPreviewSegments(clipId).catch(logBridgeError("clearClipRenderedPreviewSegments"));
    }
    set({
      trackId: null,
      clipId: null,
      contour: null,
      notes: [],
      selectedNoteIds: [],
      undoStack: [],
      redoStack: [],
      referenceTracks: [],
      isAnalyzing: false,
      analysisPhase: "idle",
      progressPercent: 0,
      progressLabel: "",
      applyState: "idle",
      applyMessage: "",
      lastApplyRequestId: null,
      renderCoverage: [],
      activeLogicalRequestId: null,
    });
    clearApplyStateResetTimer();
    clearRollingPreviewRefreshTimer();
    resetApplyRevisions();
  },

  // Analyze a specific time window of the clip (viewport-based analysis).
  // Analyzes a small chunk around the given time range and builds coverage incrementally.
  // Merges results with existing notes to build up the full picture as user scrolls.
  analyze: async (viewStartTime?: number, viewEndTime?: number) => {
    const { trackId, clipId, isAnalyzing, originalClipFilePath, originalClipOffset } = get();
    if (!trackId || !clipId || isAnalyzing) return;
    if (_noteHqApplyInFlight && get().contour) {
      deferPitchAnalysis(viewStartTime, viewEndTime, "note_hq_in_flight");
      return;
    }

    const dawState = useDAWStore.getState();
    const track = dawState.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!clip) return;

    // Always analyze from the original (pre-correction) file path and offset.
    // clip.filePath is updated to _pcN.wav after each correction; using that would
    // produce frames that reflect corrected pitch, breaking subsequent edit ratios.
    const analysisFilePath = originalClipFilePath ?? clip.filePath;
    if (!analysisFilePath) return;

    // Determine analysis window: keep first-open note load as light as possible
    const MAX_CHUNK = 5; // seconds
    // Use original offset — after correction clip.offset is reset to 0 (corrected file
    // starts at 0), but the original file needs its original seek position.
    const clipOffset = originalClipOffset;
    const clipDuration = clip.duration;

    let analyzeStart: number;
    let analyzeDuration: number;

    if (viewStartTime !== undefined && viewEndTime !== undefined) {
      // Analyze around viewport with padding
      const viewDuration = viewEndTime - viewStartTime;
      const padding = Math.min(2, viewDuration * 0.35); // tighter padding for faster viewport fills
      analyzeStart = Math.max(0, viewStartTime - padding);
      const analyzeEnd = Math.min(clipDuration, viewEndTime + padding);
      analyzeDuration = Math.min(MAX_CHUNK, analyzeEnd - analyzeStart);
    } else {
      // Initial analysis: first 5s of the clip
      analyzeStart = 0;
      analyzeDuration = Math.min(MAX_CHUNK, clipDuration);
    }

    const analysisRevision = _editRevision;
    const analysisSeq = ++_analysisRunSeq;
    set({ isAnalyzing: true, analysisPhase: "analyzing", progressPercent: 0, progressLabel: "Analyzing pitch..." });
    console.log(`[PitchEditor] Analyzing ${analyzeStart.toFixed(1)}s - ${(analyzeStart + analyzeDuration).toFixed(1)}s of ${clipDuration.toFixed(1)}s clip`);

    // Cancel any stale listener before registering a new one.
    // A stale listener would fire for this analysis result, causing duplicate processing.
    if (_pitchAnalysisUnsubscribe) {
      _pitchAnalysisUnsubscribe();
      _pitchAnalysisUnsubscribe = null;
    }

    // Set up one-time event listener for analysis completion.
    // `processed` guards against duplicate firings (JUCE removeEventListener is async,
    // so the old listener may fire once more for the next analysis result).
    let processed = false;
    const unsubscribe = nativeBridge.onPitchAnalysisComplete(async (notification: any) => {
      if (processed) { unsubscribe(); return; }
      processed = true;
      _pitchAnalysisUnsubscribe = null;
      unsubscribe();
      // notification contains noteCount and ready flag only (no heavy JSON)

      if (notification?.cancelled || analysisSeq !== _analysisRunSeq) {
        set({ isAnalyzing: false, analysisPhase: "idle", progressPercent: 0, progressLabel: "" });
        if (_noteHqApplyInFlight) {
          deferPitchAnalysis(viewStartTime, viewEndTime, "native_analysis_cancelled");
        }
        return;
      }

      if (notification?.ready && notification?.noteCount >= 0) {
        try {
          const fullResult = await nativeBridge.getLastPitchAnalysisResult();
          if (fullResult?.notes) {
            if (analysisRevision !== _editRevision && get().notes.length > 0) {
              logPitchEditorFormant("ignored stale pitch analysis after edit revision changed", {
                analysisRevision,
                currentEditRevision: _editRevision,
              });
              set({ isAnalyzing: false, analysisPhase: "idle", progressPercent: 0, progressLabel: "" });
              return;
            }
            // Offset note/frame times: C++ returns times from 0, but we need
            // them relative to clip start (analyzeStart offset).
            // Prefix IDs with the window start so notes from different analysis
            // windows never share an ID — prevents ID collision after re-analysis
            // (which caused wrong notes to be split/moved via stale context menu).
            const idPrefix = `w${analyzeStart.toFixed(1)}_`;
            const offsetNotes = fullResult.notes.map((n) => ({
              ...n,
              id: idPrefix + n.id,
              startTime: n.startTime + analyzeStart,
              endTime: n.endTime + analyzeStart,
              effectiveStartTime: (n.effectiveStartTime ?? n.startTime) + analyzeStart,
              effectiveEndTime: (n.effectiveEndTime ?? n.endTime) + analyzeStart,
            }));
            if (fullResult.frames) {
              fullResult.frames.times = fullResult.frames.times.map(
                (t: number) => t + analyzeStart
              );
            }

            const {
              notes: existingNotes,
              selectedNoteIds: existingSelectedNoteIds,
              undoStack: existingUndoStack,
              redoStack: existingRedoStack,
            } = get();
            const hadPitchHistory = existingUndoStack.length > 0 || existingRedoStack.length > 0;

            // Merge new notes with existing (replace overlapping range)
            let mergedNotes: PitchNoteData[];
            if (existingNotes.length > 0) {
              const rangeStart = analyzeStart;
              const rangeEnd = analyzeStart + analyzeDuration;
              mergedNotes = existingNotes.filter(
                (n) => n.endTime < rangeStart || n.startTime > rangeEnd
              );
              mergedNotes.push(...offsetNotes);
              mergedNotes = normalizePitchNotes(mergedNotes);
            } else {
              mergedNotes = normalizePitchNotes(offsetNotes);
            }

            console.log("[PitchEditor] Applied: " + offsetNotes.length + " new notes, " + mergedNotes.length + " total");

            // Merge contour frames with existing (accumulate across analysis windows).
            // Each analysis returns frames for its window only — merge by time so
            // scrolling back to a previously analyzed region still shows the pitch line.
            const existingContour = get().contour;
            let mergedContour: PitchContourData;
            if (existingContour && existingContour.frames.times.length > 0 && fullResult.frames) {
              const rangeStart = analyzeStart;
              const rangeEnd = analyzeStart + analyzeDuration;
              // Keep existing frames outside the new range, replace within
              const keep: number[] = [];
              for (let i = 0; i < existingContour.frames.times.length; i++) {
                const t = existingContour.frames.times[i];
                if (t < rangeStart - 0.01 || t > rangeEnd + 0.01) keep.push(i);
              }
              // Build merged arrays
              const mTimes: number[] = [];
              const mMidi: number[] = [];
              const mConf: number[] = [];
              const mRms: number[] = [];
              const mVoiced: boolean[] = [];
              for (const i of keep) {
                mTimes.push(existingContour.frames.times[i]);
                mMidi.push(existingContour.frames.midi[i]);
                mConf.push(existingContour.frames.confidence[i]);
                mRms.push(existingContour.frames.rms[i]);
                mVoiced.push(existingContour.frames.voiced[i]);
              }
              // Append new frames
              for (let i = 0; i < fullResult.frames.times.length; i++) {
                mTimes.push(fullResult.frames.times[i]);
                mMidi.push(fullResult.frames.midi[i]);
                mConf.push(fullResult.frames.confidence[i]);
                mRms.push(fullResult.frames.rms[i]);
                mVoiced.push(fullResult.frames.voiced[i]);
              }
              // Sort by time
              const indices = mTimes.map((_, i) => i);
              indices.sort((a, b) => mTimes[a] - mTimes[b]);
              mergedContour = {
                ...fullResult,
                frames: {
                  times: indices.map(i => mTimes[i]),
                  midi: indices.map(i => mMidi[i]),
                  confidence: indices.map(i => mConf[i]),
                  rms: indices.map(i => mRms[i]),
                  voiced: indices.map(i => mVoiced[i]),
                },
              };
            } else {
              mergedContour = fullResult;
            }

            set({
              isAnalyzing: false,
              analysisPhase: "idle",
              progressPercent: 100,
              progressLabel: "",
              contour: mergedContour,
              notes: mergedNotes,
              selectedNoteIds: filterSelectedNoteIdsForNotes(existingSelectedNoteIds, mergedNotes),
            });
            if (hadPitchHistory) {
              logPitchEditorFormant("preserved pitch undo history across analysis refresh", {
                undoDepth: existingUndoStack.length,
                redoDepth: existingRedoStack.length,
              });
            }

            // Auto-fit viewport on first analysis (no existing notes)
            if (existingNotes.length === 0 && mergedNotes.length > 0) {
              let minMidi = 127, maxMidi = 0;
              for (const n of mergedNotes) {
                minMidi = Math.min(minMidi, Math.floor(n.detectedPitch) - 2);
                maxMidi = Math.max(maxMidi, Math.ceil(n.detectedPitch) + 2);
              }
              set({ scrollY: minMidi, scrollX: 0 });
            }
          } else {
            console.warn("[PitchEditor] No notes in analysis result");
            set({ isAnalyzing: false, analysisPhase: "idle" });
          }
        } catch (err) {
          console.error("[PitchEditor] Failed to fetch analysis result:", err);
          set({ isAnalyzing: false, analysisPhase: "idle" });
        }
      } else {
        console.warn("[PitchEditor] Analysis completed with 0 notes or failed");
        set({ isAnalyzing: false, analysisPhase: "idle" });
      }
    });
    _pitchAnalysisUnsubscribe = unsubscribe;

    try {
      // Analyze only the requested window (offset into source file + window start)
      const fileOffset = clipOffset + analyzeStart;
      const response = await nativeBridge.analyzePitchContourDirect(
        analysisFilePath, fileOffset, analyzeDuration, clipId
      );
      const started = !!(response as any)?.started;
      if (!started) {
        if ((response as any)?.deferred) {
          deferPitchAnalysis(viewStartTime, viewEndTime, "native_deferred");
        }
        _pitchAnalysisUnsubscribe = null;
        unsubscribe();
        set({ isAnalyzing: false, analysisPhase: "idle" });
      }
    } catch {
      _pitchAnalysisUnsubscribe = null;
      unsubscribe();
      set({ isAnalyzing: false, analysisPhase: "idle" });
    }
  },

  setTool: (tool) => set({ tool }),
  setSnapMode: (mode) => set({ snapMode: mode }),

  selectNote: (noteId, addToSelection = false) => {
    const { selectedNoteIds } = get();
    if (addToSelection) {
      if (selectedNoteIds.includes(noteId)) {
        set({ selectedNoteIds: selectedNoteIds.filter(id => id !== noteId) });
      } else {
        set({ selectedNoteIds: [...selectedNoteIds, noteId] });
      }
    } else {
      set({ selectedNoteIds: [noteId] });
    }
  },

  selectAll: () => {
    set({ selectedNoteIds: get().notes.map(n => n.id) });
  },

  deselectAll: () => set({ selectedNoteIds: [] }),

  setSelectedNoteIds: (ids) => set({ selectedNoteIds: ids }),

  beginInteractivePreview: (noteId) => {
    replaceDirtyPitchNotes(expandDirtyPitchNoteIdsWithNeighbors([noteId], get().notes));
    _interactivePreviewNoteId = noteId;
    _interactivePreviewActive = true;
    if (get().clipId) {
      clearRenderedPreviewForInteractiveEdit(get().clipId!, "beginInteractivePreview");
    }
    sendPitchPreviewMap("edit");
    logPitchEditorFormant("interactive preview started", {
      clipId: get().clipId,
      noteId,
    });
  },

  endInteractivePreview: () => {
    const { clipId } = get();
    _interactivePreviewActive = false;
    _interactivePreviewNoteId = null;
    if (clipId) {
      clearTransientPitchPreview(clipId, "endInteractivePreview");
    }
    logPitchEditorFormant("interactive preview ended", {
      clipId,
    });
  },

  pushUndo: (description) => {
    const { notes, selectedNoteIds, undoStack } = get();
    const snapshot = clonePitchNotes(notes);
    const last = undoStack[undoStack.length - 1];
    if (last && pitchNotesEqual(last.notes, snapshot)) {
      return;
    }
    set({
      undoStack: [...undoStack, { description, notes: snapshot, selectedNoteIds: [...selectedNoteIds] }],
      redoStack: [],
    });
  },

  // Raw updater — does NOT push undo and does NOT schedule auto-apply.
  // Called many times per drag; auto-apply is deferred to commitNoteEdit() on mouseup.
  // Sends a throttled real-time preview so the user hears the new pitch while dragging.
  updateNote: (noteId, changes) => {
    const currentNotes = get().notes;
    const boundaryAffectingChange =
      Object.prototype.hasOwnProperty.call(changes, "startTime")
      || Object.prototype.hasOwnProperty.call(changes, "endTime")
      || Object.prototype.hasOwnProperty.call(changes, "transitionIn")
      || Object.prototype.hasOwnProperty.call(changes, "transitionOut")
      || Object.prototype.hasOwnProperty.call(changes, "effectiveStartTime")
      || Object.prototype.hasOwnProperty.call(changes, "effectiveEndTime");
    const targetIds = new Set([noteId]);
    const updatedNotes = normalizePitchNotes(currentNotes.map(n => n.id === noteId ? normalizePitchNote({ ...n, ...changes }) : n));
    if (boundaryAffectingChange) {
      replaceDirtyPitchNotes(expandDirtyPitchNoteIdsWithNeighbors(targetIds, updatedNotes));
    } else {
      markDirtyPitchNotes(targetIds);
    }
    set({
      notes: updatedNotes,
    });
    if (!_dragPreviewThrottle) {
      _dragPreviewThrottle = setTimeout(() => {
        _dragPreviewThrottle = null;
        sendPitchPreviewMap();
      }, 80);
    }
  },

  // Call once when an interactive drag/resize ends to schedule the debounced backend apply.
  commitNoteEdit: () => {
    get().endInteractivePreview();
    const { undoStack, notes } = get();
    const last = undoStack[undoStack.length - 1];
    if (last && pitchNotesEqual(last.notes, notes)) {
      set({ undoStack: undoStack.slice(0, -1) });
      return;
    }
    onNotesChanged();
  },

  updateSelectedNotes: (changes) => {
    const { selectedNoteIds, notes } = get();
    if (selectedNoteIds.length === 0) return;
    const targetIds = new Set(selectedNoteIds);
    replaceDirtyPitchNotes(targetIds);
    get().pushUndo("Edit selected notes");
    set({
      notes: normalizePitchNotes(notes.map(n =>
        targetIds.has(n.id) ? normalizePitchNote({ ...n, ...changes }) : n
      )),
      selectedNoteIds: [...targetIds],
    });
    onNotesChanged();
  },

  moveSelectedPitch: (semitones) => {
    const { selectedNoteIds, notes } = get();
    if (selectedNoteIds.length === 0) return;
    const targetIds = new Set(selectedNoteIds);
    replaceDirtyPitchNotes(targetIds);
    get().pushUndo(`Move pitch ${semitones > 0 ? "up" : "down"}`);
    set({
      notes: normalizePitchNotes(notes.map(n =>
        targetIds.has(n.id)
          ? normalizePitchNote({ ...n, correctedPitch: n.correctedPitch + semitones })
          : n
      )),
      selectedNoteIds: [...targetIds],
    });
    onNotesChanged();
  },

  splitNote: (noteId, time) => {
    const { notes } = get();
    const note = notes.find(n => n.id === noteId);
    console.log("[splitNote] id=%s time=%f note=%o", noteId, time,
      note ? { startTime: note.startTime, endTime: note.endTime } : null);
    if (!note) { console.warn("[splitNote] note not found"); return; }
    if (time <= note.startTime || time >= note.endTime) {
      console.warn("[splitNote] time %f out of range [%f, %f]", time, note.startTime, note.endTime);
      return;
    }
    get().pushUndo("Split note");

    const drift = Array.isArray(note.pitchDrift) ? note.pitchDrift : [];
    const splitIdx = Math.floor((time - note.startTime) / (note.endTime - note.startTime) * drift.length);
    const note1: PitchNoteData = {
      ...note,
      id: note.id + "_a",
      wordGroupId: `${getNoteWordGroupId(note)}_${note.id}_a`,
      endTime: time,
      effectiveEndTime: time,
      pitchDrift: drift.slice(0, splitIdx),
      transitionOut: 0,
    };
    const note2: PitchNoteData = {
      ...note,
      id: note.id + "_b",
      wordGroupId: `${getNoteWordGroupId(note)}_${note.id}_b`,
      startTime: time,
      effectiveStartTime: time,
      pitchDrift: drift.slice(splitIdx),
      transitionIn: 0,
    };

    // Recalculate each half's detectedPitch from the actual pitch contour in its time range.
    // Without this, both halves inherit the parent's detectedPitch and appear at the same height.
    const { contour } = get();
    if (contour && contour.frames.times.length > 0) {
      const { times, midi } = contour.frames;
      const calcAvgMidi = (startT: number, endT: number): number => {
        let sum = 0, count = 0;
        for (let i = 0; i < times.length; i++) {
          if (times[i] >= startT && times[i] <= endT && midi[i] > 0) {
            sum += midi[i]; count++;
          }
        }
        return count > 0 ? sum / count : 0;
      };
      const shift = note.correctedPitch - note.detectedPitch;

      const midi1 = calcAvgMidi(note1.startTime, note1.endTime);
      if (midi1 > 0) {
        note1.detectedPitch = midi1;
        note1.correctedPitch = midi1 + shift;
      }

      const midi2 = calcAvgMidi(note2.startTime, note2.endTime);
      if (midi2 > 0) {
        note2.detectedPitch = midi2;
        note2.correctedPitch = midi2 + shift;
      }
    }

    set({
      notes: normalizePitchNotes(notes.flatMap(n => n.id === noteId ? [note1, note2] : [n])),
      selectedNoteIds: [note1.id, note2.id],
    });
    replaceDirtyPitchNotes([note1.id, note2.id]);
    onNotesChanged();
  },

  correctSelectedToScale: () => {
    const { selectedNoteIds, notes } = get();
    if (selectedNoteIds.length === 0) return;
    const targetIds = new Set(selectedNoteIds);
    replaceDirtyPitchNotes(targetIds);
    get().pushUndo("Correct to scale");
    set({
      notes: normalizePitchNotes(notes.map(n => {
        if (!targetIds.has(n.id)) return n;
        return normalizePitchNote({ ...n, correctedPitch: Math.round(n.correctedPitch) });
      })),
      selectedNoteIds: [...targetIds],
    });
    onNotesChanged();
  },

  correctAllToScale: () => {
    const { notes } = get();
    replaceDirtyPitchNotes(notes.map((note) => note.id));
    get().pushUndo("Correct all to scale");
    set({
      notes: normalizePitchNotes(notes.map(n => normalizePitchNote({ ...n, correctedPitch: Math.round(n.correctedPitch) }))),
    });
    onNotesChanged();
  },

  undo: () => {
    const { undoStack, notes, selectedNoteIds } = get();
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    replaceDirtyPitchNotes(entry.notes.map((note) => note.id));
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, { description: entry.description, notes: clonePitchNotes(notes), selectedNoteIds: [...selectedNoteIds] }],
      notes: normalizePitchNotes(entry.notes),
      selectedNoteIds: [...(entry.selectedNoteIds ?? [])],
    });
    onNotesChanged();
  },

  redo: () => {
    const { redoStack, notes, selectedNoteIds } = get();
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    replaceDirtyPitchNotes(entry.notes.map((note) => note.id));
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, { description: entry.description, notes: clonePitchNotes(notes), selectedNoteIds: [...selectedNoteIds] }],
      notes: normalizePitchNotes(entry.notes),
      selectedNoteIds: [...(entry.selectedNoteIds ?? [])],
    });
    onNotesChanged();
  },

  setScrollX: (x) => set({ scrollX: Math.max(0, x) }),
  setScrollY: (y) => set({ scrollY: Math.max(0, Math.min(120, y)) }),
  setZoomX: (z) => set({ zoomX: Math.max(50, Math.min(2000, z)) }),
  setZoomY: (z) => set({ zoomY: Math.max(4, Math.min(80, z)) }),

  applyCorrection: async () => {
    const { trackId, clipId, notes, contour, globalFormantCents, clipDuration } = get();
    if (!trackId || !clipId) return;
    const globalFormantSt = globalFormantCents / 100;
    const summary = summarizeApplyRequest(notes, globalFormantSt);
    const requestRevision = _editRevision;
    _requestedApplyRevision = requestRevision;
    const logicalRequestId = buildLogicalApplyRequestId(clipId);
    logPitchEditorFormant("manual apply requested", { clipId, logicalRequestId, requestRevision, ...summary });

    if (summary.mode === "none") {
      setRenderCoverage([], null);
      nativeBridge.clearClipRenderedPreviewSegments(clipId).catch(logBridgeError("clearClipRenderedPreviewSegments"));
      dispatchSingleApplyRequest(
        trackId,
        clipId,
        notes,
        contour?.frames,
        globalFormantSt,
        requestRevision,
        summary,
        logicalRequestId,
      );
      return;
    }

    const editedNoteWindow = buildEditedNoteWindow(notes, clipDuration || 0);
    dispatchNoteHqApplyRequest(
      trackId,
      clipId,
      editedNoteWindow?.requestNotes ?? notes,
      contour?.frames,
      globalFormantSt,
      requestRevision,
      summary,
      logicalRequestId,
      editedNoteWindow?.windowStartSec,
      editedNoteWindow?.windowEndSec,
      editedNoteWindow?.coverageRanges,
    );
  },

  previewCorrection: async () => {
    const { trackId, clipId, notes } = get();
    if (!trackId || !clipId) return;
    set({ isApplying: true });
    try {
      await nativeBridge.previewPitchCorrection(trackId, clipId, notes);
    } finally {
      set({ isApplying: false });
    }
  },

  addReferenceTrack: async (trackId, clipId, trackName) => {
    const { referenceTracks } = get();
    // Don't add duplicate
    if (referenceTracks.some(r => r.trackId === trackId)) return;
    const colorIdx = referenceTracks.length % REFERENCE_COLORS.length;
    const ref: ReferenceTrack = {
      trackId, clipId, trackName,
      color: REFERENCE_COLORS[colorIdx],
      contour: null, notes: [], visible: true,
    };
    set({ referenceTracks: [...referenceTracks, ref] });
    // Analyze in background
    const result = await nativeBridge.analyzePitchContour(trackId, clipId);
    if (result) {
      set({
        referenceTracks: get().referenceTracks.map(r =>
          r.trackId === trackId ? { ...r, contour: result, notes: result.notes } : r
        ),
      });
    }
  },

  removeReferenceTrack: (trackId) => {
    set({ referenceTracks: get().referenceTracks.filter(r => r.trackId !== trackId) });
  },

  toggleReferenceVisibility: (trackId) => {
    set({
      referenceTracks: get().referenceTracks.map(r =>
        r.trackId === trackId ? { ...r, visible: !r.visible } : r
      ),
    });
  },

  // Scale/key
  setScale: (key, type) => {
    set({ scaleKey: key, scaleType: type, scaleNotes: buildScaleNotes(key, type) });
  },

  autoDetectScale: () => {
    const { notes } = get();
    if (notes.length === 0) return;
    // Histogram: count notes in each of the 12 semitone classes
    const histogram = new Array(12).fill(0);
    for (const n of notes) {
      const noteClass = Math.round(n.detectedPitch) % 12;
      histogram[noteClass < 0 ? noteClass + 12 : noteClass]++;
    }
    // Try every key + scale combo, pick best match
    let bestKey = 0, bestType = "major", bestScore = -1;
    for (const [type, intervals] of Object.entries(SCALE_INTERVALS)) {
      if (type === "chromatic") continue;
      for (let key = 0; key < 12; key++) {
        let score = 0;
        for (const interval of intervals) {
          score += histogram[(key + interval) % 12];
        }
        if (score > bestScore) {
          bestScore = score;
          bestKey = key;
          bestType = type;
        }
      }
    }
    set({ scaleKey: bestKey, scaleType: bestType, scaleNotes: buildScaleNotes(bestKey, bestType) });
  },

  toggleInspector: () => set({ inspectorExpanded: !get().inspectorExpanded }),
  toggleCorrectPitchModal: () => set({ showCorrectPitchModal: !get().showCorrectPitchModal }),

  setGlobalFormantCents: (cents) => {
    if (!PITCH_EDITOR_FORMANT_EDITING_ENABLED) {
      logPitchEditorFormant("ignored global formant change because pitch editor is in pitch-only rebuild mode", {
        clipId: get().clipId,
        requestedGlobalFormantCents: Math.round(cents),
      });
      return;
    }
    const clamped = Math.max(-386, Math.min(386, Math.round(cents)));
    set({
      globalFormantCents: clamped,
      applyState: "queued",
      applyMessage: "Queued...",
      lastApplyRequestId: get().lastApplyRequestId,
      isApplying: true,
    });
    logPitchEditorFormant("global formant changed", {
      clipId: get().clipId,
      globalFormantCents: clamped,
      globalFormantSemitones: clamped / 100,
    });
    onNotesChanged();
  },

  // Inspector editing actions
  setNoteFormant: (noteId, semitones) => {
    if (!PITCH_EDITOR_FORMANT_EDITING_ENABLED) {
      logPitchEditorFormant("ignored note formant change because pitch editor is in pitch-only rebuild mode", {
        clipId: get().clipId,
        noteId,
        requestedSemitones: semitones,
      });
      return;
    }
    get().pushUndo("Change formant");
    replaceDirtyPitchNotes([noteId]);
    const clamped = Math.max(-3.86, Math.min(3.86, semitones));
    set({ notes: normalizePitchNotes(get().notes.map(n => n.id === noteId ? normalizePitchNote({ ...n, formantShift: clamped }) : n)) });
    onNotesChanged();
  },

  setNoteGain: (noteId, dB) => {
    get().pushUndo("Change gain");
    replaceDirtyPitchNotes([noteId]);
    set({ notes: normalizePitchNotes(get().notes.map(n => n.id === noteId ? normalizePitchNote({ ...n, gain: dB }) : n)) });
    onNotesChanged();
  },

  setNoteModulation: (noteId, percent) => {
    get().pushUndo("Change modulation");
    replaceDirtyPitchNotes([noteId]);
    set({ notes: normalizePitchNotes(get().notes.map(n => n.id === noteId ? normalizePitchNote({ ...n, vibratoDepth: percent / 100 }) : n)) });
    onNotesChanged();
  },

  setNoteDrift: (noteId, percent) => {
    get().pushUndo("Change drift");
    replaceDirtyPitchNotes([noteId]);
    set({ notes: normalizePitchNotes(get().notes.map(n => n.id === noteId ? normalizePitchNote({ ...n, driftCorrectionAmount: percent / 100 }) : n)) });
    onNotesChanged();
  },

  setNoteTransition: (noteId, inMs, outMs) => {
    get().pushUndo("Change transition");
    replaceDirtyPitchNotes([noteId]);
    set({ notes: normalizePitchNotes(get().notes.map(n => n.id === noteId ? normalizePitchNote({ ...n, transitionIn: inMs, transitionOut: outMs }) : n)) });
    onNotesChanged();
  },

  // Macro correction
  applyCorrectPitchMacro: (pitchCenter, pitchDriftAmount, useScale) => {
    const { notes, scaleNotes } = get();
    if (notes.length === 0) return;
    get().pushUndo("Correct pitch macro");
    replaceDirtyPitchNotes(notes.map((note) => note.id));
    set({
      notes: normalizePitchNotes(notes.map(n => {
        // Find nearest target (semitone or scale degree)
        let nearestTarget: number;
        if (useScale) {
          // Snap to nearest in-scale note
          const rounded = Math.round(n.detectedPitch);
          let best = rounded;
          let bestDist = 999;
          for (let offset = -2; offset <= 2; offset++) {
            const candidate = rounded + offset;
            const noteClass = ((candidate % 12) + 12) % 12;
            if (scaleNotes[noteClass] && Math.abs(offset) < bestDist) {
              best = candidate;
              bestDist = Math.abs(offset);
            }
          }
          nearestTarget = best;
        } else {
          nearestTarget = Math.round(n.detectedPitch);
        }

        const offset = n.detectedPitch - nearestTarget;
        // Musical intelligence: low % only fixes far-off notes
        const threshold = (1 - pitchCenter) * 0.5;
        let correctedPitch = n.detectedPitch;
        if (Math.abs(offset) > threshold) {
          correctedPitch = n.detectedPitch - offset * pitchCenter;
        }

        return normalizePitchNote({
          ...n,
          correctedPitch,
          driftCorrectionAmount: pitchDriftAmount,
        });
      })),
    });
    onNotesChanged();
  },

  // Merge notes
  mergeNotes: (noteIds) => {
    const { notes } = get();
    const toMerge = notes.filter(n => noteIds.includes(n.id)).sort((a, b) => a.startTime - b.startTime);
    if (toMerge.length < 2) return;
    get().pushUndo("Merge notes");

    // Weighted average pitch by duration
    let totalDuration = 0;
    let weightedPitch = 0;
    const allDrift: number[] = [];
    for (const n of toMerge) {
      const dur = n.endTime - n.startTime;
      totalDuration += dur;
      weightedPitch += n.detectedPitch * dur;
      if (n.pitchDrift) allDrift.push(...n.pitchDrift);
    }

    const merged: PitchNoteData = {
      ...toMerge[0],
      id: toMerge[0].id + "_merged",
      endTime: toMerge[toMerge.length - 1].endTime,
      effectiveStartTime: toMerge[0].effectiveStartTime ?? toMerge[0].startTime,
      effectiveEndTime: toMerge[toMerge.length - 1].effectiveEndTime ?? toMerge[toMerge.length - 1].endTime,
      detectedPitch: weightedPitch / totalDuration,
      correctedPitch: weightedPitch / totalDuration,
      pitchDrift: allDrift,
      transitionIn: toMerge[0].transitionIn,
      transitionOut: toMerge[toMerge.length - 1].transitionOut,
    };

    const mergeIds = new Set(noteIds);
    set({
      notes: normalizePitchNotes([...notes.filter(n => !mergeIds.has(n.id)), merged]),
      selectedNoteIds: [merged.id],
    });
    onNotesChanged();
  },

  // Draw pitch tool
  beginDrawPitch: () => {
    get().pushUndo("Draw pitch");
  },

  drawPitchOnNote: (noteId, clipTime, midiPitch) => {
    const { notes, contour } = get();
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    const noteDuration = note.endTime - note.startTime;
    if (noteDuration <= 0) return;
    if (!isVoicedAtClipTime(contour, clipTime)) return;

    const effectiveStart = note.effectiveStartTime ?? note.startTime;
    const effectiveEnd = note.effectiveEndTime ?? note.endTime;
    if (clipTime < effectiveStart || clipTime > effectiveEnd) return;
    const clampedClipTime = Math.max(note.startTime, Math.min(note.endTime, clipTime));

    // Ensure pitchDrift array has adequate resolution (at least 100 points per note)
    const minLen = Math.max(100, Math.ceil(noteDuration * 100)); // ~100 points/sec
    let drift = Array.isArray(note.pitchDrift) && note.pitchDrift.length > 0
      ? [...note.pitchDrift]
      : new Array(minLen).fill(0);

    // If drift array is too small, interpolate up
    if (drift.length < minLen) {
      const old = drift;
      drift = new Array(minLen).fill(0);
      for (let i = 0; i < minLen; i++) {
        const srcIdx = (i / minLen) * old.length;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, old.length - 1);
        const frac = srcIdx - lo;
        drift[i] = old[lo] * (1 - frac) + old[hi] * frac;
      }
    }

    // Map clipTime to index in drift array
    const t = (clampedClipTime - note.startTime) / noteDuration;
    if (t < 0 || t > 1) return;
    const idx = Math.round(t * (drift.length - 1));

    // pitchDrift is deviation from correctedPitch in semitones
    const deviation = midiPitch - note.correctedPitch;

    // Write with a small brush radius (3 adjacent samples) for smoothing
    const brushRadius = Math.max(1, Math.round(drift.length / 200));
    for (let di = -brushRadius; di <= brushRadius; di++) {
      const ti = idx + di;
      if (ti < 0 || ti >= drift.length) continue;
      const weight = 1 - Math.abs(di) / (brushRadius + 1);
      drift[ti] = drift[ti] * (1 - weight) + deviation * weight;
    }

    set({
      notes: normalizePitchNotes(notes.map(n => n.id === noteId ? normalizePitchNote({ ...n, pitchDrift: drift }) : n)),
    });
  },

  commitDrawPitch: () => {
    const { undoStack, notes } = get();
    const last = undoStack[undoStack.length - 1];
    if (last && pitchNotesEqual(last.notes, notes)) {
      set({ undoStack: undoStack.slice(0, -1) });
      return;
    }
    onNotesChanged();
  },

  // A/B comparison
  toggleABCompare: () => {
    const { abCompareMode, trackId, clipId } = get();
    const newBypass = !abCompareMode;
    set({ abCompareMode: newBypass });
    // Tell backend to bypass/restore pitch correction
    if (trackId && clipId) {
      nativeBridge.setPitchCorrectionBypass(trackId, clipId, newBypass);
    }
  },
}));

nativeBridge.onPitchCorrectionComplete((data: PitchCorrectionCompletionData) => {
  const state = usePitchEditorStore.getState();
  const meta = consumeRequestMeta(data.requestId);
  const completedRevision = consumeRequestRevision(data.requestId) ?? meta?.revision ?? null;

  if (!meta) {
    if (state.clipId === data.clipId) {
      logPitchEditorFormant("persistent listener ignored completion without request metadata", {
        clipId: data.clipId,
        requestId: data.requestId,
        renderMode: data.renderMode ?? null,
      });
    }
    return;
  }

  const currentClipMatches = state.clipId === data.clipId && meta.clipId === data.clipId;
  const revisionStillCurrent = completedRevision !== null && isCurrentRevision(completedRevision);

  logPitchEditorFormant("received pitch correction completion", {
    clipId: data.clipId,
    requestId: data.requestId,
    logicalRequestId: meta.logicalRequestId,
    requestRevision: completedRevision,
    renderMode: data.renderMode ?? meta.renderMode,
    stage: meta.stage,
    success: data.success,
    cancelled: Boolean(data.cancelled),
    revisionStillCurrent,
    outputFile: data.outputFile,
  });

  if (!currentClipMatches) {
    if (meta.stage === "note_hq") {
      finishNoteHqPriority(meta.logicalRequestId);
    }
    return;
  }

  if (data.cancelled) {
    logPitchEditorFormant("ignoring cancelled completion", {
      clipId: data.clipId,
      requestId: data.requestId,
      logicalRequestId: meta.logicalRequestId,
      stage: meta.stage,
    });
    if (meta.stage === "note_hq") {
      finishNoteHqPriority(meta.logicalRequestId);
    }
    return;
  }

  if (!data.success || !data.outputFile) {
    const failureMessage = getPitchCorrectionFailureMessage(data);
    if (meta.stage === "preview_segment" || meta.stage === "single" || meta.stage === "note_hq") {
      if (meta.stage === "preview_segment") {
        _runningPreviewSegmentJobs = Math.max(0, _runningPreviewSegmentJobs - 1);
      }
      if (meta.stage === "note_hq") {
        finishNoteHqPriority(meta.logicalRequestId);
      }
      if (_activePitchCorrectionRequestId === meta.logicalRequestId) {
        _activePitchCorrectionRequestId = null;
      }
      setApplyStatus("error", failureMessage, meta.logicalRequestId);
      useDAWStore.getState().showToast(failureMessage, "error");
    } else if (meta.stage === "full_clip_hq") {
      _activePitchCorrectionRequestId = null;
      setApplyStatus("error", failureMessage, meta.logicalRequestId);
      useDAWStore.getState().showToast(failureMessage, "error");
    }
    warnPitchEditorFormant("persistent completion listener received failed result", {
      clipId: data.clipId,
      requestId: data.requestId,
      logicalRequestId: meta.logicalRequestId,
      requestRevision: completedRevision,
      stage: meta.stage,
      hardFailReason: data.hardFailReason ?? null,
      fallbackReason: data.fallbackReason ?? null,
      pitchRenderStrategy: data.pitchRenderStrategy ?? null,
      pitchRenderProductPath: data.pitchRenderProductPath ?? null,
      pitchRenderBackendId: data.pitchRenderBackendId ?? null,
      pitchRenderBackendFailureCode: data.pitchRenderBackendFailureCode ?? null,
    });
    return;
  }

  if (!revisionStillCurrent) {
    logPitchEditorFormant("ignoring stale completion for outdated revision", {
      clipId: data.clipId,
      requestId: data.requestId,
      logicalRequestId: meta.logicalRequestId,
      requestRevision: completedRevision,
      currentEditRevision: _editRevision,
      requestedApplyRevision: _requestedApplyRevision,
      stage: meta.stage,
    });
    if (meta.stage === "note_hq") {
      finishNoteHqPriority(meta.logicalRequestId);
      if (_activePitchCorrectionRequestId === meta.logicalRequestId) {
        _activePitchCorrectionRequestId = null;
      }
    }
    return;
  }

  _appliedRevision = Math.max(_appliedRevision, completedRevision ?? _appliedRevision);
  if (meta.stage === "preview_segment") {
    _runningPreviewSegmentJobs = Math.max(0, _runningPreviewSegmentJobs - 1);
    if (state.renderCoverage.length > 0 && state.renderCoverage.every((range) => range.state === "hq_ready")) {
      logPitchEditorFormant("ignoring preview segment completion because HQ coverage is already active", {
        clipId: data.clipId,
        requestId: data.requestId,
        logicalRequestId: meta.logicalRequestId,
      });
      return;
    }
    if (meta.windowStartSec !== undefined && meta.windowEndSec !== undefined) {
      updateRenderCoverageRange(meta.windowStartSec, meta.windowEndSec, "preview_ready");
    }
    const coverageDone = usePitchEditorStore.getState().renderCoverage.every((range) => range.state !== "pending");
    setApplyStatus("preview_ready", getRenderedPreviewStatusMessage("preview_ready", coverageDone), meta.logicalRequestId);
    if (_activePreviewRequestGroupId === meta.logicalRequestId) {
      dispatchNextPreviewSegments();
    }
    return;
  }

  if (meta.stage === "note_hq") {
    clearTransientPitchPreview(data.clipId, "note_hq_complete");
    clearStagedPreviewQueue();
    clearRenderedPreviewForInteractiveEdit(data.clipId, "note_hq_complete");
    if (data.outputFile) {
      applyPitchCorrectionResultToClip(data.clipId, data.outputFile, Boolean(data.restored));
    } else {
      warnPitchEditorFormant("note-HQ completion did not include an output file", {
        clipId: data.clipId,
        requestId: data.requestId,
        logicalRequestId: meta.logicalRequestId,
      });
    }
    if (meta.coverageRanges && meta.coverageRanges.length > 0) {
      for (const range of meta.coverageRanges) {
        updateRenderCoverageRange(range.startTime, range.endTime, "hq_ready");
      }
    } else if (meta.windowStartSec !== undefined && meta.windowEndSec !== undefined) {
      updateRenderCoverageRange(meta.windowStartSec, meta.windowEndSec, "hq_ready");
    }
    _dirtyPitchNoteIds.clear();
    finishNoteHqPriority(meta.logicalRequestId);
    _activePitchCorrectionRequestId = null;
    setApplyStatus("final_processing", "Verifying HQ note route...", meta.logicalRequestId);
    scheduleNoteHqFinalRouteVerification(meta, data);
    logPitchEditorFormant("note-local HQ cache updated", {
      clipId: data.clipId,
      requestId: data.requestId,
      logicalRequestId: meta.logicalRequestId,
      outputFile: data.outputFile,
      appFinalBakedContextPath: data.appFinalBakedContextPath,
      appFinalPlaybackContextPath: data.appFinalPlaybackContextPath,
      appFinalParityReportPath: data.appFinalParityReportPath,
      windowStartSec: meta.windowStartSec,
      windowEndSec: meta.windowEndSec,
    });
    return;
  }

  applyPitchCorrectionResultToClip(data.clipId, data.outputFile, Boolean(data.restored));
  _dirtyPitchNoteIds.clear();
  markAllRenderCoverage("hq_ready", meta.logicalRequestId);
  clearStagedPreviewQueue();
  _activePitchCorrectionRequestId = null;
  setApplyStatus("done", meta.stage === "full_clip_hq"
    ? (data.swapDeferred ? "HQ ready on stop/seek" : getRenderedPreviewStatusMessage("done", true))
    : "Applied", meta.logicalRequestId, { autoClearMs: 1800 });
  useDAWStore.getState().showToast(
    meta.stage === "full_clip_hq" ? "Pitch/formant HQ render ready" : "Pitch/formant changes applied",
    "success",
  );
  logPitchEditorFormant("clip playback source updated", {
    clipId: data.clipId,
    requestId: data.requestId,
    logicalRequestId: meta.logicalRequestId,
    outputFile: data.outputFile,
    restored: Boolean(data.restored),
    stage: meta.stage,
  });
  if (data.success) {
    console.log("[pitchEditor] SMS correction complete for clip", data.clipId);
  } else {
    console.warn("[pitchEditor] SMS correction failed for clip", data.clipId);
  }
});
