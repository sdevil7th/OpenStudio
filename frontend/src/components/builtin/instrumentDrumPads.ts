import type { BuiltInPluginSchema } from "../../services/NativeBridge";

export const drumPieceNames = ["Kick", "Snare", "Closed / pedal hat", "Open hat", "Low tom", "Mid / high tom", "Crash / percussion", "Ride"];
export const displayedDrumNotes = [49, 51, 53, 59, 41, 45, 47, 54, 42, 46, 44, 69, 36, 38, 37, 40];

/** Native effective mapping is authoritative; an ignored key has no piece. */
export function drumPadFromSchema(schema: BuiltInPluginSchema, inputNote: number) {
  const row = schema.drumMapping?.find(item => item.inputNote === inputNote);
  if (!row) return { inputNote, voiceNote: null, piece: null, label: "Mapping unavailable", ignored: false, available: false, articulation: "" };
  const ignored = row.ignored === true || row.voiceNote < 0 || row.piece < 0 || row.piece >= drumPieceNames.length;
  return {
    inputNote, voiceNote: ignored ? null : row.voiceNote, piece: ignored ? null : row.piece,
    label: ignored ? "Ignored" : !row.articulation || row.articulation === "Legacy synthesized voice" ? drumPieceNames[row.piece] : row.articulation,
    ignored, available: true, articulation: ignored ? "No voice" : row.articulation || drumPieceNames[row.piece],
  };
}
