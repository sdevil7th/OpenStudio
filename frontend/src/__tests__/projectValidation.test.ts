import { afterEach, describe, expect, it, vi } from "vitest";
import { graphProblem, parseValidatedProject } from "../utils/projectValidation";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";

const initial = useDAWStore.getState();
const track = (id: string, fields = {}) => ({ id, type: "audio", clips: [], ...fields });
const parse = (value: unknown) => parseValidatedProject(JSON.stringify(value));
afterEach(() => { vi.restoreAllMocks(); useDAWStore.setState(initial); commandManager.clear(); });

describe("project input boundary", () => {
  it.each([null, [], { tracks: {} }, { tracks: [null] }, { tracks: [track("a"), track("a")] },
    { tracks: [track("__proto__")] }, { tracks: [track("a", { clips: {} })] },
    { tracks: [track("a", { type: "unknown" })] }, { tracks: [track("a", { inputFXPaths: [null] })] },
    { tracks: [track("a", { trackFXStates: [{}] })] }, { tracks: [track("a", { sends: [{ destTrackId: "missing" }] })] },
    { tracks: [track("a", { parentFolderId: "b" }), track("b")] }, { tracks: [], undoHistory: { undoStack: {} } },
  ])("rejects malformed identities/collections before restoration: %j", value => {
    expect(() => parse(value)).toThrow();
  });
  it("rejects non-finite JSON numbers and prototype keys", () => {
    expect(() => parseValidatedProject('{"tracks":[],"tempo":1e999}')).toThrow(/non-finite/);
    expect(() => parseValidatedProject('{"tracks":[],"__proto__":{}}')).toThrow(/unsafe/);
  });
  it("rejects negative/invalid clip timing and duplicate audio/MIDI IDs", () => {
    expect(() => parse({ tracks: [track("a", { clips: [{ id: "c", duration: -1 }] })] })).toThrow(/duration/);
    expect(() => parse({ tracks: [track("a", { clips: [{ id: "c" }], midiClips: [{ id: "c" }] })] })).toThrow(/duplicate/);
  });
  it("permits retained takes referring to the same clip and bounds optional controls", () => {
    const clip = { id: "c", startTime: 2, duration: 1, offset: 0 };
    const data = parse({ tracks: [track("a", { clips: [clip], takes: [[clip]], pan: 100 })], tempo: "bad" });
    expect(data.tracks[0].pan).toBe(1);
    expect(data.tempo).toBe(120);
    expect(data.tracks[0].clips).toHaveLength(1);
  });
  it("normalizes a legacy minimal document and round-trips valid track data", () => {
    const data = parse({ tracks: [{ id: "legacy" }] });
    expect(data.tracks[0]).toMatchObject({ type: "audio", clips: [], midiClips: [], sends: [] });
    expect(parse(data)).toEqual(data);
  });
  it("bounds nested object structures", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 70; ++i) nested = { child: nested };
    expect(() => parse({ tracks: [], nested })).toThrow(/limit/);
  });
  it("rejects folder/send cycles, including disabled routes that could later be enabled", () => {
    expect(() => parse({ tracks: [track("a", { isFolder: true, parentFolderId: "b" }), track("b", { isFolder: true, parentFolderId: "a" })] })).toThrow(/cycle/);
    expect(() => parse({ tracks: [track("a", { sends: [{ destTrackId: "b", enabled: false }] }), track("b", { sends: [{ destTrackId: "a" }] })] })).toThrow(/cycle/);
  });
  it("handles a deep legal folder tree iteratively", () => {
    const tracks = Array.from({ length: 4096 }, (_, i) => ({ id: String(i), isFolder: true, parentFolderId: i ? String(i - 1) : undefined }));
    expect(graphProblem(tracks)).toBeNull();
  });
  it("leaves the current document and history untouched when loading fails validation", async () => {
    const kept = createDefaultTrack("keep", "Keep", "#fff", "audio");
    useDAWStore.setState({ tracks: [kept], projectName: "Current", isModified: true });
    vi.spyOn(nativeBridge, "loadProjectFromFile").mockResolvedValue(JSON.stringify({ tracks: [track("a"), track("a")] }));
    const reset = vi.spyOn(useDAWStore.getState(), "newProject");
    const revision = commandManager.getRevision();
    expect(await useDAWStore.getState().loadProject("C:/malformed.osproj")).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(useDAWStore.getState().tracks).toEqual([kept]);
    expect(useDAWStore.getState().projectName).toBe("Current");
    expect(commandManager.getRevision()).toBe(revision);
  });
  it("rejects live folder self/descendant moves and remains safe with already-corrupt state", () => {
    const a = { ...createDefaultTrack("a", "A", "#fff", "audio"), isFolder: true };
    const b = { ...createDefaultTrack("b", "B", "#fff", "audio"), isFolder: true, parentFolderId: "a" };
    useDAWStore.setState({ tracks: [a, b] });
    useDAWStore.getState().moveTracksToFolder(["a"], "b");
    expect(useDAWStore.getState().tracks).toEqual([a, b]);
    useDAWStore.setState({ tracks: [{ ...a, parentFolderId: "b" }, b, { ...a, id: "closed", folderCollapsed: true }] });
    expect(useDAWStore.getState().getVisibleTracks()).toHaveLength(3);
  });
});
