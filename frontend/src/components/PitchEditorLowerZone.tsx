import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { usePitchEditorStore, PitchEditorTool, PitchSnapMode } from "../store/pitchEditorStore";
import { GripHorizontal, X, Scissors, MousePointer, Activity, Waves, ChevronRight, Pencil } from "lucide-react";
import { NoteInspector } from "./NoteInspector";
import { CorrectPitchModal } from "./CorrectPitchModal";
import {
  renderPitchEditor,
  renderPlayheadOverlay,
  hitTestNote,
  xToTime,
  yToMidi,
  PIANO_WIDTH,
  type PitchEditorViewport,
  type PitchEditorRenderState,
} from "./PitchEditorCanvas";

const MIN_PPS = 1;
const MAX_PPS = 1000;
const ZOOM_SENSITIVITY = 0.0015;

const TOOL_DEFS: { id: PitchEditorTool; label: string; key: string; icon: React.ReactNode; title: string }[] = [
  { id: "select", label: "Select", key: "1", icon: <MousePointer size={11} />, title: "Select & move notes (1)" },
  { id: "drift", label: "Drift", key: "2", icon: <Activity size={11} />, title: "Edit pitch drift (2)" },
  { id: "vibrato", label: "Vibrato", key: "3", icon: <Waves size={11} />, title: "Edit vibrato (3)" },
  { id: "transition", label: "Trans", key: "4", icon: <ChevronRight size={11} />, title: "Edit transitions (4)" },
  { id: "draw", label: "Draw", key: "5", icon: <Pencil size={11} />, title: "Draw pitch curve on note (5)" },
  { id: "split", label: "Split", key: "6", icon: <Scissors size={11} />, title: "Split note at click (6)" },
];

const SNAP_MODES: { id: PitchSnapMode; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "chromatic", label: "Chromatic" },
  { id: "scale", label: "Scale" },
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function formatNoteName(midi: number): string {
  const noteClass = Math.round(midi) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  const cents = Math.round((midi - Math.round(midi)) * 100);
  const name = NOTE_NAMES[noteClass < 0 ? noteClass + 12 : noteClass];
  return `${name}${octave}${cents !== 0 ? ` ${cents > 0 ? "+" : ""}${cents}¢` : ""}`;
}

// Click-to-audition: play a short sine tone at a MIDI pitch via Web Audio API
let _auditionCtx: AudioContext | null = null;
function auditionNote(midiPitch: number, durationMs = 200) {
  _auditionCtx ??= new AudioContext();
  const ctx = _auditionCtx;
  const freq = 440 * Math.pow(2, (midiPitch - 69) / 12);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
}

