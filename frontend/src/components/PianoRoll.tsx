import { useState, useRef, useEffect } from "react";
import { Stage, Layer, Rect, Line, Text, Group } from "react-konva";
import { useDAWStore, MIDIEvent } from "../store/useDAWStore";
import { Button } from "./ui";
import "./PianoRoll.css";

interface PianoRollProps {
  clipId: string;
  trackId: string;
}

const NOTES_PER_OCTAVE = 12;
const TOTAL_NOTES = 128; // MIDI range 0-127
const NOTE_HEIGHT = 12;
const PIANO_WIDTH = 60;
const GRID_SNAP = 0.25; // 1/16 note

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

export function PianoRoll({ clipId, trackId }: PianoRollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [tool, setTool] = useState<"draw" | "select" | "erase">("draw");
  const [zoom, setZoom] = useState(100); // pixels per beat
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(TOTAL_NOTES * NOTE_HEIGHT / 2 - 300); // Center around middle C

  const track = useDAWStore((state) =>
    state.tracks.find((t) => t.id === trackId),
  );
  const clip = track?.midiClips.find((c) => c.id === clipId);
  const tempo = useDAWStore((state) => state.transport.tempo);

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
        // Horizontal scroll
        setScrollX((prev) => Math.max(0, prev + e.deltaY));
      } else {
        // Vertical scroll
        const maxScrollY = TOTAL_NOTES * NOTE_HEIGHT - (dimensions.height - 40);
        setScrollY((prev) => Math.max(0, Math.min(maxScrollY, prev + e.deltaY)));
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [dimensions.height]);

  if (!clip || !track) {
    return <div className="piano-roll-empty">No MIDI clip selected</div>;
  }

  const beatsPerSecond = tempo / 60;
  const pixelsPerSecond = zoom * beatsPerSecond;

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

  const handleStageClick = (e: any) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    const x = pos.x - PIANO_WIDTH + scrollX;
    const y = pos.y;

    if (pos.x < PIANO_WIDTH) return; // Clicked on piano keyboard

    const time = snapTime(x / pixelsPerSecond);
    const note = getNoteFromY(y);

    if (note < 0 || note >= TOTAL_NOTES) return;

    if (tool === "draw") {
      addNote(time, note, 0.25, 80); // Default: 1/4 note, velocity 80
    } else if (tool === "erase") {
      removeNoteAtPosition(time, note);
    }
  };

  const addNote = (
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
        t.id === trackId
          ? {
              ...t,
              midiClips: t.midiClips.map((c) =>
                c.id === clipId
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

  const removeNoteAtPosition = (time: number, note: number) => {
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId
          ? {
              ...t,
              midiClips: t.midiClips.map((c) =>
                c.id === clipId
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

  const renderPianoKeyboard = () => {
    const keys = [];
    for (let i = 0; i < TOTAL_NOTES; i++) {
      const y = getNoteY(i);
      const noteName = NOTE_NAMES[i % NOTES_PER_OCTAVE];
      const isBlackKey = noteName.includes("#");
      const isC = noteName === "C";

      keys.push(
        <Group key={i}>
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
    const lines = [];
    const gridWidth = clip.duration * pixelsPerSecond;

    // Horizontal lines (note rows)
    for (let i = 0; i <= TOTAL_NOTES; i++) {
      const y = i * NOTE_HEIGHT - scrollY;
      const noteName = NOTE_NAMES[(TOTAL_NOTES - 1 - i) % NOTES_PER_OCTAVE];
      const isC = noteName === "C";

      lines.push(
        <Line
          key={`h-${i}`}
          points={[PIANO_WIDTH, y, PIANO_WIDTH + gridWidth - scrollX, y]}
          stroke={isC ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)"}
          strokeWidth={isC ? 1 : 0.5}
        />,
      );
    }

    // Vertical lines (beat grid)
    const beatInterval = 1 / beatsPerSecond;
    for (let t = 0; t <= clip.duration; t += beatInterval * GRID_SNAP) {
      const x = PIANO_WIDTH + t * pixelsPerSecond - scrollX;
      const isBeat = Math.abs(t % beatInterval) < 0.001;

      // Skip if outside visible area
      if (x < PIANO_WIDTH || x > dimensions.width) continue;

      lines.push(
        <Line
          key={`v-${t}`}
          points={[x, 0, x, TOTAL_NOTES * NOTE_HEIGHT - scrollY]}
          stroke={isBeat ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)"}
          strokeWidth={isBeat ? 1 : 0.5}
        />,
      );
    }

    return lines;
  };

  const renderNotes = () => {
    const noteRects = [];
    const noteOns = clip.events.filter((e) => e.type === "noteOn");

    for (const noteOn of noteOns) {
      const noteOff = clip.events.find(
        (e) =>
          e.type === "noteOff" &&
          e.note === noteOn.note &&
          e.timestamp > noteOn.timestamp,
      );

      if (!noteOff || noteOn.note === undefined) continue;

      const x = PIANO_WIDTH + noteOn.timestamp * pixelsPerSecond - scrollX;
      const y = getNoteY(noteOn.note);

      // Skip if outside visible area
      const noteWidth = (noteOff.timestamp - noteOn.timestamp) * pixelsPerSecond;
      if (x + noteWidth < PIANO_WIDTH || x > dimensions.width) continue;
      const width = (noteOff.timestamp - noteOn.timestamp) * pixelsPerSecond;
      const velocity = noteOn.velocity || 80;
      const opacity = velocity / 127;

      noteRects.push(
        <Rect
          key={`${noteOn.timestamp}-${noteOn.note}`}
          x={x}
          y={y}
          width={width}
          height={NOTE_HEIGHT - 1}
          fill={`rgba(76, 201, 240, ${opacity})`}
          stroke="#4cc9f0"
          strokeWidth={1}
          cornerRadius={2}
        />,
      );
    }

    return noteRects;
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
          ✏️ Draw
        </Button>
        <Button
          variant="default"
          size="sm"
          active={tool === "select"}
          onClick={() => setTool("select")}
          title="Select Tool (V)"
        >
          ↖️ Select
        </Button>
        <Button
          variant="default"
          size="sm"
          active={tool === "erase"}
          onClick={() => setTool("erase")}
          title="Erase Tool (E)"
        >
          🗑️ Erase
        </Button>
        <div className="toolbar-divider" />
        <label>Zoom:</label>
        <input
          type="range"
          min="50"
          max="200"
          value={zoom}
          onChange={(e) => setZoom(parseInt(e.target.value))}
          className="zoom-slider"
        />
      </div>

      <Stage
        width={dimensions.width}
        height={dimensions.height - 40}
        onClick={handleStageClick}
      >
        <Layer>
          {/* Background */}
          <Rect
            x={0}
            y={0}
            width={dimensions.width}
            height={dimensions.height}
            fill="#1a1a1a"
          />

          {/* Grid */}
          {renderGrid()}

          {/* Piano keyboard */}
          {renderPianoKeyboard()}

          {/* MIDI notes */}
          {renderNotes()}
        </Layer>
      </Stage>
    </div>
  );
}
