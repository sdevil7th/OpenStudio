import { create } from "zustand";
import { nativeBridge, PitchNoteData, PitchContourData, PolyNoteData, PolyAnalysisResult, UnifiedNoteData, polyToUnified, monoToUnified } from "../services/NativeBridge";
import { useDAWStore } from "./useDAWStore";

export type PitchEditorTool = "select" | "pitch" | "drift" | "vibrato" | "transition" | "draw";
export type PitchSnapMode = "off" | "chromatic" | "scale";

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
  contour: PitchContourData | null;
  notes: PitchNoteData[];
  isAnalyzing: boolean;
  isApplying: boolean;
  progressPercent: number;   // 0-100, for analysis/correction progress display
  progressLabel: string;     // e.g. "Analyzing..." or "Applying correction..."

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

// Tracks the pitchCorrectionComplete listener so we know when the WORLD vocoder finishes.
let _pitchCorrectionUnsubscribe: (() => void) | null = null;

// Auto-apply debounce — fires 400ms after the last note mutation so playback
// always reflects the current state without a manual Apply button.
let _autoApplyTimer: ReturnType<typeof setTimeout> | null = null;
// Throttle timer for real-time pitch preview during drag (max ~12fps, fast enough to feel live).
let _dragPreviewThrottle: ReturnType<typeof setTimeout> | null = null;
/** Build pitch correction segments from notes and send to backend for real-time preview.
 *  This is called immediately (no debounce) so the user hears changes during playback. */
function sendPitchPreviewMap() {
  const { clipId, notes } = usePitchEditorStore.getState();
  if (!clipId || notes.length === 0) return;
  // Only include segments where pitch actually changed — the phase vocoder
  // introduces artifacts even at ratio=1.0, so skip unedited notes entirely.
  const segments = notes
    .filter(n => Math.abs(n.correctedPitch - n.detectedPitch) > 0.01)
    .map(n => ({
      startTime: n.startTime,
      endTime: n.endTime,
      pitchRatio: Math.pow(2, (n.correctedPitch - n.detectedPitch) / 12),
    }));
  if (segments.length === 0) {
    // No notes edited — clear any active preview to avoid phase vocoder artifacts
    nativeBridge.clearClipPitchPreview(clipId).catch(() => {});
    return;
  }
  console.log(`[pitchEditor] Preview: ${segments.length} segment(s), ratios:`,
    segments.map(s => `${s.startTime.toFixed(2)}-${s.endTime.toFixed(2)}s ratio=${s.pitchRatio.toFixed(3)}`));
  nativeBridge.setClipPitchPreview(clipId, segments).catch(err =>
    console.warn("[pitchEditor] setClipPitchPreview failed:", err)
  );
}

function scheduleAutoApply() {
  if (_autoApplyTimer) clearTimeout(_autoApplyTimer);
  _autoApplyTimer = setTimeout(async () => {
    _autoApplyTimer = null;
    const { trackId, clipId, notes, contour } = usePitchEditorStore.getState();
    if (!trackId || !clipId) return;
    // Ensure the clip is registered in the playback engine before applying.
    try {
      await useDAWStore.getState().syncClipsWithBackend();
    } catch (e) {
      console.warn("[pitchEditor] syncClipsWithBackend failed before apply:", e);
    }
    // Re-establish the real-time preview after sync (clearAllClips destroys it).
    sendPitchPreviewMap();
    // ALWAYS send ALL notes to the backend. The backend reads from the ORIGINAL
    // audio file every time (so corrections don't compound through the vocoder).
    // If we only sent dirty notes, the backend would only correct those notes and
    // write the rest from the original — destroying all previous corrections.
    usePitchEditorStore.setState({ isApplying: true });
    console.log(`[pitchEditor] Applying correction with ${notes.length} notes`);

    // The bridge fires completion(true) immediately (non-blocking) so the Promise
    // resolves with `true` before the job finishes — result.outputFile will be
    // undefined here.  Instead, listen for the pitchCorrectionComplete event which
    // fires when the background job actually finishes and includes the outputFile.
    if (_pitchCorrectionUnsubscribe) {
      _pitchCorrectionUnsubscribe();
      _pitchCorrectionUnsubscribe = null;
    }
    _pitchCorrectionUnsubscribe = nativeBridge.onPitchCorrectionComplete((data) => {
      if (data.clipId !== clipId) return; // stale event from a previous clip
      // Unsubscribe after first matching event (one-shot).
      if (_pitchCorrectionUnsubscribe) {
        _pitchCorrectionUnsubscribe();
        _pitchCorrectionUnsubscribe = null;
      }
      usePitchEditorStore.setState({ isApplying: false });
      console.log("[pitchEditor] pitchCorrectionComplete event: clipId=", data.clipId,
        "success=", data.success, "outputFile=", data.outputFile);
      if (data.success && data.outputFile) {
        const outFile = data.outputFile;
        useDAWStore.setState((s) => ({
          tracks: s.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === clipId ? { ...clip, filePath: outFile } : clip
            ),
          })),
        }));
        console.log("[pitchEditor] Clip filePath updated to:", outFile);
      }
    });

    nativeBridge.applyPitchCorrection(trackId, clipId, notes, contour?.frames)
      .then((result) => {
        // result is `true` (immediate non-blocking return) — actual work happens
        // in the background job; clip update is handled by onPitchCorrectionComplete.
        if (!result) {
          usePitchEditorStore.setState({ isApplying: false });
          console.warn("[pitchEditor] applyPitchCorrection: job not queued");
        }
      })
      .catch((err) => {
        console.error("[pitchEditor] applyPitchCorrection FAILED:", err);
        usePitchEditorStore.setState({ isApplying: false });
      });
  }, 400);
}

