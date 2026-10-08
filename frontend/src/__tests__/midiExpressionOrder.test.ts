import { describe, expect, it } from "vitest";
import type { MIDIClip, MIDIEvent } from "../store/useDAWStore";
import { getVisibleMIDIEventsForClip, serializeMIDIClipsForBackend } from "../utils/midiClipSerialization";
import { sortMIDIEvents } from "../utils/midiNotes";

const cc = (controller: number, value: number, channel = 1): MIDIEvent => ({ type: "cc", timestamp: 0, controller, value, channel });
const sequence: MIDIEvent[] = [cc(101, 0), cc(100, 6), cc(6, 7), cc(101, 0, 2), cc(100, 0, 2), cc(6, 48, 2),
  { type: "pitchBend", timestamp: 0, channel: 2, value: 4096 },
  { type: "channelPressure", timestamp: 0, channel: 2, value: 96 }, cc(74, 90, 2),
  { type: "noteOn", timestamp: 0, note: 60, velocity: 90, channel: 2 },
  { type: "noteOff", timestamp: .5, note: 60, velocity: 0, channel: 2 },
  { ...cc(74, 64, 2), timestamp: .5 },
  { type: "noteOn", timestamp: .5, note: 67, velocity: 90, channel: 2 },
  { type: "noteOff", timestamp: .9, note: 67, velocity: 0, channel: 2 }];
const clip = { id: "mpe", startTime: 0, duration: 1, sourceLength: 1, loopLength: 1, loopEnabled: false, events: sequence } as MIDIClip;
const identity = (event: MIDIEvent) => [event.type, event.channel, event.controller ?? event.note, event.value];

describe("MIDI expression ordering", () => {
  it("preserves equal-time RPN, expression and member reuse order", () => {
    expect(sortMIDIEvents(sequence).map(identity)).toEqual(sequence.map(identity));
    expect(getVisibleMIDIEventsForClip(clip).map(identity)).toEqual(sequence.map(identity));
    expect(serializeMIDIClipsForBackend([clip])[0].events.map(identity)).toEqual(sequence.map(identity));
  });
  it("keeps RPN before notes across source loops and non-generating MIDI effects", () => {
    const projected = serializeMIDIClipsForBackend([{ ...clip, duration: 2, loopEnabled: true }], [{ id: "pitch", type: "pitch", enabled: true, semitones: 12 }])[0].events;
    for (const start of [0, 1]) {
      const events = projected.filter(event => event.timestamp === start);
      expect(events.slice(0, 9).map(identity)).toEqual(sequence.slice(0, 9).map(identity));
      expect(events[events.length - 1]?.note).toBe(72);
    }
  });
});
