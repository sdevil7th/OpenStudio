import { nativeBridge } from "../services/NativeBridge";
import type { MIDIClip } from "../store/useDAWStore";

export function serializeMIDIClipsForBackend(clips: MIDIClip[]) {
  return clips.map((clip) => ({
    id: clip.id,
    startTime: clip.startTime,
    duration: clip.duration,
    events: [
      ...clip.events.map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
        note: event.note,
        velocity: event.velocity,
        controller: event.controller,
        value: event.value,
        channel: 1,
      })),
      ...(clip.ccEvents || []).map((event) => ({
        type: "cc",
        timestamp: event.time,
        controller: event.cc,
        value: event.value,
        channel: 1,
      })),
    ].sort((a, b) => a.timestamp - b.timestamp),
  }));
}

export async function syncTrackMIDIClipsToBackend(trackId: string, clips: MIDIClip[]) {
  return nativeBridge.setTrackMIDIClips(trackId, serializeMIDIClipsForBackend(clips));
}
