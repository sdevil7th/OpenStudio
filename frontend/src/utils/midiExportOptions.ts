import type { MIDIExportOptions } from "../services/NativeBridge";
import type { DAWState } from "../store/useDAWStore";

/** Rebase the musical map together with clip timestamps for portable MIDI export. */
export function midiExportOptions(
  state: Pick<DAWState, "transport" | "tempoMarkers" | "timeSignature">,
  rangeStart = 0,
  rangeEnd = Number.POSITIVE_INFINITY,
): MIDIExportOptions {
  const start = Math.max(0, rangeStart);
  const markers = state.tempoMarkers.filter(marker => Number.isFinite(marker.time) && marker.time >= 0
    && Number.isFinite(marker.tempo) && marker.tempo > 0).sort((a, b) => a.time - b.time);
  let tempo = state.transport.tempo;
  for (const marker of markers) {
    if (marker.time > start) break;
    tempo = marker.tempo;
  }
  return {
    tempo,
    tempoMarkers: markers.filter(marker => marker.time > start && marker.time < rangeEnd)
      .map(marker => ({ time: marker.time - start, bpm: marker.tempo })),
    timeSignature: { ...state.timeSignature },
  };
}
