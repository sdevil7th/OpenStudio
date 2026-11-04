import { describe, expect, it } from "vitest";
import type { MIDIClip, MIDIEvent } from "../store/useDAWStore";
import { joinMIDIClips } from "../utils/joinMIDIClips";
import { applyNoteMetadataValueToEvents, clipboardItemsFromPairs, eventsFromClipboardItems, parseMIDINotePairs, rebuildMIDIEventsForNotes } from "../utils/midiNotes";
import { getVisibleMIDIEventsForClip, serializeMIDIClipsForBackend } from "../utils/midiClipSerialization";
import { parseValidatedProject } from "../utils/projectValidation";

function clip(id: string, start: number, duration: number, channel = 1): MIDIClip {
  return { id, name: id, startTime: start, duration, offset: 0, loopEnabled: false, color: "#abcdef",
    events: [{ type: "noteOn", note: 60, channel, timestamp: 0, velocity: 80, pressure: 0.3, slide: 0.7 },
      { type: "noteOff", note: 60, channel, timestamp: duration, velocity: 25, releaseVelocity: 25 }] };
}
function audible(clips: MIDIClip[]) {
  return serializeMIDIClipsForBackend(clips).flatMap(c => c.events.map(e => ({ ...e, timestamp: e.timestamp + c.startTime })))
    .sort((a, b) => a.timestamp - b.timestamp || a.channel - b.channel || (a.velocity ?? 0) - (b.velocity ?? 0));
}

describe("joined note identities", () => {
  for (const muted of [false, true]) for (const channel of [1, 2]) {
    it(`preserves nested pairs, releases and playback with muted=${muted}, channel=${channel}`, () => {
      const clips = [clip("long", 3, 4), { ...clip("short", 4, 1, channel), muted }];
      const joined = joinMIDIClips(clips)!;
      expect(audible([joined])).toEqual(audible(clips));
      expect(parseMIDINotePairs(joined.events).map(n => [n.startTime, n.duration, n.muted, n.releaseVelocity, n.pressure, n.slide]))
        .toEqual([[0, 4, false, 25, 0.3, 0.7], [1, 1, muted, 25, 0.3, 0.7]]);
    });
  }

  it("preserves explicit pairs across legacy project validation and JSON round trips without a schema change", () => {
    const legacy = clip("legacy", 0, 4);
    const joined = joinMIDIClips([legacy, clip("short", 1, 1)])!;
    for (const source of [legacy, joined]) {
      const parsed = parseValidatedProject(JSON.stringify({ tracks: [{ id: "track", type: "midi", clips: [], midiClips: [source] }] }));
      const restored = (parsed.tracks[0].midiClips as MIDIClip[])[0];
      expect(restored.events).toEqual(source.events);
      expect(audible([restored])).toEqual(audible([source]));
    }
  });

  it("retains pairs through trim, stretch, looping and repeated joining", () => {
    const joined = joinMIDIClips([clip("long", 0, 4), clip("short", 1, 1)])!;
    const trimmed = { ...joined, offset: 0.5, duration: 3 };
    expect(parseMIDINotePairs(getVisibleMIDIEventsForClip(trimmed)).map(n => [n.startTime, n.duration]))
      .toEqual([[0, 3], [0.5, 1]]);
    const stretched = { ...joined, duration: 8, events: joined.events.map(e => ({ ...e, timestamp: e.timestamp * 2 })) };
    expect(parseMIDINotePairs(stretched.events).map(n => n.duration)).toEqual([8, 2]);
    const looped = { ...joined, loopEnabled: true, sourceLength: 4, loopLength: 4, duration: 8 };
    const repeated = joinMIDIClips([looped, { ...joined, id: "copy", startTime: 10 }])!;
    expect(parseMIDINotePairs(repeated.events).map(n => [n.startTime, n.duration]))
      .toEqual([[0, 4], [1, 1], [4, 4], [5, 1], [10, 4], [11, 1]]);
  });

  it("edits and copies one simultaneous same-key note without modifying its neighbour", () => {
    const joined = joinMIDIClips([clip("long", 0, 4), clip("short", 0, 1)])!;
    const pairs = parseMIDINotePairs(joined.events, joined.id);
    expect(pairs[0].id).not.toBe(pairs[1].id);
    const edited = rebuildMIDIEventsForNotes(joined.events, joined.id, [pairs[1].id], () => ({ velocity: 42 }));
    expect(parseMIDINotePairs(edited.events).map(n => [n.velocity, n.duration, n.releaseVelocity])).toEqual([[80, 4, 25], [42, 1, 25]]);
    const copied = eventsFromClipboardItems(joined.id, clipboardItemsFromPairs([pairs[1]]), 0.25, 4);
    expect(copied.events[0].notePairId).not.toBe(pairs[1].noteOn.notePairId);
    expect(parseMIDINotePairs([...joined.events, ...copied.events]).map(n => n.duration)).toEqual([4, 1, 1]);
  });

  it("does not pair orphan tagged events with unrelated legacy releases", () => {
    const events: MIDIEvent[] = [{ type: "noteOn", note: 60, timestamp: 0, velocity: 80, notePairId: "lost" },
      { type: "noteOff", note: 60, timestamp: 2 }];
    expect(parseMIDINotePairs(events)).toEqual([]);
  });

  it("keeps metadata edits isolated for simultaneous joined notes with identical releases", () => {
    const joined = joinMIDIClips([clip("first", 0, 1), clip("second", 0, 1)])!;
    const selected = parseMIDINotePairs(joined.events, joined.id)[1];
    let events = applyNoteMetadataValueToEvents(joined.events, selected, "noteOffVelocity", 48);
    events = applyNoteMetadataValueToEvents(events, selected, "chance", 30);
    events = applyNoteMetadataValueToEvents(events, selected, "velocityVariance", 12);
    expect(parseMIDINotePairs(events).map(n => [n.releaseVelocity, n.probability, n.velocityVariance]))
      .toEqual([[25, undefined, undefined], [48, 0.3, 12]]);
  });
});