export function PitchEditorLowerZone() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  // Offscreen canvas caches the static content (grid, notes, contour) so the
  // playback RAF loop only needs to blit + draw playhead, not redraw everything.
  const staticCanvasRef = useRef<OffscreenCanvas | null>(null);
  // Track the scrollX that the static cache was rendered at, so we can invalidate
  // when auto-scroll during playback changes the viewport.
  const staticCacheScrollXRef = useRef<number>(-1);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 300 });

  // DAW store
  const {
    pixelsPerSecond, scrollX: dawScrollX, lowerZoneHeight, tcpWidth,
    pitchEditorTrackId, pitchEditorClipId,
    setLowerZoneHeight, closePitchEditor, setScroll, setZoom,
  } = useDAWStore(
    useShallow((s) => ({
      pixelsPerSecond: s.pixelsPerSecond,
      scrollX: s.scrollX,
      lowerZoneHeight: s.lowerZoneHeight,
      tcpWidth: s.tcpWidth,
      pitchEditorTrackId: s.pitchEditorTrackId,
      pitchEditorClipId: s.pitchEditorClipId,
      setLowerZoneHeight: s.setLowerZoneHeight,
      closePitchEditor: s.closePitchEditor,
      setScroll: s.setScroll,
      setZoom: s.setZoom,
    }))
  );

  const clipInfo = useDAWStore(
    useShallow((s) => {
      if (!s.pitchEditorTrackId || !s.pitchEditorClipId) return null;
      const track = s.tracks.find((t) => t.id === s.pitchEditorTrackId);
      if (!track) return null;
      const clip = track.clips.find((c) => c.id === s.pitchEditorClipId);
      if (!clip) return null;
      return {
        startTime: clip.startTime,
        duration: clip.duration,
        trackName: track.name,
        clipName: clip.name || clip.filePath?.split(/[\\/]/).pop() || "Clip",
      };
    })
  );

  // Keep clipInfo in a ref so event handlers always read the latest value without stale closures.
  const clipInfoRef = useRef(clipInfo);
  useEffect(() => { clipInfoRef.current = clipInfo; }, [clipInfo]);

  const currentTime = useDAWStore((s) => s.transport.currentTime);
  const isPlaying = useDAWStore((s) => s.transport.isPlaying);
  const bpm = useDAWStore((s) => s.transport.tempo);
  const timeSignature = useDAWStore((s) => s.timeSignature);

  const {
    contour, notes, isAnalyzing, selectedNoteIds, tool, snapMode, progressPercent, progressLabel,
    applyState, applyMessage,
    scrollY, zoomY,
    clipStartTime: pitchClipStartTime, clipDuration: pitchClipDuration,
    analyze, setTool, setSnapMode,
    selectNote, selectAll, deselectAll,
    updateNote, commitNoteEdit, moveSelectedPitch, splitNote,
    correctSelectedToScale, correctAllToScale,
    undo, redo, pushUndo,
    setScrollY,
    undoStack, redoStack,
    polyMode, polyNotes, polyAnalysisResult, showPitchSalience,
    togglePolyMode, analyzePolyphonic, moveSelectedPolyPitch,
    applyPolyCorrection, togglePitchSalience,
    polyNoteThreshold, polyOnsetThreshold, polyMinDuration,
    setPolyNoteThreshold, setPolyOnsetThreshold, setPolyMinDuration,
    scaleKey, scaleType, scaleNotes, setScale, autoDetectScale,
    mergeNotes, toggleCorrectPitchModal,
    abCompareMode, toggleABCompare,
    drawPitchOnNote, beginDrawPitch, commitDrawPitch,
    globalFormantCents, setGlobalFormantCents,
    renderCoverage,
  } = usePitchEditorStore(
    useShallow((s) => ({
      contour: s.contour, notes: s.notes, isAnalyzing: s.isAnalyzing, progressPercent: s.progressPercent, progressLabel: s.progressLabel,
      applyState: s.applyState, applyMessage: s.applyMessage,
      selectedNoteIds: s.selectedNoteIds, tool: s.tool, snapMode: s.snapMode,
      scrollY: s.scrollY, zoomY: s.zoomY,
      clipStartTime: s.clipStartTime, clipDuration: s.clipDuration,
      analyze: s.analyze, setTool: s.setTool, setSnapMode: s.setSnapMode,
      selectNote: s.selectNote, selectAll: s.selectAll, deselectAll: s.deselectAll,
      updateNote: s.updateNote, commitNoteEdit: s.commitNoteEdit, moveSelectedPitch: s.moveSelectedPitch,
      splitNote: s.splitNote,
      correctSelectedToScale: s.correctSelectedToScale, correctAllToScale: s.correctAllToScale,
      undo: s.undo, redo: s.redo, pushUndo: s.pushUndo,
      setScrollY: s.setScrollY,
      undoStack: s.undoStack, redoStack: s.redoStack,
      polyMode: s.polyMode, polyNotes: s.polyNotes,
      polyAnalysisResult: s.polyAnalysisResult, showPitchSalience: s.showPitchSalience,
      togglePolyMode: s.togglePolyMode, analyzePolyphonic: s.analyzePolyphonic,
      moveSelectedPolyPitch: s.moveSelectedPolyPitch,
      applyPolyCorrection: s.applyPolyCorrection, togglePitchSalience: s.togglePitchSalience,
      polyNoteThreshold: s.polyNoteThreshold, polyOnsetThreshold: s.polyOnsetThreshold,
      polyMinDuration: s.polyMinDuration,
      setPolyNoteThreshold: s.setPolyNoteThreshold, setPolyOnsetThreshold: s.setPolyOnsetThreshold,
      setPolyMinDuration: s.setPolyMinDuration,
      scaleKey: s.scaleKey, scaleType: s.scaleType, scaleNotes: s.scaleNotes,
      setScale: s.setScale, autoDetectScale: s.autoDetectScale,
      mergeNotes: s.mergeNotes, toggleCorrectPitchModal: s.toggleCorrectPitchModal,
      abCompareMode: s.abCompareMode, toggleABCompare: s.toggleABCompare,
      drawPitchOnNote: s.drawPitchOnNote, beginDrawPitch: s.beginDrawPitch, commitDrawPitch: s.commitDrawPitch,
      globalFormantCents: s.globalFormantCents, setGlobalFormantCents: s.setGlobalFormantCents,
      renderCoverage: s.renderCoverage,
    }))
  );

  const applyStateClassName =
    applyState === "error" ? "text-red-400 bg-red-500/10 border-red-500/30"
      : applyState === "done" ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
      : applyState === "preview_ready" ? "text-sky-300 bg-sky-500/10 border-sky-500/30"
      : applyState === "queued" || applyState === "processing" || applyState === "preview_processing" || applyState === "final_processing"
        ? "text-daw-accent bg-daw-accent/10 border-daw-accent/30"
      : "text-neutral-500 bg-neutral-800/80 border-neutral-700";
  const formantStatusHint = globalFormantCents !== 0
    ? (
        applyState === "preview_processing"
          ? "Rendering preview near playhead..."
          : applyState === "preview_ready" || applyState === "final_processing" || applyState === "done"
            ? "Previewing rendered formant"
            : "Rendered formant preview"
      )
    : "Clip-wide timbre shift";

  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    type: "move" | "pitch" | "resize-left" | "resize-right" | "straighten" | "formant" | "gain" | "drift" | "transition-in" | "transition-out" | "transition-both" | "draw";
    noteId: string;
    startMouseY: number;
    origPitch: number;
    origStart: number;
    origEnd: number;
    origValue: number; // original vibratoDepth/formantShift/gain for smart controls
  } | null>(null);
  // Clear analyzed range tracking when clip changes
  const analyzedRangesRef = useRef<Array<[number, number]>>([]);
  useEffect(() => {
    analyzedRangesRef.current = [];
  }, [pitchEditorClipId]);

  // Auto-analyze on mount
  useEffect(() => {
    if (pitchEditorTrackId && pitchEditorClipId && !contour && !isAnalyzing) {
      // Record initial range so scroll-based re-analyze won't duplicate it
      analyzedRangesRef.current = [[0, 30]];
      analyze();
    }
  }, [pitchEditorTrackId, pitchEditorClipId, contour, isAnalyzing, analyze]);

  // Re-analyze when scrolling into unanalyzed territory (debounced)
  const analyzeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!pitchEditorTrackId || !pitchEditorClipId || isAnalyzing || !contour || !clipInfo) return;

    // Never re-analyze if the user has made manual edits — it would wipe splits/moves.
    if (undoStack.length > 0) return;

    const visibleStartProject = dawScrollX / pixelsPerSecond;
    const visibleStart = visibleStartProject - clipInfo.startTime;
    const visibleEnd = visibleStart + canvasSize.width / pixelsPerSecond;
    const clipStart = Math.max(0, visibleStart);
    const clipEnd = Math.min(clipInfo.duration, visibleEnd);
    if (clipEnd <= clipStart) return;

    // Only re-analyze if this range hasn't been analyzed (2s tolerance)
    const alreadyAnalyzed = analyzedRangesRef.current.some(
      ([s, e]) => clipStart >= s - 2 && clipEnd <= e + 2
    );
    if (alreadyAnalyzed) return;

    if (analyzeTimeoutRef.current) clearTimeout(analyzeTimeoutRef.current);
    analyzeTimeoutRef.current = setTimeout(() => {
      analyzedRangesRef.current.push([clipStart, clipEnd]);
      analyze(clipStart, clipEnd);
    }, 500);

    return () => {
      if (analyzeTimeoutRef.current) clearTimeout(analyzeTimeoutRef.current);
    };
  }, [dawScrollX, pixelsPerSecond, canvasSize.width, pitchEditorTrackId, pitchEditorClipId, isAnalyzing, contour, clipInfo, analyze, undoStack]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setCanvasSize({ width: Math.max(100, width), height: Math.max(50, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Viewport — scrollX in seconds for canvas coordinate math
  const scrollXSeconds = dawScrollX / pixelsPerSecond;
  const viewport: PitchEditorViewport = useMemo(() => ({
    scrollX: scrollXSeconds,
    scrollY,
    pixelsPerSecond,
    pixelsPerSemitone: zoomY,
    clipStartTime: pitchClipStartTime,
    clipDuration: pitchClipDuration,
  }), [scrollXSeconds, scrollY, pixelsPerSecond, zoomY, pitchClipStartTime, pitchClipDuration]);

  // Build render state (avoids object recreation in RAF)
  const buildRenderState = useCallback((
    st: ReturnType<typeof usePitchEditorStore.getState>,
    daw: ReturnType<typeof useDAWStore.getState>
  ): PitchEditorRenderState => ({
    notes: st.notes,
    contour: st.contour,
    selectedNoteIds: st.selectedNoteIds,
    hoveredNoteId: null,
    currentTime: daw.transport.currentTime,
    isPlaying: daw.transport.isPlaying,
    bpm: daw.transport.tempo,
    timeSignature: [daw.timeSignature.numerator, daw.timeSignature.denominator],
    scaleNotes: st.scaleNotes,
    scaleKey: st.scaleKey,
    polyMode: st.polyMode,
    polyNotes: st.polyNotes,
    showPitchSalience: st.showPitchSalience,
    pitchSalience: st.polyAnalysisResult?.pitchSalience ?? null,
    salienceDownsampleFactor: st.polyAnalysisResult?.salienceDownsampleFactor ?? 1,
    salienceHopSize: st.polyAnalysisResult?.hopSize ?? 256,
    salienceSampleRate: st.polyAnalysisResult?.sampleRate ?? 22050,
    renderCoverage: st.renderCoverage,
  }), []);

  // Static render — draws grid, notes, contour to both the visible canvas AND an
  // offscreen cache.  During playback the RAF loop blits the cache + draws playhead
  // only, avoiding a full redraw at 60fps.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;

    const renderState: PitchEditorRenderState = {
      notes, contour, selectedNoteIds,
      hoveredNoteId,
      currentTime, isPlaying, bpm,
      timeSignature: [timeSignature.numerator, timeSignature.denominator],
      scaleNotes, scaleKey,
      polyMode, polyNotes, showPitchSalience,
      pitchSalience: polyAnalysisResult?.pitchSalience ?? null,
      salienceDownsampleFactor: polyAnalysisResult?.salienceDownsampleFactor ?? 1,
      salienceHopSize: polyAnalysisResult?.hopSize ?? 256,
      salienceSampleRate: polyAnalysisResult?.sampleRate ?? 22050,
      renderCoverage,
    };
    renderPitchEditor(ctx, canvasSize.width, canvasSize.height, viewport, renderState);

    // Cache to offscreen canvas for playback RAF overlay
    const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
    const offCtx = offscreen.getContext("2d");
    if (offCtx) {
      offCtx.drawImage(canvas, 0, 0);
    }
    staticCanvasRef.current = offscreen;
  }, [canvasSize, viewport, notes, contour, selectedNoteIds, hoveredNoteId, currentTime, isPlaying, bpm, timeSignature, scaleNotes, scaleKey, polyMode, polyNotes, showPitchSalience, polyAnalysisResult, renderCoverage]);

  // Playhead RAF — during playback, blit cached static canvas + draw playhead only.
  // This avoids a full renderPitchEditor() (grid, notes, contour) at 60fps.
  // The static cache is re-rendered by the effect above when state changes (scroll, zoom, edits).
  useEffect(() => {
    if (!isPlaying) return;
    const clipStart = clipInfo?.startTime ?? 0;
    const clipDur = clipInfo?.duration ?? 0;

    // Render static content once at playback start so the cache is fresh
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const st = usePitchEditorStore.getState();
        const daw = useDAWStore.getState();
        const vp: PitchEditorViewport = {
          scrollX: daw.scrollX / daw.pixelsPerSecond,
          scrollY: st.scrollY,
          pixelsPerSecond: daw.pixelsPerSecond,
          pixelsPerSemitone: st.zoomY,
          clipStartTime: clipStart,
          clipDuration: clipDur,
        };
        renderPitchEditor(ctx, canvasSize.width, canvasSize.height, vp, buildRenderState(st, daw));
        // Update cache
        const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
        const offCtx = offscreen.getContext("2d");
        if (offCtx) offCtx.drawImage(canvas, 0, 0);
        staticCanvasRef.current = offscreen;
        staticCacheScrollXRef.current = daw.scrollX;
      }
    }

    const animate = () => {
      const cvs = canvasRef.current;
      if (!cvs) return;
      const ctx = cvs.getContext("2d");
      if (!ctx) return;

      const daw = useDAWStore.getState();
      const st = usePitchEditorStore.getState();
      const currentScrollX = daw.scrollX;
      const vp: PitchEditorViewport = {
        scrollX: currentScrollX / daw.pixelsPerSecond,
        scrollY: st.scrollY,
        pixelsPerSecond: daw.pixelsPerSecond,
        pixelsPerSemitone: st.zoomY,
        clipStartTime: clipStart,
        clipDuration: clipDur,
      };

      // If viewport scrolled (auto-scroll during playback), invalidate static cache
      if (Math.abs(currentScrollX - staticCacheScrollXRef.current) > 0.5) {
        renderPitchEditor(ctx, canvasSize.width, canvasSize.height, vp, buildRenderState(st, daw));
        const offscreen = new OffscreenCanvas(cvs.width, cvs.height);
        const offCtx = offscreen.getContext("2d");
        if (offCtx) offCtx.drawImage(cvs, 0, 0);
        staticCanvasRef.current = offscreen;
        staticCacheScrollXRef.current = currentScrollX;
      } else if (staticCanvasRef.current) {
        // Fast path: blit cached content + playhead only
        renderPlayheadOverlay(ctx, canvasSize.width, canvasSize.height,
          staticCanvasRef.current, daw.transport.currentTime, vp);
      } else {
        // Fallback: full render
        renderPitchEditor(ctx, canvasSize.width, canvasSize.height, vp, buildRenderState(st, daw));
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, canvasSize, clipInfo, buildRenderState]);

  // Wheel handler — attached imperatively with passive:false so preventDefault works
  const pixelsPerSecondRef = useRef(pixelsPerSecond);
  const dawScrollXRef = useRef(dawScrollX);
  const scrollYRef = useRef(scrollY);
  const zoomYRef = useRef(zoomY);
  pixelsPerSecondRef.current = pixelsPerSecond;
  dawScrollXRef.current = dawScrollX;
  scrollYRef.current = scrollY;
  zoomYRef.current = zoomY;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const curPps = pixelsPerSecondRef.current;
      const curScrollX = dawScrollXRef.current;
      const curScrollY = scrollYRef.current;
      const curZoomY = zoomYRef.current;
      const daw = useDAWStore.getState();

      if (e.ctrlKey || e.metaKey) {
        // Horizontal zoom — mirrors Timeline.tsx exactly
        const rect = canvas.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const factor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY);
        const newPps = Math.max(MIN_PPS, Math.min(MAX_PPS, curPps * factor));
        const timeAtCursor = (curScrollX + cursorX) / curPps;
        const newScrollX = Math.max(0, timeAtCursor * newPps - cursorX);
        setZoom(newPps);
        setScroll(newScrollX, daw.scrollY);
      } else if (e.shiftKey) {
        // Horizontal scroll — same scrollSpeed as Timeline
        const newScrollX = Math.max(0, curScrollX + e.deltaY * 2);
        setScroll(newScrollX, daw.scrollY);
      } else {
        // Vertical pitch scroll
        const delta = e.deltaY / curZoomY;
        setScrollY(curScrollY - delta);
      }
    };

    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [setZoom, setScroll, setScrollY]);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Build fresh viewport from store state — no React closure issues.
    const dawState = useDAWStore.getState();
    const pitchState = usePitchEditorStore.getState();
    const freshViewport: PitchEditorViewport = {
      scrollX: dawState.scrollX / dawState.pixelsPerSecond,
      scrollY: pitchState.scrollY,
      pixelsPerSecond: dawState.pixelsPerSecond,
      pixelsPerSemitone: pitchState.zoomY,
      clipStartTime: pitchState.clipStartTime,
      clipDuration: pitchState.clipDuration,
    };
    const currentNotes = pitchState.notes;

    const hit = hitTestNote(x, y, currentNotes, freshViewport, canvasSize.height);

    // Alt+click: audition note (play sine tone at note pitch)
    if (e.altKey && hit) {
      const note = currentNotes.find(n => n.id === hit.noteId);
      if (note) auditionNote(note.correctedPitch, 300);
      selectNote(hit.noteId, e.ctrlKey || e.metaKey);
      return;
    }

    // Double-click splits a note regardless of active tool
    if (e.detail === 2 && hit) {
      const t = xToTime(x, freshViewport);
      splitNote(hit.noteId, t);
      return;
    }

    if (hit) {
      selectNote(hit.noteId, e.ctrlKey || e.metaKey);
      const note = currentNotes.find((n) => n.id === hit.noteId);
      if (!note) return;

      if (hit.edge === "top-center") {
        pushUndo("Straighten vibrato");
        setDragState({
          type: "straighten", noteId: hit.noteId, startMouseY: y,
          origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
          origValue: note.vibratoDepth,
        });
      } else if (hit.edge === "bottom-left") {
        pushUndo("Change formant");
        setDragState({
          type: "formant", noteId: hit.noteId, startMouseY: y,
          origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
          origValue: note.formantShift,
        });
      } else if (hit.edge === "bottom-right") {
        pushUndo("Change gain");
        setDragState({
          type: "gain", noteId: hit.noteId, startMouseY: y,
          origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
          origValue: note.gain,
        });
      } else if (hit.edge === "body") {
        // Tool-specific drag behavior
        const currentTool = usePitchEditorStore.getState().tool;
        if (currentTool === "vibrato") {
          pushUndo("Adjust vibrato");
          setDragState({
            type: "straighten", noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: note.vibratoDepth,
          });
        } else if (currentTool === "drift") {
          pushUndo("Adjust drift");
          setDragState({
            type: "drift", noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: note.driftCorrectionAmount,
          });
        } else if (currentTool === "pitch") {
          // Pitch tool: same as move but with finer control (no snap) and visual feedback
          pushUndo("Adjust pitch");
          setDragState({
            type: "pitch", noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: note.correctedPitch,
          });
        } else if (currentTool === "transition") {
          // Transition tool on body: adjust both transitionIn and transitionOut simultaneously
          pushUndo("Adjust transitions");
          setDragState({
            type: "transition-both", noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: (note.transitionIn + note.transitionOut) / 2,
          });
        } else if (currentTool === "split") {
          const t = xToTime(x, freshViewport);
          splitNote(hit.noteId, t);
          return;
        } else if (currentTool === "draw") {
          beginDrawPitch();
          const clipTime = xToTime(x, freshViewport);
          const midi = yToMidi(y, freshViewport, canvasSize.height);
          drawPitchOnNote(hit.noteId, clipTime, midi);
          setDragState({
            type: "draw", noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: 0,
          });
        } else {
          pushUndo("Move note");
          setDragState({
            type: "move", noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: 0,
          });
        }
      } else if (hit.edge === "left" || hit.edge === "right") {
        const currentTool = usePitchEditorStore.getState().tool;
        if (currentTool === "transition") {
          pushUndo("Adjust transition");
          setDragState({
            type: hit.edge === "left" ? "transition-in" : "transition-out",
            noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: hit.edge === "left" ? note.transitionIn : note.transitionOut,
          });
        } else {
          pushUndo("Resize note");
          setDragState({
            type: hit.edge === "left" ? "resize-left" : "resize-right",
            noteId: hit.noteId, startMouseY: y,
            origPitch: note.correctedPitch, origStart: note.startTime, origEnd: note.endTime,
            origValue: 0,
          });
        }
      }
    } else {
      deselectAll();
    }
  }, [canvasSize.height, tool, selectNote, deselectAll, splitNote, pushUndo, beginDrawPitch, drawPitchOnNote]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Build fresh viewport from store state — no React closure issues.
    const dawState = useDAWStore.getState();
    const pitchState = usePitchEditorStore.getState();
    const freshViewport: PitchEditorViewport = {
      scrollX: dawState.scrollX / dawState.pixelsPerSecond,
      scrollY: pitchState.scrollY,
      pixelsPerSecond: dawState.pixelsPerSecond,
      pixelsPerSemitone: pitchState.zoomY,
      clipStartTime: pitchState.clipStartTime,
      clipDuration: pitchState.clipDuration,
    };

    if (dragState) {
      const deltaY = -(y - dragState.startMouseY);
      if (dragState.type === "move") {
        const deltaSemitones = deltaY / freshViewport.pixelsPerSemitone;
        let newPitch = dragState.origPitch + deltaSemitones;
        if (snapMode === "chromatic") newPitch = Math.round(newPitch);
        updateNote(dragState.noteId, { correctedPitch: newPitch });
      } else if (dragState.type === "resize-left") {
        const t = xToTime(x, freshViewport);
        if (t < dragState.origEnd - 0.02) updateNote(dragState.noteId, { startTime: t });
      } else if (dragState.type === "resize-right") {
        const t = xToTime(x, freshViewport);
        if (t > dragState.origStart + 0.02) updateNote(dragState.noteId, { endTime: t });
      } else if (dragState.type === "straighten") {
        // Drag up = reduce vibrato (straighten), drag down = increase
        const newDepth = Math.max(0, Math.min(2, dragState.origValue - deltaY / 100));
        updateNote(dragState.noteId, { vibratoDepth: newDepth });
      } else if (dragState.type === "formant") {
        // Drag up = shift formants higher (cents). 1px ≈ 2 cents.
        const deltaCents = -deltaY * 2;
        const newCents = Math.max(-386, Math.min(386, Math.round(dragState.origValue * 100 + deltaCents)));
        updateNote(dragState.noteId, { formantShift: newCents / 100 });
      } else if (dragState.type === "gain") {
        // Drag up = louder, drag down = softer
        const newGain = Math.max(-24, Math.min(24, dragState.origValue + deltaY / 5));
        updateNote(dragState.noteId, { gain: Math.round(newGain * 2) / 2 });
      } else if (dragState.type === "drift") {
        // Drag up = less drift correction (preserve), drag down = more correction (straighten)
        const newDrift = Math.max(0, Math.min(1, dragState.origValue - deltaY / 100));
        updateNote(dragState.noteId, { driftCorrectionAmount: newDrift });
      } else if (dragState.type === "pitch") {
        // Pitch tool: finer control (0.1 semitone per 10px), no chromatic snap
        const deltaSemitones = deltaY / (freshViewport.pixelsPerSemitone * 1.5);
        const newPitch = dragState.origPitch + deltaSemitones;
        updateNote(dragState.noteId, { correctedPitch: Math.round(newPitch * 10) / 10 });
      } else if (dragState.type === "transition-in") {
        const newMs = Math.max(0, Math.min(200, dragState.origValue + deltaY / 2));
        updateNote(dragState.noteId, { transitionIn: Math.round(newMs) });
      } else if (dragState.type === "transition-out") {
        const newMs = Math.max(0, Math.min(200, dragState.origValue + deltaY / 2));
        updateNote(dragState.noteId, { transitionOut: Math.round(newMs) });
      } else if (dragState.type === "transition-both") {
        // Transition tool on body: adjust both in and out together
        const newMs = Math.max(0, Math.min(200, dragState.origValue + deltaY / 2));
        updateNote(dragState.noteId, { transitionIn: Math.round(newMs), transitionOut: Math.round(newMs) });
      } else if (dragState.type === "draw") {
        const clipTime = xToTime(x, freshViewport);
        const midi = yToMidi(y, freshViewport, canvasSize.height);
        drawPitchOnNote(dragState.noteId, clipTime, midi);
      }
      return;
    }

    const currentNotes = pitchState.notes;
    const hit = hitTestNote(x, y, currentNotes, freshViewport, canvasSize.height);
    setHoveredNoteId(hit?.noteId ?? null);

    const canvas = canvasRef.current;
    if (canvas) {
      if (hit?.edge === "left" || hit?.edge === "right") {
        canvas.style.cursor = "ew-resize";
      } else if (hit?.edge === "top-center" || hit?.edge === "bottom-left" || hit?.edge === "bottom-right") {
        canvas.style.cursor = "ns-resize";
      } else if (hit) {
        const currentTool = usePitchEditorStore.getState().tool;
        canvas.style.cursor = currentTool === "draw" ? "crosshair"
          : currentTool === "split" ? "crosshair"
          : currentTool === "pitch" ? "ns-resize"
          : currentTool === "transition" ? "col-resize"
          : "grab";
      } else {
        const currentTool = usePitchEditorStore.getState().tool;
        canvas.style.cursor = currentTool === "draw" ? "not-allowed" : "default";
      }
    }
  }, [dragState, canvasSize.height, snapMode, updateNote, drawPitchOnNote]);

  const handleMouseUp = useCallback(() => {
    if (dragState) {
      if (dragState.type === "draw") {
        commitDrawPitch();
      } else {
        commitNoteEdit();
      }
    }
    setDragState(null);
  }, [dragState, commitNoteEdit, commitDrawPitch]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!pitchEditorTrackId) return;
      if (e.ctrlKey && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (e.ctrlKey && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (e.ctrlKey && e.key === "a") { e.preventDefault(); selectAll(); return; }
      if (e.key === "Escape") { closePitchEditor(); return; }
      if (e.key === "ArrowUp" && !e.ctrlKey) {
        e.preventDefault();
        if (polyMode) moveSelectedPolyPitch(e.shiftKey ? 0.1 : 1);
        else moveSelectedPitch(e.shiftKey ? 0.1 : 1);
        return;
      }
      if (e.key === "ArrowDown" && !e.ctrlKey) {
        e.preventDefault();
        if (polyMode) moveSelectedPolyPitch(e.shiftKey ? -0.1 : -1);
        else moveSelectedPitch(e.shiftKey ? -0.1 : -1);
        return;
      }
      if (e.key === "q" || e.key === "Q") { correctSelectedToScale(); return; }
      if (e.ctrlKey && e.key === "j") {
        e.preventDefault();
        const sIds = usePitchEditorStore.getState().selectedNoteIds;
        if (sIds.length >= 2) mergeNotes(sIds);
        return;
      }
      const toolKey = Number.parseInt(e.key);
      if (toolKey >= 1 && toolKey <= TOOL_DEFS.length) setTool(TOOL_DEFS[toolKey - 1].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pitchEditorTrackId, undo, redo, selectAll, closePitchEditor, moveSelectedPitch, moveSelectedPolyPitch, polyMode, correctSelectedToScale, setTool, mergeNotes]);

  // Panel resize
  const isDragging = useRef(false);
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const startY = e.clientY;
    const startH = lowerZoneHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (me: MouseEvent) => setLowerZoneHeight(startH + (startY - me.clientY));
    const onUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [lowerZoneHeight, setLowerZoneHeight]);

  const hoveredNote = hoveredNoteId ? notes.find((n) => n.id === hoveredNoteId) : null;
  const selectedNote = selectedNoteIds.length === 1 ? notes.find((n) => n.id === selectedNoteIds[0]) : null;
  const displayNote = hoveredNote || selectedNote;

  // Left panel width = tcpWidth + resize_handle(6) - PIANO_WIDTH
  // so that PIANO_WIDTH in canvas compensates and content aligns with timeline
  const leftPanelWidth = tcpWidth + 6 - PIANO_WIDTH;

  return (
    <div
      className="flex flex-col border-t border-neutral-800 bg-neutral-950 shrink-0"
      style={{ height: lowerZoneHeight }}
    >
      {/* Resize grip */}
      <div
        className="h-1.5 cursor-row-resize group flex items-center justify-center shrink-0 hover:bg-daw-accent/30 transition-colors"
        onMouseDown={handleResizeStart}
      >
        <GripHorizontal size={10} className="text-neutral-700 group-hover:text-daw-accent/70" />
      </div>

      {/* Two-column layout */}
      <div className="flex-1 min-h-0 flex">

        {/* ── Left panel (controls) ── */}
        <div
          className="shrink-0 flex flex-col border-r border-neutral-800"
          style={{ width: leftPanelWidth }}
        >
          {/* Header */}
          <div className="flex items-center h-7 px-2.5 border-b border-neutral-800 shrink-0 bg-neutral-900">
            <span className="text-[10px] font-semibold text-neutral-200 tracking-wide uppercase flex-1">Pitch Editor</span>
            <button
              onClick={closePitchEditor}
              className="p-0.5 rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-700 transition-colors"
              title="Close (Escape)"
            >
              <X size={11} />
            </button>
          </div>

          {/* Clip info */}
          <div className="px-2.5 py-1.5 border-b border-neutral-800/60 shrink-0 bg-neutral-900/40">
            <div className="text-[9px] text-neutral-600 uppercase tracking-wider truncate">{clipInfo?.trackName ?? "—"}</div>
            <div className="text-[11px] text-neutral-300 truncate font-medium leading-tight">{clipInfo?.clipName ?? "—"}</div>
          </div>

          {/* Scrollable controls area */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-h-0">

            {/* Tools */}
            <div className="px-2 pt-2 pb-1.5 border-b border-neutral-800/60 shrink-0">
              <div className="text-[9px] text-neutral-600 uppercase tracking-wider mb-1.5">Tools</div>
              <div className="grid grid-cols-3 gap-0.5">
                {TOOL_DEFS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTool(t.id)}
                    title={t.title}
                    className={`flex items-center gap-1 px-1.5 py-1 text-[10px] rounded transition-colors ${
                      tool === t.id
                        ? "bg-daw-accent text-white shadow-sm"
                        : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
                    }`}
                  >
                    <span className="shrink-0">{t.icon}</span>
                    <span className="truncate">{t.label}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[9px] text-neutral-600 leading-tight">
                Double-click or use Split tool to split notes. Draw modifies pitch on existing notes.
              </p>
            </div>

            {/* Snap */}
            <div className="px-2 py-1.5 border-b border-neutral-800/60 shrink-0">
              <div className="text-[9px] text-neutral-600 uppercase tracking-wider mb-1">Snap</div>
              <div className="flex gap-0.5">
                {SNAP_MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setSnapMode(m.id)}
                    className={`flex-1 px-1 py-0.5 text-[9px] rounded transition-colors ${
                      snapMode === m.id
                        ? "bg-neutral-600 text-white"
                        : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-300"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Scale/Key */}
            <div className="px-2 py-1.5 border-b border-neutral-800/60 shrink-0">
              <div className="text-[9px] text-neutral-600 uppercase tracking-wider mb-1">Scale</div>
              <div className="flex gap-0.5 mb-1">
                <select
                  value={scaleKey}
                  onChange={(e) => setScale(Number(e.target.value), scaleType)}
                  className="flex-1 text-[10px] bg-neutral-800 text-neutral-300 border border-neutral-700 rounded px-1 py-0.5 focus:border-daw-accent focus:outline-none"
                >
                  {NOTE_NAMES.map((name) => (
                    <option key={name} value={NOTE_NAMES.indexOf(name)}>{name}</option>
                  ))}
                </select>
                <select
                  value={scaleType}
                  onChange={(e) => setScale(scaleKey, e.target.value)}
                  className="flex-2 text-[10px] bg-neutral-800 text-neutral-300 border border-neutral-700 rounded px-1 py-0.5 focus:border-daw-accent focus:outline-none"
                >
                  <option value="chromatic">Chromatic</option>
                  <option value="major">Major</option>
                  <option value="natural_minor">Natural Minor</option>
                  <option value="harmonic_minor">Harmonic Minor</option>
                  <option value="melodic_minor">Melodic Minor</option>
                  <option value="dorian">Dorian</option>
                  <option value="mixolydian">Mixolydian</option>
                  <option value="phrygian">Phrygian</option>
                  <option value="lydian">Lydian</option>
                  <option value="pentatonic_major">Pent. Major</option>
                  <option value="pentatonic_minor">Pent. Minor</option>
                  <option value="blues">Blues</option>
                </select>
              </div>
              <button
                onClick={autoDetectScale}
                disabled={notes.length === 0}
                className="w-full px-2 py-0.5 text-[9px] rounded bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 disabled:opacity-30 transition-colors"
                title="Detect key/scale from note distribution"
              >
                Auto-detect
              </button>
            </div>

            {/* Correction */}
            <div className="px-2 py-1.5 border-b border-neutral-800/60 shrink-0">
              <div className="text-[9px] text-neutral-600 uppercase tracking-wider mb-1">Correct</div>
              <div className="flex flex-col gap-0.5">
                <button
                  onClick={toggleCorrectPitchModal}
                  className="w-full px-2 py-1 text-[10px] rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors text-left"
                  title="Open Correct Pitch macro"
                >
                  Correct Pitch...
                </button>
                <button
                  onClick={correctAllToScale}
                  className="w-full px-2 py-1 text-[10px] rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors text-left"
                  title="Snap all notes to nearest semitone"
                >
                  Quantize all
                </button>
                <button
                  onClick={correctSelectedToScale}
                  disabled={selectedNoteIds.length === 0}
                  className="w-full px-2 py-1 text-[10px] rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 disabled:opacity-30 transition-colors text-left"
                  title="Snap selected notes (Q)"
                >
                  Quantize sel.
                </button>
                {selectedNoteIds.length >= 2 && (
                  <button
                    onClick={() => mergeNotes(selectedNoteIds)}
                    className="w-full px-2 py-1 text-[10px] rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors text-left"
                    title="Merge selected notes (Ctrl+J)"
                  >
                    Merge notes
                  </button>
                )}
              </div>
            </div>

            {/* Global Formant */}
            <div className="px-2 py-1.5 border-b border-neutral-800/60 shrink-0">
              <div className="text-[9px] text-neutral-600 uppercase tracking-wider mb-1">Formant</div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-neutral-500 shrink-0">Global</span>
                <input
                  type="range"
                  min={-386}
                  max={386}
                  step={1}
                  value={globalFormantCents}
                  onChange={(e) => setGlobalFormantCents(Number(e.target.value))}
                  className="flex-1 h-1 accent-daw-accent cursor-pointer"
                />
                <span className="w-12 text-right text-[10px] font-mono text-neutral-300 shrink-0">
                  {globalFormantCents > 0 ? "+" : ""}
                  {globalFormantCents}c
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[8px] text-neutral-600">{formantStatusHint}</span>
                {applyState !== "idle" && applyMessage && (
                  <span className={`px-1.5 py-0.5 rounded border text-[8px] uppercase tracking-wider ${applyStateClassName}`}>
                    {applyMessage}
                  </span>
                )}
              </div>
            </div>

            {/* Note Inspector */}
            <NoteInspector />

            {/* Undo / Redo */}
            <div className="px-2 py-1.5 border-b border-neutral-800/60 shrink-0">
              <div className="flex gap-0.5">
                <button
                  onClick={undo}
                  disabled={undoStack.length === 0}
                  className="flex-1 px-2 py-1 text-[10px] rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 disabled:opacity-30 transition-colors"
                  title="Undo (Ctrl+Z)"
                >
                  ← Undo
                </button>
                <button
                  onClick={redo}
                  disabled={redoStack.length === 0}
                  className="flex-1 px-2 py-1 text-[10px] rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 disabled:opacity-30 transition-colors"
                  title="Redo (Ctrl+Y)"
                >
                  Redo →
                </button>
              </div>
            </div>

            {/* Poly mode */}
            <div className="px-2 py-1.5 border-b border-neutral-800/60 shrink-0">
              <div className="text-[9px] text-neutral-600 uppercase tracking-wider mb-1">Mode</div>
              <button
                onClick={togglePolyMode}
                className={`w-full px-2 py-1 text-[10px] rounded mb-0.5 transition-colors ${
                  polyMode
                    ? "bg-purple-700/80 text-purple-100 ring-1 ring-purple-500/40"
                    : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
                }`}
                title="Toggle polyphonic mode"
              >
                {polyMode ? "Polyphonic ✓" : "Polyphonic"}
              </button>
              {polyMode && (
                <div className="flex flex-col gap-0.5 mt-0.5">
                  <button
                    onClick={analyzePolyphonic}
                    disabled={isAnalyzing}
                    className="w-full px-2 py-1 text-[10px] rounded bg-neutral-800 text-amber-400 hover:bg-neutral-700 disabled:opacity-30 transition-colors"
                    title="Run polyphonic analysis"
                  >
                    {isAnalyzing ? "Analyzing…" : "Run Poly Analysis"}
                  </button>
                  <button
                    onClick={togglePitchSalience}
                    className={`w-full px-2 py-0.5 text-[9px] rounded transition-colors ${
                      showPitchSalience ? "bg-amber-800/60 text-amber-300" : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700"
                    }`}
                  >
                    Salience heatmap
                  </button>

                  {/* Poly detection tuning */}
                  <div className="mt-1 pt-1 border-t border-neutral-800/40">
                    <div className="text-[8px] text-neutral-600 uppercase tracking-wider mb-1">Detection Tuning</div>
                    <div className="flex flex-col gap-1">
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] text-neutral-500">Note thresh</span>
                          <span className="text-[8px] font-mono text-neutral-400">{polyNoteThreshold.toFixed(2)}</span>
                        </div>
                        <input
                          type="range" min={0.01} max={0.5} step={0.01} value={polyNoteThreshold}
                          onChange={(e) => setPolyNoteThreshold(Number(e.target.value))}
                          className="w-full h-0.5 bg-neutral-700 rounded-full appearance-none cursor-pointer accent-purple-500"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] text-neutral-500">Onset thresh</span>
                          <span className="text-[8px] font-mono text-neutral-400">{polyOnsetThreshold.toFixed(2)}</span>
                        </div>
                        <input
                          type="range" min={0.05} max={0.8} step={0.01} value={polyOnsetThreshold}
                          onChange={(e) => setPolyOnsetThreshold(Number(e.target.value))}
                          className="w-full h-0.5 bg-neutral-700 rounded-full appearance-none cursor-pointer accent-purple-500"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] text-neutral-500">Min duration</span>
                          <span className="text-[8px] font-mono text-neutral-400">{polyMinDuration}ms</span>
                        </div>
                        <input
                          type="range" min={10} max={500} step={10} value={polyMinDuration}
                          onChange={(e) => setPolyMinDuration(Number(e.target.value))}
                          className="w-full h-0.5 bg-neutral-700 rounded-full appearance-none cursor-pointer accent-purple-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* A/B Compare */}
            <div className="px-2 py-1.5 border-b border-neutral-800/60 shrink-0">
              <button
                onClick={toggleABCompare}
                className={`w-full px-2 py-1 text-[10px] rounded transition-colors font-semibold ${
                  abCompareMode
                    ? "bg-amber-700/80 text-amber-100 ring-1 ring-amber-500/40"
                    : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
                }`}
                title="Toggle A/B comparison (hear original vs corrected)"
              >
                {abCompareMode ? "B (Original)" : "A/B Compare"}
              </button>
            </div>

            {polyMode && (
              <div className="px-2 py-1.5 shrink-0">
                <button
                  onClick={applyPolyCorrection}
                  className="w-full px-2 py-1.5 text-[11px] rounded bg-daw-accent text-white hover:bg-daw-accent/80 font-semibold transition-colors shadow-sm"
                  title="Apply polyphonic correction"
                >
                  Apply Poly
                </button>
              </div>
            )}
          </div>

          {/* Status footer */}
          <div className="px-2.5 py-1.5 border-t border-neutral-800 bg-neutral-900/60 shrink-0 min-h-10 flex flex-col justify-center gap-0.5">
            {displayNote ? (
              <>
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="text-neutral-500 shrink-0">Pitch</span>
                  <span className="text-neutral-300 font-mono">{formatNoteName(displayNote.correctedPitch)}</span>
                  {Math.abs(displayNote.correctedPitch - displayNote.detectedPitch) > 0.05 && (
                    <span className="text-amber-500 font-mono text-[9px]">
                      ({(displayNote.correctedPitch - displayNote.detectedPitch) > 0 ? "+" : ""}{(displayNote.correctedPitch - displayNote.detectedPitch).toFixed(1)}st)
                    </span>
                  )}
                </div>
                <div className="text-[9px] text-neutral-600">
                  Detected: {formatNoteName(displayNote.detectedPitch)}
                </div>
              </>
            ) : selectedNoteIds.length > 1 ? (
              <div className="text-[10px] text-neutral-400">{selectedNoteIds.length} notes selected</div>
            ) : (
              <div className="text-[9px] text-neutral-700">Hover or click a note</div>
            )}
            {(isAnalyzing || progressLabel) && (
              <div className="text-[9px] text-daw-accent animate-pulse">{progressLabel || "Analyzing…"}</div>
            )}
            {!isAnalyzing && applyMessage && (
              <div className={`text-[9px] ${applyState === "error" ? "text-red-400" : applyState === "done" ? "text-emerald-300" : applyState === "preview_ready" ? "text-sky-300" : "text-daw-accent"} ${applyState === "queued" || applyState === "processing" || applyState === "preview_processing" || applyState === "final_processing" ? "animate-pulse" : ""}`}>
                {applyMessage}
              </div>
            )}
          </div>
        </div>

        {/* ── Canvas (aligned with timeline) ── */}
        <div ref={containerRef} className="flex-1 min-w-0 relative bg-daw-panel">
          {isAnalyzing && !contour && (
            <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/50">
              <div className="flex flex-col items-center gap-2 w-48">
                <div className="w-5 h-5 border-2 border-daw-accent border-t-transparent rounded-full animate-spin" />
                <div className="text-sm text-neutral-400">{progressLabel || "Analyzing pitch…"}</div>
                {progressPercent > 0 && progressPercent < 100 && (
                  <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-daw-accent rounded-full transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="block w-full h-full"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      </div>

      {/* Correct Pitch macro modal */}
      <CorrectPitchModal />
    </div>
  );
}
