import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Stage, Layer, Rect, Line, Text, Group } from "react-konva";
import { useShallow } from "zustand/react/shallow";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore, MIDIEvent, MIDICCEvent } from "../store/useDAWStore";
import { Button } from "./ui";
import "./PianoRoll.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KonvaEvent = any;

interface PianoRollProps {
  readonly clipId: string;
  readonly trackId: string;
  readonly additionalClipIds?: string[];
}

interface NotePair {
  noteOn: MIDIEvent;
  noteOff: MIDIEvent;
  noteNumber: number;
  velocity: number;
  startTime: number;
  duration: number;
  pitchBend?: number;
  pressure?: number;
  slide?: number;
}

interface MultiClipNotePair extends NotePair {
  clipId: string;
  clipIndex: number;
  timeOffset: number;
}

type DragMode = "move" | "resize-start" | "resize-end";

interface NoteDragState {
  mode: DragMode;
  noteIds: string[];
  originalEvents: MIDIEvent[];
  startPointerTime: number;
  startPointerNote: number;
  activeNoteId: string;
}

interface DrawingState {
  startTime: number;
  endTime: number;
  noteNumber: number;
  velocity: number;
}

interface VelocityEditState {
  noteId: string;
  timestamp: number;
  noteNumber: number;
  originalEvents: MIDIEvent[];
}

interface CCDrawState {
  originalCCEvents: MIDICCEvent[];
}

const MULTI_CLIP_TINTS = [
  null,
  "#ff6b9d",
  "#51cf66",
  "#ffd43b",
  "#748ffc",
  "#f06595",
  "#20c997",
  "#ff922b",
];

const STEP_SIZE_OPTIONS = [
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32", beats: 0.125 },
];

const KEY_TO_NOTE: Record<string, number> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

const NOTES_PER_OCTAVE = 12;
const TOTAL_NOTES = 128;
const NOTE_HEIGHT = 12;
const PIANO_WIDTH = 60;
const GRID_SNAP = 0.25;
const VELOCITY_LANE_HEIGHT = 60;
const CC_LANE_HEIGHT = 80;
const LANE_DIVIDER_HEIGHT = 1;
const TOOLBAR_HEIGHT = 40;
const HORIZONTAL_SCROLLBAR_HEIGHT = 16;
const NOTE_EDGE_HIT_WIDTH = 7;
const AUDITION_DURATION_MS = 180;
const AUDITION_THROTTLE_MS = 120;
const MIN_ZOOM = 50;
const MAX_ZOOM = 240;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const SCALE_DEFINITIONS: Record<string, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

const SCALE_DISPLAY_NAMES: Record<string, string> = {
  chromatic: "Chromatic",
  major: "Major",
  minor: "Minor",
  dorian: "Dorian",
  mixolydian: "Mixolydian",
  pentatonic_major: "Pentatonic Major",
  pentatonic_minor: "Pentatonic Minor",
  blues: "Blues",
};

const CC_PRESETS = [
  { cc: 1, name: "CC#1 Modulation" },
  { cc: 7, name: "CC#7 Volume" },
  { cc: 10, name: "CC#10 Pan" },
  { cc: 11, name: "CC#11 Expression" },
  { cc: 64, name: "CC#64 Sustain" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sortEvents(events: MIDIEvent[]): MIDIEvent[] {
  return events
    .map((event) => ({ ...event }))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      if (a.type === b.type) return 0;
      return a.type === "noteOff" ? 1 : -1;
    });
}

function noteIdFor(clipId: string, timestamp: number, noteNumber: number): string {
  return `${clipId}:${timestamp.toFixed(6)}:${noteNumber}`;
}

function getNoteNameFromPitch(pitch: number): string {
  const noteName = NOTE_NAMES[((pitch % NOTES_PER_OCTAVE) + NOTES_PER_OCTAVE) % NOTES_PER_OCTAVE];
  const octave = Math.floor(pitch / 12) - 2;
  return `${noteName}${octave}`;
}

