import type { ComponentType } from "react";
import {
  Activity,
  ArrowLeftRight,
  Eraser,
  Hand,
  Link2,
  MousePointer,
  Pencil,
  Scissors,
  Square,
  VolumeX,
  Wand2,
  ZoomIn,
} from "lucide-react";
import type { PianoRollTool } from "../store/useDAWStore";

export type PianoRollToolIcon = ComponentType<{ size?: number; strokeWidth?: number }>;

export interface PianoRollToolButton {
  tool: PianoRollTool;
  label: string;
  shortcut: string;
  Icon: PianoRollToolIcon;
}

export const PIANO_ROLL_TOOL_BUTTONS: PianoRollToolButton[] = [
  { tool: "select", label: "Select", shortcut: "V", Icon: MousePointer },
  { tool: "draw", label: "Draw", shortcut: "D", Icon: Pencil },
  { tool: "erase", label: "Erase", shortcut: "E", Icon: Eraser },
  { tool: "range", label: "Range", shortcut: "R", Icon: Square },
  { tool: "trim", label: "Trim", shortcut: "T", Icon: ArrowLeftRight },
  { tool: "split", label: "Split", shortcut: "B", Icon: Scissors },
  { tool: "glue", label: "Glue", shortcut: "G", Icon: Link2 },
  { tool: "mute", label: "Mute", shortcut: "M", Icon: VolumeX },
  { tool: "velocity", label: "Velocity", shortcut: "Y", Icon: Activity },
  { tool: "line", label: "Line", shortcut: "L", Icon: Wand2 },
  { tool: "zoom", label: "Zoom", shortcut: "Z", Icon: ZoomIn },
  { tool: "pan", label: "Pan", shortcut: "H", Icon: Hand },
];
