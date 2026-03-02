import { useState, useCallback, useMemo, useRef } from "react";
import { Stage, Layer, Rect, Line, Text, Group } from "react-konva";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Select } from "./ui";

// General MIDI drum names (notes 35-81)
const GM_DRUM_MAP: Record<number, string> = {
  35: "Acoustic Bass Drum",
  36: "Bass Drum 1",
  37: "Side Stick",
  38: "Acoustic Snare",
  39: "Hand Clap",
  40: "Electric Snare",
  41: "Low Floor Tom",
  42: "Closed Hi-Hat",
  43: "High Floor Tom",
  44: "Pedal Hi-Hat",
  45: "Low Tom",
  46: "Open Hi-Hat",
  47: "Low-Mid Tom",
  48: "Hi-Mid Tom",
  49: "Crash Cymbal 1",
  50: "High Tom",
  51: "Ride Cymbal 1",
  52: "Chinese Cymbal",
  53: "Ride Bell",
  54: "Tambourine",
  55: "Splash Cymbal",
  56: "Cowbell",
  57: "Crash Cymbal 2",
  59: "Ride Cymbal 2",
  60: "Hi Bongo",
  61: "Low Bongo",
  62: "Mute Hi Conga",
  63: "Open Hi Conga",
  64: "Low Conga",
  69: "Cabasa",
  70: "Maracas",
  75: "Claves",
  76: "Hi Wood Block",
  77: "Low Wood Block",
};

// Common drum kit rows (subset of GM)
const DEFAULT_ROWS = [36, 38, 42, 46, 45, 48, 50, 49, 51, 56];

const CELL_WIDTH = 28;
const CELL_HEIGHT = 24;
const LABEL_WIDTH = 120;
const HEADER_HEIGHT = 24;

interface DrumEditorProps {
  clipId: string;
}

/**
 * DrumEditor (Sprint 19.8)
 * Grid-based percussion editor. Rows represent drum instruments,
 * columns represent time steps. Click to toggle notes.
 */
