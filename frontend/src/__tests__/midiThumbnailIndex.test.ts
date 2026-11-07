import { describe, expect, it } from "vitest";
import { MIDIThumbnailIndex, sampleMIDIThumbnailBars } from "../utils/midiPreview";
import type { MIDIEvent } from "../store/useDAWStore";

const note = (timestamp: number, pitch = 60): MIDIEvent[] => [
  { type: "noteOn", timestamp, note: pitch, velocity: 100 },
  { type: "noteOff", timestamp: timestamp + 0.5, note: pitch, velocity: 0 },
];

describe("indexed MIDI thumbnails", () => {
  it("keeps the full pitch range independent of width-dependent sampling", () => {
    const index = new MIDIThumbnailIndex();
    index.update(Array.from({ length: 1000 }, (_, i) => note(i, i === 499 ? 84 : 60)).flat());
    for (const width of [64, 256, 260, 1024]) {
      expect(index.pitchRange).toEqual({ min: 60, max: 84 });
      expect(sampleMIDIThumbnailBars(index.visible(0, 1000, 1000), width).length)
        .toBeLessThanOrEqual(Math.max(64, width / 4));
    }
  });

  it("appends event deltas, grows held notes and closes them without duplicates", () => {
    const index = new MIDIThumbnailIndex();
    const first: MIDIEvent = { type: "noteOn", timestamp: 2, note: 64, velocity: 100 };
    const initial = [first];
    index.update(initial);
    expect(index.visible(0, 8, 4)).toEqual([{ note: 64, start: 2, end: 4 }]);
    index.update([...initial, { type: "noteOff", timestamp: 5, note: 64 }]);
    expect(index.visible(0, 8, 8)).toEqual([{ note: 64, start: 2, end: 5 }]);
    expect(index.visible(6, 8, 8)).toEqual([]);
  });

  it("queries only visible notes and rebuilds after replacing source events", () => {
    const index = new MIDIThumbnailIndex();
    index.update(Array.from({ length: 20000 }, (_, i) => note(i)).flat());
    expect(index.visible(19000, 19010, 20000)).toHaveLength(11);
    index.update(note(1, 72));
    expect(index.visible(0, 10, 10)).toEqual([{ note: 72, start: 1, end: 1.5 }]);
    expect(index.pitchRange).toEqual({ min: 72, max: 72 });
  });

  it("pairs overlapping pitches by channel and observes middle-event edits", () => {
    const index = new MIDIThumbnailIndex();
    const events: MIDIEvent[] = [
      { type: "noteOn", timestamp: 0, note: 60, channel: 1 },
      { type: "noteOn", timestamp: 1, note: 60, channel: 2 },
      { type: "noteOff", timestamp: 2, note: 60, channel: 2 },
      { type: "noteOff", timestamp: 4, note: 60, channel: 1 },
    ];
    index.update(events);
    expect(index.visible(0, 5, 5)).toEqual([{ note: 60, start: 0, end: 4 }, { note: 60, start: 1, end: 2 }]);
    index.update([events[0], events[1], { ...events[2], timestamp: 3 }, events[3]]);
    expect(index.visible(0, 5, 5)[1].end).toBe(3);
  });

  it("samples dense visible history exactly while cloning only the selected result", () => {
    const index = new MIDIThumbnailIndex();
    index.update(Array.from({ length: 50000 }, (_, i) => note(i / 100, i % 128)).flat());
    // The old allocating query must not be used by the sampled query.
    const oldVisible = index.visible.bind(index);
    index.visible = () => { throw new Error("sampleVisible materialized the whole result"); };
    for (const [start, end, duration] of [[0, 500, 500], [3.17, 490.09, 500], [489, 489.2, 500], [499.9, 501, 500], [600, 610, 700]]) {
      for (const width of [0, 63, 256, 257, 999.9, 1600]) {
        const expected = sampleMIDIThumbnailBars(oldVisible(start, end, duration), width);
        const actual = index.sampleVisible(start, end, duration, width);
        expect(actual).toEqual(expected);
        expect(actual.length).toBeLessThanOrEqual(Math.max(64, Math.floor(width / 4)));
      }
    }
    const sampled = index.sampleVisible(0, 500, 500, 256);
    sampled[0].end = -1;
    expect(index.sampleVisible(0, 500, 500, 256)[0].end).toBe(0.5);
  });

  it("preserves held notes, channels, append closure, edits and boundary inclusivity when sampling", () => {
    const index = new MIDIThumbnailIndex();
    const events: MIDIEvent[] = [
      { type: "noteOn", timestamp: 0, note: 60, channel: 1 },
      { type: "noteOn", timestamp: 1, note: 60, channel: 2 },
      ...Array.from({ length: 1000 }, (_, i) => note(2 + i / 100, i % 128)).flat(),
    ];
    const check = () => {
      for (const [start, end, duration] of [[0, 20, 20], [10, 10, 10], [10.1, 11, 12], [12, 20, 20], [0, 20, 0.5]])
        for (const width of [64, 800, 10000]) expect(index.sampleVisible(start, end, duration, width))
          .toEqual(sampleMIDIThumbnailBars(index.visible(start, end, duration), width));
    };
    index.update(events); check();
    index.update([...events, { type: "noteOff", timestamp: 14, note: 60, channel: 2 }, { type: "noteOff", timestamp: 15, note: 60, channel: 1 }]); check();
    index.update(note(4, 72)); check();
    expect(index.sampleVisible(0, 10, 10, NaN)).toHaveLength(1);
  });
});
