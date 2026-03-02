import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Stage, Layer, Rect, Line, Text, Group } from "react-konva";
import { useDAWStore, MIDIEvent, MIDICCEvent } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./ui";
import "./PianoRoll.css";

interface PianoRollProps {
  readonly clipId: string;
  readonly trackId: string;
  /** Additional MIDI clip IDs to show simultaneously (multi-clip editing) */
  readonly additionalClipIds?: string[];
}

// Per-clip color tints for multi-clip editing (hue shifts)
const MULTI_CLIP_TINTS = [
  null,          // Primary clip: use default velocity colors
  "#ff6b9d",     // Pink
  "#51cf66",     // Green
  "#ffd43b",     // Yellow
  "#748ffc",     // Indigo
  "#f06595",     // Hot pink
  "#20c997",     // Teal
  "#ff922b",     // Orange
];

// Step size options for step input mode
const STEP_SIZE_OPTIONS = [
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32", beats: 0.125 },
];

// Key-to-note mapping for step input (C major by default, octave set separately)
const KEY_TO_NOTE: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
};

const NOTES_PER_OCTAVE = 12;
const TOTAL_NOTES = 128; // MIDI range 0-127
const NOTE_HEIGHT = 12;
const PIANO_WIDTH = 60;
const GRID_SNAP = 0.25; // 1/16 note

// Lane heights
const VELOCITY_LANE_HEIGHT = 60;
const CC_LANE_HEIGHT = 80;
const LANE_DIVIDER_HEIGHT = 1;
const TOOLBAR_HEIGHT = 40;

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

// ============================================
// Scale Definitions
// ============================================
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

// CC lane presets
const CC_PRESETS = [
  { cc: 1, name: "CC#1 Modulation" },
  { cc: 7, name: "CC#7 Volume" },
  { cc: 10, name: "CC#10 Pan" },
  { cc: 11, name: "CC#11 Expression" },
  { cc: 64, name: "CC#64 Sustain" },
];

/** Convert MIDI pitch number to note name string, e.g. 60 -> "C4" */
function getNoteNameFromPitch(pitch: number): string {
  const noteName = NOTE_NAMES[pitch % NOTES_PER_OCTAVE];
  const octave = Math.floor(pitch / 12) - 2;
  return `${noteName}${octave}`;
}

