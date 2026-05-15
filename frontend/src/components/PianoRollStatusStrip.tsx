import type { PianoRollTool } from "../store/useDAWStore";
import { PIANO_ROLL_TOOL_BUTTONS } from "../utils/pianoRollTools";

interface PianoRollStatusStripProps {
  readonly tool: PianoRollTool;
  readonly snapBeats: number;
  readonly cursorSeconds?: number | null;
  readonly sourceSeconds: number;
  readonly laneLabel: string;
}

export function PianoRollStatusStrip({
  tool,
  snapBeats,
  cursorSeconds,
  sourceSeconds,
  laneLabel,
}: PianoRollStatusStripProps) {
  const toolLabel = PIANO_ROLL_TOOL_BUTTONS.find((item) => item.tool === tool)?.label ?? tool;

  return (
    <div className="piano-roll-status-strip">
      <span>Tool: {toolLabel}</span>
      <span>Snap: {snapBeats} beat</span>
      <span>Cursor: {cursorSeconds?.toFixed(3) ?? "--"}s</span>
      <span>Source: {sourceSeconds.toFixed(2)}s</span>
      <span>Lane: {laneLabel}</span>
    </div>
  );
}