function velocityColor(velocity: number): string {
  const v = clamp(velocity, 0, 127);
  const t = v / 127;
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.25) {
    const s = t / 0.25;
    r = 60;
    g = Math.round(100 + 155 * s);
    b = 240;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    r = Math.round(60 + 40 * s);
    g = 255;
    b = Math.round(240 - 140 * s);
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    r = Math.round(100 + 155 * s);
    g = 255;
    b = Math.round(100 - 100 * s);
  } else {
    const s = (t - 0.75) / 0.25;
    r = 255;
    g = Math.round(255 - 200 * s);
    b = 0;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

function velocityStrokeColor(velocity: number): string {
  const t = clamp(velocity, 0, 127) / 127;
  if (t < 0.5) return "#3b82f6";
  if (t < 0.75) return "#22c55e";
  return "#ef4444";
}

function isNoteInScale(noteNumber: number, scaleRoot: number, scaleType: string): boolean {
  if (scaleType === "chromatic") return true;
  const intervals = SCALE_DEFINITIONS[scaleType];
  if (!intervals) return true;
  const degree = ((noteNumber % 12) - scaleRoot + 12) % 12;
  return intervals.includes(degree);
}

function parseNotePairs(events?: MIDIEvent[]): NotePair[] {
  if (!events) return [];
  const pairs: NotePair[] = [];
  const usedNoteOffs = new Set<number>();

  for (const noteOn of events.filter((event) => event.type === "noteOn")) {
    if (noteOn.note === undefined) continue;
    let noteOff: MIDIEvent | undefined;
    let noteOffIndex = -1;
    events.forEach((event, index) => {
      if (
        usedNoteOffs.has(index) ||
        event.type !== "noteOff" ||
        event.note !== noteOn.note ||
        event.timestamp <= noteOn.timestamp
      ) {
        return;
      }
      if (!noteOff || event.timestamp < noteOff.timestamp) {
        noteOff = event;
        noteOffIndex = index;
      }
    });
    if (!noteOff || noteOffIndex < 0) continue;
    usedNoteOffs.add(noteOffIndex);
    pairs.push({
      noteOn,
      noteOff,
      noteNumber: noteOn.note,
      velocity: noteOn.velocity || 80,
      startTime: noteOn.timestamp,
      duration: Math.max(0.01, noteOff.timestamp - noteOn.timestamp),
      pitchBend: noteOn.pitchBend,
      pressure: noteOn.pressure,
      slide: noteOn.slide,
    });
  }

  return pairs;
}

function transformSelectedEvents(
  events: MIDIEvent[],
  clipId: string,
  noteIds: string[],
  transform: (pair: NotePair) => NotePair | null,
): { events: MIDIEvent[]; nextIds: string[]; auditionPair?: NotePair } {
  const selected = new Set(noteIds);
  const pairs = parseNotePairs(events);
  const consumed = new Set<MIDIEvent>();
  const additions: MIDIEvent[] = [];
  const nextIds: string[] = [];
  let auditionPair: NotePair | undefined;

  pairs.forEach((pair) => {
    const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
    if (!selected.has(id)) return;
    consumed.add(pair.noteOn);
    consumed.add(pair.noteOff);
    const nextPair = transform(pair);
    if (!nextPair) return;

    const startTime = Math.max(0, nextPair.startTime);
    const duration = Math.max(0.01, nextPair.duration);
    const noteNumber = clamp(Math.round(nextPair.noteNumber), 0, 127);
    const velocity = clamp(Math.round(nextPair.velocity), 1, 127);
    const nextNoteOn = {
      ...pair.noteOn,
      timestamp: startTime,
      type: "noteOn" as const,
      note: noteNumber,
      velocity,
    };
    const nextNoteOff = {
      ...pair.noteOff,
      timestamp: startTime + duration,
      type: "noteOff" as const,
      note: noteNumber,
      velocity: 0,
    };

    additions.push(nextNoteOn, nextNoteOff);
    nextIds.push(noteIdFor(clipId, startTime, noteNumber));
    auditionPair ||= {
      ...nextPair,
      noteOn: nextNoteOn,
      noteOff: nextNoteOff,
      startTime,
      duration,
      noteNumber,
      velocity,
    };
  });

  return {
    events: sortEvents([...events.filter((event) => !consumed.has(event)), ...additions]),
    nextIds,
    auditionPair,
  };
}

export function PianoRoll({ clipId, trackId, additionalClipIds = [] }: PianoRollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const auditionRef = useRef<{ note: number | null; timeoutId: number | null; lastAt: number }>({
    note: null,
    timeoutId: null,
    lastAt: 0,
  });
  const latestDragAuditionRef = useRef<{ noteNumber: number; velocity: number } | null>(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [toolbarHeight, setToolbarHeight] = useState(TOOLBAR_HEIGHT);
  const [tool, setTool] = useState<"draw" | "select" | "erase">("draw");
  const [zoom, setZoom] = useState(100);
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(TOTAL_NOTES * NOTE_HEIGHT / 2 - 300);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [stepInputOctave, setStepInputOctave] = useState(4);
  const [selectedCC, setSelectedCC] = useState(1);
  const [showTransformMenu, setShowTransformMenu] = useState(false);
  const [dragState, setDragState] = useState<NoteDragState | null>(null);
  const [drawingState, setDrawingState] = useState<DrawingState | null>(null);
  const [velocityEdit, setVelocityEdit] = useState<VelocityEditState | null>(null);
  const [ccDrawState, setCCDrawState] = useState<CCDrawState | null>(null);
  const transformMenuRef = useRef<HTMLDivElement>(null);

  const {
    track,
    tempo,
    scaleRoot,
    scaleType,
    stepInputEnabled,
    stepInputSize,
    stepInputPosition,
  } = useDAWStore(
    useShallow((state) => ({
      track: state.tracks.find((candidate) => candidate.id === trackId),
      tempo: state.transport.tempo,
      scaleRoot: state.pianoRollScaleRoot,
      scaleType: state.pianoRollScaleType,
      stepInputEnabled: state.stepInputEnabled,
      stepInputSize: state.stepInputSize,
      stepInputPosition: state.stepInputPosition,
    })),
  );

  const {
    toggleStepInput,
    setStepInputSize,
    advanceStepInput,
    setStepInputPosition,
    updateMIDINoteVelocity,
    updateMIDICCEvents,
    commitMIDICCEvents,
    previewMIDIClipEvents,
    commitMIDIClipEvents,
    addMIDINote,
    removeMIDINotes,
    moveMIDINotes,
    setPianoRollScaleRoot,
    setPianoRollScaleType,
    transposeMIDINotes,
    scaleMIDINoteVelocity,
    reverseMIDINotes,
    invertMIDINotes,
  } = useDAWStore(
    useShallow((state) => ({
      toggleStepInput: state.toggleStepInput,
      setStepInputSize: state.setStepInputSize,
      advanceStepInput: state.advanceStepInput,
      setStepInputPosition: state.setStepInputPosition,
      updateMIDINoteVelocity: state.updateMIDINoteVelocity,
      updateMIDICCEvents: state.updateMIDICCEvents,
      commitMIDICCEvents: state.commitMIDICCEvents,
      previewMIDIClipEvents: state.previewMIDIClipEvents,
      commitMIDIClipEvents: state.commitMIDIClipEvents,
      addMIDINote: state.addMIDINote,
      removeMIDINotes: state.removeMIDINotes,
      moveMIDINotes: state.moveMIDINotes,
      setPianoRollScaleRoot: state.setPianoRollScaleRoot,
      setPianoRollScaleType: state.setPianoRollScaleType,
      transposeMIDINotes: state.transposeMIDINotes,
      scaleMIDINoteVelocity: state.scaleMIDINoteVelocity,
      reverseMIDINotes: state.reverseMIDINotes,
      invertMIDINotes: state.invertMIDINotes,
    })),
  );

  const clip = track?.midiClips.find((candidate) => candidate.id === clipId);
  const clipEvents = clip?.events;
  const clipCCEvents = clip?.ccEvents;
  const clipDuration = clip?.duration ?? 0;
  const clipStartTime = clip?.startTime ?? 0;
  const beatsPerSecond = tempo / 60;
  const pixelsPerSecond = zoom * beatsPerSecond;
  const stepDurationSeconds = stepInputSize / beatsPerSecond;
  const snapDuration = GRID_SNAP / beatsPerSecond;
  const bottomLanesHeight = VELOCITY_LANE_HEIGHT + CC_LANE_HEIGHT + LANE_DIVIDER_HEIGHT * 2;
  const stageHeight = Math.max(0, dimensions.height - toolbarHeight - HORIZONTAL_SCROLLBAR_HEIGHT);
  const noteGridHeight = Math.max(NOTE_HEIGHT * 4, stageHeight - bottomLanesHeight);
  const velocityLaneY = noteGridHeight;
  const ccLaneY = velocityLaneY + VELOCITY_LANE_HEIGHT + LANE_DIVIDER_HEIGHT;
  const visibleGridWidth = Math.max(1, dimensions.width - PIANO_WIDTH);

  const notePairs = useMemo(() => parseNotePairs(clipEvents), [clipEvents]);
  const additionalClips = useMemo(() => {
    if (!track || additionalClipIds.length === 0) return [];
    return additionalClipIds
      .map((id) => track.midiClips.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null);
  }, [track, additionalClipIds]);

  const additionalClipNotePairs: MultiClipNotePair[] = useMemo(() => {
    const allPairs: MultiClipNotePair[] = [];
    additionalClips.forEach((additionalClip, clipIndex) => {
      const timeOffset = additionalClip.startTime - clipStartTime;
      parseNotePairs(additionalClip.events).forEach((pair) => {
        allPairs.push({
          ...pair,
          startTime: pair.startTime + timeOffset,
          clipId: additionalClip.id,
          clipIndex: clipIndex + 1,
          timeOffset,
        });
      });
    });
    return allPairs;
  }, [additionalClips, clipStartTime]);

  const ccEventsForLane: MIDICCEvent[] = useMemo(() => {
    if (!clipCCEvents) return [];
    return clipCCEvents.filter((event) => event.cc === selectedCC);
  }, [clipCCEvents, selectedCC]);

  const contentDuration = useMemo(() => {
    const noteEnd = notePairs.reduce((max, pair) => Math.max(max, pair.startTime + pair.duration), 0);
    const ccEnd = (clipCCEvents || []).reduce((max, event) => Math.max(max, event.time), 0);
    const drawEnd = drawingState ? Math.max(drawingState.startTime, drawingState.endTime) : 0;
    return Math.max(clipDuration, noteEnd, ccEnd, drawEnd, stepInputPosition + stepDurationSeconds, 1);
  }, [clipDuration, notePairs, clipCCEvents, drawingState, stepInputPosition, stepDurationSeconds]);

  const contentWidth = Math.max(visibleGridWidth, contentDuration * pixelsPerSecond);
  const maxScrollX = Math.max(0, contentWidth - visibleGridWidth);
  const maxScrollY = Math.max(0, TOTAL_NOTES * NOTE_HEIGHT - noteGridHeight);

  const stopAudition = useCallback(() => {
    const current = auditionRef.current;
    if (current.timeoutId !== null) {
      window.clearTimeout(current.timeoutId);
      current.timeoutId = null;
    }
    if (current.note !== null) {
      void nativeBridge.sendMidiNote(trackId, current.note, 0, false).catch(() => undefined);
      current.note = null;
    }
  }, [trackId]);

  const auditionNote = useCallback((note: number, velocity = 90, options?: { throttle?: boolean; durationMs?: number }) => {
    const now = performance.now();
    if (options?.throttle && now - auditionRef.current.lastAt < AUDITION_THROTTLE_MS) return;
    auditionRef.current.lastAt = now;
    stopAudition();
    const safeNote = clamp(Math.round(note), 0, 127);
    const safeVelocity = clamp(Math.round(velocity), 1, 127);
    auditionRef.current.note = safeNote;
    void nativeBridge.sendMidiNote(trackId, safeNote, safeVelocity, true).catch(() => undefined);
    auditionRef.current.timeoutId = window.setTimeout(() => {
      stopAudition();
    }, options?.durationMs ?? AUDITION_DURATION_MS);
  }, [stopAudition, trackId]);

  const getNoteY = useCallback((noteNumber: number) => {
    return (TOTAL_NOTES - 1 - noteNumber) * NOTE_HEIGHT - scrollY;
  }, [scrollY]);

  const getNoteFromY = useCallback((y: number): number => {
    return clamp(TOTAL_NOTES - 1 - Math.floor((y + scrollY) / NOTE_HEIGHT), 0, 127);
  }, [scrollY]);

  const snapTime = useCallback((time: number): number => {
    return Math.max(0, Math.round(time / snapDuration) * snapDuration);
  }, [snapDuration]);

  const getTimeFromX = useCallback((x: number) => {
    return Math.max(0, (x - PIANO_WIDTH + scrollX) / pixelsPerSecond);
  }, [pixelsPerSecond, scrollX]);

  const getPointer = (event: KonvaEvent) => {
    const stage = event.target.getStage();
    return stage?.getPointerPosition() ?? null;
  };

  const getLatestClipEvents = useCallback(() => {
    const latestTrack = useDAWStore.getState().tracks.find((candidate) => candidate.id === trackId);
    const latestClip = latestTrack?.midiClips.find((candidate) => candidate.id === clipId);
    return latestClip?.events ? latestClip.events.map((event) => ({ ...event })) : [];
  }, [trackId, clipId]);

  const getLatestCCEvents = useCallback(() => {
    const latestTrack = useDAWStore.getState().tracks.find((candidate) => candidate.id === trackId);
    const latestClip = latestTrack?.midiClips.find((candidate) => candidate.id === clipId);
    return latestClip?.ccEvents ? latestClip.ccEvents.map((event) => ({ ...event })) : [];
  }, [trackId, clipId]);

  useEffect(() => {
    const updateDimensions = () => {
      if (!containerRef.current) return;
      setDimensions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      setToolbarHeight(toolbarRef.current?.offsetHeight || TOOLBAR_HEIGHT);
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateDimensions)
      : null;
    if (toolbarRef.current && resizeObserver) {
      resizeObserver.observe(toolbarRef.current);
    }
    return () => {
      window.removeEventListener("resize", updateDimensions);
      resizeObserver?.disconnect();
    };
  }, []);

  useEffect(() => {
    setScrollX((previous) => clamp(previous, 0, maxScrollX));
  }, [maxScrollX]);

  useEffect(() => {
    setScrollY((previous) => clamp(previous, 0, maxScrollY));
  }, [maxScrollY]);

  useEffect(() => {
    const scrollbar = scrollbarRef.current;
    if (scrollbar && Math.abs(scrollbar.scrollLeft - scrollX) > 1) {
      scrollbar.scrollLeft = scrollX;
    }
  }, [scrollX]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        event.stopPropagation();
        const rect = container.getBoundingClientRect();
        const cursorGridX = clamp(event.clientX - rect.left - PIANO_WIDTH, 0, visibleGridWidth);
        const timeAtCursor = (cursorGridX + scrollX) / pixelsPerSecond;
        const nextZoom = clamp(
          zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
          MIN_ZOOM,
          MAX_ZOOM,
        );
        const nextPixelsPerSecond = nextZoom * beatsPerSecond;
        const nextContentWidth = Math.max(visibleGridWidth, contentDuration * nextPixelsPerSecond);
        const nextMaxScrollX = Math.max(0, nextContentWidth - visibleGridWidth);

        setZoom(nextZoom);
        setScrollX(clamp(timeAtCursor * nextPixelsPerSecond - cursorGridX, 0, nextMaxScrollX));
        return;
      }

      const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
      if (horizontalIntent) {
        const delta = event.deltaX + (event.shiftKey ? event.deltaY : 0);
        setScrollX((previous) => clamp(previous + delta, 0, maxScrollX));
      } else {
        setScrollY((previous) => clamp(previous + event.deltaY, 0, maxScrollY));
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [beatsPerSecond, contentDuration, maxScrollX, maxScrollY, pixelsPerSecond, scrollX, visibleGridWidth, zoom]);

  useEffect(() => {
    if (!showTransformMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (transformMenuRef.current && !transformMenuRef.current.contains(event.target as Node)) {
        setShowTransformMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTransformMenu]);

  useEffect(() => {
    return () => {
      stopAudition();
    };
  }, [stopAudition]);

  useEffect(() => {
    const handleBlur = () => stopAudition();
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [stopAudition]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;

      const key = event.key.toLowerCase();
      const isStepInputNoteKey =
        stepInputEnabled
        && selectedNoteIds.length === 0
        && KEY_TO_NOTE[key] !== undefined;
      if (isStepInputNoteKey) return;

      if (key === "d") {
        event.preventDefault();
        setTool("draw");
        return;
      }
      if (key === "v") {
        event.preventDefault();
        setTool("select");
        return;
      }
      if (key === "e") {
        event.preventDefault();
        setTool("erase");
        return;
      }

      if ((key === "delete" || key === "backspace") && selectedNoteIds.length > 0) {
        event.preventDefault();
        removeMIDINotes(trackId, clipId, selectedNoteIds);
        setSelectedNoteIds([]);
        stopAudition();
        return;
      }

      if (selectedNoteIds.length > 0 && key.startsWith("arrow")) {
        event.preventDefault();
        const timeStep = event.shiftKey ? stepDurationSeconds : snapDuration;
        let deltaTime = 0;
        let deltaNote = 0;
        if (key === "arrowleft") deltaTime = -timeStep;
        if (key === "arrowright") deltaTime = timeStep;
        if (key === "arrowup") deltaNote = event.shiftKey ? 12 : 1;
        if (key === "arrowdown") deltaNote = event.shiftKey ? -12 : -1;
        const nextIds = moveMIDINotes(trackId, clipId, selectedNoteIds, deltaTime, deltaNote);
        if (nextIds.length > 0) {
          setSelectedNoteIds(nextIds);
          const nextPair = parseNotePairs(getLatestClipEvents()).find((pair) =>
            nextIds.includes(noteIdFor(clipId, pair.startTime, pair.noteNumber)),
          );
          if (nextPair) auditionNote(nextPair.noteNumber, nextPair.velocity);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    auditionNote,
    clipId,
    getLatestClipEvents,
    moveMIDINotes,
    removeMIDINotes,
    selectedNoteIds,
    snapDuration,
    stepDurationSeconds,
    stepInputEnabled,
    stopAudition,
    trackId,
  ]);

  useEffect(() => {
    if (!stepInputEnabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (selectedNoteIds.length > 0) return;

      const key = event.key.toLowerCase();
      if (key === "arrowup") {
        event.preventDefault();
        setStepInputOctave((previous) => Math.min(8, previous + 1));
        return;
      }
      if (key === "arrowdown") {
        event.preventDefault();
        setStepInputOctave((previous) => Math.max(-2, previous - 1));
        return;
      }
      if (key === "arrowleft") {
        event.preventDefault();
        setStepInputPosition(Math.max(0, stepInputPosition - stepDurationSeconds));
        setScrollX((previous) => clamp(previous - stepDurationSeconds * pixelsPerSecond, 0, maxScrollX));
        return;
      }
      if (key === "arrowright") {
        event.preventDefault();
        advanceStepInput();
        setScrollX((previous) => clamp(previous + stepDurationSeconds * pixelsPerSecond, 0, maxScrollX));
        return;
      }

      const semitone = KEY_TO_NOTE[key];
      if (semitone === undefined) return;
      event.preventDefault();
      const noteNumber = (stepInputOctave + 2) * 12 + semitone + (event.shiftKey ? 1 : 0);
      if (noteNumber < 0 || noteNumber > 127) return;

      const newId = addMIDINote(trackId, clipId, stepInputPosition, noteNumber, stepDurationSeconds, 80);
      setSelectedNoteIds(newId ? [newId] : []);
      auditionNote(noteNumber, 80);
      advanceStepInput();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    addMIDINote,
    advanceStepInput,
    auditionNote,
    clipId,
    maxScrollX,
    pixelsPerSecond,
    selectedNoteIds.length,
    setStepInputPosition,
    stepDurationSeconds,
    stepInputEnabled,
    stepInputOctave,
    stepInputPosition,
    trackId,
  ]);

  const handleScrollbarScroll = useCallback(() => {
    const scrollbar = scrollbarRef.current;
    if (!scrollbar) return;
    setScrollX(clamp(scrollbar.scrollLeft, 0, maxScrollX));
  }, [maxScrollX]);

  const getVelocityFromLaneY = useCallback((y: number) => {
    const relY = clamp(y - velocityLaneY, 0, VELOCITY_LANE_HEIGHT);
    return clamp(Math.round(127 * (1 - relY / VELOCITY_LANE_HEIGHT)), 1, 127);
  }, [velocityLaneY]);

  const upsertCCEvent = useCallback((eventX: number, eventY: number, existingEvents: MIDICCEvent[]) => {
    const time = Math.min(clipDuration, snapTime(getTimeFromX(eventX)));
    const relY = clamp(eventY - ccLaneY, 0, CC_LANE_HEIGHT);
    const value = clamp(Math.round(127 * (1 - relY / CC_LANE_HEIGHT)), 0, 127);
    const filtered = existingEvents.filter(
      (event) => !(event.cc === selectedCC && Math.abs(event.time - time) < snapDuration * 0.5),
    );
    return [...filtered, { cc: selectedCC, time, value }].sort((a, b) => a.time - b.time);
  }, [ccLaneY, clipDuration, getTimeFromX, selectedCC, snapDuration, snapTime]);

  const handleVelocityMouseDown = useCallback((event: KonvaEvent) => {
    const pos = getPointer(event);
    if (!pos || pos.y < velocityLaneY || pos.y >= velocityLaneY + VELOCITY_LANE_HEIGHT) return;

    const pair = notePairs.find((candidate) => {
      const barX = PIANO_WIDTH + candidate.startTime * pixelsPerSecond - scrollX;
      const barWidth = Math.max(4, candidate.duration * pixelsPerSecond);
      return pos.x >= barX && pos.x <= barX + barWidth;
    });
    if (!pair) return;

    const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
    const velocity = getVelocityFromLaneY(pos.y);
    setSelectedNoteIds([id]);
    setVelocityEdit({
      noteId: id,
      timestamp: pair.startTime,
      noteNumber: pair.noteNumber,
      originalEvents: getLatestClipEvents(),
    });
    updateMIDINoteVelocity(trackId, clipId, pair.startTime, pair.noteNumber, velocity, { transient: true });
    auditionNote(pair.noteNumber, velocity, { throttle: true });
  }, [
    auditionNote,
    clipId,
    getLatestClipEvents,
    getVelocityFromLaneY,
    notePairs,
    pixelsPerSecond,
    scrollX,
    trackId,
    updateMIDINoteVelocity,
    velocityLaneY,
  ]);

  const handleCCMouseDown = useCallback((event: KonvaEvent) => {
    const pos = getPointer(event);
    if (!pos || pos.y < ccLaneY || pos.y >= ccLaneY + CC_LANE_HEIGHT) return;
    const originalCCEvents = getLatestCCEvents();
    const newEvents = upsertCCEvent(pos.x, pos.y, originalCCEvents);
    setCCDrawState({ originalCCEvents });
    updateMIDICCEvents(trackId, clipId, newEvents, { transient: true });
  }, [ccLaneY, clipId, getLatestCCEvents, trackId, updateMIDICCEvents, upsertCCEvent]);

  const updateDragPreview = useCallback((event: KonvaEvent) => {
    if (!dragState) return;
    const pos = getPointer(event);
    if (!pos) return;

    const pointerTime = snapTime(getTimeFromX(pos.x));
    const pointerNote = getNoteFromY(pos.y);
    const deltaTime = pointerTime - dragState.startPointerTime;
    const deltaNote = pointerNote - dragState.startPointerNote;
    const clipLimit = Math.max(0.01, clipDuration);

    const { events: nextEvents, nextIds, auditionPair } = transformSelectedEvents(
      dragState.originalEvents,
      clipId,
      dragState.noteIds,
      (pair) => {
        if (dragState.mode === "move") {
          const maxStart = Math.max(0, clipLimit - pair.duration);
          return {
            ...pair,
            startTime: clamp(pair.startTime + deltaTime, 0, maxStart),
            noteNumber: clamp(pair.noteNumber + deltaNote, 0, 127),
          };
        }

        if (dragState.mode === "resize-start") {
          const oldEnd = pair.startTime + pair.duration;
          const nextStart = clamp(pointerTime, 0, oldEnd - snapDuration);
          return {
            ...pair,
            startTime: nextStart,
            duration: oldEnd - nextStart,
          };
        }

        const nextEnd = clamp(pointerTime, pair.startTime + snapDuration, clipLimit);
        return {
          ...pair,
          duration: nextEnd - pair.startTime,
        };
      },
    );

    previewMIDIClipEvents(trackId, clipId, nextEvents);
    if (nextIds.length > 0) setSelectedNoteIds(nextIds);
    if (auditionPair) {
      latestDragAuditionRef.current = {
        noteNumber: auditionPair.noteNumber,
        velocity: auditionPair.velocity,
      };
      auditionNote(auditionPair.noteNumber, auditionPair.velocity, { throttle: true, durationMs: 120 });
    }
  }, [
    auditionNote,
    clipDuration,
    clipId,
    dragState,
    getNoteFromY,
    getTimeFromX,
    previewMIDIClipEvents,
    snapDuration,
    snapTime,
    trackId,
  ]);

  const handleNoteMouseDown = useCallback((event: KonvaEvent, pair: NotePair) => {
    event.cancelBubble = true;
    const nativeEvent = event.evt as MouseEvent;
    const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);

    if (tool === "erase") {
      removeMIDINotes(trackId, clipId, [id]);
      setSelectedNoteIds((previous) => previous.filter((noteId) => noteId !== id));
      stopAudition();
      return;
    }

    const modifier = nativeEvent.ctrlKey || nativeEvent.metaKey || nativeEvent.shiftKey;
    let nextSelection = selectedNoteIds;
    if (modifier) {
      nextSelection = selectedNoteIds.includes(id)
        ? selectedNoteIds.filter((noteId) => noteId !== id)
        : [...selectedNoteIds, id];
    } else if (!selectedNoteIds.includes(id)) {
      nextSelection = [id];
    }

    setSelectedNoteIds(nextSelection);
    auditionNote(pair.noteNumber, pair.velocity);

    if (tool !== "select" || !nextSelection.includes(id)) return;

    const pos = getPointer(event);
    if (!pos) return;
    const noteX = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
    const noteWidth = Math.max(4, pair.duration * pixelsPerSecond);
    const relX = pos.x - noteX;
    const mode: DragMode =
      relX <= NOTE_EDGE_HIT_WIDTH
        ? "resize-start"
        : noteWidth - relX <= NOTE_EDGE_HIT_WIDTH
          ? "resize-end"
          : "move";

    setDragState({
      mode,
      noteIds: mode === "move" ? nextSelection : [id],
      originalEvents: getLatestClipEvents(),
      startPointerTime: snapTime(getTimeFromX(pos.x)),
      startPointerNote: pair.noteNumber,
      activeNoteId: id,
    });
    latestDragAuditionRef.current = {
      noteNumber: pair.noteNumber,
      velocity: pair.velocity,
    };
  }, [
    auditionNote,
    clipId,
    getLatestClipEvents,
    getTimeFromX,
    pixelsPerSecond,
    removeMIDINotes,
    scrollX,
    selectedNoteIds,
    snapTime,
    stopAudition,
    tool,
    trackId,
  ]);

  const handleStageMouseDown = useCallback((event: KonvaEvent) => {
    const pos = getPointer(event);
    if (!pos) return;

    if (pos.y >= ccLaneY && pos.y < ccLaneY + CC_LANE_HEIGHT) {
      handleCCMouseDown(event);
      return;
    }
    if (pos.y >= velocityLaneY && pos.y < velocityLaneY + VELOCITY_LANE_HEIGHT) {
      handleVelocityMouseDown(event);
      return;
    }
    if (pos.x < PIANO_WIDTH || pos.y >= noteGridHeight) return;

    const time = Math.min(clipDuration, snapTime(getTimeFromX(pos.x)));
    const note = getNoteFromY(pos.y);

    if (tool === "draw") {
      setSelectedNoteIds([]);
      setDrawingState({
        startTime: time,
        endTime: Math.min(clipDuration, time + snapDuration),
        noteNumber: note,
        velocity: 80,
      });
      return;
    }

    if (tool === "select") {
      setSelectedNoteIds([]);
    }
  }, [
    ccLaneY,
    clipDuration,
    getNoteFromY,
    getTimeFromX,
    handleCCMouseDown,
    handleVelocityMouseDown,
    noteGridHeight,
    snapDuration,
    snapTime,
    tool,
    velocityLaneY,
  ]);

  const handleStageMouseMove = useCallback((event: KonvaEvent) => {
    const pos = getPointer(event);
    if (!pos) return;

    if (dragState) {
      updateDragPreview(event);
      return;
    }

    if (drawingState) {
      setDrawingState((current) => {
        if (!current) return null;
        return {
          ...current,
          endTime: Math.min(clipDuration, Math.max(0, snapTime(getTimeFromX(pos.x)))),
          noteNumber: getNoteFromY(pos.y),
        };
      });
      return;
    }

    if (velocityEdit) {
      const velocity = getVelocityFromLaneY(pos.y);
      updateMIDINoteVelocity(trackId, clipId, velocityEdit.timestamp, velocityEdit.noteNumber, velocity, { transient: true });
      auditionNote(velocityEdit.noteNumber, velocity, { throttle: true, durationMs: 120 });
      return;
    }

    if (ccDrawState) {
      const currentEvents = getLatestCCEvents();
      const nextEvents = upsertCCEvent(pos.x, pos.y, currentEvents);
      updateMIDICCEvents(trackId, clipId, nextEvents, { transient: true });
    }
  }, [
    auditionNote,
    ccDrawState,
    clipDuration,
    clipId,
    dragState,
    drawingState,
    getLatestCCEvents,
    getNoteFromY,
    getTimeFromX,
    getVelocityFromLaneY,
    snapTime,
    trackId,
    updateDragPreview,
    updateMIDICCEvents,
    updateMIDINoteVelocity,
    upsertCCEvent,
    velocityEdit,
  ]);

  const handleStageMouseUp = useCallback(() => {
    const hadEdit = dragState || drawingState || velocityEdit || ccDrawState;
    if (hadEdit) stopAudition();

    if (dragState) {
      const finalEvents = getLatestClipEvents();
      const description = dragState.mode === "move"
        ? "Move MIDI notes"
        : "Resize MIDI note";
      commitMIDIClipEvents(trackId, clipId, dragState.originalEvents, finalEvents, description);
      const preview = latestDragAuditionRef.current;
      if (preview) auditionNote(preview.noteNumber, preview.velocity, { durationMs: 140 });
      latestDragAuditionRef.current = null;
      setDragState(null);
    }

    if (drawingState) {
      const start = Math.min(drawingState.startTime, drawingState.endTime);
      const end = Math.max(drawingState.startTime, drawingState.endTime);
      const duration = Math.max(snapDuration, end - start || snapDuration);
      const newId = addMIDINote(trackId, clipId, start, drawingState.noteNumber, Math.min(duration, clipDuration - start), drawingState.velocity);
      setSelectedNoteIds(newId ? [newId] : []);
      auditionNote(drawingState.noteNumber, drawingState.velocity);
      setDrawingState(null);
    }

    if (velocityEdit) {
      const finalPair = parseNotePairs(getLatestClipEvents()).find((pair) =>
        noteIdFor(clipId, pair.startTime, pair.noteNumber) === velocityEdit.noteId
        || (Math.abs(pair.startTime - velocityEdit.timestamp) < 0.001 && pair.noteNumber === velocityEdit.noteNumber),
      );
      commitMIDIClipEvents(trackId, clipId, velocityEdit.originalEvents, getLatestClipEvents(), "Edit MIDI velocity");
      if (finalPair) auditionNote(finalPair.noteNumber, finalPair.velocity, { durationMs: 140 });
      setVelocityEdit(null);
    }

    if (ccDrawState) {
      commitMIDICCEvents(trackId, clipId, ccDrawState.originalCCEvents, getLatestCCEvents(), "Draw MIDI CC");
      setCCDrawState(null);
    }
  }, [
    addMIDINote,
    auditionNote,
    ccDrawState,
    clipDuration,
    clipId,
    commitMIDICCEvents,
    commitMIDIClipEvents,
    dragState,
    drawingState,
    getLatestCCEvents,
    getLatestClipEvents,
    snapDuration,
    stopAudition,
    trackId,
    velocityEdit,
  ]);

  useEffect(() => {
    window.addEventListener("mouseup", handleStageMouseUp);
    return () => window.removeEventListener("mouseup", handleStageMouseUp);
  }, [handleStageMouseUp]);

  if (!clip || !track) {
    return <div className="piano-roll-empty">No MIDI clip selected</div>;
  }

  const renderPianoKeyboard = () => {
    const keys = [];
    const firstRow = Math.max(0, Math.floor(scrollY / NOTE_HEIGHT) - 1);
    const lastRow = Math.min(TOTAL_NOTES, Math.ceil((scrollY + noteGridHeight) / NOTE_HEIGHT) + 1);
    for (let row = firstRow; row < lastRow; row += 1) {
      const noteNumber = TOTAL_NOTES - 1 - row;
      const y = row * NOTE_HEIGHT - scrollY;
      const noteName = NOTE_NAMES[noteNumber % NOTES_PER_OCTAVE];
      const isBlackKey = noteName.includes("#");
      const isC = noteName === "C";
      keys.push(
        <Group key={`pk-${noteNumber}`}>
          <Rect
            x={0}
            y={y}
            width={PIANO_WIDTH}
            height={NOTE_HEIGHT}
            fill={isBlackKey ? "#27272a" : "#f4f4f5"}
            stroke="#0a0a0a"
            strokeWidth={0.5}
          />
          {isC && (
            <Text
              x={5}
              y={y + 2}
              text={`C${Math.floor(noteNumber / 12) - 2}`}
              fontSize={9}
              fill="#0a0a0a"
              listening={false}
            />
          )}
        </Group>,
      );
    }
    return keys;
  };

  const renderGrid = () => {
    const elements: React.ReactNode[] = [];
    const beatInterval = 1 / beatsPerSecond;
    const firstRow = Math.max(0, Math.floor(scrollY / NOTE_HEIGHT) - 1);
    const lastRow = Math.min(TOTAL_NOTES, Math.ceil((scrollY + noteGridHeight) / NOTE_HEIGHT) + 1);

    let beatIndex = 0;
    for (let time = 0; time < contentDuration; time += beatInterval) {
      const x = PIANO_WIDTH + time * pixelsPerSecond - scrollX;
      const width = beatInterval * pixelsPerSecond;
      if (x + width < PIANO_WIDTH || x > dimensions.width) {
        beatIndex += 1;
        continue;
      }
      if (beatIndex % 2 === 1) {
        elements.push(
          <Rect
            key={`beat-shade-${beatIndex}`}
            x={Math.max(PIANO_WIDTH, x)}
            y={0}
            width={Math.min(width, dimensions.width - x)}
            height={noteGridHeight}
            fill="#ffffff"
            opacity={0.035}
            listening={false}
          />,
        );
      }
      beatIndex += 1;
    }

    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = row * NOTE_HEIGHT - scrollY;
      const noteNumber = TOTAL_NOTES - 1 - row;
      const noteName = NOTE_NAMES[noteNumber >= 0 ? noteNumber % NOTES_PER_OCTAVE : 0];
      const isC = noteName === "C";
      const isBlackKey = noteName.includes("#");
      const inScale = noteNumber >= 0 && isNoteInScale(noteNumber, scaleRoot, scaleType);

      if (row < TOTAL_NOTES && scaleType !== "chromatic" && inScale) {
        elements.push(
          <Rect
            key={`scale-bg-${row}`}
            x={PIANO_WIDTH}
            y={y}
            width={contentWidth}
            height={NOTE_HEIGHT}
            fill="#4cc9f0"
            opacity={0.06}
            listening={false}
          />,
        );
      }
      if (isBlackKey && row < TOTAL_NOTES) {
        elements.push(
          <Rect
            key={`black-bg-${row}`}
            x={PIANO_WIDTH}
            y={y}
            width={contentWidth}
            height={NOTE_HEIGHT}
            fill="#000000"
            opacity={0.08}
            listening={false}
          />,
        );
      }

      elements.push(
        <Line
          key={`h-${row}`}
          points={[PIANO_WIDTH, y, dimensions.width, y]}
          stroke={isC ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.055)"}
          strokeWidth={isC ? 1 : 0.5}
          listening={false}
        />,
      );
    }

    for (let time = 0; time <= contentDuration; time += beatInterval * GRID_SNAP) {
      const x = PIANO_WIDTH + time * pixelsPerSecond - scrollX;
      if (x < PIANO_WIDTH || x > dimensions.width) continue;
      const isBeat = Math.abs(time % beatInterval) < 0.001;
      elements.push(
        <Line
          key={`v-${time.toFixed(4)}`}
          points={[x, 0, x, noteGridHeight]}
          stroke={isBeat ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.055)"}
          strokeWidth={isBeat ? 1 : 0.5}
          listening={false}
        />,
      );
    }

    return elements;
  };

  const renderGhostNotes = () => {
    const ghostElements: React.ReactNode[] = [];
    const editingClipIds = new Set([clipId, ...additionalClipIds]);
    track.midiClips
      .filter((candidate) => !editingClipIds.has(candidate.id))
      .forEach((otherClip) => {
        const timeOffset = otherClip.startTime - clipStartTime;
        parseNotePairs(otherClip.events).forEach((pair) => {
          const adjustedTime = pair.startTime + timeOffset;
          const x = PIANO_WIDTH + adjustedTime * pixelsPerSecond - scrollX;
          const y = getNoteY(pair.noteNumber);
          const width = pair.duration * pixelsPerSecond;
          if (x + width < PIANO_WIDTH || x > dimensions.width || y + NOTE_HEIGHT < 0 || y > noteGridHeight) return;
          ghostElements.push(
            <Rect
              key={`ghost-${otherClip.id}-${pair.startTime}-${pair.noteNumber}`}
              x={x}
              y={y}
              width={Math.max(3, width)}
              height={NOTE_HEIGHT - 1}
              fill="#9ca3af"
              opacity={0.2}
              cornerRadius={2}
              listening={false}
            />,
          );
        });
      });
    return ghostElements;
  };

  const renderPrimaryNotes = () => {
    return notePairs.map((pair) => {
      const id = noteIdFor(clipId, pair.startTime, pair.noteNumber);
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const y = getNoteY(pair.noteNumber);
      const width = Math.max(4, pair.duration * pixelsPerSecond);
      if (x + width < PIANO_WIDTH || x > dimensions.width || y + NOTE_HEIGHT < 0 || y > noteGridHeight) return null;

      const selected = selectedNoteIds.includes(id);
      const fillColor = velocityColor(pair.velocity);
      const strokeColor = selected ? "#ffffff" : velocityStrokeColor(pair.velocity);
      const showName = width > 40;

      return (
        <Group key={`note-${id}`} onMouseDown={(event) => handleNoteMouseDown(event, pair)}>
          <Rect
            x={x}
            y={y}
            width={width}
            height={NOTE_HEIGHT - 1}
            fill={fillColor}
            opacity={selected ? 0.98 : 0.85}
            stroke={strokeColor}
            strokeWidth={selected ? 1.5 : 1}
            cornerRadius={2}
            shadowColor={selected ? "#ffffff" : undefined}
            shadowBlur={selected ? 5 : 0}
            shadowOpacity={selected ? 0.28 : 0}
          />
          {selected && width > 14 && (
            <>
              <Rect x={x + 2} y={y + 2} width={2} height={NOTE_HEIGHT - 5} fill="#ffffff" opacity={0.9} listening={false} />
              <Rect x={x + width - 4} y={y + 2} width={2} height={NOTE_HEIGHT - 5} fill="#ffffff" opacity={0.9} listening={false} />
            </>
          )}
          {pair.pressure !== undefined && pair.pressure > 0 && (
            <Rect x={x} y={y} width={width} height={NOTE_HEIGHT - 1} fill="#ffffff" opacity={pair.pressure * 0.3} cornerRadius={2} listening={false} />
          )}
          {pair.pitchBend !== undefined && pair.pitchBend !== 0 && width > 8 && (
            <Line
              points={pair.pitchBend > 0
                ? [x + width - 6, y + NOTE_HEIGHT - 4, x + width - 3, y + 2, x + width, y + NOTE_HEIGHT - 4]
                : [x + width - 6, y + 2, x + width - 3, y + NOTE_HEIGHT - 4, x + width, y + 2]}
              fill="#ffffff"
              closed
              opacity={0.7}
              listening={false}
            />
          )}
          {pair.slide !== undefined && pair.slide > 0 && width > 8 && (
            <Line points={[x + width - 8, y + NOTE_HEIGHT - 3, x + width - 2, y + 2]} stroke="#ffffff" strokeWidth={1.5} opacity={0.6} listening={false} />
          )}
          {showName && (
            <Text
              x={x + 4}
              y={y + 1}
              text={getNoteNameFromPitch(pair.noteNumber)}
              fontSize={8}
              fill="#000000"
              opacity={0.7}
              width={width - 8}
              listening={false}
            />
          )}
        </Group>
      );
    });
  };

  const renderAdditionalClipNotes = () => {
    return additionalClipNotePairs.map((pair) => {
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const y = getNoteY(pair.noteNumber);
      const width = Math.max(4, pair.duration * pixelsPerSecond);
      if (x + width < PIANO_WIDTH || x > dimensions.width || y + NOTE_HEIGHT < 0 || y > noteGridHeight) return null;
      const tintColor = MULTI_CLIP_TINTS[pair.clipIndex % MULTI_CLIP_TINTS.length] || "#ff6b9d";
      return (
        <Group key={`mcnote-${pair.clipId}-${pair.startTime}-${pair.noteNumber}`}>
          <Rect
            x={x}
            y={y}
            width={width}
            height={NOTE_HEIGHT - 1}
            fill={tintColor}
            opacity={0.68}
            stroke={tintColor}
            strokeWidth={1}
            cornerRadius={2}
            listening={false}
          />
          {width > 40 && (
            <Text x={x + 3} y={y + 1} text={getNoteNameFromPitch(pair.noteNumber)} fontSize={8} fill="#000000" opacity={0.6} width={width - 6} listening={false} />
          )}
        </Group>
      );
    });
  };

  const renderDrawingPreview = () => {
    if (!drawingState) return null;
    const start = Math.min(drawingState.startTime, drawingState.endTime);
    const end = Math.max(drawingState.startTime, drawingState.endTime);
    const x = PIANO_WIDTH + start * pixelsPerSecond - scrollX;
    const y = getNoteY(drawingState.noteNumber);
    const width = Math.max(4, (end - start || snapDuration) * pixelsPerSecond);
    return (
      <Rect
        x={x}
        y={y}
        width={width}
        height={NOTE_HEIGHT - 1}
        fill="#ffffff"
        opacity={0.35}
        stroke="#4cc9f0"
        strokeWidth={1}
        dash={[4, 2]}
        cornerRadius={2}
        listening={false}
      />
    );
  };

  const renderStepInputCursor = () => {
    if (!stepInputEnabled) return null;
    const cursorX = PIANO_WIDTH + stepInputPosition * pixelsPerSecond - scrollX;
    if (cursorX < PIANO_WIDTH || cursorX > dimensions.width) return null;
    return (
      <Group>
        <Line points={[cursorX, 0, cursorX, noteGridHeight]} stroke="#ff4444" strokeWidth={2} opacity={0.9} dash={[6, 3]} listening={false} />
        <Line points={[cursorX - 5, 0, cursorX + 5, 0, cursorX, 8]} fill="#ff4444" closed listening={false} />
      </Group>
    );
  };

  const renderVelocityLane = () => {
    const elements: React.ReactNode[] = [
      <Rect key="vel-bg" x={0} y={velocityLaneY} width={dimensions.width} height={VELOCITY_LANE_HEIGHT} fill="#161616" listening={false} />,
      <Line key="vel-divider" points={[0, velocityLaneY, dimensions.width, velocityLaneY]} stroke="rgba(255,255,255,0.15)" strokeWidth={1} listening={false} />,
      <Text key="vel-label" x={4} y={velocityLaneY + 2} text="Vel" fontSize={9} fill="#8a8a8a" listening={false} />,
    ];

    [0.25, 0.5, 0.75].forEach((frac) => {
      const y = velocityLaneY + VELOCITY_LANE_HEIGHT * (1 - frac);
      elements.push(<Line key={`vel-guide-${frac}`} points={[PIANO_WIDTH, y, dimensions.width, y]} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} listening={false} />);
    });

    notePairs.forEach((pair) => {
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const width = Math.max(4, pair.duration * pixelsPerSecond - 1);
      if (x + width < PIANO_WIDTH || x > dimensions.width) return;
      const barHeight = (pair.velocity / 127) * (VELOCITY_LANE_HEIGHT - 4);
      const y = velocityLaneY + VELOCITY_LANE_HEIGHT - barHeight - 2;
      elements.push(
        <Rect
          key={`vel-bar-${pair.startTime}-${pair.noteNumber}`}
          x={x}
          y={y}
          width={width}
          height={barHeight}
          fill={velocityColor(pair.velocity)}
          opacity={selectedNoteIds.includes(noteIdFor(clipId, pair.startTime, pair.noteNumber)) ? 1 : 0.8}
          cornerRadius={1}
        />,
      );
    });

    elements.push(<Rect key="vel-overlay" x={PIANO_WIDTH} y={velocityLaneY} width={dimensions.width - PIANO_WIDTH} height={VELOCITY_LANE_HEIGHT} fill="transparent" />);
    return elements;
  };

  const renderCCLane = () => {
    const elements: React.ReactNode[] = [];
    const ccPreset = CC_PRESETS.find((preset) => preset.cc === selectedCC);
    elements.push(
      <Rect key="cc-bg" x={0} y={ccLaneY} width={dimensions.width} height={CC_LANE_HEIGHT} fill="#141414" listening={false} />,
      <Line key="cc-divider" points={[0, ccLaneY, dimensions.width, ccLaneY]} stroke="rgba(255,255,255,0.15)" strokeWidth={1} listening={false} />,
      <Text key="cc-label" x={4} y={ccLaneY + 2} text={ccPreset?.name || `CC#${selectedCC}`} fontSize={9} fill="#8a8a8a" listening={false} />,
    );

    [0.25, 0.5, 0.75].forEach((frac) => {
      const y = ccLaneY + CC_LANE_HEIGHT * (1 - frac);
      elements.push(<Line key={`cc-guide-${frac}`} points={[PIANO_WIDTH, y, dimensions.width, y]} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} listening={false} />);
    });

    const linePoints: number[] = [];
    ccEventsForLane.forEach((event) => {
      const x = PIANO_WIDTH + event.time * pixelsPerSecond - scrollX;
      const y = ccLaneY + CC_LANE_HEIGHT * (1 - event.value / 127);
      linePoints.push(x, y);
    });
    if (linePoints.length >= 4) {
      elements.push(<Line key="cc-line" points={linePoints} stroke="#4cc9f0" strokeWidth={1.5} opacity={0.6} listening={false} />);
    }

    ccEventsForLane.forEach((event, index) => {
      const x = PIANO_WIDTH + event.time * pixelsPerSecond - scrollX;
      if (x < PIANO_WIDTH || x > dimensions.width) return;
      const barHeight = (event.value / 127) * (CC_LANE_HEIGHT - 4);
      const y = ccLaneY + CC_LANE_HEIGHT - barHeight - 2;
      elements.push(
        <Rect key={`cc-bar-${index}`} x={x - 1} y={y} width={3} height={barHeight} fill="#4cc9f0" opacity={0.5} listening={false} />,
        <Rect key={`cc-dot-${index}`} x={x - 3} y={y - 3} width={6} height={6} fill="#4cc9f0" cornerRadius={3} opacity={0.9} listening={false} />,
      );
    });

    elements.push(<Rect key="cc-overlay" x={PIANO_WIDTH} y={ccLaneY} width={dimensions.width - PIANO_WIDTH} height={CC_LANE_HEIGHT} fill="transparent" />);
    return elements;
  };

  return (
    <div className="piano-roll" ref={containerRef}>
      <div className="piano-roll-toolbar" ref={toolbarRef}>
        <Button variant="default" size="sm" active={tool === "draw"} onClick={() => setTool("draw")} title="Draw Tool (D)">
          Draw
        </Button>
        <Button variant="default" size="sm" active={tool === "select"} onClick={() => setTool("select")} title="Select Tool (V)">
          Select
        </Button>
        <Button variant="default" size="sm" active={tool === "erase"} onClick={() => setTool("erase")} title="Erase Tool (E)">
          Erase
        </Button>
        <div className="toolbar-divider" />
        <label htmlFor="pr-zoom">Zoom</label>
        <input id="pr-zoom" type="range" min={MIN_ZOOM} max={MAX_ZOOM} value={zoom} onChange={(event) => setZoom(Number.parseInt(event.target.value, 10))} className="zoom-slider" />
        <div className="toolbar-divider" />
        <label htmlFor="pr-root">Root</label>
        <select id="pr-root" className="piano-roll-select" value={scaleRoot} onChange={(event) => setPianoRollScaleRoot(Number.parseInt(event.target.value, 10))}>
          {NOTE_NAMES.map((name, index) => (
            <option key={name} value={index}>{name}</option>
          ))}
        </select>
        <label htmlFor="pr-scale">Scale</label>
        <select id="pr-scale" className="piano-roll-select" value={scaleType} onChange={(event) => setPianoRollScaleType(event.target.value)}>
          {Object.entries(SCALE_DISPLAY_NAMES).map(([key, displayLabel]) => (
            <option key={key} value={key}>{displayLabel}</option>
          ))}
        </select>
        <div className="toolbar-divider" />
        <label htmlFor="pr-cc">CC</label>
        <select id="pr-cc" className="piano-roll-select" value={selectedCC} onChange={(event) => setSelectedCC(Number.parseInt(event.target.value, 10))}>
          {CC_PRESETS.map((preset) => (
            <option key={preset.cc} value={preset.cc}>{preset.name}</option>
          ))}
        </select>
        <div className="toolbar-divider" />
        <div ref={transformMenuRef} style={{ position: "relative", display: "inline-block" }}>
          <Button variant="default" size="sm" onClick={() => setShowTransformMenu((value) => !value)} title="MIDI Transform">
            Transform
          </Button>
          {showTransformMenu && (
            <div className="piano-roll-transform-menu">
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, 1); setShowTransformMenu(false); }}>Transpose Up (+1)</button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, -1); setShowTransformMenu(false); }}>Transpose Down (-1)</button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, 12); setShowTransformMenu(false); }}>Transpose Octave Up (+12)</button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, -12); setShowTransformMenu(false); }}>Transpose Octave Down (-12)</button>
              <div className="piano-roll-transform-separator" />
              <button className="piano-roll-transform-item" onClick={() => { scaleMIDINoteVelocity(clipId, 1.1); setShowTransformMenu(false); }}>Velocity +10%</button>
              <button className="piano-roll-transform-item" onClick={() => { scaleMIDINoteVelocity(clipId, 0.9); setShowTransformMenu(false); }}>Velocity -10%</button>
              <div className="piano-roll-transform-separator" />
              <button className="piano-roll-transform-item" onClick={() => { reverseMIDINotes(clipId); setShowTransformMenu(false); }}>Reverse</button>
              <button className="piano-roll-transform-item" onClick={() => { invertMIDINotes(clipId); setShowTransformMenu(false); }}>Invert</button>
            </div>
          )}
        </div>
        <div className="toolbar-divider" />
        <Button variant={stepInputEnabled ? "primary" : "default"} size="sm" active={stepInputEnabled} onClick={toggleStepInput} title="Step Input Mode - type C-B to enter notes">
          Step
        </Button>
        {stepInputEnabled && (
          <>
            <label htmlFor="pr-step-size">Size</label>
            <select id="pr-step-size" className="piano-roll-select" value={stepInputSize} onChange={(event) => setStepInputSize(Number.parseFloat(event.target.value))}>
              {STEP_SIZE_OPTIONS.map((option) => (
                <option key={option.label} value={option.beats}>{option.label}</option>
              ))}
            </select>
            <span className="piano-roll-step-octave">Oct: {stepInputOctave}</span>
          </>
        )}
        {additionalClips.length > 0 && (
          <>
            <div className="toolbar-divider" />
            <span className="piano-roll-multi-clip">Editing {additionalClips.length + 1} clips</span>
          </>
        )}
      </div>

      <Stage
        width={dimensions.width}
        height={stageHeight}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        pixelRatio={window.devicePixelRatio || 1}
      >
        <Layer>
          <Rect x={0} y={0} width={dimensions.width} height={stageHeight} fill="#1a1a1a" />
          {renderGrid()}
          {renderPianoKeyboard()}
          {renderGhostNotes()}
          {renderAdditionalClipNotes()}
          {renderPrimaryNotes()}
          {renderDrawingPreview()}
          {renderStepInputCursor()}
          {renderVelocityLane()}
          {renderCCLane()}
        </Layer>
      </Stage>

      <div className="piano-roll-horizontal-scroll" ref={scrollbarRef} onScroll={handleScrollbarScroll}>
        <div style={{ width: PIANO_WIDTH + contentWidth, height: 1 }} />
      </div>
    </div>
  );
}
