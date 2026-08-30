import { METER_NOISE_FLOOR_LINEAR } from "../components/meterConfig";

export type TrackMeterSource = "audio" | "midi_input" | "idle";

export interface TrackMeterPresentation {
  source: TrackMeterSource;
  normalizedLevel: number;
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/**
 * Selects one visual signal without mixing MIDI velocity into the audio meter.
 * Real post-FX audio always wins. Raw MIDI activity is a fallback for armed
 * MIDI/instrument tracks whose audio output is currently silent.
 */
export function resolveTrackMeterPresentation(
  audioLevel: number,
  midiInputLevel: number,
  armed: boolean,
  trackType: string,
): TrackMeterPresentation {
  if (Number.isFinite(audioLevel) && audioLevel >= METER_NOISE_FLOOR_LINEAR) {
    return { source: "audio", normalizedLevel: Math.max(0, audioLevel) };
  }

  const acceptsMidi = trackType === "midi" || trackType === "instrument";
  const normalizedMidi = clampUnit(midiInputLevel);
  if (armed && acceptsMidi && normalizedMidi > 0) {
    return { source: "midi_input", normalizedLevel: normalizedMidi };
  }

  return { source: "idle", normalizedLevel: 0 };
}
