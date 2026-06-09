import { describe, expect, it } from "vitest";
import pianoRollSource from "../components/PianoRoll.tsx?raw";
import timelineSource from "../components/Timeline.tsx?raw";
import { serializeMIDIClipsForBackend } from "../utils/midiClipSerialization";

describe("MIDI editor timeline range", () => {
  it("keeps inline piano-roll scrolling padded instead of source-end bounded", () => {
    expect(pianoRollSource).toContain("EDITOR_HORIZONTAL_PADDING_BARS");
    expect(pianoRollSource).toContain("editorContentEnd");
    expect(pianoRollSource).toContain("contentDuration + editorPaddingSeconds");
    expect(pianoRollSource).toContain("loopDragEnd");
    expect(pianoRollSource).not.toContain("if (timelineScrollX > maxScrollX)");
  });

  it("autoscrolls while dragging MIDI loop boundaries near editor edges", () => {
    expect(pianoRollSource).toContain("LOOP_BOUNDARY_EDGE_SCROLL_ZONE_PX");
    expect(pianoRollSource).toContain("LOOP_BOUNDARY_EDGE_SCROLL_MAX_STEP_PX");
    expect(pianoRollSource).toContain("currentSourceTime");
    expect(pianoRollSource).toContain("projectXToMidiSourceTime");
  });

  it("counts MIDI clips when sizing the main timeline scroll range", () => {
    expect(timelineSource).toContain("track.midiClips.forEach");
    expect(timelineSource).toContain("const clipEnd = clip.startTime + clip.duration");
  });

  it("preserves overlapping MIDI clips as separate scheduled clips", () => {
    const clips = [
      {
        id: "clip-a",
        startTime: 10,
        duration: 4,
        sourceLength: 4,
        loopLength: 4,
        events: [
          { type: "noteOn", timestamp: 0, note: 60, velocity: 100 },
          { type: "noteOff", timestamp: 2, note: 60, velocity: 0 },
        ],
        ccEvents: [],
      },
      {
        id: "clip-b",
        startTime: 11,
        duration: 4,
        sourceLength: 4,
        loopLength: 4,
        events: [
          { type: "noteOn", timestamp: 0, note: 64, velocity: 100 },
          { type: "noteOff", timestamp: 2, note: 64, velocity: 0 },
        ],
        ccEvents: [],
      },
    ] as any;

    const serialized = serializeMIDIClipsForBackend(clips);

    expect(serialized).toHaveLength(2);
    expect(serialized.map((clip) => clip.startTime)).toEqual([10, 11]);
    expect(serialized[0].events.map((event) => event.timestamp)).toEqual([0, 2]);
    expect(serialized[1].events.map((event) => event.timestamp)).toEqual([0, 2]);
  });
});
