import { create } from "zustand";
import { nativeBridge, PitchNoteData, PitchContourData, PolyNoteData, PolyAnalysisResult, UnifiedNoteData, polyToUnified, monoToUnified, type ClipPitchPreviewPayload, type PitchCorrectionRenderMode } from "../services/NativeBridge";
import { useDAWStore } from "./useDAWStore";
import { logBridgeError } from "../utils/bridgeErrorHandler";

export type PitchEditorTool = "select" | "pitch" | "drift" | "vibrato" | "transition" | "draw" | "split";
export type PitchSnapMode = "off" | "chromatic" | "scale";
export type PitchEditorApplyState =
  | "idle"
  | "queued"
  | "processing"
  | "preview_processing"
  | "preview_ready"
  | "final_processing"
  | "done"
  | "error";

export type PitchRenderCoverageState = "pending" | "preview_ready" | "hq_ready";

export interface PitchRenderCoverageRange {
  startTime: number;
  endTime: number;
  state: PitchRenderCoverageState;
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

  // Polyphonic mode (Phase 7)
  polyMode: boolean;
  polyNotes: PolyNoteData[];
  polyAnalysisResult: PolyAnalysisResult | null;
  showPitchSalience: boolean;
  soloNoteId: string | null;

  // Poly detection tuning
  polyNoteThreshold: number;    // 0-1, default 0.15
  polyOnsetThreshold: number;   // 0-1, default 0.3
  polyMinDuration: number;      // ms, default 80

  togglePolyMode: () => void;
  analyzePolyphonic: () => Promise<void>;
  updatePolyNote: (noteId: string, changes: Partial<PolyNoteData>) => void;
  movePolyNotePitch: (noteId: string, semitones: number) => void;
  moveSelectedPolyPitch: (semitones: number) => void;
  soloPolyNote: (noteId: string | null) => void;
  applyPolyCorrection: () => Promise<void>;
  togglePitchSalience: () => void;
  setPolyNoteThreshold: (v: number) => void;
  setPolyOnsetThreshold: (v: number) => void;
  setPolyMinDuration: (v: number) => void;

  // Auto-detect mono vs poly
  autoDetectMonoPoly: () => void;

  // A/B comparison
  abCompareMode: boolean;       // true = playing original (bypass correction)
  toggleABCompare: () => void;

  // Unified note accessor — returns mono or poly notes as UnifiedNoteData[]
  getUnifiedNotes: () => UnifiedNoteData[];
}

// Tracks the active pitchAnalysisComplete listener so stale listeners from
// previous analyze() calls can be cancelled before subscribing a new one.
// Without this, a stale listener fires for the next analysis result,
// doubling the notes and corrupting pitch correction data.
let _pitchAnalysisUnsubscribe: (() => void) | null = null;

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
const _requestRevisionById = new Map<string, number>();
type PitchApplyRenderStage = "single" | "preview_segment" | "full_clip_hq";
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
  requestGroupId: string;
  segmentIndex?: number;
}
const _requestMetaById = new Map<string, PitchCorrectionRequestMeta>();

// Auto-apply debounce — fires 400ms after the last note mutation so playback
// always reflects the current state without a manual Apply button.
let _autoApplyTimer: ReturnType<typeof setTimeout> | null = null;
// Throttle timer for real-time pitch preview during drag (max ~12fps, fast enough to feel live).
let _dragPreviewThrottle: ReturnType<typeof setTimeout> | null = null;
const FORMANT_LOG_PREFIX = "[pitchEditor.formant]";
const PREVIEW_SEGMENT_DURATION_SEC = 10;
const MAX_PREVIEW_SEGMENT_CONCURRENCY = 2;
const PREVIEW_LOOKBEHIND_SEC = 0.2;
const PREVIEW_LOOKAHEAD_PLAYING_SEC = 3.0;
const PREVIEW_LOOKAHEAD_STOPPED_SEC = 1.5;
const AUTO_BAKE_LOOKBEHIND_SEC = 0.25;
const AUTO_BAKE_LOOKAHEAD_SEC = 2.5;
let _activePreviewRequestGroupId: string | null = null;
let _pendingPreviewSegments: PendingPreviewSegment[] = [];
let _runningPreviewSegmentJobs = 0;
let _stagedPreviewBase: Omit<PitchCorrectionRequestMeta, "requestId" | "stage" | "renderMode" | "windowStartSec" | "windowEndSec" | "segmentIndex"> | null = null;

