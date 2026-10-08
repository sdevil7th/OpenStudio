import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { automationToBackend, parseSendAutomationParamId, sendAutomationParamId } from "../store/automationParams";
import { advanceProjectEpoch } from "../utils/projectLifetime";

const initial = useDAWStore.getState();
const flush = async () => { await vi.waitFor(() => expect(useDAWStore.getState().canRedo).toBe(commandManager.canRedo())); await new Promise(resolve => setTimeout(resolve, 0)); };
beforeEach(() => {
  commandManager.clear();
  vi.spyOn(nativeBridge, "replaceTrackSends").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationMode").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setAutomationPoints").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setTrackSendLevel").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "setTrackSendPan").mockResolvedValue(true);
  const source = createDefaultTrack("source", "Source", "#fff", "audio");
  source.sends = [{ destTrackId: "bus", level: 0.4, pan: 0, enabled: true, preFader: false, phaseInvert: false }];
  useDAWStore.setState({ ...initial, globalLocked: false, tracks: [source, createDefaultTrack("bus", "Bus", "#fff", "bus")], canUndo: false, canRedo: false });
});
afterEach(() => { useDAWStore.getState().endAutomationWriteSession(); useDAWStore.setState(initial); commandManager.clear(); vi.restoreAllMocks(); });

