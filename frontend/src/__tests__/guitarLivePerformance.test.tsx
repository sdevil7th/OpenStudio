import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { GuitarPerformanceView } from "../components/builtin/GuitarLivePerformance";

type Performance = NonNullable<NonNullable<BuiltInPluginSchema["visualization"]>["guitarPerformance"]>;
const names = ["Sustain", "Palm mute", "Harmonic", "Legato", "Slide", "Slide in", "Slide out", "Dead note", "Pop"];
const snapshot: Performance = {
  available: true, scope: "block-end-voice-allocation",
  nextArticulations: [{ channel: 1, articulation: 0, source: "panel" }, { channel: 3, articulation: 2, source: "keyswitch" }],
  voices: [
    { channel: 3, slot: 1, note: 62, stringIndex: 2, articulation: 1, held: true, sustained: false, releasing: true, plucked: true, assigned: false },
    { channel: 3, slot: 2, note: 64, stringIndex: 2, articulation: 2, held: true, sustained: false, releasing: false, plucked: true, assigned: true },
    { channel: 1, slot: 0, note: 40, stringIndex: 0, articulation: 0, held: false, sustained: true, releasing: false, plucked: false, assigned: false },
  ],
};
describe("Guitar native performance readout", () => {
  it("keeps unavailable distinct from idle", () => {
    expect(renderToStaticMarkup(<GuitarPerformanceView performance={undefined} articulationNames={names} />)).toContain("allocation unavailable");
    const html = renderToStaticMarkup(<GuitarPerformanceView performance={{ ...snapshot, voices: [] }} articulationNames={names} />);
    expect(html.match(/>Idle</g)).toHaveLength(6);
    expect(html).not.toContain("allocation unavailable");
  });
  it("shows native voice articulation separately from the next channel override", () => {
    const html = renderToStaticMarkup(<GuitarPerformanceView performance={snapshot} articulationNames={names} />);
    expect(html).toContain("Palm mute");
    expect(html).toContain("Harmonic · assigned");
    expect(html).toContain("Ch 3: Harmonic · keyswitch");
    expect(html).toContain("Next notes: Sustain · panel");
    expect(html).toContain("ch 3 · releasing");
    expect(html).toContain("ch 1 · pedal");
    expect(html).toContain("Legacy voice");
    expect(html.indexOf("E4")).toBeLessThan(html.indexOf("D4"));
  });
  it("does not show stale voices from an incoherent snapshot", () => {
    const html = renderToStaticMarkup(<GuitarPerformanceView performance={{ ...snapshot, available: false }} articulationNames={names} />);
    expect(html).toContain("allocation unavailable");
    expect(html).not.toContain("Harmonic");
  });
});
