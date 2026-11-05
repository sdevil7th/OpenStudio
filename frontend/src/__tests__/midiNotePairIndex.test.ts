import { describe, expect, it } from "vitest";
import { parseMIDINotePairs } from "../utils/midiNotes";
import type { MIDIEvent } from "../store/useDAWStore";

// Retain the prior exhaustive matcher as an independent compatibility oracle.
function reference(events: MIDIEvent[]) {
  const used = new Set<number>();
  const pairs: number[][] = [];
  events.forEach((on, onIndex) => {
    if (on.type !== "noteOn" || on.note === undefined) return;
    let offIndex = -1;
    events.forEach((off, index) => {
      if (used.has(index) || off.type !== "noteOff" || off.note !== on.note
        || (off.channel ?? on.channel ?? 1) !== (on.channel ?? off.channel ?? 1)
        || off.timestamp <= on.timestamp) return;
      if (offIndex < 0 || off.timestamp < events[offIndex].timestamp) offIndex = index;
    });
    if (offIndex >= 0) { used.add(offIndex); pairs.push([onIndex, offIndex]); }
  });
  return pairs;
}

describe("indexed MIDI note pairing", () => {
  it("preserves source-order consumption, wildcard channels, strict release times and tie order", () => {
    let seed = 1234567;
    const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let run = 0; run < 60; run++) {
      const events: MIDIEvent[] = Array.from({ length: 240 }, () => ({
        type: random(3) === 0 ? "noteOn" : "noteOff", timestamp: random(25) / 10,
        note: 60 + random(4), channel: [undefined, 1, 2, 3][random(4)], velocity: random(128),
      }));
      const before = structuredClone(events);
      const pairs = parseMIDINotePairs(events, "fixture");
      expect(pairs.map(pair => [pair.onIndex, pair.offIndex])).toEqual(reference(events));
      expect(events).toEqual(before);
      for (const pair of pairs) {
        expect(pair.noteOn).toBe(events[pair.onIndex]);
        expect(pair.noteOff).toBe(events[pair.offIndex]);
      }
    }
  });

  it("retains legacy behavior for malformed nonfinite input", () => {
    const events: MIDIEvent[] = [
      { type: "noteOn", timestamp: 0, note: 60 },
      { type: "noteOff", timestamp: NaN, note: 60 },
      { type: "noteOff", timestamp: 1, note: 60 },
      { type: "noteOn", timestamp: 2, note: 60, channel: NaN },
      { type: "noteOff", timestamp: 3, note: 60, channel: NaN },
    ];
    expect(parseMIDINotePairs(events).map(pair => [pair.onIndex, pair.offIndex])).toEqual(reference(events));
  });

  it("bounds event reads for a long, densely overlapping same-pitch recording", () => {
    const count = 10000;
    let timestampReads = 0;
    const events: MIDIEvent[] = Array.from({ length: count * 2 }, (_, i) => ({
      type: i < count ? "noteOn" : "noteOff", note: 60, channel: 1,
      get timestamp() { timestampReads++; return i / 10000; },
    }));
    const pairs = parseMIDINotePairs(events);
    expect(pairs).toHaveLength(count);
    expect(pairs[0].offIndex).toBe(count);
    expect(pairs[pairs.length - 1].offIndex).toBe(count * 2 - 1);
    // A generous input-size budget rejects the former quadratic full scans
    // without depending on CPU speed or wall-clock test timing.
    expect(timestampReads).toBeLessThan(events.length * 100);
  });
});
