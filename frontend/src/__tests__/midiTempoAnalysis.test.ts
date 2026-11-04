import { describe, expect, it } from "vitest";
import { analyzeMIDIClipTempo } from "../utils/midiTempoAnalysis";
import type { MIDIClip, MIDIEvent } from "../store/useDAWStore";

function clipFor(onsets: number[], duration: number, chord = false): MIDIClip {
  const events: MIDIEvent[] = onsets.flatMap((timestamp, index) => (chord ? [48, 60, 67] : [60]).flatMap(note => [
    { type: "noteOn" as const, note, timestamp, velocity: 80 + index % 4 },
    { type: "noteOff" as const, note, timestamp: timestamp + 0.08, velocity: 0 },
  ])).sort((a, b) => a.timestamp - b.timestamp);
  return { id: "tempo-fixture", name: "Tempo fixture", startTime: 23.75, duration, offset: 0,
    sourceLength: duration, loopEnabled: false, color: "#123456", events };
}

describe("MIDI repeated beat-grid analysis", () => {
  it.each([90, 120, 137.23, 187.4])("retains a %s BPM pulse without using the project tempo", bpm => {
    const onsets = Array.from({ length: 64 }, (_, index) => 0.2 + index * 60 / bpm + (index % 3 - 1) * 0.001);
    const result = analyzeMIDIClipTempo(clipFor(onsets, onsets[onsets.length - 1] + 0.5));
    expect(result.error).toBeUndefined();
    expect(result.bpm).toBeCloseTo(bpm, 0);
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.beatOffsetSeconds).toBeGreaterThanOrEqual(0);
    expect(result.beatOffsetSeconds).toBeLessThan(60 / result.bpm);
  });

  it("does not count chord pitches as independent beats", () => {
    const onsets = Array.from({ length: 48 }, (_, index) => index * 0.5);
    const single = analyzeMIDIClipTempo(clipFor(onsets, 24));
    const chords = analyzeMIDIClipTempo(clipFor(onsets, 24, true));
    expect(chords.bpm).toBe(single.bpm);
    expect(chords.confidence).toBeCloseTo(single.confidence, 8);
  });

  it("reports changing pulses conservatively instead of inventing certainty", () => {
    const slow = Array.from({ length: 24 }, (_, index) => index * 60 / 90);
    const fast = Array.from({ length: 40 }, (_, index) => 16 + index * 60 / 150);
    const result = analyzeMIDIClipTempo(clipFor([...slow, ...fast], 32));
    expect(Boolean(result.error) || result.confidence <= 0.35).toBe(true);
    if (!result.error) expect(result.warning).toContain("Different sections");
  });

  it("rejects unmetered random onsets", () => {
    let seed = 123456;
    const onsets = Array.from({ length: 600 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32 * 40;
    }).sort((a, b) => a - b);
    const result = analyzeMIDIClipTempo(clipFor(onsets, 40));
    expect(result.error).toBeTruthy();
    expect(result.confidence).toBe(0);
  });

  it("analyzes only the requested retained range", () => {
    const slow = Array.from({ length: 20 }, (_, index) => index * 0.75);
    const fast = Array.from({ length: 32 }, (_, index) => 16 + index * 0.4);
    const result = analyzeMIDIClipTempo(clipFor([...slow, ...fast], 30), { startSeconds: 16, durationSeconds: 12 });
    expect(result.bpm).toBeCloseTo(150, 0);
    expect(result.analysisStartSeconds).toBe(16);
    expect(result.analysisDurationSeconds).toBe(12);
  });
});