export function DrumEditor({ clipId }: DrumEditorProps) {
  const { clip, tempo } = useDAWStore(
    useShallow((s) => {
      const c = s.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === clipId);
      return { clip: c, tempo: s.transport.tempo };
    }),
  );

  const [steps, setSteps] = useState(32);
  const [gridDivision, setGridDivision] = useState("1/16");
  const [velocity, setVelocity] = useState(100);
  const containerRef = useRef<HTMLDivElement>(null);

  const drumRows = DEFAULT_ROWS;

  // Parse grid division to beat fraction
  const stepDuration = useMemo(() => {
    const beatDuration = 60 / tempo;
    const parts = gridDivision.split("/");
    if (parts.length === 2) {
      return ((4 * parseInt(parts[0])) / parseInt(parts[1])) * beatDuration;
    }
    return beatDuration / 4; // default 1/16
  }, [gridDivision, tempo]);

  const midiClip = clip && (clip as any).type === "midi" ? (clip as any) : null;
  const notes: Array<{ id: string; note: number; time: number; duration: number; velocity: number }> =
    midiClip?.notes || [];

  // Build a set of active cells
  const activeNotes = useMemo(() => {
    const set = new Set<string>();
    if (!clip) return set;
    for (const note of notes) {
      const relTime = note.time - clip.startTime;
      const stepIndex = Math.round(relTime / stepDuration);
      if (stepIndex >= 0 && stepIndex < steps) {
        set.add(`${note.note}-${stepIndex}`);
      }
    }
    return set;
  }, [notes, clip, stepDuration, steps]);

  const handleCellClick = useCallback(
    (drumNote: number, stepIndex: number) => {
      if (!clip) return;
      const store = useDAWStore.getState();
      const key = `${drumNote}-${stepIndex}`;
      const time = clip.startTime + stepIndex * stepDuration;

      if (activeNotes.has(key)) {
        // Remove note
        const noteToRemove = notes.find(
          (n) =>
            n.note === drumNote &&
            Math.abs(n.time - time) < stepDuration * 0.5,
        );
        if (noteToRemove && (store as any).removeMIDINote) {
          (store as any).removeMIDINote(clipId, noteToRemove.id);
        }
      } else {
        // Add note
        if ((store as any).addMIDINote) {
          (store as any).addMIDINote(clipId, {
            note: drumNote,
            time,
            duration: stepDuration * 0.9,
            velocity: velocity / 127,
          });
        }
      }
    },
    [clip, clipId, notes, activeNotes, stepDuration, velocity],
  );

  const totalWidth = LABEL_WIDTH + steps * CELL_WIDTH;
  const totalHeight = HEADER_HEIGHT + drumRows.length * CELL_HEIGHT;

  return (
    <div className="flex flex-col gap-2 bg-daw-dark p-2 rounded border border-daw-border">
      {/* Toolbar */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-daw-text-muted">Steps:</span>
        <Select
          value={String(steps)}
          onChange={(v) => setSteps(parseInt(v as string))}
          options={[
            { value: "16", label: "16" },
            { value: "32", label: "32" },
            { value: "64", label: "64" },
          ]}
          size="sm"
        />
        <span className="text-daw-text-muted">Grid:</span>
        <Select
          value={gridDivision}
          onChange={(v) => setGridDivision(v as string)}
          options={[
            { value: "1/8", label: "1/8" },
            { value: "1/16", label: "1/16" },
            { value: "1/32", label: "1/32" },
          ]}
          size="sm"
        />
        <span className="text-daw-text-muted">Vel:</span>
        <input
          type="range"
          min={1}
          max={127}
          value={velocity}
          onChange={(e) => setVelocity(parseInt(e.target.value))}
          className="w-16"
        />
        <span className="text-daw-text tabular-nums">{velocity}</span>
      </div>

      {/* Grid */}
      <div ref={containerRef} className="overflow-auto" style={{ maxHeight: 400 }}>
        <Stage width={totalWidth} height={totalHeight}>
          <Layer>
            {/* Header - step numbers */}
            {Array.from({ length: steps }, (_, i) => (
              <Text
                key={`hdr-${i}`}
                x={LABEL_WIDTH + i * CELL_WIDTH}
                y={4}
                width={CELL_WIDTH}
                height={HEADER_HEIGHT - 4}
                text={String(i + 1)}
                fontSize={9}
                fill={i % 4 === 0 ? "#aaa" : "#555"}
                align="center"
              />
            ))}

            {/* Drum rows */}
            {drumRows.map((drumNote, rowIndex) => {
              const y = HEADER_HEIGHT + rowIndex * CELL_HEIGHT;
              const drumName =
                GM_DRUM_MAP[drumNote] || `Note ${drumNote}`;

              return (
                <Group key={drumNote}>
                  {/* Row background */}
                  <Rect
                    x={0}
                    y={y}
                    width={totalWidth}
                    height={CELL_HEIGHT}
                    fill={rowIndex % 2 === 0 ? "#1a1a1a" : "#1e1e1e"}
                  />

                  {/* Label */}
                  <Text
                    x={4}
                    y={y + 4}
                    width={LABEL_WIDTH - 8}
                    height={CELL_HEIGHT - 8}
                    text={drumName}
                    fontSize={10}
                    fill="#bbb"
                    ellipsis
                    wrap="none"
                  />

                  {/* Grid cells */}
                  {Array.from({ length: steps }, (_, stepIdx) => {
                    const cellX = LABEL_WIDTH + stepIdx * CELL_WIDTH;
                    const isActive = activeNotes.has(
                      `${drumNote}-${stepIdx}`,
                    );
                    const isBeatStart = stepIdx % 4 === 0;

                    return (
                      <Group key={stepIdx}>
                        {/* Cell background */}
                        <Rect
                          x={cellX}
                          y={y}
                          width={CELL_WIDTH}
                          height={CELL_HEIGHT}
                          fill={
                            isActive
                              ? "#0078d4"
                              : isBeatStart
                                ? "#252525"
                                : "transparent"
                          }
                          stroke="#333"
                          strokeWidth={0.5}
                          onClick={() =>
                            handleCellClick(drumNote, stepIdx)
                          }
                        />
                        {/* Active note indicator */}
                        {isActive && (
                          <Rect
                            x={cellX + 4}
                            y={y + 4}
                            width={CELL_WIDTH - 8}
                            height={CELL_HEIGHT - 8}
                            fill="#3b9bff"
                            cornerRadius={2}
                            listening={false}
                          />
                        )}
                      </Group>
                    );
                  })}
                </Group>
              );
            })}

            {/* Beat lines */}
            {Array.from({ length: Math.ceil(steps / 4) + 1 }, (_, i) => (
              <Line
                key={`beat-${i}`}
                points={[
                  LABEL_WIDTH + i * 4 * CELL_WIDTH,
                  HEADER_HEIGHT,
                  LABEL_WIDTH + i * 4 * CELL_WIDTH,
                  totalHeight,
                ]}
                stroke="#444"
                strokeWidth={1}
                listening={false}
              />
            ))}
          </Layer>
        </Stage>
      </div>
    </div>
  );
}
