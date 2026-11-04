import { afterEach, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore, type MIDIClip } from "../store/useDAWStore";
import { exportMIDISelection } from "../utils/midiSelectionExport";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const clip = (id: string, startTime: number, muted = false): MIDIClip => ({ id, name: id, startTime,
    duration: 2, offset: 0.5, color: "#abc", muted, loopEnabled: false,
    events: [{ type: "noteOn", note: 60, channel: 2, velocity: 80, timestamp: 0 },
      { type: "noteOff", note: 60, channel: 2, velocity: 30, timestamp: 2 }] });
  return { ...useDAWStore.getState(), selectedClipIds: ["a", "b", "muted"], selectedClipId: "a",
    transport: { ...useDAWStore.getState().transport, tempo: 120 }, timeSignature: { numerator: 3, denominator: 4 },
    tempoMarkers: [{ id: "first", time: 2, tempo: 90 }, { id: "change", time: 7, tempo: 100 }],
    tracks: [{ ...createDefaultTrack("first", "First", "#abc", "midi"), midiClips: [clip("a", 4), clip("excluded", 0)] },
      { ...createDefaultTrack("second", "Second", "#abc", "midi"), midiClips: [clip("b", 9), clip("muted", 12, true)],
        midiEffects: [{ id: "pitch", type: "pitch" as const, enabled: true, semitones: 12 }] }], showToast: vi.fn() };
}

it("exports one file with separate source tracks, rebased tempo, gaps, trims and MIDI effects applied once", async () => {
  const state = fixture();
  const before = JSON.stringify(state.tracks);
  vi.spyOn(nativeBridge, "showSaveDialog").mockResolvedValue("selected.mid");
  const write = vi.spyOn(nativeBridge, "exportProjectMIDI").mockResolvedValue(true);
  await exportMIDISelection(state);
  expect(write).toHaveBeenCalledOnce();
  const [path, tracks, options] = write.mock.calls[0];
  expect(path).toBe("selected.mid");
  expect(tracks.map(t => [t.name, t.clips.map((c: { id: string; startTime: number }) => [c.id, c.startTime])]))
    .toEqual([["First", [["a", 0]]], ["Second", [["b", 5]]]]);
  expect(tracks[0].clips[0].events.map((e: { timestamp: number }) => e.timestamp)).toEqual([0, 1.5]);
  expect(tracks[1].clips[0].events.map((e: { note: number }) => e.note)).toEqual([72, 72]);
  expect(options).toEqual({ tempo: 90, tempoMarkers: [{ time: 3, bpm: 100 }], timeSignature: { numerator: 3, denominator: 4 } });
  expect(JSON.stringify(state.tracks)).toBe(before);
});

it("snapshots the complete export before the save dialog, even if the project changes", async () => {
  const state = fixture();
  let resolve!: (path: string) => void;
  vi.spyOn(nativeBridge, "showSaveDialog").mockImplementation(() => new Promise(done => { resolve = done; }));
  const write = vi.spyOn(nativeBridge, "exportProjectMIDI").mockResolvedValue(true);
  const pending = exportMIDISelection(state);
  state.tracks[0].midiClips[0].events[0].note = 70;
  state.timeSignature.numerator = 7;
  state.tempoMarkers[0].tempo = 200;
  state.selectedClipIds = [];
  resolve("saved.mid");
  await pending;
  expect(write.mock.calls[0][1][0].clips[0].events[0].note).toBe(60);
  expect(write.mock.calls[0][2]).toMatchObject({ tempo: 90, timeSignature: { numerator: 3 } });
});

it("cancelling the dialog leaves the document and file writer untouched", async () => {
  vi.spyOn(nativeBridge, "showSaveDialog").mockResolvedValue("");
  const write = vi.spyOn(nativeBridge, "exportProjectMIDI");
  const state = fixture();
  await exportMIDISelection(state);
  expect(write).not.toHaveBeenCalled();
  expect(state.showToast).not.toHaveBeenCalled();
});

it("reports a rejected native export without an unhandled promise", async () => {
  vi.spyOn(nativeBridge, "showSaveDialog").mockResolvedValue("saved.mid");
  vi.spyOn(nativeBridge, "exportProjectMIDI").mockRejectedValue(new Error("Disk full"));
  const state = fixture();
  await exportMIDISelection(state);
  expect(state.showToast).toHaveBeenCalledWith("Failed to export MIDI clips: Disk full", "error");
});