function shouldLogPitchEditorFormant() {
  const win = window as Window & { __S13_DEBUG_FORMANT__?: boolean; location?: { hostname?: string } };
  const host = win.location?.hostname ?? "";
  return win.__S13_DEBUG_FORMANT__ === true || host === "localhost" || host === "127.0.0.1";
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

function resetApplyRevisions() {
  _editRevision = 0;
  _requestedApplyRevision = 0;
  _appliedRevision = 0;
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

function summarizeApplyRequest(notes: PitchNoteData[], globalFormantSt: number): ApplyRequestSummary {
  let pitchEdits = 0;
  let noteFormantEdits = 0;
  let gainEdits = 0;
  let driftEdits = 0;
  let vibratoEdits = 0;
  for (const note of notes) {
    if (Math.abs(note.correctedPitch - note.detectedPitch) > 0.01) pitchEdits++;
    if (Math.abs(note.formantShift) > 0.01) noteFormantEdits++;
    if (Math.abs(note.gain) > 0.01) gainEdits++;
    if (note.driftCorrectionAmount > 0.01) driftEdits++;
    if (Math.abs(note.vibratoDepth - 1.0) > 0.01) vibratoEdits++;
  }
  const hasGlobalFormant = Math.abs(globalFormantSt) > 0.01;
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
    globalFormantCents: Math.round(globalFormantSt * 100),
    globalFormantSemitones: globalFormantSt,
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
  return Math.abs(globalFormantSt) > 0.01
    || notes.some((n) => Math.abs(n.formantShift) > 0.01);
}

function hasRealtimePitchPreviewWork(notes: PitchNoteData[], globalFormantSt: number) {
  void globalFormantSt;
  return notes.some((n) => Math.abs(n.correctedPitch - n.detectedPitch) > 0.01);
}

function getPlaybackPreviewStatusMessage(notes: PitchNoteData[], globalFormantSt: number) {
  if (hasRequestedFormantWork(notes, globalFormantSt) && hasRealtimePitchPreviewWork(notes, globalFormantSt)) {
    return "Rendered formant + live pitch preview";
  }
  if (hasRequestedFormantWork(notes, globalFormantSt)) return "Formant after apply";
  if (hasRealtimePitchPreviewWork(notes, globalFormantSt)) return "Live pitch preview";
  return "No preview changes";
}

function buildPreviewWindow() {
  const pitchState = usePitchEditorStore.getState();
  const transport = useDAWStore.getState().transport;
  const clipDuration = pitchState.clipDuration || 0;
  const clipTime = Math.max(0, Math.min(clipDuration, transport.currentTime - pitchState.clipStartTime));
  const lookAhead = transport.isPlaying ? PREVIEW_LOOKAHEAD_PLAYING_SEC : PREVIEW_LOOKAHEAD_STOPPED_SEC;
  return {
    previewStartSec: Math.max(0, clipTime - PREVIEW_LOOKBEHIND_SEC),
    previewEndSec: Math.min(clipDuration, clipTime + lookAhead),
    clipTime,
    isPlaying: transport.isPlaying,
  };
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

/** Build pitch correction segments and send pitch+global-formant preview to backend. */
function sendPitchPreviewMap(reason: "edit" | "transport" | "sync" = "edit") {
  const { clipId, notes, globalFormantCents } = usePitchEditorStore.getState();
  if (!clipId) return;
  const globalFormantSt = globalFormantCents / 100;
  const pitchSegments = notes
    .filter(n => Math.abs(n.correctedPitch - n.detectedPitch) > 0.01)
    .map(n => ({
      startTime: n.startTime,
      endTime: n.endTime,
      pitchRatio: Math.pow(2, (n.correctedPitch - n.detectedPitch) / 12),
    }));

  if (!hasRealtimePitchPreviewWork(notes, globalFormantSt)) {
    nativeBridge.clearClipPitchPreview(clipId).catch(logBridgeError("clearClipPitchPreview"));
    logPitchEditorFormant(
      hasRequestedFormantWork(notes, globalFormantSt)
        ? "suppressed realtime preview while formant edits are active"
        : "cleared rolling preview",
      { clipId, reason, globalFormantSemitones: globalFormantSt },
    );
    return;
  }

  const window = buildPreviewWindow();
  const payload: ClipPitchPreviewPayload = {
    pitchSegments,
    globalFormantSemitones: 0,
    previewStartSec: window.previewStartSec,
    previewEndSec: window.previewEndSec,
  };

  logPitchEditorFormant("sending rolling preview", {
    clipId,
    reason,
    pitchSegments: pitchSegments.length,
    requestedGlobalFormantSemitones: globalFormantSt,
    livePreviewPitchOnly: true,
    previewStartSec: payload.previewStartSec,
    previewEndSec: payload.previewEndSec,
    transportPlaying: window.isPlaying,
  });

  nativeBridge.setClipPitchPreview(clipId, payload).catch(err =>
    console.warn("[pitchEditor] setClipPitchPreview failed:", err)
  );
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
        scheduleRollingPreviewRefresh();
      } else if (prevTransport?.isPlaying) {
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
  registerRequestMeta(meta);
  const statusRequestId = meta.logicalRequestId;
  _activePitchCorrectionRequestId = statusRequestId;

  if (meta.stage === "preview_segment") {
    if (usePitchEditorStore.getState().applyState !== "final_processing") {
      setApplyStatus("preview_processing", getFormantPreviewStatusMessage("preview_processing", false), statusRequestId);
    }
  } else if (meta.stage === "full_clip_hq") {
    setApplyStatus("final_processing", getFormantPreviewStatusMessage("final_processing", false), statusRequestId);
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
    meta.notes,
    meta.frames,
    meta.requestId,
    meta.globalFormantSt,
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

function getFormantPreviewStatusMessage(state: PitchEditorApplyState, previewCoverageComplete: boolean) {
  switch (state) {
    case "preview_processing":
      return "Rendering preview near playhead...";
    case "preview_ready":
      return previewCoverageComplete ? "Rendered formant preview ready" : "Previewing rendered formant";
    case "final_processing":
      return "Refining full clip render...";
    case "done":
      return "Previewing rendered formant";
    default:
      return "Rendered formant preview";
  }
}

function dispatchStagedFormantApply(
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

function scheduleAutoApply(delayMs = 400) {
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
    const { trackId, clipId, notes, contour, globalFormantCents } = usePitchEditorStore.getState();
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
    const bakeWindow = buildAutoBakeWindow();
    const requiresStagedFormantBake = hasRequestedFormantWork(notes, globalFormantSt);
    // Ensure the clip is registered in the playback engine before applying.
    // Re-establish the real-time preview after sync (clearAllClips destroys it).
    sendPitchPreviewMap("sync");
    if (bakeWindow.isPlaying && !requiresStagedFormantBake) {
      setApplyStatus("done", getPlaybackPreviewStatusMessage(notes, globalFormantSt), null, { autoClearMs: 1400 });
      logPitchEditorFormant("skipping auto-apply during playback; preview-only mode active", {
        clipId,
        editRevision: _editRevision,
        appliedRevision: _appliedRevision,
        realtimePitchPreview: hasRealtimePitchPreviewWork(notes, globalFormantSt),
        formantDeferred: hasRequestedFormantWork(notes, globalFormantSt),
      });
      return;
    }
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
    logPitchEditorFormant("dispatching auto-bake request", {
      clipId,
      logicalRequestId,
      requestRevision,
      stagedFormant: requiresStagedFormantBake,
      windowStartSec: requiresStagedFormantBake ? null : bakeWindow.windowStartSec,
      windowEndSec: requiresStagedFormantBake ? null : bakeWindow.windowEndSec,
      ...requestSummary,
    });

    if (requiresStagedFormantBake) {
      dispatchStagedFormantApply(
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

    clearStagedPreviewQueue();
    setRenderCoverage([], null);
    nativeBridge.clearClipRenderedPreviewSegments(clipId).catch(logBridgeError("clearClipRenderedPreviewSegments"));
    // Do NOT pass a playhead-based window override for single bakes.
    // When the playhead is inside a note, the playhead window ([clipTime-0.25, clipTime+2.5])
    // starts mid-note, clamping the note's startSample to 0 and eliminating its pre-roll.
    // The Signalsmith stretcher then has no warm-up before the note (analysis window = 120ms),
    // producing edge artifacts at the splice crossfade that sound abrupt ("not smoothened").
    // Without an override, the backend computes the window from note boundaries with 1.0s
    // of padding on each side — always giving the stretcher time to fully initialize.
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
  zoomY: 24,   // pixels per semitone
  undoStack: [],
  redoStack: [],
  referenceTracks: [],
  scaleKey: 0,
  scaleType: "chromatic",
  scaleNotes: new Array(12).fill(true),
  inspectorExpanded: true,
  globalFormantCents: 0,
  showCorrectPitchModal: false,
  polyMode: false,
  polyNotes: [],
  polyAnalysisResult: null,
  showPitchSalience: false,
  soloNoteId: null,
  polyNoteThreshold: 0.15,
  polyOnsetThreshold: 0.3,
  polyMinDuration: 80,
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
      isApplying: false,
      applyState: "idle",
      applyMessage: "",
      lastApplyRequestId: null,
      renderCoverage: [],
      activeLogicalRequestId: null,
      scrollY: 48, // Reset to middle C, will be auto-fit after analysis
      globalFormantCents: 0,
      polyMode: false,
      polyNotes: [],
      polyAnalysisResult: null,
      showPitchSalience: false,
      soloNoteId: null,
    });
  },

  close: () => {
    // Clear real-time pitch preview when closing the editor
    const { clipId } = get();
    if (clipId) {
      nativeBridge.clearClipPitchPreview(clipId).catch(logBridgeError("clearClipPitchPreview"));
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
      polyMode: false,
      polyNotes: [],
      polyAnalysisResult: null,
      showPitchSalience: false,
      soloNoteId: null,
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
  // Analyzes a chunk (max ~30s) around the given time range.
  // Merges results with existing notes to build up the full picture as user scrolls.
  analyze: async (viewStartTime?: number, viewEndTime?: number) => {
    const { trackId, clipId, isAnalyzing, originalClipFilePath, originalClipOffset } = get();
    if (!trackId || !clipId || isAnalyzing) return;

    const dawState = useDAWStore.getState();
    const track = dawState.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!clip) return;

    // Always analyze from the original (pre-correction) file path and offset.
    // clip.filePath is updated to _pcN.wav after each correction; using that would
    // produce frames that reflect corrected pitch, breaking subsequent edit ratios.
    const analysisFilePath = originalClipFilePath ?? clip.filePath;
    if (!analysisFilePath) return;

    // Determine analysis window: max 30s chunk centered on viewport
    const MAX_CHUNK = 30; // seconds
    // Use original offset — after correction clip.offset is reset to 0 (corrected file
    // starts at 0), but the original file needs its original seek position.
    const clipOffset = originalClipOffset;
    const clipDuration = clip.duration;

    let analyzeStart: number;
    let analyzeDuration: number;

    if (viewStartTime !== undefined && viewEndTime !== undefined) {
      // Analyze around viewport with padding
      const viewDuration = viewEndTime - viewStartTime;
      const padding = Math.min(5, viewDuration * 0.5); // 5s padding or 50% of view
      analyzeStart = Math.max(0, viewStartTime - padding);
      const analyzeEnd = Math.min(clipDuration, viewEndTime + padding);
      analyzeDuration = Math.min(MAX_CHUNK, analyzeEnd - analyzeStart);
    } else {
      // Initial analysis: first 30s of the clip
      analyzeStart = 0;
      analyzeDuration = Math.min(MAX_CHUNK, clipDuration);
    }

    set({ isAnalyzing: true, progressPercent: 0, progressLabel: "Analyzing pitch..." });
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

      if (notification?.ready && notification?.noteCount >= 0) {
        try {
          const fullResult = await nativeBridge.getLastPitchAnalysisResult();
          if (fullResult?.notes) {
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
            }));
            if (fullResult.frames) {
              fullResult.frames.times = fullResult.frames.times.map(
                (t: number) => t + analyzeStart
              );
            }

            const { notes: existingNotes } = get();

            // Merge new notes with existing (replace overlapping range)
            let mergedNotes: PitchNoteData[];
            if (existingNotes.length > 0) {
              const rangeStart = analyzeStart;
              const rangeEnd = analyzeStart + analyzeDuration;
              mergedNotes = existingNotes.filter(
                (n) => n.endTime < rangeStart || n.startTime > rangeEnd
              );
              mergedNotes.push(...offsetNotes);
              mergedNotes.sort((a, b) => a.startTime - b.startTime);
            } else {
              mergedNotes = offsetNotes;
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
              progressPercent: 100,
              progressLabel: "",
              contour: mergedContour,
              notes: mergedNotes,
              selectedNoteIds: [],
              undoStack: [],
              redoStack: [],
            });

            // Auto-fit viewport on first analysis (no existing notes)
            if (existingNotes.length === 0 && mergedNotes.length > 0) {
              let minMidi = 127, maxMidi = 0;
              for (const n of mergedNotes) {
                minMidi = Math.min(minMidi, Math.floor(n.detectedPitch) - 2);
                maxMidi = Math.max(maxMidi, Math.ceil(n.detectedPitch) + 2);
              }
              set({ scrollY: minMidi, scrollX: 0 });
              // Auto-detect mono vs poly on first analysis
              get().autoDetectMonoPoly();
            }
          } else {
            console.warn("[PitchEditor] No notes in analysis result");
            set({ isAnalyzing: false });
          }
        } catch (err) {
          console.error("[PitchEditor] Failed to fetch analysis result:", err);
          set({ isAnalyzing: false });
        }
      } else {
        console.warn("[PitchEditor] Analysis completed with 0 notes or failed");
        set({ isAnalyzing: false });
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
        _pitchAnalysisUnsubscribe = null;
        unsubscribe();
        set({ isAnalyzing: false });
      }
    } catch {
      _pitchAnalysisUnsubscribe = null;
      unsubscribe();
      set({ isAnalyzing: false });
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

  pushUndo: (description) => {
    const { notes, undoStack } = get();
    set({
      undoStack: [...undoStack, { description, notes: JSON.parse(JSON.stringify(notes)) }],
      redoStack: [],
    });
  },

  // Raw updater — does NOT push undo and does NOT schedule auto-apply.
  // Called many times per drag; auto-apply is deferred to commitNoteEdit() on mouseup.
  // Sends a throttled real-time preview so the user hears the new pitch while dragging.
  updateNote: (noteId, changes) => {
    set({
      notes: get().notes.map(n => n.id === noteId ? { ...n, ...changes } : n),
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
    onNotesChanged();
  },

  updateSelectedNotes: (changes) => {
    const { selectedNoteIds, notes } = get();
    if (selectedNoteIds.length === 0) return;
    get().pushUndo("Edit selected notes");
    set({
      notes: notes.map(n =>
        selectedNoteIds.includes(n.id) ? { ...n, ...changes } : n
      ),
    });
    onNotesChanged();
  },

  moveSelectedPitch: (semitones) => {
    const { selectedNoteIds, notes } = get();
    if (selectedNoteIds.length === 0) return;
    get().pushUndo(`Move pitch ${semitones > 0 ? "up" : "down"}`);
    set({
      notes: notes.map(n =>
        selectedNoteIds.includes(n.id)
          ? { ...n, correctedPitch: n.correctedPitch + semitones }
          : n
      ),
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
      endTime: time,
      pitchDrift: drift.slice(0, splitIdx),
      transitionOut: 0,
    };
    const note2: PitchNoteData = {
      ...note,
      id: note.id + "_b",
      startTime: time,
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
      notes: notes.flatMap(n => n.id === noteId ? [note1, note2] : [n]),
      selectedNoteIds: [note1.id, note2.id],
    });
    onNotesChanged();
  },

  correctSelectedToScale: () => {
    const { selectedNoteIds, notes } = get();
    if (selectedNoteIds.length === 0) return;
    get().pushUndo("Correct to scale");
    set({
      notes: notes.map(n => {
        if (!selectedNoteIds.includes(n.id)) return n;
        return { ...n, correctedPitch: Math.round(n.correctedPitch) };
      }),
    });
    onNotesChanged();
  },

  correctAllToScale: () => {
    const { notes } = get();
    get().pushUndo("Correct all to scale");
    set({
      notes: notes.map(n => ({ ...n, correctedPitch: Math.round(n.correctedPitch) })),
    });
    onNotesChanged();
  },

  undo: () => {
    const { undoStack, notes } = get();
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, { description: entry.description, notes: JSON.parse(JSON.stringify(notes)) }],
      notes: entry.notes,
    });
    onNotesChanged();
  },

  redo: () => {
    const { redoStack, notes } = get();
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, { description: entry.description, notes: JSON.parse(JSON.stringify(notes)) }],
      notes: entry.notes,
    });
    onNotesChanged();
  },

  setScrollX: (x) => set({ scrollX: Math.max(0, x) }),
  setScrollY: (y) => set({ scrollY: Math.max(0, Math.min(120, y)) }),
  setZoomX: (z) => set({ zoomX: Math.max(50, Math.min(2000, z)) }),
  setZoomY: (z) => set({ zoomY: Math.max(4, Math.min(40, z)) }),

  applyCorrection: async () => {
    const { trackId, clipId, notes, contour, globalFormantCents } = get();
    if (!trackId || !clipId) return;
    const globalFormantSt = globalFormantCents / 100;
    const summary = summarizeApplyRequest(notes, globalFormantSt);
    const requestRevision = _editRevision;
    _requestedApplyRevision = requestRevision;
    const logicalRequestId = buildLogicalApplyRequestId(clipId);
    logPitchEditorFormant("manual apply requested", { clipId, logicalRequestId, requestRevision, ...summary });

    if (hasRequestedFormantWork(notes, globalFormantSt)) {
      dispatchStagedFormantApply(
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
    get().pushUndo("Change formant");
    const clamped = Math.max(-3.86, Math.min(3.86, semitones));
    set({ notes: get().notes.map(n => n.id === noteId ? { ...n, formantShift: clamped } : n) });
    onNotesChanged();
  },

  setNoteGain: (noteId, dB) => {
    get().pushUndo("Change gain");
    set({ notes: get().notes.map(n => n.id === noteId ? { ...n, gain: dB } : n) });
    onNotesChanged();
  },

  setNoteModulation: (noteId, percent) => {
    get().pushUndo("Change modulation");
    set({ notes: get().notes.map(n => n.id === noteId ? { ...n, vibratoDepth: percent / 100 } : n) });
    onNotesChanged();
  },

  setNoteDrift: (noteId, percent) => {
    get().pushUndo("Change drift");
    set({ notes: get().notes.map(n => n.id === noteId ? { ...n, driftCorrectionAmount: percent / 100 } : n) });
    onNotesChanged();
  },

  setNoteTransition: (noteId, inMs, outMs) => {
    get().pushUndo("Change transition");
    set({ notes: get().notes.map(n => n.id === noteId ? { ...n, transitionIn: inMs, transitionOut: outMs } : n) });
    onNotesChanged();
  },

  // Macro correction
  applyCorrectPitchMacro: (pitchCenter, pitchDriftAmount, useScale) => {
    const { notes, scaleNotes } = get();
    if (notes.length === 0) return;
    get().pushUndo("Correct pitch macro");
    set({
      notes: notes.map(n => {
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

        return {
          ...n,
          correctedPitch,
          driftCorrectionAmount: pitchDriftAmount,
        };
      }),
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
      detectedPitch: weightedPitch / totalDuration,
      correctedPitch: weightedPitch / totalDuration,
      pitchDrift: allDrift,
      transitionIn: toMerge[0].transitionIn,
      transitionOut: toMerge[toMerge.length - 1].transitionOut,
    };

    const mergeIds = new Set(noteIds);
    set({
      notes: [...notes.filter(n => !mergeIds.has(n.id)), merged].sort((a, b) => a.startTime - b.startTime),
      selectedNoteIds: [merged.id],
    });
    onNotesChanged();
  },

  // Draw pitch tool
  beginDrawPitch: () => {
    get().pushUndo("Draw pitch");
  },

  drawPitchOnNote: (noteId, clipTime, midiPitch) => {
    const { notes } = get();
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    const noteDuration = note.endTime - note.startTime;
    if (noteDuration <= 0) return;

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
    const t = (clipTime - note.startTime) / noteDuration;
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
      notes: notes.map(n => n.id === noteId ? { ...n, pitchDrift: drift } : n),
    });
  },

  commitDrawPitch: () => {
    onNotesChanged();
  },

  // Polyphonic mode actions
  togglePolyMode: () => set({ polyMode: !get().polyMode }),
  togglePitchSalience: () => set({ showPitchSalience: !get().showPitchSalience }),

  analyzePolyphonic: async () => {
    const { trackId, clipId, polyNoteThreshold, polyOnsetThreshold, polyMinDuration } = get();
    if (!trackId || !clipId) return;
    set({ isAnalyzing: true });
    try {
      const result = await nativeBridge.analyzePolyphonic(trackId, clipId, {
        noteThreshold: polyNoteThreshold,
        onsetThreshold: polyOnsetThreshold,
        minDurationMs: polyMinDuration,
      });
      if (result && !result.error) {
        const polyNotes: PolyNoteData[] = result.notes.map(n => ({
          ...n,
          correctedPitch: n.correctedPitch ?? n.midiPitch,
          formantShift: n.formantShift ?? 0,
          gain: n.gain ?? 0,
        }));
        set({
          polyAnalysisResult: result,
          polyNotes,
          polyMode: true,
          selectedNoteIds: [],
        });
        // Auto-fit viewport to content
        if (polyNotes.length > 0) {
          let minMidi = 127, maxMidi = 0;
          for (const n of polyNotes) {
            minMidi = Math.min(minMidi, n.midiPitch - 2);
            maxMidi = Math.max(maxMidi, n.midiPitch + 2);
          }
          set({ scrollY: minMidi });
        }
      } else if (result?.error) {
        console.error("Polyphonic analysis error:", result.error);
      }
    } finally {
      set({ isAnalyzing: false });
    }
  },

  updatePolyNote: (noteId, changes) => {
    set({
      polyNotes: get().polyNotes.map(n => n.id === noteId ? { ...n, ...changes } : n),
    });
  },

  movePolyNotePitch: (noteId, semitones) => {
    set({
      polyNotes: get().polyNotes.map(n =>
        n.id === noteId ? { ...n, correctedPitch: n.correctedPitch + semitones } : n
      ),
    });
  },

  moveSelectedPolyPitch: (semitones) => {
    const { selectedNoteIds, polyNotes } = get();
    if (selectedNoteIds.length === 0) return;
    set({
      polyNotes: polyNotes.map(n =>
        selectedNoteIds.includes(n.id)
          ? { ...n, correctedPitch: n.correctedPitch + semitones }
          : n
      ),
    });
  },

  soloPolyNote: (noteId) => set({ soloNoteId: noteId }),

  applyPolyCorrection: async () => {
    const { trackId, clipId, polyNotes } = get();
    if (!trackId || !clipId) return;
    set({ isApplying: true });
    try {
      const editedNotes = polyNotes
        .filter(n => Math.abs(n.correctedPitch - n.midiPitch) > 0.05 || Math.abs(n.gain) > 0.1)
        .map(n => ({
          id: n.id,
          originalPitch: n.midiPitch,
          correctedPitch: n.correctedPitch,
          formantShift: n.formantShift,
          gain: n.gain,
        }));
      await nativeBridge.applyPolyPitchCorrection(trackId, clipId, editedNotes);
    } finally {
      set({ isApplying: false });
    }
  },

  // Poly detection tuning
  setPolyNoteThreshold: (v) => set({ polyNoteThreshold: Math.max(0.01, Math.min(1, v)) }),
  setPolyOnsetThreshold: (v) => set({ polyOnsetThreshold: Math.max(0.01, Math.min(1, v)) }),
  setPolyMinDuration: (v) => set({ polyMinDuration: Math.max(10, Math.min(500, v)) }),

  // Auto-detect mono vs poly — heuristic based on mono analysis quality
  autoDetectMonoPoly: () => {
    const { contour, notes } = get();
    if (!contour || notes.length === 0) return;

    const frames = contour.frames;
    if (!frames || frames.confidence.length === 0) return;

    // Heuristic 1: average confidence — mono YIN struggles with polyphonic content
    let totalConf = 0;
    let voicedCount = 0;
    for (let i = 0; i < frames.confidence.length; i++) {
      if (frames.midi[i] > 0) {
        totalConf += frames.confidence[i];
        voicedCount++;
      }
    }
    const avgConf = voicedCount > 0 ? totalConf / voicedCount : 1;

    // Heuristic 2: note fragmentation — poly content produces many short notes
    const avgDuration = notes.reduce((s, n) => s + (n.endTime - n.startTime), 0) / notes.length;

    // Heuristic 3: pitch instability — large jumps between adjacent notes
    let jumpCount = 0;
    for (let i = 1; i < notes.length; i++) {
      const gap = notes[i].startTime - notes[i - 1].endTime;
      const pitchDiff = Math.abs(notes[i].detectedPitch - notes[i - 1].detectedPitch);
      if (gap < 0.1 && pitchDiff > 7) jumpCount++;
    }
    const jumpRate = notes.length > 1 ? jumpCount / (notes.length - 1) : 0;

    // Score: higher = more likely polyphonic
    const isLikelyPoly = avgConf < 0.5 || avgDuration < 0.12 || jumpRate > 0.3;

    if (isLikelyPoly) {
      console.log(`[PitchEditor] Auto-detect: likely polyphonic (avgConf=${avgConf.toFixed(2)}, avgDur=${avgDuration.toFixed(2)}s, jumpRate=${jumpRate.toFixed(2)})`);
      set({ polyMode: true });
    } else {
      console.log(`[PitchEditor] Auto-detect: likely monophonic (avgConf=${avgConf.toFixed(2)}, avgDur=${avgDuration.toFixed(2)}s, jumpRate=${jumpRate.toFixed(2)})`);
      set({ polyMode: false });
    }
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

  // Unified note accessor
  getUnifiedNotes: () => {
    const { polyMode, notes, polyNotes } = get();
    if (polyMode) {
      return polyNotes.map(polyToUnified);
    }
    return notes.map(n => monoToUnified(n));
  },
}));