/** Velocity-based color: blue (quiet) -> cyan -> yellow -> red (loud) */
function velocityColor(velocity: number): string {
  const v = Math.max(0, Math.min(127, velocity));
  const t = v / 127; // 0..1
  let r: number, g: number, b: number;
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

/** Velocity-based stroke color (slightly darker version) */
function velocityStrokeColor(velocity: number): string {
  const v = Math.max(0, Math.min(127, velocity));
  const t = v / 127;
  if (t < 0.5) return "#3b82f6";
  if (t < 0.75) return "#22c55e";
  return "#ef4444";
}

/** Check if a MIDI note number is in the given scale */
function isNoteInScale(noteNumber: number, scaleRoot: number, scaleType: string): boolean {
  if (scaleType === "chromatic") return true;
  const intervals = SCALE_DEFINITIONS[scaleType];
  if (!intervals) return true;
  const degree = ((noteNumber % 12) - scaleRoot + 12) % 12;
  return intervals.includes(degree);
}

// ============================================
// Parsed note pair: noteOn + noteOff matched
// ============================================
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

/** Extended note pair with clip ownership info for multi-clip editing */
interface MultiClipNotePair extends NotePair {
  clipId: string;
  clipIndex: number; // 1-based index into additionalClips (0 = primary)
  timeOffset: number; // time offset relative to primary clip
}

export function PianoRoll({ clipId, trackId, additionalClipIds = [] }: PianoRollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [tool, setTool] = useState<"draw" | "select" | "erase">("draw");
  const [zoom, setZoom] = useState(100); // pixels per beat
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(TOTAL_NOTES * NOTE_HEIGHT / 2 - 300);

  // Step input: octave for keyboard input
  const [stepInputOctave, setStepInputOctave] = useState(4); // C4 = middle C

  // Velocity editing state
  const [velocityEditingNote, setVelocityEditingNote] = useState<{ timestamp: number; note: number } | null>(null);

  // CC lane state
  const [selectedCC, setSelectedCC] = useState(1); // CC#1 Modulation by default
  const [ccDrawing, setCCDrawing] = useState(false);

  // Store selectors — consolidated into useShallow to prevent unnecessary re-renders
  const {
    track, tempo, scaleRoot, scaleType,
    stepInputEnabled, stepInputSize, stepInputPosition,
  } = useDAWStore(
    useShallow((state) => ({
      track: state.tracks.find((t) => t.id === trackId),
      tempo: state.transport.tempo,
      scaleRoot: state.pianoRollScaleRoot,
      scaleType: state.pianoRollScaleType,
      stepInputEnabled: state.stepInputEnabled,
      stepInputSize: state.stepInputSize,
      stepInputPosition: state.stepInputPosition,
    })),
  );

  // Step input actions
  const toggleStepInput = useDAWStore((s) => s.toggleStepInput);
  const setStepInputSize = useDAWStore((s) => s.setStepInputSize);
  const advanceStepInput = useDAWStore((s) => s.advanceStepInput);
  const setStepInputPosition = useDAWStore((s) => s.setStepInputPosition);

  const clip = track?.midiClips.find((c) => c.id === clipId);
  const clipEvents = clip?.events;
  const clipCCEvents = clip?.ccEvents;
  const clipDuration = clip?.duration ?? 0;
  const clipStartTime = clip?.startTime ?? 0;

  // Multi-clip editing: gather additional clips from the same track
  const additionalClips = useMemo(() => {
    if (!track || additionalClipIds.length === 0) return [];
    return additionalClipIds
      .map((id) => track.midiClips.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => c != null);
  }, [track, additionalClipIds]);

  // Transform dropdown state
  const [showTransformMenu, setShowTransformMenu] = useState(false);
  const transformMenuRef = useRef<HTMLDivElement>(null);

  // Close transform menu on outside click
  useEffect(() => {
    if (!showTransformMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (transformMenuRef.current && !transformMenuRef.current.contains(e.target as Node)) {
        setShowTransformMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTransformMenu]);

  // Store actions — consolidated into useShallow to reduce subscription overhead
  const {
    updateMIDINoteVelocity,
    updateMIDICCEvents,
    setPianoRollScaleRoot,
    setPianoRollScaleType,
    transposeMIDINotes,
    scaleMIDINoteVelocity,
    reverseMIDINotes,
    invertMIDINotes,
  } = useDAWStore(
    useShallow((s) => ({
      updateMIDINoteVelocity: s.updateMIDINoteVelocity,
      updateMIDICCEvents: s.updateMIDICCEvents,
      setPianoRollScaleRoot: s.setPianoRollScaleRoot,
      setPianoRollScaleType: s.setPianoRollScaleType,
      transposeMIDINotes: s.transposeMIDINotes,
      scaleMIDINoteVelocity: s.scaleMIDINoteVelocity,
      reverseMIDINotes: s.reverseMIDINotes,
      invertMIDINotes: s.invertMIDINotes,
    })),
  );

  // Derived values (computed before hooks that depend on them)
  const beatsPerSecond = tempo / 60;
  const pixelsPerSecond = zoom * beatsPerSecond;
  const bottomLanesHeight = VELOCITY_LANE_HEIGHT + LANE_DIVIDER_HEIGHT + CC_LANE_HEIGHT + LANE_DIVIDER_HEIGHT;
  const stageHeight = dimensions.height - TOOLBAR_HEIGHT;
  const noteGridHeight = stageHeight - bottomLanesHeight;
  const velocityLaneY = noteGridHeight;
  const ccLaneY = velocityLaneY + VELOCITY_LANE_HEIGHT + LANE_DIVIDER_HEIGHT;

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, []);

  // Handle wheel scrolling
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        setScrollX((prev) => Math.max(0, prev + e.deltaY));
      } else {
        const maxScrollY = TOTAL_NOTES * NOTE_HEIGHT - (dimensions.height - TOOLBAR_HEIGHT);
        setScrollY((prev) => Math.max(0, Math.min(maxScrollY, prev + e.deltaY)));
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [dimensions.height]);

  // Step input keyboard handler
  useEffect(() => {
    if (!stepInputEnabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in inputs/selects
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      const key = e.key.toLowerCase();

      // Octave shift with up/down arrows
      if (key === "arrowup") {
        e.preventDefault();
        setStepInputOctave((prev) => Math.min(8, prev + 1));
        return;
      }
      if (key === "arrowdown") {
        e.preventDefault();
        setStepInputOctave((prev) => Math.max(-2, prev - 1));
        return;
      }

      // Left/Right arrows to manually move step cursor
      if (key === "arrowleft") {
        e.preventDefault();
        const bps = tempo / 60;
        const stepSeconds = stepInputSize / bps;
        setStepInputPosition(Math.max(0, stepInputPosition - stepSeconds));
        return;
      }
      if (key === "arrowright") {
        e.preventDefault();
        advanceStepInput();
        return;
      }

      // Note input: C, D, E, F, G, A, B keys
      const semitone = KEY_TO_NOTE[key];
      if (semitone !== undefined) {
        e.preventDefault();
        // Shift key adds sharp (+1 semitone)
        const sharpOffset = e.shiftKey ? 1 : 0;
        const noteNumber = (stepInputOctave + 2) * 12 + semitone + sharpOffset;
        if (noteNumber < 0 || noteNumber > 127) return;

        const bps = tempo / 60;
        const durationSeconds = stepInputSize / bps;

        // Add the note at stepInputPosition (direct setState to avoid closure issues)
        const noteOnEvent: MIDIEvent = { timestamp: stepInputPosition, type: "noteOn", note: noteNumber, velocity: 80 };
        const noteOffEvent: MIDIEvent = { timestamp: stepInputPosition + durationSeconds, type: "noteOff", note: noteNumber, velocity: 0 };
        useDAWStore.setState((state) => ({
          tracks: state.tracks.map((t) =>
            t.id === trackId
              ? {
                  ...t,
                  midiClips: t.midiClips.map((c) =>
                    c.id === clipId
                      ? { ...c, events: [...c.events, noteOnEvent, noteOffEvent].sort((a, b) => a.timestamp - b.timestamp) }
                      : c,
                  ),
                }
              : t,
          ),
        }));

        // Advance cursor
        advanceStepInput();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stepInputEnabled, stepInputOctave, stepInputSize, stepInputPosition, tempo, clipId, trackId]);

  // Parse noteOn/noteOff pairs (must be before early return)
  const notePairs: NotePair[] = useMemo(() => {
    if (!clipEvents) return [];
    const pairs: NotePair[] = [];
    const noteOns = clipEvents.filter((e) => e.type === "noteOn");
    for (const noteOn of noteOns) {
      const noteOff = clipEvents.find(
        (e) =>
          e.type === "noteOff" &&
          e.note === noteOn.note &&
          e.timestamp > noteOn.timestamp,
      );
      if (!noteOff || noteOn.note === undefined) continue;
      pairs.push({
        noteOn,
        noteOff,
        noteNumber: noteOn.note,
        velocity: noteOn.velocity || 80,
        startTime: noteOn.timestamp,
        duration: noteOff.timestamp - noteOn.timestamp,
        pitchBend: noteOn.pitchBend,
        pressure: noteOn.pressure,
        slide: noteOn.slide,
      });
    }
    return pairs;
  }, [clipEvents]);

  // Parse note pairs for additional clips (multi-clip editing)
  const additionalClipNotePairs: MultiClipNotePair[] = useMemo(() => {
    if (additionalClips.length === 0) return [];
    const allPairs: MultiClipNotePair[] = [];
    for (let ci = 0; ci < additionalClips.length; ci++) {
      const ac = additionalClips[ci];
      const timeOffset = ac.startTime - clipStartTime;
      const noteOns = ac.events.filter((e) => e.type === "noteOn");
      for (const noteOn of noteOns) {
        const noteOff = ac.events.find(
          (e) => e.type === "noteOff" && e.note === noteOn.note && e.timestamp > noteOn.timestamp,
        );
        if (!noteOff || noteOn.note === undefined) continue;
        allPairs.push({
          noteOn,
          noteOff,
          noteNumber: noteOn.note,
          velocity: noteOn.velocity || 80,
          startTime: noteOn.timestamp + timeOffset,
          duration: noteOff.timestamp - noteOn.timestamp,
          clipId: ac.id,
          clipIndex: ci + 1,
          timeOffset,
        });
      }
    }
    return allPairs;
  }, [additionalClips, clipStartTime]);

  // Get CC events for the selected CC number (must be before early return)
  const ccEventsForLane: MIDICCEvent[] = useMemo(() => {
    if (!clipCCEvents) return [];
    return clipCCEvents.filter((e) => e.cc === selectedCC);
  }, [clipCCEvents, selectedCC]);

  // ============================================
  // Velocity Lane Mouse Handlers (must be before early return)
  // ============================================
  const handleVelocityMouseDown = useCallback((e: any) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const y = pos.y;

    if (y < velocityLaneY || y >= velocityLaneY + VELOCITY_LANE_HEIGHT) return;

    const x = pos.x;
    for (const pair of notePairs) {
      const barX = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const barWidth = Math.max(4, pair.duration * pixelsPerSecond);
      if (x >= barX && x <= barX + barWidth) {
        const relY = y - velocityLaneY;
        const newVelocity = Math.round(127 * (1 - relY / VELOCITY_LANE_HEIGHT));
        const clamped = Math.max(1, Math.min(127, newVelocity));
        setVelocityEditingNote({ timestamp: pair.startTime, note: pair.noteNumber });
        updateMIDINoteVelocity(trackId, clipId, pair.startTime, pair.noteNumber, clamped);
        return;
      }
    }
  }, [notePairs, velocityLaneY, pixelsPerSecond, scrollX, trackId, clipId, updateMIDINoteVelocity]);

  const handleVelocityMouseMove = useCallback((e: any) => {
    if (!velocityEditingNote) return;
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const relY = pos.y - velocityLaneY;
    const newVelocity = Math.round(127 * (1 - Math.max(0, Math.min(VELOCITY_LANE_HEIGHT, relY)) / VELOCITY_LANE_HEIGHT));
    const clamped = Math.max(1, Math.min(127, newVelocity));
    updateMIDINoteVelocity(trackId, clipId, velocityEditingNote.timestamp, velocityEditingNote.note, clamped);
  }, [velocityEditingNote, velocityLaneY, trackId, clipId, updateMIDINoteVelocity]);

  const handleVelocityMouseUp = useCallback(() => {
    setVelocityEditingNote(null);
  }, []);

  // ============================================
  // CC Lane Mouse Handlers (must be before early return)
  // ============================================
  const handleCCMouseDown = useCallback((e: any) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const y = pos.y;

    if (y < ccLaneY || y >= ccLaneY + CC_LANE_HEIGHT) return;

    setCCDrawing(true);

    const x = pos.x - PIANO_WIDTH + scrollX;
    const time = Math.max(0, x / pixelsPerSecond);
    const relY = y - ccLaneY;
    const value = Math.round(127 * (1 - relY / CC_LANE_HEIGHT));
    const clamped = Math.max(0, Math.min(127, value));

    const existingEvents = clipCCEvents || [];
    const filtered = existingEvents.filter(
      (ev) => !(ev.cc === selectedCC && Math.abs(ev.time - time) < 0.01),
    );
    const newEvents = [...filtered, { cc: selectedCC, time, value: clamped }]
      .sort((a, b) => a.time - b.time);
    updateMIDICCEvents(trackId, clipId, newEvents);
  }, [ccLaneY, scrollX, pixelsPerSecond, selectedCC, clipCCEvents, trackId, clipId, updateMIDICCEvents]);

  const handleCCMouseMove = useCallback((e: any) => {
    if (!ccDrawing) return;
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;

    const x = pos.x - PIANO_WIDTH + scrollX;
    const time = Math.max(0, x / pixelsPerSecond);
    const relY = pos.y - ccLaneY;
    const value = Math.round(127 * (1 - Math.max(0, Math.min(CC_LANE_HEIGHT, relY)) / CC_LANE_HEIGHT));
    const clamped = Math.max(0, Math.min(127, value));

    // Read current state directly for continuous drawing
    const currentTrack = useDAWStore.getState().tracks.find((t) => t.id === trackId);
    const currentClip = currentTrack?.midiClips.find((c) => c.id === clipId);
    const existingEvents = currentClip?.ccEvents || [];
    const filtered = existingEvents.filter(
      (ev) => !(ev.cc === selectedCC && Math.abs(ev.time - time) < 0.02),
    );
    const newEvents = [...filtered, { cc: selectedCC, time, value: clamped }]
      .sort((a, b) => a.time - b.time);
    // Direct setState to avoid pushing undo for every mousemove
    useDAWStore.setState((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId
          ? { ...t, midiClips: t.midiClips.map((c) => c.id === clipId ? { ...c, ccEvents: newEvents } : c) }
          : t,
      ),
    }));
  }, [ccDrawing, ccLaneY, scrollX, pixelsPerSecond, selectedCC, trackId, clipId]);

  const handleCCMouseUp = useCallback(() => {
    if (ccDrawing) {
      setCCDrawing(false);
      // Push final undo on mouse up
      const currentClip = useDAWStore.getState().tracks
        .find((t) => t.id === trackId)?.midiClips.find((c) => c.id === clipId);
      if (currentClip?.ccEvents) {
        updateMIDICCEvents(trackId, clipId, currentClip.ccEvents);
      }
    }
  }, [ccDrawing, trackId, clipId, updateMIDICCEvents]);

  // Combined stage mouse handlers (must be before early return)
  const handleStageMouseDown = useCallback((e: any) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;

    if (pos.y >= ccLaneY && pos.y < ccLaneY + CC_LANE_HEIGHT) {
      handleCCMouseDown(e);
    } else if (pos.y >= velocityLaneY && pos.y < velocityLaneY + VELOCITY_LANE_HEIGHT) {
      handleVelocityMouseDown(e);
    }
  }, [ccLaneY, velocityLaneY, handleCCMouseDown, handleVelocityMouseDown]);

  const handleStageMouseMove = useCallback((e: any) => {
    if (velocityEditingNote) {
      handleVelocityMouseMove(e);
    } else if (ccDrawing) {
      handleCCMouseMove(e);
    }
  }, [velocityEditingNote, ccDrawing, handleVelocityMouseMove, handleCCMouseMove]);

  const handleStageMouseUp = useCallback(() => {
    handleVelocityMouseUp();
    handleCCMouseUp();
  }, [handleVelocityMouseUp, handleCCMouseUp]);

  // ============================================
  // Early return AFTER all hooks
  // ============================================
  if (!clip || !track) {
    return <div className="piano-roll-empty">No MIDI clip selected</div>;
  }

  const getNoteY = (noteNumber: number) => {
    return (TOTAL_NOTES - 1 - noteNumber) * NOTE_HEIGHT - scrollY;
  };

  const getNoteFromY = (y: number): number => {
    return TOTAL_NOTES - 1 - Math.floor((y + scrollY) / NOTE_HEIGHT);
  };

  const snapTime = (time: number): number => {
    const beatTime = GRID_SNAP / beatsPerSecond;
    return Math.round(time / beatTime) * beatTime;
  };

  /** Add a note to a specific clip (used by both draw tool and step input) */
  const addNoteToClip = (
    targetClipId: string,
    targetTrackId: string,
    time: number,
    note: number,
    duration: number,
    velocity: number,
  ) => {
    const noteOnEvent: MIDIEvent = {
      timestamp: time,
      type: "noteOn",
      note,
      velocity,
    };
    const noteOffEvent: MIDIEvent = {
      timestamp: time + duration,
      type: "noteOff",
      note,
      velocity: 0,
    };
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === targetTrackId
          ? {
              ...t,
              midiClips: t.midiClips.map((c) =>
                c.id === targetClipId
                  ? {
                      ...c,
                      events: [...c.events, noteOnEvent, noteOffEvent].sort(
                        (a, b) => a.timestamp - b.timestamp,
                      ),
                    }
                  : c,
              ),
            }
          : t,
      ),
    }));
  };

  /** Remove a note from a specific clip */
  const removeNoteFromClip = (
    targetClipId: string,
    targetTrackId: string,
    time: number,
    note: number,
  ) => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === targetTrackId
          ? {
              ...t,
              midiClips: t.midiClips.map((c) =>
                c.id === targetClipId
                  ? {
                      ...c,
                      events: c.events.filter(
                        (e) =>
                          !(
                            e.note === note &&
                            Math.abs(e.timestamp - time) < 0.01
                          ),
                      ),
                    }
                  : c,
              ),
            }
          : t,
      ),
    }));
  };

  const handleStageClick = (e: any) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    const x = pos.x - PIANO_WIDTH + scrollX;
    const y = pos.y;

    // Ignore clicks in velocity lane and CC lane (handled separately)
    if (y >= velocityLaneY) return;

    if (pos.x < PIANO_WIDTH) return;

    const time = snapTime(x / pixelsPerSecond);
    const note = getNoteFromY(y);

    if (note < 0 || note >= TOTAL_NOTES) return;

    if (tool === "draw") {
      addNoteToClip(clipId, trackId, time, note, 0.25, 80);
    } else if (tool === "erase") {
      // Try to remove from primary clip first, then additional clips
      removeNoteFromClip(clipId, trackId, time, note);
      for (const ac of additionalClips) {
        removeNoteFromClip(ac.id, trackId, time, note);
      }
    }
  };

  // ============================================
  // Render Functions
  // ============================================

  const renderPianoKeyboard = () => {
    const keys = [];
    for (let i = 0; i < TOTAL_NOTES; i++) {
      const y = getNoteY(i);
      const noteName = NOTE_NAMES[i % NOTES_PER_OCTAVE];
      const isBlackKey = noteName.includes("#");
      const isC = noteName === "C";

      keys.push(
        <Group key={`pk-${i}`}>
          <Rect
            x={0}
            y={y}
            width={PIANO_WIDTH}
            height={NOTE_HEIGHT}
            fill={isBlackKey ? "#333" : "#fff"}
            stroke="#000"
            strokeWidth={0.5}
          />
          {isC && (
            <Text
              x={5}
              y={y + 2}
              text={`C${Math.floor(i / 12) - 2}`}
              fontSize={9}
              fill={isBlackKey ? "#fff" : "#000"}
            />
          )}
        </Group>,
      );
    }
    return keys;
  };

  const renderGrid = () => {
    const elements: React.ReactNode[] = [];
    const gridWidth = clipDuration * pixelsPerSecond;
    const beatInterval = 1 / beatsPerSecond;

    // Beat grid shading: alternate beats
    let beatIndex = 0;
    for (let t = 0; t < clipDuration; t += beatInterval) {
      const bx = PIANO_WIDTH + t * pixelsPerSecond - scrollX;
      const bw = beatInterval * pixelsPerSecond;

      if (bx + bw < PIANO_WIDTH || bx > dimensions.width) {
        beatIndex++;
        continue;
      }

      if (beatIndex % 2 === 1) {
        elements.push(
          <Rect
            key={`beat-shade-${beatIndex}`}
            x={Math.max(PIANO_WIDTH, bx)}
            y={0}
            width={Math.min(bw, dimensions.width - bx)}
            height={TOTAL_NOTES * NOTE_HEIGHT}
            fill="#ffffff"
            opacity={0.04}
            listening={false}
          />,
        );
      }
      beatIndex++;
    }

    // Horizontal lines (note rows) with scale highlighting
    for (let i = 0; i <= TOTAL_NOTES; i++) {
      const y = i * NOTE_HEIGHT - scrollY;
      const noteNumber = TOTAL_NOTES - 1 - i;
      const noteName = NOTE_NAMES[noteNumber >= 0 ? noteNumber % NOTES_PER_OCTAVE : 0];
      const isC = noteName === "C";
      const isBlackKey = noteName.includes("#");
      const inScale = noteNumber >= 0 && isNoteInScale(noteNumber, scaleRoot, scaleType);

      // Scale highlighting: in-scale rows get a lighter tint
      if (i < TOTAL_NOTES && scaleType !== "chromatic" && inScale) {
        elements.push(
          <Rect
            key={`scale-bg-${i}`}
            x={PIANO_WIDTH}
            y={y}
            width={gridWidth}
            height={NOTE_HEIGHT}
            fill="#4cc9f0"
            opacity={0.06}
            listening={false}
          />,
        );
      }

      // Black key row background tint
      if (isBlackKey && i < TOTAL_NOTES) {
        elements.push(
          <Rect
            key={`black-bg-${i}`}
            x={PIANO_WIDTH}
            y={y}
            width={gridWidth}
            height={NOTE_HEIGHT}
            fill="#000000"
            opacity={0.08}
            listening={false}
          />,
        );
      }

      elements.push(
        <Line
          key={`h-${i}`}
          points={[PIANO_WIDTH, y, PIANO_WIDTH + gridWidth - scrollX, y]}
          stroke={isC ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)"}
          strokeWidth={isC ? 1 : 0.5}
        />,
      );
    }

    // Vertical lines (beat grid)
    for (let t = 0; t <= clipDuration; t += beatInterval * GRID_SNAP) {
      const x = PIANO_WIDTH + t * pixelsPerSecond - scrollX;
      const isBeat = Math.abs(t % beatInterval) < 0.001;

      if (x < PIANO_WIDTH || x > dimensions.width) continue;

      elements.push(
        <Line
          key={`v-${t.toFixed(4)}`}
          points={[x, 0, x, TOTAL_NOTES * NOTE_HEIGHT - scrollY]}
          stroke={isBeat ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)"}
          strokeWidth={isBeat ? 1 : 0.5}
        />,
      );
    }

    return elements;
  };

  // Ghost notes from other MIDI clips (excluding additional clips being edited)
  const renderGhostNotes = () => {
    const ghostElements: React.ReactNode[] = [];
    const editingClipIds = new Set([clipId, ...additionalClipIds]);
    const otherClips = track.midiClips.filter((c) => !editingClipIds.has(c.id));

    for (const otherClip of otherClips) {
      const timeOffset = otherClip.startTime - clipStartTime;
      const noteOns = otherClip.events.filter((e) => e.type === "noteOn");

      for (const noteOn of noteOns) {
        const noteOff = otherClip.events.find(
          (e) =>
            e.type === "noteOff" &&
            e.note === noteOn.note &&
            e.timestamp > noteOn.timestamp,
        );

        if (!noteOff || noteOn.note === undefined) continue;

        const adjustedTime = noteOn.timestamp + timeOffset;
        const x = PIANO_WIDTH + adjustedTime * pixelsPerSecond - scrollX;
        const y = getNoteY(noteOn.note);
        const width = (noteOff.timestamp - noteOn.timestamp) * pixelsPerSecond;

        if (x + width < PIANO_WIDTH || x > dimensions.width) continue;

        ghostElements.push(
          <Rect
            key={`ghost-${otherClip.id}-${noteOn.timestamp}-${noteOn.note}`}
            x={x}
            y={y}
            width={width}
            height={NOTE_HEIGHT - 1}
            fill="#888888"
            opacity={0.2}
            cornerRadius={2}
            listening={false}
          />,
        );
      }
    }

    return ghostElements;
  };

  const renderNotes = () => {
    const noteElements: React.ReactNode[] = [];

    // Render primary clip notes
    for (const pair of notePairs) {
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const y = getNoteY(pair.noteNumber);
      const width = pair.duration * pixelsPerSecond;

      if (x + width < PIANO_WIDTH || x > dimensions.width) continue;

      const fillColor = velocityColor(pair.velocity);
      const strokeColor = velocityStrokeColor(pair.velocity);
      const hasPressure = pair.pressure !== undefined && pair.pressure > 0;
      const hasPitchBend = pair.pitchBend !== undefined && pair.pitchBend !== 0;
      const hasSlide = pair.slide !== undefined && pair.slide > 0;

      const noteLabel = getNoteNameFromPitch(pair.noteNumber);
      const showName = width > 40;

      noteElements.push(
        <Group key={`note-${pair.startTime}-${pair.noteNumber}`}>
          <Rect
            x={x}
            y={y}
            width={width}
            height={NOTE_HEIGHT - 1}
            fill={fillColor}
            opacity={0.85}
            stroke={strokeColor}
            strokeWidth={1}
            cornerRadius={2}
          />
          {hasPressure && (
            <Rect
              x={x}
              y={y}
              width={width}
              height={NOTE_HEIGHT - 1}
              fill="#ffffff"
              opacity={pair.pressure! * 0.3}
              cornerRadius={2}
              listening={false}
            />
          )}
          {hasPitchBend && width > 8 && (
            <Line
              points={
                pair.pitchBend! > 0
                  ? [x + width - 6, y + NOTE_HEIGHT - 4, x + width - 3, y + 2, x + width, y + NOTE_HEIGHT - 4]
                  : [x + width - 6, y + 2, x + width - 3, y + NOTE_HEIGHT - 4, x + width, y + 2]
              }
              fill="#ffffff"
              closed
              opacity={0.7}
              listening={false}
            />
          )}
          {hasSlide && width > 8 && (
            <Line
              points={[x + width - 8, y + NOTE_HEIGHT - 3, x + width - 2, y + 2]}
              stroke="#ffffff"
              strokeWidth={1.5}
              opacity={0.6}
              listening={false}
            />
          )}
          {showName && (
            <Text
              x={x + 3}
              y={y + 1}
              text={noteLabel}
              fontSize={8}
              fill="#000000"
              opacity={0.7}
              width={width - 6}
              listening={false}
            />
          )}
        </Group>,
      );
    }

    // Render additional clip notes (multi-clip editing) with tinted colors
    for (const pair of additionalClipNotePairs) {
      const x = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const y = getNoteY(pair.noteNumber);
      const width = pair.duration * pixelsPerSecond;

      if (x + width < PIANO_WIDTH || x > dimensions.width) continue;

      const tintColor = MULTI_CLIP_TINTS[pair.clipIndex % MULTI_CLIP_TINTS.length] || "#ff6b9d";
      const noteLabel = getNoteNameFromPitch(pair.noteNumber);
      const showName = width > 40;

      noteElements.push(
        <Group key={`mcnote-${pair.clipId}-${pair.startTime}-${pair.noteNumber}`}>
          <Rect
            x={x}
            y={y}
            width={width}
            height={NOTE_HEIGHT - 1}
            fill={tintColor}
            opacity={0.7}
            stroke={tintColor}
            strokeWidth={1}
            cornerRadius={2}
          />
          {showName && (
            <Text
              x={x + 3}
              y={y + 1}
              text={noteLabel}
              fontSize={8}
              fill="#000000"
              opacity={0.6}
              width={width - 6}
              listening={false}
            />
          )}
        </Group>,
      );
    }

    return noteElements;
  };

  // Step input cursor line
  const renderStepInputCursor = () => {
    if (!stepInputEnabled) return null;
    const cursorX = PIANO_WIDTH + stepInputPosition * pixelsPerSecond - scrollX;
    if (cursorX < PIANO_WIDTH || cursorX > dimensions.width) return null;

    return (
      <Group>
        {/* Vertical cursor line */}
        <Line
          key="step-cursor"
          points={[cursorX, 0, cursorX, noteGridHeight]}
          stroke="#ff4444"
          strokeWidth={2}
          opacity={0.9}
          dash={[6, 3]}
          listening={false}
        />
        {/* Small triangle indicator at top */}
        <Line
          key="step-cursor-arrow"
          points={[cursorX - 5, 0, cursorX + 5, 0, cursorX, 8]}
          fill="#ff4444"
          closed
          listening={false}
        />
      </Group>
    );
  };

  // ============================================
  // Velocity Lane Rendering
  // ============================================
  const renderVelocityLane = () => {
    const elements: React.ReactNode[] = [];

    // Background + divider + label
    elements.push(
      <Rect key="vel-bg" x={0} y={velocityLaneY} width={dimensions.width} height={VELOCITY_LANE_HEIGHT} fill="#161616" listening={false} />,
      <Line key="vel-divider" points={[0, velocityLaneY, dimensions.width, velocityLaneY]} stroke="rgba(255,255,255,0.15)" strokeWidth={1} listening={false} />,
      <Text key="vel-label" x={4} y={velocityLaneY + 2} text="Vel" fontSize={9} fill="#666" listening={false} />,
    );

    // Horizontal guide lines at 25%, 50%, 75%
    for (const frac of [0.25, 0.5, 0.75]) {
      const gy = velocityLaneY + VELOCITY_LANE_HEIGHT * (1 - frac);
      elements.push(
        <Line key={`vel-guide-${frac}`} points={[PIANO_WIDTH, gy, dimensions.width, gy]} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} listening={false} />,
      );
    }

    // Draw velocity bars for each note
    for (const pair of notePairs) {
      const barX = PIANO_WIDTH + pair.startTime * pixelsPerSecond - scrollX;
      const barWidth = Math.max(4, pair.duration * pixelsPerSecond - 1);

      if (barX + barWidth < PIANO_WIDTH || barX > dimensions.width) continue;

      const velFrac = pair.velocity / 127;
      const barHeight = velFrac * (VELOCITY_LANE_HEIGHT - 4);
      const barY = velocityLaneY + VELOCITY_LANE_HEIGHT - barHeight - 2;
      const color = velocityColor(pair.velocity);

      elements.push(
        <Rect
          key={`vel-bar-${pair.startTime}-${pair.noteNumber}`}
          x={barX}
          y={barY}
          width={barWidth}
          height={barHeight}
          fill={color}
          opacity={0.8}
          cornerRadius={1}
        />,
      );
    }

    // Clickable overlay for the whole velocity lane
    elements.push(
      <Rect key="vel-overlay" x={PIANO_WIDTH} y={velocityLaneY} width={dimensions.width - PIANO_WIDTH} height={VELOCITY_LANE_HEIGHT} fill="transparent" />,
    );

    return elements;
  };

  // ============================================
  // CC Lane Rendering
  // ============================================
  const renderCCLane = () => {
    const elements: React.ReactNode[] = [];
    const ccPreset = CC_PRESETS.find((p) => p.cc === selectedCC);

    // Background + divider + label
    elements.push(
      <Rect key="cc-bg" x={0} y={ccLaneY} width={dimensions.width} height={CC_LANE_HEIGHT} fill="#141414" listening={false} />,
      <Line key="cc-divider" points={[0, ccLaneY, dimensions.width, ccLaneY]} stroke="rgba(255,255,255,0.15)" strokeWidth={1} listening={false} />,
      <Text key="cc-label" x={4} y={ccLaneY + 2} text={ccPreset?.name || `CC#${selectedCC}`} fontSize={9} fill="#666" listening={false} />,
    );

    // Horizontal guide lines
    for (const frac of [0.25, 0.5, 0.75]) {
      const gy = ccLaneY + CC_LANE_HEIGHT * (1 - frac);
      elements.push(
        <Line key={`cc-guide-${frac}`} points={[PIANO_WIDTH, gy, dimensions.width, gy]} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} listening={false} />,
      );
    }

    // Draw CC events as vertical bars and connecting line
    if (ccEventsForLane.length > 0) {
      // Draw connecting line
      const linePoints: number[] = [];
      for (const ev of ccEventsForLane) {
        const x = PIANO_WIDTH + ev.time * pixelsPerSecond - scrollX;
        const y = ccLaneY + CC_LANE_HEIGHT * (1 - ev.value / 127);
        linePoints.push(x, y);
      }
      if (linePoints.length >= 4) {
        elements.push(
          <Line key="cc-line" points={linePoints} stroke="#4cc9f0" strokeWidth={1.5} opacity={0.6} listening={false} />,
        );
      }

      // Draw individual CC points
      for (let i = 0; i < ccEventsForLane.length; i++) {
        const ev = ccEventsForLane[i];
        const x = PIANO_WIDTH + ev.time * pixelsPerSecond - scrollX;
        if (x < PIANO_WIDTH || x > dimensions.width) continue;

        const valFrac = ev.value / 127;
        const barHeight = valFrac * (CC_LANE_HEIGHT - 4);
        const barY = ccLaneY + CC_LANE_HEIGHT - barHeight - 2;

        // Vertical stem + dot
        elements.push(
          <Rect key={`cc-bar-${i}`} x={x - 1} y={barY} width={3} height={barHeight} fill="#4cc9f0" opacity={0.5} listening={false} />,
          <Rect key={`cc-dot-${i}`} x={x - 3} y={barY - 3} width={6} height={6} fill="#4cc9f0" cornerRadius={3} opacity={0.9} listening={false} />,
        );
      }
    }

    // Clickable overlay
    elements.push(
      <Rect key="cc-overlay" x={PIANO_WIDTH} y={ccLaneY} width={dimensions.width - PIANO_WIDTH} height={CC_LANE_HEIGHT} fill="transparent" />,
    );

    return elements;
  };

  return (
    <div className="piano-roll" ref={containerRef}>
      <div className="piano-roll-toolbar">
        <Button
          variant="default"
          size="sm"
          active={tool === "draw"}
          onClick={() => setTool("draw")}
          title="Draw Tool (D)"
        >
          Draw
        </Button>
        <Button
          variant="default"
          size="sm"
          active={tool === "select"}
          onClick={() => setTool("select")}
          title="Select Tool (V)"
        >
          Select
        </Button>
        <Button
          variant="default"
          size="sm"
          active={tool === "erase"}
          onClick={() => setTool("erase")}
          title="Erase Tool (E)"
        >
          Erase
        </Button>
        <div className="toolbar-divider" />
        <label htmlFor="pr-zoom">Zoom:</label>
        <input
          id="pr-zoom"
          type="range"
          min="50"
          max="200"
          value={zoom}
          onChange={(e) => setZoom(Number.parseInt(e.target.value))}
          className="zoom-slider"
        />
        <div className="toolbar-divider" />

        {/* Scale Selector */}
        <label htmlFor="pr-root">Root:</label>
        <select
          id="pr-root"
          className="piano-roll-select"
          value={scaleRoot}
          onChange={(e) => setPianoRollScaleRoot(Number.parseInt(e.target.value))}
        >
          {NOTE_NAMES.map((name, idx) => (
            <option key={name} value={idx}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor="pr-scale">Scale:</label>
        <select
          id="pr-scale"
          className="piano-roll-select"
          value={scaleType}
          onChange={(e) => setPianoRollScaleType(e.target.value)}
        >
          {Object.entries(SCALE_DISPLAY_NAMES).map(([key, displayLabel]) => (
            <option key={key} value={key}>
              {displayLabel}
            </option>
          ))}
        </select>
        <div className="toolbar-divider" />

        {/* CC Lane Selector */}
        <label htmlFor="pr-cc">CC:</label>
        <select
          id="pr-cc"
          className="piano-roll-select"
          value={selectedCC}
          onChange={(e) => setSelectedCC(Number.parseInt(e.target.value))}
        >
          {CC_PRESETS.map((preset) => (
            <option key={preset.cc} value={preset.cc}>
              {preset.name}
            </option>
          ))}
        </select>
        <div className="toolbar-divider" />

        {/* Transform Dropdown */}
        <div ref={transformMenuRef} style={{ position: "relative", display: "inline-block" }}>
          <Button
            variant="default"
            size="sm"
            onClick={() => setShowTransformMenu((v) => !v)}
            title="MIDI Transform"
          >
            Transform
          </Button>
          {showTransformMenu && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                zIndex: 100,
                background: "#2a2a2a",
                border: "1px solid #444",
                borderRadius: 4,
                padding: "4px 0",
                minWidth: 200,
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              }}
            >
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, 1); setShowTransformMenu(false); }}>
                Transpose Up (+1)
              </button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, -1); setShowTransformMenu(false); }}>
                Transpose Down (-1)
              </button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, 12); setShowTransformMenu(false); }}>
                Transpose Octave Up (+12)
              </button>
              <button className="piano-roll-transform-item" onClick={() => { transposeMIDINotes(clipId, -12); setShowTransformMenu(false); }}>
                Transpose Octave Down (-12)
              </button>
              <div style={{ height: 1, background: "#444", margin: "4px 0" }} />
              <button className="piano-roll-transform-item" onClick={() => { scaleMIDINoteVelocity(clipId, 1.1); setShowTransformMenu(false); }}>
                Velocity +10%
              </button>
              <button className="piano-roll-transform-item" onClick={() => { scaleMIDINoteVelocity(clipId, 0.9); setShowTransformMenu(false); }}>
                Velocity -10%
              </button>
              <div style={{ height: 1, background: "#444", margin: "4px 0" }} />
              <button className="piano-roll-transform-item" onClick={() => { reverseMIDINotes(clipId); setShowTransformMenu(false); }}>
                Reverse
              </button>
              <button className="piano-roll-transform-item" onClick={() => { invertMIDINotes(clipId); setShowTransformMenu(false); }}>
                Invert
              </button>
            </div>
          )}
        </div>
        <div className="toolbar-divider" />

        {/* Step Input Mode */}
        <Button
          variant={stepInputEnabled ? "primary" : "default"}
          size="sm"
          active={stepInputEnabled}
          onClick={toggleStepInput}
          title="Step Input Mode - Type note letters (C-B) to enter notes"
        >
          Step
        </Button>
        {stepInputEnabled && (
          <>
            <label htmlFor="pr-step-size">Size:</label>
            <select
              id="pr-step-size"
              className="piano-roll-select"
              value={stepInputSize}
              onChange={(e) => setStepInputSize(Number.parseFloat(e.target.value))}
            >
              {STEP_SIZE_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.beats}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 10, color: "#888", marginLeft: 4 }}>
              Oct: {stepInputOctave}
            </span>
          </>
        )}

        {/* Multi-clip indicator */}
        {additionalClips.length > 0 && (
          <>
            <div className="toolbar-divider" />
            <span style={{ fontSize: 10, color: "#aaa" }}>
              Editing {additionalClips.length + 1} clips
            </span>
          </>
        )}
      </div>

      <Stage
        width={dimensions.width}
        height={stageHeight}
        onClick={handleStageClick}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
        pixelRatio={window.devicePixelRatio || 1}
      >
        <Layer>
          {/* Background */}
          <Rect
            x={0}
            y={0}
            width={dimensions.width}
            height={stageHeight}
            fill="#1a1a1a"
          />

          {/* Grid with beat shading and scale highlighting */}
          {renderGrid()}

          {/* Piano keyboard */}
          {renderPianoKeyboard()}

          {/* Ghost notes from other MIDI clips on this track */}
          {renderGhostNotes()}

          {/* MIDI notes with velocity coloring (includes multi-clip notes) */}
          {renderNotes()}

          {/* Step input cursor line */}
          {renderStepInputCursor()}

          {/* Velocity lane */}
          {renderVelocityLane()}

          {/* CC lane */}
          {renderCCLane()}
        </Layer>
      </Stage>
    </div>
  );
}
