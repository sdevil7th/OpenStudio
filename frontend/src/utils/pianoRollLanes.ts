import type { NoteMetadataLaneType } from "./midiNotes";
import { getNoteNameFromPitch } from "./pianoRollPitch";

export const PITCH_BEND_LANE = -1;
export const PROGRAM_CHANGE_LANE = -2;
export const CHANNEL_PRESSURE_LANE = -3;
export const POLY_PRESSURE_LANE = -4;
export const NOTE_OFF_VELOCITY_LANE = -5;
export const CHANCE_LANE = -6;
export const VELOCITY_VARIANCE_LANE = -7;

export const CC_PRESETS = [
  { cc: VELOCITY_VARIANCE_LANE, name: "Velocity Variance" },
  { cc: CHANCE_LANE, name: "Chance" },
  { cc: NOTE_OFF_VELOCITY_LANE, name: "Note-Off Velocity" },
  { cc: POLY_PRESSURE_LANE, name: "Poly Pressure" },
  { cc: CHANNEL_PRESSURE_LANE, name: "Channel Pressure" },
  { cc: PROGRAM_CHANGE_LANE, name: "Program Change" },
  { cc: PITCH_BEND_LANE, name: "Pitch Bend" },
  { cc: 1, name: "CC#1 Modulation" },
  { cc: 0, name: "CC#0 Bank MSB" },
  { cc: 32, name: "CC#32 Bank LSB" },
  { cc: 7, name: "CC#7 Volume" },
  { cc: 10, name: "CC#10 Pan" },
  { cc: 11, name: "CC#11 Expression" },
  { cc: 64, name: "CC#64 Sustain" },
];

export type ScalarMIDIEventType = "programChange" | "channelPressure" | "polyPressure";

export function scalarMIDIEventTypeForLane(lane: number): ScalarMIDIEventType | null {
  if (lane === POLY_PRESSURE_LANE) return "polyPressure";
  if (lane === PROGRAM_CHANGE_LANE) return "programChange";
  if (lane === CHANNEL_PRESSURE_LANE) return "channelPressure";
  return null;
}

export function scalarMIDIEventName(type: ScalarMIDIEventType, noteNumber?: number): string {
  if (type === "programChange") return "program change";
  if (type === "channelPressure") return "channel pressure";
  const note = Math.max(0, Math.min(127, Math.round(noteNumber ?? 60)));
  return `poly pressure ${getNoteNameFromPitch(note)}`;
}

export function noteMetadataLaneTypeForLane(lane: number): NoteMetadataLaneType | null {
  if (lane === NOTE_OFF_VELOCITY_LANE) return "noteOffVelocity";
  if (lane === CHANCE_LANE) return "chance";
  if (lane === VELOCITY_VARIANCE_LANE) return "velocityVariance";
  return null;
}