describe("send automation", () => {
  it("keeps a queued routing edit attached to its destination after an earlier removal", async () => {
    const store = useDAWStore.getState();
    useDAWStore.setState(state => ({ tracks: [...state.tracks.map(track => track.id === "source"
      ? { ...track, sends: [...track.sends, { ...track.sends[0], destTrackId: "other" }] } : track), createDefaultTrack("other", "Other", "#fff", "bus")] }));
    let resolve!: (value: boolean) => void;
    vi.mocked(nativeBridge.replaceTrackSends).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const removing = store.removeTrackSend("source", 0);
    await vi.waitFor(() => expect(nativeBridge.replaceTrackSends).toHaveBeenCalled());
    const changing = store.setTrackSendPreFader("source", 1, true);
    resolve(true);
    await Promise.all([removing, changing]);
    expect(useDAWStore.getState().tracks[0].sends).toEqual([expect.objectContaining({ destTrackId: "other", preFader: true })]);
  });

  it("retains new points for Undo when their destination is removed during a pending change", async () => {
    const store = useDAWStore.getState();
    const id = store.addAutomationLane("source", sendAutomationParamId("bus", "level"))!;
    store.addAutomationPoint("source", id, 1, 0.3);
    let resolve!: (value: boolean) => void;
    vi.mocked(nativeBridge.replaceTrackSends).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const changing = store.removeTrackSend("source", 0);
    await vi.waitFor(() => expect(nativeBridge.replaceTrackSends).toHaveBeenCalled());
    store.addAutomationPoint("source", id, 2, 0.8);
    const expected = structuredClone(useDAWStore.getState().tracks[0].automationLanes);
    resolve(true);
    await changing;
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual([]);
    store.undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].sends).toHaveLength(1));
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(expected);
  });

  it("leaves the send and lanes intact if native automation cannot be suspended", async () => {
    const store = useDAWStore.getState();
    const id = store.addAutomationLane("source", sendAutomationParamId("bus", "level"))!;
    store.addAutomationPoint("source", id, 1, 0.3);
    commandManager.clear();
    const expected = structuredClone(useDAWStore.getState().tracks[0]);
    vi.mocked(nativeBridge.setAutomationMode).mockResolvedValueOnce(false);
    vi.spyOn(nativeBridge, "getTrackSends").mockResolvedValue(expected.sends);
    await store.removeTrackSend("source", 0);
    expect(useDAWStore.getState().tracks[0]).toEqual(expected);
    expect(nativeBridge.replaceTrackSends).not.toHaveBeenCalled();
    expect(commandManager.canUndo()).toBe(false);
  });
  it("preserves edits to surviving send lanes during a pending routing change and its undo/redo", async () => {
    const store = useDAWStore.getState();
    const id = store.addAutomationLane("source", sendAutomationParamId("bus", "level"))!;
    store.addAutomationPoint("source", id, 1, 0.3);
    let resolve!: (value: boolean) => void;
    vi.mocked(nativeBridge.replaceTrackSends).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const changing = store.setTrackSendPreFader("source", 0, true);
    await vi.waitFor(() => expect(nativeBridge.replaceTrackSends).toHaveBeenCalled());
    store.addAutomationPoint("source", id, 2, 0.8);
    const expected = structuredClone(useDAWStore.getState().tracks[0].automationLanes);
    resolve(true);
    await changing;
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(expected);
    store.undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].sends[0].preFader).toBe(false));
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(expected);
    store.redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].sends[0].preFader).toBe(true));
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(expected);
  });

  it("does not capture mute automation or history when the engine rejects the send change", async () => {
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationWriteEnabled: true })),
      transport: { ...state.transport, isPlaying: true, currentTime: 2 } }));
    vi.mocked(nativeBridge.replaceTrackSends).mockResolvedValue(false);
    vi.spyOn(nativeBridge, "getTrackSends").mockResolvedValue(structuredClone(useDAWStore.getState().tracks[0].sends));
    await useDAWStore.getState().setTrackSendEnabled("source", 0, false);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ sends: [{ enabled: true }], automationLanes: [] });
    expect(commandManager.canUndo()).toBe(false);
  });

  it("preserves a concurrent send level gesture when changing routing", async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(nativeBridge.replaceTrackSends).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const store = useDAWStore.getState();
    const changing = store.setTrackSendPreFader("source", 0, true);
    await vi.waitFor(() => expect(nativeBridge.replaceTrackSends).toHaveBeenCalled());
    await store.setTrackSendLevel("source", 0, 0.9);
    resolve(true);
    await changing;
    expect(useDAWStore.getState().tracks[0].sends[0]).toMatchObject({ level: 0.9, preFader: true });
    expect(nativeBridge.replaceTrackSends).toHaveBeenLastCalledWith("source", [expect.objectContaining({ level: 0.9, preFader: true })]);
    store.undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].sends[0].preFader).toBe(false));
    expect(useDAWStore.getState().tracks[0].sends[0].level).toBe(0.9);
  });

  it("does not capture a late mute response into a replacement project", async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(nativeBridge.replaceTrackSends).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const changing = useDAWStore.getState().setTrackSendEnabled("source", 0, false);
    await vi.waitFor(() => expect(nativeBridge.replaceTrackSends).toHaveBeenCalled());
    advanceProjectEpoch();
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, automationWriteEnabled: true })),
      transport: { ...state.transport, isPlaying: true, currentTime: 2 } }));
    resolve(true);
    await changing;
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ sends: [{ enabled: true }], automationLanes: [] });
    expect(commandManager.canUndo()).toBe(false);
  });
  it("uses a stable escaped destination and normalized values", () => {
    const id = sendAutomationParamId("bus_with / %", "pan");
    expect(parseSendAutomationParamId(id)).toEqual({ destinationId: "bus_with / %", control: "pan" });
    expect(automationToBackend(id, 0.75)).toBe(0.75);
    expect(parseSendAutomationParamId("send_bus_%ZZ_level")).toBeNull();
  });
  it("removes a send's lanes and restores their points with Undo", async () => {
    const store = useDAWStore.getState();
    const lane = store.addAutomationLane("source", sendAutomationParamId("bus", "level"))!;
    store.addAutomationPoint("source", lane, 3, 0.7);
    await store.removeTrackSend("source", 0);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ sends: [], automationLanes: [] });
    store.undo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].sends).toHaveLength(1));
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points[0]).toMatchObject({ time: 3, value: 0.7 });
    store.redo();
    await vi.waitFor(() => expect(useDAWStore.getState().tracks[0].sends).toHaveLength(0));
    await flush();
    expect(nativeBridge.setAutomationPoints).toHaveBeenCalledWith("source", sendAutomationParamId("bus", "level"), []);
  });
  it("writes level, pan and mute from the routing controls", async () => {
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => track.id === "source" ? { ...track, automationWriteEnabled: true } : track), transport: { ...state.transport, isPlaying: true, currentTime: 2 } }));
    const state = useDAWStore.getState();
    state.beginTrackSendLevelEdit("source", 0);
    await state.setTrackSendLevel("source", 0, 0.8);
    state.recordAutomationWriteTick(1000);
    state.commitTrackSendLevelEdit("source", 0);
    state.beginTrackSendPanEdit("source", 0);
    await state.setTrackSendPan("source", 0, -0.4);
    state.recordAutomationWriteTick(1100);
    state.commitTrackSendPanEdit("source", 0);
    await state.setTrackSendEnabled("source", 0, false);
    const lanes = useDAWStore.getState().tracks[0].automationLanes;
    for (const [control, value] of [["level", 0.8], ["pan", 0.3], ["mute", 1]] as const) {
      const points = lanes.find(lane => lane.param === sendAutomationParamId("bus", control))?.points ?? [];
      expect(points[points.length - 1]?.value).toBeCloseTo(value);
    }
  });
});
