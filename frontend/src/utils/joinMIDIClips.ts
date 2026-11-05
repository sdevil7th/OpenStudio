import type { MIDIClip, MIDICCEvent, MIDIEvent } from "../store/useDAWStore";
import { getVisibleMIDICCEventsForClip, getVisibleMIDIEventsForClip } from "./midiClipSerialization";

/** Materialize the finite audible source windows without applying the track's MIDI FX twice. */
export function joinMIDIClips(clips: readonly MIDIClip[]): MIDIClip | null {
  if (clips.length < 2) return null;
  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime);
  if (sorted.some(clip => !Number.isFinite(clip.startTime) || !Number.isFinite(clip.duration) || clip.duration <= 0)) return null;
  const first = sorted[0];
  const duration = Math.max(...sorted.map(clip => clip.startTime + clip.duration)) - first.startTime;
  const events: MIDIEvent[] = [];
  const ccEvents: MIDICCEvent[] = [];
  for (const clip of sorted) {
    const delta = clip.startTime - first.startTime;
    for (const source of getVisibleMIDIEventsForClip(clip, { includeMuted: true, preserveNoteIdentity: true })) {
      // The visible-window utility has already realized these modifiers for each
      // original source loop. Retaining them would apply them a second time.
      const { probability: _probability, chance: _chance, playCount: _playCount,
        velocityVariance: _variance, ...event } = source;
      events.push({ ...event, timestamp: event.timestamp + delta, muted: Boolean(clip.muted || event.muted) });
    }
    for (const source of getVisibleMIDICCEventsForClip(clip)) {
      const { probability: _probability, chance: _chance, playCount: _playCount, ...event } = source;
      if (clip.muted) {
        events.push({ type: "cc", timestamp: event.time + delta, controller: event.cc,
          value: event.value, channel: event.channel, muted: true });
      } else ccEvents.push({ ...event, time: event.time + delta });
    }
  }
  return {
    id: first.id,
    name: sorted.every(clip => clip.name === first.name) ? first.name : `${first.name} (joined)`,
    startTime: first.startTime,
    duration,
    offset: 0,
    sourceStart: 0,
    sourceLength: duration,
    loopLength: duration,
    loopOffset: 0,
    loopEnabled: false,
    events: events.sort((a, b) => a.timestamp - b.timestamp),
    ccEvents: ccEvents.sort((a, b) => a.time - b.time),
    color: first.color,
    groupId: sorted.every(clip => clip.groupId === first.groupId) ? first.groupId : undefined,
  };
}
