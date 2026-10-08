/** Small, JSON-only protocol. Window identity is stamped by native code. */
export interface PitchSessionIdentity {
  projectEpoch: number;
  sessionId: string;
  generation: number;
  sourceRevision: string;
}
export interface PitchSessionCommand extends PitchSessionIdentity {
  viewId: string;
  requestId: string;
  sequence: number;
  action: string;
  args: unknown[];
}

const noArgs = new Set(["selectAll", "deselectAll", "endInteractivePreview", "commitNoteEdit",
  "correctSelectedToScale", "correctAllToScale", "undo", "redo", "applyCorrection", "previewCorrection",
  "autoDetectScale", "toggleInspector", "toggleCorrectPitchModal", "beginDrawPitch", "commitDrawPitch", "toggleABCompare", "cancelEdit", "dock"]);
const numeric = new Set(["setScrollX", "setScrollY", "setZoomX", "setZoomY", "moveSelectedPitch", "setGlobalFormantCents"]);
const noteNumeric = new Set(["splitNote", "setNoteFormant", "setNoteGain", "setNoteModulation", "setNoteDrift", "setNoteTransition"]);
const noteFields = new Set(["correctedPitch", "startTime", "endTime", "effectiveStartTime", "effectiveEndTime",
  "vibratoDepth", "vibratoRate", "formantShift", "gain", "pitchDrift", "drift", "transitionIn", "transitionOut", "pitchModulation", "pitchDriftAmount", "driftCorrectionAmount"]);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e7;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const changes = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v)
  && Object.entries(v).every(([k, value]) => noteFields.has(k)
    && (finite(value) || (k === "pitchDrift" && Array.isArray(value) && value.length <= 16384 && value.every(finite))));

export function validPitchAction(action: string, args: unknown[]): boolean {
  if (!Array.isArray(args) || args.length > 4) return false;
  if (noArgs.has(action)) return args.length === 0;
  if (numeric.has(action)) return args.length === 1 && finite(args[0]);
  if (noteNumeric.has(action)) return args.length >= 2 && args.length <= 3 && id(args[0]) && args.slice(1).every(finite);
  if (action === "analyze") return args.length <= 2 && args.every(v => v == null || finite(v));
  if (action === "setTool") return args.length === 1 && ["select", "pitch", "drift", "vibrato", "transition", "draw", "split"].includes(String(args[0]));
  if (action === "setSnapMode") return args.length === 1 && ["off", "chromatic", "scale"].includes(String(args[0]));
  if (action === "selectNote") return args.length >= 1 && args.length <= 2 && id(args[0]) && (args[1] == null || typeof args[1] === "boolean");
  if (action === "beginInteractivePreview" || action === "pushUndo") return args.length === 1 && id(args[0]);
  if (action === "setSelectedNoteIds" || action === "mergeNotes") return args.length === 1 && Array.isArray(args[0]) && args[0].length <= 16384 && args[0].every(id);
  if (action === "updateNote") return args.length === 2 && id(args[0]) && changes(args[1]);
  if (action === "updateSelectedNotes") return args.length === 1 && changes(args[0]);
  if (action === "setScale") return args.length === 2 && finite(args[0]) && args[0] >= 0 && args[0] < 12 && typeof args[1] === "string" && /^[a-z_]{1,32}$/.test(args[1]);
  if (action === "applyCorrectPitchMacro") return args.length === 3 && args.slice(0, 2).every(v => finite(v) && v >= 0 && v <= 100) && typeof args[2] === "boolean";
  if (action === "drawPitchOnNote") return args.length === 3 && id(args[0]) && args.slice(1).every(finite);
  if (action === "addReferenceTrack") return args.length === 3 && args.every(id);
  if (action === "removeReferenceTrack" || action === "toggleReferenceVisibility") return args.length === 1 && id(args[0]);
  if (action === "setViewportInitialized") return args.length === 0;
  return false; // No open/close, arbitrary functions, source paths or store patches.
}

export function samePitchIdentity(a: PitchSessionIdentity, b: PitchSessionIdentity): boolean {
  return a.projectEpoch === b.projectEpoch && a.sessionId === b.sessionId
    && a.generation === b.generation && a.sourceRevision === b.sourceRevision;
}

export class PitchCommandGate {
  sequence = 0;
  private requests = new Set<string>();
  constructor(readonly identity: PitchSessionIdentity, readonly viewId: string) {}
  accept(value: PitchSessionCommand): "accept" | "stale" | "duplicate" | "resync" | "invalid" {
    if (!value || !samePitchIdentity(this.identity, value) || value.viewId !== this.viewId) return "stale";
    if (!id(value.requestId) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !validPitchAction(value.action, value.args)) return "invalid";
    if (this.requests.has(value.requestId) || value.sequence <= this.sequence) return "duplicate";
    if (value.sequence !== this.sequence + 1) return "resync";
    this.sequence = value.sequence;
    this.requests.add(value.requestId);
    if (this.requests.size > 256) this.requests.delete(this.requests.values().next().value!);
    return "accept";
  }
}
