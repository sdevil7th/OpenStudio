import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Stage, Layer, Rect, Line, Text, Group } from "react-konva";
import { useShallow } from "zustand/react/shallow";
import { usePitchEditorStore, PitchEditorTool, PitchSnapMode } from "../store/pitchEditorStore";
import { useDAWStore } from "../store/useDAWStore";
import Konva from "konva";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const PIANO_WIDTH = 50;
const TOOLBAR_HEIGHT = 32;
const FOOTER_HEIGHT = 28;
const MIN_MIDI = 24;  // C1
const MAX_MIDI = 96;  // C7

interface S13PitchEditorProps {
  onClose: () => void;
}

export function S13PitchEditor({ onClose }: S13PitchEditorProps) {
  const {
    trackId, clipId, contour, notes, isAnalyzing, isApplying,
    selectedNoteIds, tool, snapMode,
    scrollX, scrollY, zoomX, zoomY,
    analyze, setTool, setSnapMode,
    selectNote, selectAll, deselectAll, setSelectedNoteIds,
    updateNote, moveSelectedPitch, splitNote,
    correctSelectedToScale, correctAllToScale,
    undo, redo, pushUndo,
    setScrollX, setScrollY, setZoomX,
    applyCorrection, previewCorrection,
    undoStack, redoStack,
    referenceTracks, addReferenceTrack, removeReferenceTrack, toggleReferenceVisibility,
  } = usePitchEditorStore(
    useShallow((s) => ({
      trackId: s.trackId, clipId: s.clipId, contour: s.contour,
      notes: s.notes, isAnalyzing: s.isAnalyzing, isApplying: s.isApplying,
      selectedNoteIds: s.selectedNoteIds, tool: s.tool, snapMode: s.snapMode,
      scrollX: s.scrollX, scrollY: s.scrollY, zoomX: s.zoomX, zoomY: s.zoomY,
      analyze: s.analyze, setTool: s.setTool, setSnapMode: s.setSnapMode,
      selectNote: s.selectNote, selectAll: s.selectAll, deselectAll: s.deselectAll,
      setSelectedNoteIds: s.setSelectedNoteIds,
      updateNote: s.updateNote, moveSelectedPitch: s.moveSelectedPitch,
      splitNote: s.splitNote,
      correctSelectedToScale: s.correctSelectedToScale, correctAllToScale: s.correctAllToScale,
      undo: s.undo, redo: s.redo, pushUndo: s.pushUndo,
      setScrollX: s.setScrollX, setScrollY: s.setScrollY,
      setZoomX: s.setZoomX,
      applyCorrection: s.applyCorrection, previewCorrection: s.previewCorrection,
      undoStack: s.undoStack, redoStack: s.redoStack,
      referenceTracks: s.referenceTracks, addReferenceTrack: s.addReferenceTrack,
      removeReferenceTrack: s.removeReferenceTrack, toggleReferenceVisibility: s.toggleReferenceVisibility,
    }))
  );

  // Get DAW tracks for reference track picker
  const dawTracks = useDAWStore(useShallow((s) => s.tracks));
  const [showRefPanel, setShowRefPanel] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 900, height: 500 });
  const [hoveredNote, setHoveredNote] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    type: "move" | "resize-start" | "resize-end" | "drift" | "rubberband";
    noteId?: string;
    startX: number;
    startY: number;
    origPitch?: number;
    origStartTime?: number;
    origEndTime?: number;
  } | null>(null);
  const [rubberBand, setRubberBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const canvasWidth = stageSize.width - PIANO_WIDTH;
  const canvasHeight = stageSize.height - TOOLBAR_HEIGHT - FOOTER_HEIGHT;

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setStageSize({ width: Math.max(400, width), height: Math.max(300, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-analyze when user scrolls into unanalyzed territory (debounced)
  const analyzeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyzedRangesRef = useRef<Array<[number, number]>>([]);

  // Auto-analyze on mount (first 30s)
  useEffect(() => {
    if (trackId && clipId && !contour && !isAnalyzing) {
      analyzedRangesRef.current = [[0, 30]];
      analyze(); // No args = analyze first 30s
    }
  }, [trackId, clipId, contour, isAnalyzing, analyze]);

  useEffect(() => {
    if (!trackId || !clipId || isAnalyzing || !contour) return;

    // Check if current viewport has notes coverage
    const hasNotesInRange = notes.some(
      (n) => n.endTime >= visibleTimeStart && n.startTime <= visibleTimeEnd
    );
    // Check if this range was already analyzed
    const alreadyAnalyzed = analyzedRangesRef.current.some(
      ([start, end]) => visibleTimeStart >= start && visibleTimeEnd <= end
    );

    if (!hasNotesInRange && !alreadyAnalyzed) {
      // Debounce: wait 500ms after scrolling stops before analyzing
      if (analyzeTimeoutRef.current) clearTimeout(analyzeTimeoutRef.current);
      analyzeTimeoutRef.current = setTimeout(() => {
        analyzedRangesRef.current.push([visibleTimeStart, visibleTimeEnd]);
        analyze(visibleTimeStart, visibleTimeEnd);
      }, 500);
    }

    return () => {
      if (analyzeTimeoutRef.current) clearTimeout(analyzeTimeoutRef.current);
    };
  }, [visibleTimeStart, visibleTimeEnd, trackId, clipId, isAnalyzing, contour, notes, analyze]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "z") { e.preventDefault(); undo(); }
      else if (e.ctrlKey && e.key === "y") { e.preventDefault(); redo(); }
      else if (e.ctrlKey && e.key === "a") { e.preventDefault(); selectAll(); }
      else if (e.key === "ArrowUp" && !e.ctrlKey) {
        e.preventDefault();
        moveSelectedPitch(e.shiftKey ? 0.01 : 1);
      }
      else if (e.key === "ArrowDown" && !e.ctrlKey) {
        e.preventDefault();
        moveSelectedPitch(e.shiftKey ? -0.01 : -1);
      }
      else if (e.key === "Escape") { deselectAll(); }
      else if (e.key === "1") setTool("select");
      else if (e.key === "2") setTool("pitch");
      else if (e.key === "3") setTool("drift");
      else if (e.key === "4") setTool("vibrato");
      else if (e.key === "5") setTool("transition");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, selectAll, moveSelectedPitch, deselectAll, setTool]);

  // Coordinate helpers
  const timeToX = useCallback((time: number) => {
    return PIANO_WIDTH + (time - scrollX) * zoomX;
  }, [scrollX, zoomX]);

  const xToTime = useCallback((x: number) => {
    return (x - PIANO_WIDTH) / zoomX + scrollX;
  }, [scrollX, zoomX]);

  const midiToY = useCallback((midi: number) => {
    return TOOLBAR_HEIGHT + canvasHeight - (midi - scrollY) * zoomY;
  }, [scrollY, zoomY, canvasHeight]);

  // Visible MIDI range
  const visibleMidiBottom = scrollY;
  const visibleMidiTop = scrollY + canvasHeight / zoomY;

  // Visible time range
  const visibleTimeStart = scrollX;
  const visibleTimeEnd = scrollX + canvasWidth / zoomX;

  // Piano keys
  const pianoKeys = useMemo(() => {
    const keys: React.ReactElement[] = [];
    const start = Math.max(MIN_MIDI, Math.floor(visibleMidiBottom));
    const end = Math.min(MAX_MIDI, Math.ceil(visibleMidiTop));
    for (let m = start; m <= end; m++) {
      const y = midiToY(m + 1);
      const h = zoomY;
      const noteIdx = m % 12;
      const isBlack = BLACK_KEYS.has(noteIdx);
      keys.push(
        <Rect
          key={`pk-${m}`}
          x={0} y={y} width={PIANO_WIDTH} height={h}
          fill={isBlack ? "#1a1a1a" : "#2a2a2a"}
          stroke="#111" strokeWidth={0.5}
        />
      );
      keys.push(
        <Text
          key={`pn-${m}`}
          x={2} y={y + 1}
          width={PIANO_WIDTH - 4} height={h}
          text={`${NOTE_NAMES[noteIdx]}${Math.floor(m / 12) - 1}`}
          fontSize={Math.min(9, zoomY - 1)}
          fill={isBlack ? "#666" : "#999"}
          verticalAlign="middle"
        />
      );
    }
    return keys;
  }, [visibleMidiBottom, visibleMidiTop, midiToY, zoomY]);

  // Grid lines
  const gridLines = useMemo(() => {
    const lines: React.ReactElement[] = [];
    // Horizontal: semitone lines
    const start = Math.max(MIN_MIDI, Math.floor(visibleMidiBottom));
    const end = Math.min(MAX_MIDI, Math.ceil(visibleMidiTop));
    for (let m = start; m <= end; m++) {
      const y = midiToY(m);
      const noteIdx = m % 12;
      const isC = noteIdx === 0;
      lines.push(
        <Line
          key={`gh-${m}`}
          points={[PIANO_WIDTH, y, stageSize.width, y]}
          stroke={isC ? "#333" : "#1a1a1a"}
          strokeWidth={isC ? 1 : 0.5}
        />
      );
    }
    // Vertical: time grid (every 0.5s or beat-aligned)
    const timeStep = zoomX > 400 ? 0.1 : zoomX > 150 ? 0.25 : zoomX > 50 ? 0.5 : 1.0;
    for (let t = Math.floor(visibleTimeStart / timeStep) * timeStep; t <= visibleTimeEnd; t += timeStep) {
      const x = timeToX(t);
      if (x < PIANO_WIDTH) continue;
      const isMajor = Math.abs(t - Math.round(t)) < 0.001;
      lines.push(
        <Line
          key={`gv-${t.toFixed(3)}`}
          points={[x, TOOLBAR_HEIGHT, x, stageSize.height - FOOTER_HEIGHT]}
          stroke={isMajor ? "#2a2a2a" : "#161616"}
          strokeWidth={isMajor ? 1 : 0.5}
        />
      );
    }
    return lines;
  }, [visibleMidiBottom, visibleMidiTop, visibleTimeStart, visibleTimeEnd, midiToY, timeToX, zoomX, stageSize]);

  // Pitch contour curve (raw detected pitch)
  const pitchCurve = useMemo(() => {
    if (!contour) return null;
    const { times, midi, confidence } = contour.frames;
    const points: number[] = [];
    let hasPoints = false;
    for (let i = 0; i < times.length; i++) {
      if (midi[i] <= 0 || confidence[i] < 0.3) continue;
      const t = times[i];
      if (t < visibleTimeStart - 0.5 || t > visibleTimeEnd + 0.5) continue;
      const x = timeToX(t);
      const y = midiToY(midi[i]);
      points.push(x, y);
      hasPoints = true;
    }
    if (!hasPoints) return null;
    return (
      <Line
        points={points}
        stroke="#f59e0b"
        strokeWidth={1}
        opacity={0.4}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />
    );
  }, [contour, visibleTimeStart, visibleTimeEnd, timeToX, midiToY]);

  // Reference track contours & notes (rendered behind main notes)
  const referenceElements = useMemo(() => {
    const elements: React.ReactElement[] = [];
    for (const ref of referenceTracks) {
      if (!ref.visible || !ref.contour) continue;
      // Draw reference notes as semi-transparent rectangles
      for (const note of ref.notes) {
        if (note.endTime < visibleTimeStart || note.startTime > visibleTimeEnd) continue;
        const x = timeToX(note.startTime);
        const x2 = timeToX(note.endTime);
        const y = midiToY(note.correctedPitch);
        elements.push(
          <Rect
            key={`ref-${ref.trackId}-${note.id}`}
            x={x} y={y}
            width={x2 - x} height={zoomY}
            fill={ref.color}
            opacity={0.15}
            cornerRadius={2}
            listening={false}
          />
        );
        // Label
        if (x2 - x > 20) {
          elements.push(
            <Text
              key={`ref-label-${ref.trackId}-${note.id}`}
              x={x + 2} y={y + 1}
              text={ref.trackName}
              fontSize={8} fill={ref.color} opacity={0.6}
              listening={false}
            />
          );
        }
      }
      // Draw reference pitch contour line
      const { times, midi, confidence } = ref.contour.frames;
      const pts: number[] = [];
      for (let i = 0; i < times.length; i++) {
        if (midi[i] <= 0 || confidence[i] < 0.3) continue;
        if (times[i] < visibleTimeStart - 0.5 || times[i] > visibleTimeEnd + 0.5) continue;
        pts.push(timeToX(times[i]), midiToY(midi[i]));
      }
      if (pts.length >= 4) {
        elements.push(
          <Line
            key={`ref-contour-${ref.trackId}`}
            points={pts}
            stroke={ref.color}
            strokeWidth={1}
            opacity={0.35}
            lineCap="round"
            lineJoin="round"
            listening={false}
          />
        );
      }
    }
    return elements;
  }, [referenceTracks, visibleTimeStart, visibleTimeEnd, timeToX, midiToY, zoomY]);

  // Note blobs
  const noteBlobs = useMemo(() => {
    if (notes.length > 0) {
      const visible = notes.filter(n => n.endTime >= visibleTimeStart && n.startTime <= visibleTimeEnd);
      console.log(`[PitchEditor Render] ${notes.length} total notes, ${visible.length} in view [${visibleTimeStart.toFixed(2)}s - ${visibleTimeEnd.toFixed(2)}s], scrollY=${scrollY}, zoomY=${zoomY}`);
      if (visible.length > 0) {
        const n = visible[0];
        console.log(`[PitchEditor Render] First visible note: pitch=${n.correctedPitch.toFixed(1)}, time=${n.startTime.toFixed(2)}-${n.endTime.toFixed(2)}, x=${timeToX(n.startTime).toFixed(0)}, y=${midiToY(n.correctedPitch).toFixed(0)}`);
      }
    }
    return notes.map((note) => {
      if (note.endTime < visibleTimeStart || note.startTime > visibleTimeEnd) return null;

      const x = timeToX(note.startTime);
      const x2 = timeToX(note.endTime);
      const y = midiToY(note.correctedPitch);
      const width = x2 - x;
      const height = zoomY;
      const isSelected = selectedNoteIds.includes(note.id);
      const isHovered = hoveredNote === note.id;
      const isShifted = Math.abs(note.correctedPitch - note.detectedPitch) > 0.1;

      // Note pitch drift curve (within note)
      const driftPoints: number[] = [];
      if (note.pitchDrift.length > 0) {
        const driftStep = (note.endTime - note.startTime) / note.pitchDrift.length;
        for (let i = 0; i < note.pitchDrift.length; i++) {
          const t = note.startTime + i * driftStep;
          const px = timeToX(t);
          const py = midiToY(note.correctedPitch + note.pitchDrift[i]);
          driftPoints.push(px, py);
        }
      }

      return (
        <Group key={note.id}>
          {/* Note body */}
          <Rect
            x={x} y={y - height}
            width={Math.max(2, width)} height={height}
            fill={isShifted ? "#c2410c" : "#166534"}
            opacity={isSelected ? 0.9 : isHovered ? 0.75 : 0.6}
            stroke={isSelected ? "#fff" : isHovered ? "#aaa" : "#555"}
            strokeWidth={isSelected ? 1.5 : 0.5}
            cornerRadius={2}
            name={`note-${note.id}`}
          />
          {/* Drift curve inside note */}
          {driftPoints.length > 4 && (
            <Line
              points={driftPoints}
              stroke={isShifted ? "#fb923c" : "#4ade80"}
              strokeWidth={1.2}
              opacity={0.8}
              listening={false}
              clipX={x} clipY={y - height}
              clipWidth={Math.max(2, width)} clipHeight={height}
            />
          )}
          {/* Note label */}
          {width > 30 && (
            <Text
              x={x + 3} y={y - height + 2}
              text={`${NOTE_NAMES[Math.round(note.correctedPitch) % 12]}${Math.floor(Math.round(note.correctedPitch) / 12) - 1}`}
              fontSize={9}
              fill="#fff"
              opacity={0.7}
              listening={false}
            />
          )}
          {/* Resize handles (left/right edges) */}
          {isSelected && (
            <>
              <Rect
                x={x} y={y - height}
                width={4} height={height}
                fill="transparent"
                name={`resize-start-${note.id}`}
              />
              <Rect
                x={x2 - 4} y={y - height}
                width={4} height={height}
                fill="transparent"
                name={`resize-end-${note.id}`}
              />
            </>
          )}
        </Group>
      );
    });
  }, [notes, visibleTimeStart, visibleTimeEnd, timeToX, midiToY, zoomY, selectedNoteIds, hoveredNote]);

  // Mouse handlers
  const handleMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const target = e.target;
    const name = target.name() || "";
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;

    // Resize handle?
    if (name.startsWith("resize-start-")) {
      const noteId = name.replace("resize-start-", "");
      const note = notes.find(n => n.id === noteId);
      if (note) {
        pushUndo("Resize note start");
        setDragState({ type: "resize-start", noteId, startX: pos.x, startY: pos.y, origStartTime: note.startTime });
      }
      return;
    }
    if (name.startsWith("resize-end-")) {
      const noteId = name.replace("resize-end-", "");
      const note = notes.find(n => n.id === noteId);
      if (note) {
        pushUndo("Resize note end");
        setDragState({ type: "resize-end", noteId, startX: pos.x, startY: pos.y, origEndTime: note.endTime });
      }
      return;
    }

    // Note click
    if (name.startsWith("note-")) {
      const noteId = name.replace("note-", "");

      if (tool === "pitch") {
        const note = notes.find(n => n.id === noteId);
        if (note) {
          updateNote(noteId, { correctedPitch: Math.round(note.correctedPitch) });
        }
        return;
      }

      const addToSel = e.evt.shiftKey || e.evt.ctrlKey;
      selectNote(noteId, addToSel);

      if (tool === "vibrato") {
        // Vibrato tool: drag up/down to change vibrato depth
        const note = notes.find(n => n.id === noteId);
        if (note) {
          pushUndo("Adjust vibrato");
          setDragState({
            type: "drift", // reuse drift drag type for vibrato
            noteId,
            startX: pos.x,
            startY: pos.y,
          });
        }
        return;
      }

      if (tool === "transition") {
        // Transition tool: drag up/down to adjust transition in/out
        const note = notes.find(n => n.id === noteId);
        if (note) {
          pushUndo("Adjust transition");
          setDragState({
            type: "drift",
            noteId,
            startX: pos.x,
            startY: pos.y,
          });
        }
        return;
      }

      if (tool === "select" || tool === "drift") {
        const note = notes.find(n => n.id === noteId);
        if (note) {
          setDragState({
            type: tool === "drift" ? "drift" : "move",
            noteId,
            startX: pos.x,
            startY: pos.y,
            origPitch: note.correctedPitch,
            origStartTime: note.startTime,
          });
          if (tool === "select") pushUndo("Move note");
        }
      }
      return;
    }

    // Background click — rubber band or deselect
    if (pos.x > PIANO_WIDTH && pos.y > TOOLBAR_HEIGHT) {
      if (tool === "pitch" && !name.startsWith("note-")) {
        // Click background with pitch tool = correct all
        correctAllToScale();
        return;
      }
      if (!e.evt.shiftKey) deselectAll();
      setDragState({ type: "rubberband", startX: pos.x, startY: pos.y });
    }
  }, [notes, tool, selectNote, deselectAll, updateNote, splitNote, correctAllToScale, pushUndo, xToTime]);

  const handleMouseMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;

    // Hover detection
    const target = e.target;
    const name = target.name() || "";
    if (name.startsWith("note-")) {
      setHoveredNote(name.replace("note-", ""));
    } else {
      setHoveredNote(null);
    }

    if (!dragState) return;

    if (dragState.type === "move" && dragState.noteId && dragState.origPitch !== undefined && dragState.origStartTime !== undefined) {
      const deltaMidi = (dragState.startY - pos.y) / zoomY;
      const deltaTime = (pos.x - dragState.startX) / zoomX;
      let newPitch = dragState.origPitch + deltaMidi;
      if (snapMode === "chromatic") newPitch = Math.round(newPitch);
      // Move all selected notes by the same delta
      const store = usePitchEditorStore.getState();
      const note = store.notes.find(n => n.id === dragState.noteId);
      if (!note) return;
      const pitchDelta = newPitch - note.correctedPitch;
      const timeDelta = deltaTime - (note.startTime - dragState.origStartTime);
      usePitchEditorStore.setState({
        notes: store.notes.map(n => {
          if (!selectedNoteIds.includes(n.id)) return n;
          return {
            ...n,
            correctedPitch: n.correctedPitch + pitchDelta,
            startTime: Math.max(0, n.startTime + timeDelta),
            endTime: n.endTime + timeDelta,
          };
        }),
      });
    }

    if (dragState.type === "resize-start" && dragState.noteId && dragState.origStartTime !== undefined) {
      const deltaTime = (pos.x - dragState.startX) / zoomX;
      const newStart = Math.max(0, dragState.origStartTime + deltaTime);
      const store = usePitchEditorStore.getState();
      const note = store.notes.find(n => n.id === dragState.noteId);
      if (note && newStart < note.endTime - 0.01) {
        usePitchEditorStore.setState({
          notes: store.notes.map(n =>
            n.id === dragState.noteId ? { ...n, startTime: newStart } : n
          ),
        });
      }
    }

    if (dragState.type === "resize-end" && dragState.noteId && dragState.origEndTime !== undefined) {
      const deltaTime = (pos.x - dragState.startX) / zoomX;
      const newEnd = dragState.origEndTime + deltaTime;
      const store = usePitchEditorStore.getState();
      const note = store.notes.find(n => n.id === dragState.noteId);
      if (note && newEnd > note.startTime + 0.01) {
        usePitchEditorStore.setState({
          notes: store.notes.map(n =>
            n.id === dragState.noteId ? { ...n, endTime: newEnd } : n
          ),
        });
      }
    }

    if (dragState.type === "drift" && dragState.noteId) {
      const deltaY = (dragState.startY - pos.y) / 100;
      const store = usePitchEditorStore.getState();
      const note = store.notes.find(n => n.id === dragState.noteId);
      if (note) {
        if (tool === "vibrato") {
          // Vibrato tool: drag up/down changes vibrato depth
          const newDepth = Math.max(0, Math.min(3, note.vibratoDepth + deltaY * 0.05));
          usePitchEditorStore.setState({
            notes: store.notes.map(n =>
              selectedNoteIds.includes(n.id) ? { ...n, vibratoDepth: newDepth } : n
            ),
          });
        } else if (tool === "transition") {
          // Transition tool: drag changes transition in/out (ms)
          const deltaMs = deltaY * 5;
          const newTransIn = Math.max(0, Math.min(200, note.transitionIn + deltaMs));
          const newTransOut = Math.max(0, Math.min(200, note.transitionOut + deltaMs));
          usePitchEditorStore.setState({
            notes: store.notes.map(n =>
              selectedNoteIds.includes(n.id) ? { ...n, transitionIn: newTransIn, transitionOut: newTransOut } : n
            ),
          });
        } else {
          // Drift tool: drag changes drift correction amount
          const newDrift = Math.max(0, Math.min(1, note.driftCorrectionAmount + deltaY * 0.05));
          usePitchEditorStore.setState({
            notes: store.notes.map(n =>
              selectedNoteIds.includes(n.id) ? { ...n, driftCorrectionAmount: newDrift } : n
            ),
          });
        }
      }
    }

    if (dragState.type === "rubberband") {
      setRubberBand({
        x1: Math.min(dragState.startX, pos.x),
        y1: Math.min(dragState.startY, pos.y),
        x2: Math.max(dragState.startX, pos.x),
        y2: Math.max(dragState.startY, pos.y),
      });
    }
  }, [dragState, zoomY, zoomX, snapMode, selectedNoteIds]);

  const handleMouseUp = useCallback(() => {
    if (dragState?.type === "rubberband" && rubberBand) {
      // Select notes within rubber band
      const ids: string[] = [];
      for (const note of notes) {
        const nx1 = timeToX(note.startTime);
        const nx2 = timeToX(note.endTime);
        const ny = midiToY(note.correctedPitch);
        if (nx2 > rubberBand.x1 && nx1 < rubberBand.x2 &&
            ny > rubberBand.y1 && ny - zoomY < rubberBand.y2) {
          ids.push(note.id);
        }
      }
      setSelectedNoteIds(ids);
      setRubberBand(null);
    }
    setDragState(null);
  }, [dragState, rubberBand, notes, timeToX, midiToY, zoomY, setSelectedNoteIds]);

  // Wheel zoom/scroll
  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    if (e.evt.ctrlKey) {
      // Zoom X
      const factor = e.evt.deltaY < 0 ? 1.1 : 0.9;
      setZoomX(zoomX * factor);
    } else if (e.evt.shiftKey) {
      // Scroll X
      setScrollX(scrollX + e.evt.deltaY * 0.002 * (canvasWidth / zoomX));
    } else {
      // Scroll Y
      setScrollY(scrollY - e.evt.deltaY * 0.05);
    }
  }, [zoomX, scrollX, scrollY, canvasWidth, setZoomX, setScrollX, setScrollY]);

  // Cursor based on tool
  const cursor = useMemo(() => {
    switch (tool) {
      case "select": return dragState?.type === "move" ? "grabbing" : "default";
      case "pitch": return "crosshair";
      case "drift": return "ns-resize";
      case "vibrato": return "ew-resize";
      case "transition": return "col-resize";
      default: return "default";
    }
  }, [tool, dragState]);

  // Info about hovered/selected note
  const infoNote = useMemo(() => {
    if (selectedNoteIds.length === 1) {
      return notes.find(n => n.id === selectedNoteIds[0]);
    }
    if (hoveredNote) {
      return notes.find(n => n.id === hoveredNote);
    }
    return null;
  }, [selectedNoteIds, hoveredNote, notes]);

  const toolDefs: { id: PitchEditorTool; label: string; shortcut: string }[] = [
    { id: "select", label: "Select", shortcut: "1" },
    { id: "pitch", label: "Pitch", shortcut: "2" },
    { id: "drift", label: "Drift", shortcut: "3" },
    { id: "vibrato", label: "Vibrato", shortcut: "4" },
    { id: "transition", label: "Trans", shortcut: "5" },
  ];

  const snapDefs: { id: PitchSnapMode; label: string }[] = [
    { id: "off", label: "Free" },
    { id: "chromatic", label: "Semi" },
    { id: "scale", label: "Scale" },
  ];

  if (!trackId || !clipId) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
        No clip selected for pitch editing.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col bg-daw-dark h-full select-none" style={{ cursor }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 bg-neutral-800 border-b border-neutral-700" style={{ height: TOOLBAR_HEIGHT }}>
        {/* Tools */}
        <div className="flex gap-0.5">
          {toolDefs.map(t => (
            <button
              key={t.id}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                tool === t.id
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-700 text-neutral-400 hover:bg-neutral-600"
              }`}
              onClick={() => setTool(t.id)}
              title={`${t.label} (${t.shortcut})`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-neutral-600" />

        {/* Snap */}
        <div className="flex gap-0.5">
          {snapDefs.map(s => (
            <button
              key={s.id}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                snapMode === s.id
                  ? "bg-green-700 text-white"
                  : "bg-neutral-700 text-neutral-400 hover:bg-neutral-600"
              }`}
              onClick={() => setSnapMode(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-neutral-600" />

        {/* Undo/Redo */}
        <button
          className="px-1.5 py-0.5 text-[10px] bg-neutral-700 rounded text-neutral-400 hover:bg-neutral-600 disabled:opacity-30"
          onClick={undo}
          disabled={undoStack.length === 0}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          className="px-1.5 py-0.5 text-[10px] bg-neutral-700 rounded text-neutral-400 hover:bg-neutral-600 disabled:opacity-30"
          onClick={redo}
          disabled={redoStack.length === 0}
          title="Redo (Ctrl+Y)"
        >
          Redo
        </button>

        <div className="w-px h-4 bg-neutral-600" />

        {/* Correct */}
        <button
          className="px-2 py-0.5 text-[10px] bg-neutral-700 rounded text-neutral-400 hover:bg-neutral-600"
          onClick={correctSelectedToScale}
          title="Correct selected notes to nearest semitone"
        >
          Correct Sel
        </button>
        <button
          className="px-2 py-0.5 text-[10px] bg-neutral-700 rounded text-neutral-400 hover:bg-neutral-600"
          onClick={correctAllToScale}
          title="Correct all notes to nearest semitone"
        >
          Correct All
        </button>

        <div className="w-px h-4 bg-neutral-600" />

        {/* Reference Tracks */}
        <div className="relative">
          <button
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              referenceTracks.length > 0
                ? "bg-purple-700 text-white"
                : "bg-neutral-700 text-neutral-400 hover:bg-neutral-600"
            }`}
            onClick={() => setShowRefPanel(!showRefPanel)}
            title="Show/hide reference tracks"
          >
            Ref ({referenceTracks.length})
          </button>
          {showRefPanel && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-neutral-800 border border-neutral-600 rounded shadow-xl p-2 w-56">
              <div className="text-[9px] text-neutral-500 uppercase tracking-wider mb-1">Reference Tracks</div>
              {/* Active references */}
              {referenceTracks.map(ref => (
                <div key={ref.trackId} className="flex items-center gap-1 py-0.5">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: ref.color }} />
                  <button
                    className={`flex-1 text-left text-[10px] px-1 rounded ${ref.visible ? "text-neutral-200" : "text-neutral-600 line-through"}`}
                    onClick={() => toggleReferenceVisibility(ref.trackId)}
                  >
                    {ref.trackName}
                  </button>
                  <button
                    className="text-[9px] text-neutral-500 hover:text-red-400 px-1"
                    onClick={() => removeReferenceTrack(ref.trackId)}
                  >✕</button>
                </div>
              ))}
              {/* Add reference */}
              <div className="border-t border-neutral-700 mt-1 pt-1">
                <div className="text-[9px] text-neutral-500 mb-0.5">Add track:</div>
                {dawTracks
                  .filter(t => t.id !== trackId && !referenceTracks.some(r => r.trackId === t.id))
                  .map(t => {
                    const firstClip = t.clips?.[0];
                    if (!firstClip) return null;
                    return (
                      <button
                        key={t.id}
                        className="block w-full text-left text-[10px] text-neutral-400 hover:text-white hover:bg-neutral-700 px-1 py-0.5 rounded"
                        onClick={() => {
                          addReferenceTrack(t.id, firstClip.id, t.name);
                        }}
                      >
                        {t.name}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Zoom */}
        <span className="text-[9px] text-neutral-500">Zoom</span>
        <button
          className="px-1 py-0.5 text-[10px] bg-neutral-700 rounded text-neutral-400 hover:bg-neutral-600"
          onClick={() => setZoomX(zoomX * 1.3)}
        >+</button>
        <button
          className="px-1 py-0.5 text-[10px] bg-neutral-700 rounded text-neutral-400 hover:bg-neutral-600"
          onClick={() => setZoomX(zoomX / 1.3)}
        >-</button>

        <div className="w-px h-4 bg-neutral-600" />

        {/* Apply / Preview */}
        <button
          className="px-2 py-0.5 text-[10px] bg-yellow-700 rounded text-white hover:bg-yellow-600 disabled:opacity-30"
          onClick={previewCorrection}
          disabled={isApplying}
        >
          Preview
        </button>
        <button
          className="px-2 py-0.5 text-[10px] bg-green-700 rounded text-white hover:bg-green-600 disabled:opacity-30"
          onClick={applyCorrection}
          disabled={isApplying}
        >
          Apply
        </button>

        <button
          className="px-1.5 py-0.5 text-[10px] text-neutral-500 hover:text-white"
          onClick={onClose}
        >
          X
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        {isAnalyzing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
            <div className="text-neutral-300 text-sm animate-pulse">Analyzing pitch contour...</div>
          </div>
        )}
        {isApplying && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
            <div className="text-neutral-300 text-sm animate-pulse">Processing...</div>
          </div>
        )}
        <Stage
          width={stageSize.width}
          height={canvasHeight + TOOLBAR_HEIGHT}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
        >
          <Layer>
            {/* Background */}
            <Rect
              x={PIANO_WIDTH} y={TOOLBAR_HEIGHT}
              width={canvasWidth} height={canvasHeight}
              fill="#0d0d0d"
              name="pitch-bg"
            />

            {/* Semitone background bands */}
            {(() => {
              const bands: React.ReactElement[] = [];
              const start = Math.max(MIN_MIDI, Math.floor(visibleMidiBottom));
              const end = Math.min(MAX_MIDI, Math.ceil(visibleMidiTop));
              for (let m = start; m <= end; m++) {
                const noteIdx = m % 12;
                if (BLACK_KEYS.has(noteIdx)) {
                  const y = midiToY(m + 1);
                  bands.push(
                    <Rect
                      key={`band-${m}`}
                      x={PIANO_WIDTH} y={y}
                      width={canvasWidth} height={zoomY}
                      fill="#0a0a0a"
                      listening={false}
                    />
                  );
                }
              }
              return bands;
            })()}

            {/* Grid */}
            {gridLines}

            {/* Reference track contours */}
            {referenceElements}

            {/* Pitch contour curve */}
            {pitchCurve}

            {/* Notes */}
            {noteBlobs}

            {/* Rubber band selection */}
            {rubberBand && (
              <Rect
                x={rubberBand.x1} y={rubberBand.y1}
                width={rubberBand.x2 - rubberBand.x1}
                height={rubberBand.y2 - rubberBand.y1}
                fill="rgba(0, 120, 212, 0.15)"
                stroke="#0078d4"
                strokeWidth={1}
                dash={[4, 2]}
                listening={false}
              />
            )}

            {/* Piano keys */}
            <Group clipX={0} clipY={TOOLBAR_HEIGHT} clipWidth={PIANO_WIDTH} clipHeight={canvasHeight}>
              {pianoKeys}
            </Group>
          </Layer>
        </Stage>
      </div>

      {/* Note Properties Panel (when note selected) */}
      {infoNote && selectedNoteIds.length > 0 && (
        <div className="flex items-center gap-4 px-3 py-1 bg-neutral-850 border-t border-neutral-700 text-[10px]">
          <span className="text-neutral-400 font-semibold">
            {NOTE_NAMES[Math.round(infoNote.correctedPitch) % 12]}
            {Math.floor(Math.round(infoNote.correctedPitch) / 12) - 1}
          </span>
          <label className="flex items-center gap-1 text-neutral-500">
            Drift
            <input type="range" min={0} max={100} step={1}
              value={Math.round(infoNote.driftCorrectionAmount * 100)}
              onChange={(e) => updateNote(infoNote.id, { driftCorrectionAmount: parseInt(e.target.value) / 100 })}
              className="w-14 h-1 accent-blue-500"
            />
            <span className="text-neutral-400 w-7">{Math.round(infoNote.driftCorrectionAmount * 100)}%</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500">
            Vibrato
            <input type="range" min={0} max={300} step={1}
              value={Math.round(infoNote.vibratoDepth * 100)}
              onChange={(e) => updateNote(infoNote.id, { vibratoDepth: parseInt(e.target.value) / 100 })}
              className="w-14 h-1 accent-purple-500"
            />
            <span className="text-neutral-400 w-8">{Math.round(infoNote.vibratoDepth * 100)}%</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500">
            Trans In
            <input type="range" min={0} max={200} step={1}
              value={Math.round(infoNote.transitionIn)}
              onChange={(e) => updateNote(infoNote.id, { transitionIn: parseInt(e.target.value) })}
              className="w-10 h-1 accent-green-500"
            />
            <span className="text-neutral-400 w-8">{Math.round(infoNote.transitionIn)}ms</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500">
            Out
            <input type="range" min={0} max={200} step={1}
              value={Math.round(infoNote.transitionOut)}
              onChange={(e) => updateNote(infoNote.id, { transitionOut: parseInt(e.target.value) })}
              className="w-10 h-1 accent-green-500"
            />
            <span className="text-neutral-400 w-8">{Math.round(infoNote.transitionOut)}ms</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500">
            Formant
            <input type="range" min={-12} max={12} step={0.1}
              value={infoNote.formantShift}
              onChange={(e) => updateNote(infoNote.id, { formantShift: parseFloat(e.target.value) })}
              className="w-12 h-1 accent-orange-500"
            />
            <span className="text-neutral-400 w-7">{infoNote.formantShift.toFixed(1)}st</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500">
            Gain
            <input type="range" min={-12} max={12} step={0.1}
              value={infoNote.gain}
              onChange={(e) => updateNote(infoNote.id, { gain: parseFloat(e.target.value) })}
              className="w-10 h-1 accent-yellow-500"
            />
            <span className="text-neutral-400 w-8">{infoNote.gain.toFixed(1)}dB</span>
          </label>
        </div>
      )}

      {/* Keyboard Shortcuts Help Overlay */}
      {showHelp && (
        <div className="absolute inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => setShowHelp(false)}>
          <div className="bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-4 max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <span className="text-[12px] font-semibold text-neutral-200">Keyboard Shortcuts</span>
              <button className="text-neutral-500 hover:text-white text-[12px]" onClick={() => setShowHelp(false)}>✕</button>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px]">
              {[
                ["1", "Select tool"],
                ["2", "Pitch tool"],
                ["3", "Drift tool"],
                ["4", "Vibrato tool"],
                ["5", "Transition tool"],
                ["6", "Cut tool"],
                ["Up / Down", "Move pitch ±1 semitone"],
                ["Shift+Up/Down", "Fine pitch ±1 cent"],
                ["Ctrl+A", "Select all notes"],
                ["Ctrl+Z", "Undo"],
                ["Ctrl+Y", "Redo"],
                ["Escape", "Deselect all"],
                ["Wheel", "Scroll vertically"],
                ["Shift+Wheel", "Scroll horizontally"],
                ["Ctrl+Wheel", "Zoom in/out"],
              ].map(([key, desc]) => (
                <div key={key} className="contents">
                  <span className="text-neutral-300 font-mono bg-neutral-700 rounded px-1 py-0.5 text-center">{key}</span>
                  <span className="text-neutral-400 py-0.5">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center px-3 bg-neutral-800 border-t border-neutral-700 text-[10px] text-neutral-500 gap-4" style={{ height: FOOTER_HEIGHT }}>
        <span>Notes: {notes.length}</span>
        <span>Selected: {selectedNoteIds.length}</span>
        {infoNote && (
          <span>
            {NOTE_NAMES[Math.round(infoNote.correctedPitch) % 12]}
            {Math.floor(Math.round(infoNote.correctedPitch) / 12) - 1}
            {" "}({(infoNote.correctedPitch - infoNote.detectedPitch) > 0 ? "+" : ""}
            {(infoNote.correctedPitch - infoNote.detectedPitch).toFixed(1)} st)
          </span>
        )}
        <div className="flex-1" />
        <span>Tool: {tool} | Scroll: Wheel | Zoom: Ctrl+Wheel</span>
        <button
          className="text-neutral-500 hover:text-white text-[10px] px-1 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600"
          onClick={() => setShowHelp(true)}
          title="Show keyboard shortcuts"
        >
          ?
        </button>
      </div>
    </div>
  );
}