/** Wrapper: send real-time preview immediately + queue high-quality WORLD correction. */
function onNotesChanged() {
  sendPitchPreviewMap();
  scheduleAutoApply();
}

export const usePitchEditorStore = create<PitchEditorState>()((set, get) => ({
  trackId: null,
  clipId: null,
  fxIndex: 0,
  clipStartTime: 0,
  clipDuration: 0,
  contour: null,
  notes: [],
  isAnalyzing: false,
  isApplying: false,
  progressPercent: 0,
  progressLabel: "",
  selectedNoteIds: [],
  tool: "select",
  snapMode: "chromatic",
  scrollX: 0,
  scrollY: 48, // C3
  zoomX: 200,  // pixels per second
  zoomY: 12,   // pixels per semitone
  undoStack: [],
  redoStack: [],
  referenceTracks: [],
  scaleKey: 0,
  scaleType: "chromatic",
  scaleNotes: new Array(12).fill(true),
  inspectorExpanded: true,
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
      contour: null,
      notes: [],
      selectedNoteIds: [],
      undoStack: [],
      redoStack: [],
      referenceTracks: [],
      isAnalyzing: false,
      isApplying: false,
      scrollY: 48, // Reset to middle C, will be auto-fit after analysis
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
      nativeBridge.clearClipPitchPreview(clipId).catch(() => {});
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
    });
  },

  // Analyze a specific time window of the clip (viewport-based analysis).
  // Analyzes a chunk (max ~30s) around the given time range.
  // Merges results with existing notes to build up the full picture as user scrolls.
  analyze: async (viewStartTime?: number, viewEndTime?: number) => {
    const { trackId, clipId, isAnalyzing } = get();
    if (!trackId || !clipId || isAnalyzing) return;

    const dawState = useDAWStore.getState();
    const track = dawState.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!clip?.filePath) return;

    // Determine analysis window: max 30s chunk centered on viewport
    const MAX_CHUNK = 30; // seconds
    const clipOffset = clip.offset || 0;
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

            set({
              isAnalyzing: false,
              progressPercent: 100,
              progressLabel: "",
              contour: fullResult,
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
        clip.filePath, fileOffset, analyzeDuration, clipId
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
    const { trackId, clipId, notes } = get();
    if (!trackId || !clipId) return;
    set({ isApplying: true, progressPercent: 0, progressLabel: "Applying correction..." });
    try {
      await nativeBridge.applyPitchCorrection(trackId, clipId, notes);
    } finally {
      set({ isApplying: false, progressPercent: 100, progressLabel: "" });
    }
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

  // Inspector editing actions
  setNoteFormant: (noteId, semitones) => {
    get().pushUndo("Change formant");
    set({ notes: get().notes.map(n => n.id === noteId ? { ...n, formantShift: semitones } : n) });
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

// Persistent listener: when the WORLD vocoder finishes on the C++ thread pool,
// update isApplying state. The corrected file has already been swapped in by
// replaceClipAudioFile (which also clears the real-time PitchShifter preview).
nativeBridge.onPitchCorrectionComplete((data: { clipId: string; success: boolean }) => {
  const state = usePitchEditorStore.getState();
  if (state.clipId === data.clipId) {
    usePitchEditorStore.setState({ isApplying: false });
    if (data.success) {
      console.log("[pitchEditor] SMS correction complete for clip", data.clipId);
    } else {
      console.warn("[pitchEditor] SMS correction failed for clip", data.clipId);
    }
  }
});