nativeBridge.onPitchCorrectionComplete((data: {
  clipId: string;
  success: boolean;
  outputFile?: string;
  requestId?: string;
  restored?: boolean;
  renderMode?: PitchCorrectionRenderMode;
  cancelled?: boolean;
  swapDeferred?: boolean;
}) => {
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
    return;
  }

  if (data.cancelled) {
    logPitchEditorFormant("ignoring cancelled completion", {
      clipId: data.clipId,
      requestId: data.requestId,
      logicalRequestId: meta.logicalRequestId,
      stage: meta.stage,
    });
    return;
  }

  if (!data.success || !data.outputFile) {
    if (meta.stage === "preview_segment" || meta.stage === "single") {
      if (meta.stage === "preview_segment") {
        _runningPreviewSegmentJobs = Math.max(0, _runningPreviewSegmentJobs - 1);
      }
      _activePitchCorrectionRequestId = null;
      setApplyStatus("error", "Failed", meta.logicalRequestId);
      useDAWStore.getState().showToast("Pitch/formant apply failed", "error");
    } else if (meta.stage === "full_clip_hq") {
      _activePitchCorrectionRequestId = null;
      setApplyStatus("error", "Preview ready, HQ failed", meta.logicalRequestId);
      useDAWStore.getState().showToast("Pitch/formant HQ render failed", "error");
    }
    warnPitchEditorFormant("persistent completion listener received failed result", {
      clipId: data.clipId,
      requestId: data.requestId,
      logicalRequestId: meta.logicalRequestId,
      requestRevision: completedRevision,
      stage: meta.stage,
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
    setApplyStatus("preview_ready", getFormantPreviewStatusMessage("preview_ready", coverageDone), meta.logicalRequestId);
    if (_activePreviewRequestGroupId === meta.logicalRequestId) {
      dispatchNextPreviewSegments();
    }
    return;
  }

  applyPitchCorrectionResultToClip(data.clipId, data.outputFile, Boolean(data.restored));
  markAllRenderCoverage("hq_ready", meta.logicalRequestId);
  clearStagedPreviewQueue();
  _activePitchCorrectionRequestId = null;
  setApplyStatus("done", meta.stage === "full_clip_hq"
    ? (data.swapDeferred ? "HQ ready on stop/seek" : getFormantPreviewStatusMessage("done", true))
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
