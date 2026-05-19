import type { PianoRollTool } from "../store/useDAWStore";

export type PianoRollHitTarget =
  | { kind: "piano-key"; noteNumber: number }
  | { kind: "note"; noteId: string; edge: "start" | "end" | "body" }
  | { kind: "loop-boundary"; edge: "start" | "end" }
  | { kind: "lane-header"; laneId: string }
  | { kind: "lane-resize"; laneId: string }
  | { kind: "velocity-lane"; laneId?: string }
  | { kind: "controller-lane"; laneId?: string }
  | { kind: "controller-node"; laneId: string; eventId: string }
  | { kind: "controller-segment"; laneId: string; eventId: string }
  | { kind: "grid"; time: number; noteNumber: number }
  | { kind: "outside" };

export type PianoRollGestureKind =
  | "select"
  | "range"
  | "draw-note"
  | "erase-note"
  | "move-note"
  | "resize-note-start"
  | "resize-note-end"
  | "resize-loop-boundary"
  | "split-note"
  | "mute-note"
  | "edit-velocity"
  | "draw-controller"
  | "zoom"
  | "pan";

export interface PianoRollGestureSession {
  kind: PianoRollGestureKind;
  tool: PianoRollTool;
  target: PianoRollHitTarget;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  previewOnly?: boolean;
}

export type MidiEditorHitTarget = PianoRollHitTarget;
export type MidiEditorGestureSession = PianoRollGestureSession;

export interface PianoRollHitNote {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PianoRollHitLane {
  id: string;
  y: number;
  height: number;
  headerWidth: number;
  resizeHandleHeight?: number;
  kind: "velocity" | "controller";
}

export interface PianoRollHitControllerEvent {
  laneId: string;
  eventId: string;
  x: number;
  y: number;
  radius: number;
}

export interface PianoRollHitGeometry {
  pianoWidth: number;
  noteGridHeight: number;
  velocityLaneY: number;
  velocityLaneHeight: number;
  controllerLaneY: number;
  controllerLaneHeight: number;
  noteEdgeHitWidth: number;
  notes: PianoRollHitNote[];
  lanes?: PianoRollHitLane[];
  controllerEvents?: PianoRollHitControllerEvent[];
  loopStartX?: number;
  loopEndX?: number;
  loopBoundaryHitWidth?: number;
  timeFromX: (x: number) => number;
  noteFromY: (y: number) => number;
}

export function hitTestPianoRoll(x: number, y: number, geometry: PianoRollHitGeometry): PianoRollHitTarget {
  if (x < 0 || y < 0) return { kind: "outside" };
  const loopHitWidth = geometry.loopBoundaryHitWidth ?? geometry.noteEdgeHitWidth;
  if (
    geometry.loopStartX !== undefined
    && Math.abs(x - geometry.loopStartX) <= loopHitWidth
    && y < geometry.noteGridHeight
  ) {
    return { kind: "loop-boundary", edge: "start" };
  }
  if (
    geometry.loopEndX !== undefined
    && Math.abs(x - geometry.loopEndX) <= loopHitWidth
    && y < geometry.noteGridHeight
  ) {
    return { kind: "loop-boundary", edge: "end" };
  }
  if (x < geometry.pianoWidth && y < geometry.noteGridHeight) {
    return { kind: "piano-key", noteNumber: geometry.noteFromY(y) };
  }
  for (const event of geometry.controllerEvents || []) {
    const dx = x - event.x;
    const dy = y - event.y;
    if (Math.sqrt(dx * dx + dy * dy) <= event.radius) {
      return { kind: "controller-node", laneId: event.laneId, eventId: event.eventId };
    }
  }
  for (const lane of geometry.lanes || []) {
    if (y < lane.y || y >= lane.y + lane.height) continue;
    const resizeHandleHeight = lane.resizeHandleHeight ?? 5;
    if (y >= lane.y + lane.height - resizeHandleHeight) {
      return { kind: "lane-resize", laneId: lane.id };
    }
    if (x < lane.headerWidth) {
      return { kind: "lane-header", laneId: lane.id };
    }
    return lane.kind === "velocity"
      ? { kind: "velocity-lane", laneId: lane.id }
      : { kind: "controller-lane", laneId: lane.id };
  }
  if (y >= geometry.velocityLaneY && y < geometry.velocityLaneY + geometry.velocityLaneHeight) {
    return { kind: "velocity-lane" };
  }
  if (y >= geometry.controllerLaneY && y < geometry.controllerLaneY + geometry.controllerLaneHeight) {
    return { kind: "controller-lane" };
  }
  if (y >= geometry.noteGridHeight || x < geometry.pianoWidth) return { kind: "outside" };

  for (let index = geometry.notes.length - 1; index >= 0; index -= 1) {
    const note = geometry.notes[index];
    const inside = x >= note.x && x <= note.x + note.width && y >= note.y && y <= note.y + note.height;
    if (!inside) continue;
    const edge = x - note.x <= geometry.noteEdgeHitWidth
      ? "start"
      : note.x + note.width - x <= geometry.noteEdgeHitWidth
        ? "end"
        : "body";
    return { kind: "note", noteId: note.id, edge };
  }

  return {
    kind: "grid",
    time: geometry.timeFromX(x),
    noteNumber: geometry.noteFromY(y),
  };
}

export function gestureKindForHit(tool: PianoRollTool, target: PianoRollHitTarget): PianoRollGestureKind | null {
  if (target.kind === "outside") return null;
  if (target.kind === "lane-header" || target.kind === "lane-resize") return null;
  if (target.kind === "velocity-lane") return "edit-velocity";
  if (target.kind === "controller-lane" || target.kind === "controller-node" || target.kind === "controller-segment") return "draw-controller";
  if (tool === "range" && (target.kind === "grid" || target.kind === "note" || target.kind === "loop-boundary")) return "range";
  if (target.kind === "loop-boundary") return "resize-loop-boundary";
  if (tool === "zoom") return "zoom";
  if (tool === "pan") return "pan";
  if (target.kind === "note") {
    if (tool === "erase") return "erase-note";
    if (tool === "split") return "split-note";
    if (tool === "mute") return "mute-note";
    if (tool === "trim" || target.edge !== "body") {
      return target.edge === "start" ? "resize-note-start" : target.edge === "end" ? "resize-note-end" : "move-note";
    }
    return "move-note";
  }
  if (tool === "draw") return "draw-note";
  if (tool === "range") return "range";
  return "select";
}
