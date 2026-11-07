import { afterEach, expect, it, vi } from "vitest";
import { joinMIDIClips } from "../utils/joinMIDIClips";
import { parseMIDINotePairs } from "../utils/midiNotes";
import { serializeMIDIClipsForBackend } from "../utils/midiClipSerialization";
import { prepareImportedProjectRateCopy } from "../store/actions/audioConversion";
import { nativeBridge } from "../services/NativeBridge";
import type { DAWActions, DAWState, MIDIClip } from "../store/useDAWStore";

vi.mock("../store/useDAWStore", () => ({ createDefaultTrack: vi.fn(),
  useDAWStore: { getState: vi.fn(), setState: vi.fn(), subscribe: vi.fn(() => () => {}) } }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const first: MIDIClip = { id: "audible", name: "Audible", startTime: 0, duration: 4, color: "red", loopEnabled: false,
  events: [{ type: "noteOn", timestamp: 0, note: 60, velocity: 90, channel: 1 },
    { type: "noteOff", timestamp: 4, note: 60, velocity: 0, channel: 1 }] };
const second: MIDIClip = { id: "nested", name: "Nested", startTime: 1, duration: 1, color: "blue", loopEnabled: false,
  events: [{ type: "noteOn", timestamp: 0, note: 60, velocity: 70, channel: 1 },
    { type: "noteOff", timestamp: 1, note: 60, velocity: 0, channel: 1 }] };

it("joining a muted nested clip preserves the audible note", () => {
  const input = [first, { ...second, muted: true }];
  const before = serializeMIDIClipsForBackend(input).flatMap(clip => clip.events);
  const joined = joinMIDIClips(input)!;
  const after = serializeMIDIClipsForBackend([joined]).flatMap(clip => clip.events);
  expect(after).toEqual(before);
});

it("joining nested same-key notes preserves note durations", () => {
  const joined = joinMIDIClips([first, second])!;
  const notes = parseMIDINotePairs(joined.events).map(note => [note.startTime, note.duration]);
  expect(notes).toEqual([[0, 4], [1, 1]]);
});

it("revalidates project rate when an import conversion finishes before the polling timer", async () => {
  vi.useFakeTimers();
  const state = { projectSampleRate: 44100, projectPath: "C:/project/song.osproj", audioConversionJobs: {},
    showToast: vi.fn() } as unknown as DAWState & DAWActions;
  const get = () => state;
  const set = (patch: object | ((previous: typeof state) => object)) => Object.assign(state,
    typeof patch === "function" ? patch(state) : patch);
  let resolve!: (value: any) => void;
  vi.spyOn(nativeBridge, "createProjectRateCopy").mockImplementation(() => new Promise(yes => { resolve = yes; }));
  const input = { filePath: "C:/audio/source.wav", sampleRate: 48000, duration: 1, numChannels: 2, format: "WAV" };
  const pending = prepareImportedProjectRateCopy(set, get, "track", "clip", input, () => true);
  state.projectSampleRate = 96000;
  resolve({ success: true, filePath: "C:/project/old44100.wav", sampleRate: 44100 });
  expect(await pending).toEqual(input);
});
