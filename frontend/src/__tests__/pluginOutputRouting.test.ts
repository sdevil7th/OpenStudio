import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { createDefaultTrack, useDAWStore, type Track } from "../store/useDAWStore";
import { advanceProjectEpoch } from "../utils/projectLifetime";
import { parseValidatedProject } from "../utils/projectValidation";

const initial = useDAWStore.getState();
const flush = async () => { for (let index = 0; index < 180; index++) await Promise.resolve(); };
const sends = () => useDAWStore.getState().tracks[0].sends;
let backend: Track["sends"];
let publications: Track["sends"][];
beforeEach(() => {
  commandManager.clear(); backend = []; publications = [];
  useDAWStore.setState({ ...initial, isModified: false, tracks: ["source", "kick", "snare"].map(id => createDefaultTrack(id, id, "#fff", "audio")) });
  vi.spyOn(nativeBridge, "replaceTrackSends").mockImplementation(async (_id, sends) => {
    backend = sends.map(send => ({ ...send }));
    publications.push(structuredClone(backend));
    return true;
  });
  vi.spyOn(nativeBridge, "addTrackSend");
  vi.spyOn(nativeBridge, "getTrackSends").mockImplementation(async () => backend.map(send => ({ ...send })));

});
afterEach(async () => { await flush(); vi.restoreAllMocks(); commandManager.clear(); useDAWStore.setState(initial); });

describe("plugin output pair routing", () => {
  it("restores ordered sends and every routing property through fast undo and redo", async () => {
    const actions = useDAWStore.getState();
    await actions.addTrackSend("source", "kick");
    await actions.addTrackSend("source", "snare");
    await actions.setTrackSendSourceChannel("source", 0, 2);
    await actions.setTrackSendSourceChannel("source", 1, 4);
    await actions.setTrackSendPreFader("source", 0, true);
    await actions.setTrackSendPhaseInvert("source", 0, true);
    await actions.setTrackSendEnabled("source", 0, false);
    const expected = structuredClone(sends());
    await actions.removeTrackSend("source", 0);
    expect(backend).toEqual(sends());
    publications = [];
    commandManager.undo(); commandManager.redo(); commandManager.undo();
    await flush();
    expect(sends()).toEqual(expected); expect(backend).toEqual(expected);
    expect(publications).toEqual([expected, [expected[1]], expected]);
    expect(publications.flat().every(send => (send.sourceChannel ?? 0) > 0)).toBe(true);
    expect(nativeBridge.addTrackSend).not.toHaveBeenCalled();
    expect(useDAWStore.getState().isModified).toBe(true);
  });
  it("keeps the previous routing and history when the engine rejects an output pair", async () => {
    await useDAWStore.getState().addTrackSend("source", "kick"); commandManager.clear();
    vi.mocked(nativeBridge.replaceTrackSends).mockResolvedValueOnce(false);
    await useDAWStore.getState().setTrackSendSourceChannel("source", 0, 2);
    expect(sends()[0].sourceChannel).toBe(0); expect(backend[0].sourceChannel).toBe(0);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("does not apply a late reply or continue native mutations in a replacement project", async () => {
    await useDAWStore.getState().addTrackSend("source", "kick"); commandManager.clear();
    let resolve!: (accepted: boolean) => void;
    vi.mocked(nativeBridge.replaceTrackSends).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = useDAWStore.getState().setTrackSendSourceChannel("source", 0, 2);
    await flush(); advanceProjectEpoch(); useDAWStore.setState({ tracks: initial.tracks, isModified: false });
    resolve(true); await pending;
    expect(useDAWStore.getState().tracks).toBe(initial.tracks);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("rejects feedback and duplicate destinations before native mutation", async () => {
    await useDAWStore.getState().addTrackSend("source", "kick");
    await useDAWStore.getState().addTrackSend("source", "kick");
    await useDAWStore.getState().addTrackSend("kick", "source");
    expect(nativeBridge.replaceTrackSends).toHaveBeenCalledTimes(1);
    expect(nativeBridge.addTrackSend).not.toHaveBeenCalled();
  });
  it.each([1, -2, 64, 2.5, "2"])("rejects invalid persisted pair %s", sourceChannel => {
    expect(() => parseValidatedProject(JSON.stringify({ tracks: [
      { id: "a", sends: [{ destTrackId: "b", sourceChannel }] }, { id: "b" },
    ] }))).toThrow("Invalid send output pair");
  });
  it("reads old projects as main stereo and preserves independent pairs", () => {
    const parsed = parseValidatedProject(JSON.stringify({ tracks: [
      { id: "a", sends: [{ destTrackId: "b" }, { destTrackId: "c", sourceChannel: 16 }] }, { id: "b" }, { id: "c" },
    ] }));
    expect((parsed.tracks[0].sends as Track["sends"]).map(send => send.sourceChannel)).toEqual([0, 16]);
  });
});
