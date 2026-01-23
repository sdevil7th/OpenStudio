import { useState, useRef, useEffect } from "react";
import { Stage, Layer, Rect, Line, Text, Group } from "react-konva";
import { useDAWStore, MIDIEvent } from "../store/useDAWStore";
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
    const x = pos.x - PIANO_WIDTH;
    const y = pos.y;

    if (x < 0) return; // Clicked on piano keyboard

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
          points={[PIANO_WIDTH, y, PIANO_WIDTH + gridWidth, y]}
          stroke={isC ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)"}
          strokeWidth={isC ? 1 : 0.5}
        />,
      );
    }

    // Vertical lines (beat grid)
    const beatInterval = 1 / beatsPerSecond;
    for (let t = 0; t <= clip.duration; t += beatInterval * GRID_SNAP) {
      const x = PIANO_WIDTH + t * pixelsPerSecond;
      const isBeat = Math.abs(t % beatInterval) < 0.001;

      lines.push(
        <Line
          key={`v-${t}`}
          points={[x, 0, x, TOTAL_NOTES * NOTE_HEIGHT]}
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

      const x = PIANO_WIDTH + noteOn.timestamp * pixelsPerSecond;
      const y = getNoteY(noteOn.note);
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
        <button
          className={`tool-btn ${tool === "draw" ? "active" : ""}`}
          onClick={() => setTool("draw")}
          title="Draw Tool (D)"
        >
          ✏️ Draw
        </button>
        <button
          className={`tool-btn ${tool === "select" ? "active" : ""}`}
          onClick={() => setTool("select")}
          title="Select Tool (V)"
        >
          ↖️ Select
        </button>
        <button
          className={`tool-btn ${tool === "erase" ? "active" : ""}`}
          onClick={() => setTool("erase")}
          title="Erase Tool (E)"
        >
          🗑️ Erase
        </button>
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
