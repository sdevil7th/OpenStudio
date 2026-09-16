import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPluginAutomationCapture, type PluginParameterEdit } from "../services/pluginAutomationCapture";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { _automationTouchedParams, automationTouchKey } from "../store/actions/storeHelpers";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import { resetShortcutContextForTests } from "../utils/shortcutContext";

const initial = useDAWStore.getState();
let emit: (event: PluginParameterEdit) => void;
let stop: () => void;
const param = "plugin_track_0_1";
function event(phase: PluginParameterEdit["phase"], value = 0.7, id = param) {
  emit({ trackId: "track", param: id, phase, value });
}

beforeEach(() => {
  vi.useFakeTimers();
  commandManager.clear();
  const track = createDefaultTrack("track", "Track", "#fff", "audio");
  useDAWStore.setState({ ...initial, tracks: [track], isModified: false,
    keyboardShortcutProfileId: "cubase", customShortcuts: {},
    transport: { ...initial.transport, isPlaying: true, currentTime: 2 } });
  vi.spyOn(nativeBridge, "subscribe").mockImplementation((id, handler) => {
    if (id === "pluginParameterEdit") emit = handler;
    return () => {};
  });
  stop = startPluginAutomationCapture();
});
afterEach(() => {
  stop();
  useDAWStore.getState().endAutomationWriteSession();
  commandManager.clear();
  useDAWStore.setState(initial);
  resetShortcutContextForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native plugin and detached NAM automation capture", () => {
  it.each([param, "plugin_instrument_0_0", "builtin_track_0_ampGainDb", "builtin_input_1_mix"])("captures brief %s edits and allows undo", id => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("begin", 0.3, id); event("value", 0.8, id); event("end", 0.8, id);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([
      expect.objectContaining({ time: 2, value: 0.8 }),
    ]);
    expect(_automationTouchedParams.has(automationTouchKey("track", id))).toBe(false);
    useDAWStore.getState().endAutomationWriteSession();
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points).toEqual([]);
  });
  it("marks stopped edits unsaved without creating automation", () => {
    useDAWStore.setState({ transport: { ...initial.transport, isPlaying: false } });
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("value");
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual([]);
  });
  it("ignores restore notifications while opening a project", () => {
    useDAWStore.setState({ isProjectLoading: true }); event("value");
    expect(useDAWStore.getState().isModified).toBe(false);
  });
  it("times out value-only plugins without ending explicit held gestures", () => {
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("value"); vi.advanceTimersByTime(181);
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(false);
    event("begin"); event("value"); vi.advanceTimersByTime(1000);
    expect(_automationTouchedParams.has(automationTouchKey("track", param))).toBe(true);
    event("end");
  });
  it("latches the last edit until Write is disabled", () => {
    useDAWStore.getState().setAutomationWriteBehavior("latch");
    useDAWStore.getState().setTrackAutomationWrite("track", true);
    event("begin"); event("value"); event("end");
    useDAWStore.setState({ transport: { ...useDAWStore.getState().transport, currentTime: 3 } });
    useDAWStore.getState().recordAutomationWriteTick(Date.now() + 1000);
    expect(useDAWStore.getState().tracks[0].automationLanes[0].points.slice(-1)[0]?.time).toBe(3);
    useDAWStore.getState().setTrackAutomationWrite("track", false);
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(true);
  });
  it("dispatches Cubase all-track R/W and F6 with timeline/global focus", () => {
    dispatchGlobalShortcut({ key: "w", code: "KeyW", altKey: true });
    expect(useDAWStore.getState().tracks[0].automationWriteEnabled).toBe(true);
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(true);
    dispatchGlobalShortcut({ key: "w", code: "KeyW", altKey: true });
    expect(useDAWStore.getState().tracks[0].automationWriteEnabled).toBe(false);
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(true);
    dispatchGlobalShortcut({ key: "r", code: "KeyR", altKey: true });
    expect(useDAWStore.getState().tracks[0].automationReadEnabled).toBe(false);
    dispatchGlobalShortcut({ key: "F6", code: "F6" });
    expect(useDAWStore.getState().showEnvelopeManager).toBe(true);
  });
  it("keeps master Read enabled when Write is switched off before recording", () => {
    useDAWStore.getState().setMasterAutomationRead(true);
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(true);
    useDAWStore.getState().setMasterAutomationWrite(true);
    useDAWStore.getState().setMasterAutomationWrite(false);
    expect(useDAWStore.getState().masterAutomationReadEnabled).toBe(true);
  });
  it("removes instrument lanes with the plugin and restores them on undo", async () => {
    vi.spyOn(nativeBridge, "getInstrumentState").mockResolvedValue("saved");
    vi.spyOn(nativeBridge, "removeInstrument").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "loadInstrument").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setInstrumentState").mockResolvedValue(true);
    useDAWStore.setState({ tracks: [{ ...useDAWStore.getState().tracks[0], type: "instrument", instrumentPlugin: "Kontakt" }] });
    useDAWStore.getState().addAutomationLane("track", "plugin_instrument_0_0");
    useDAWStore.getState().addAutomationLane("track", "plugin_track_0_0");
    const before = useDAWStore.getState().tracks[0].automationLanes;
    await useDAWStore.getState().removeInstrumentWithUndo("track");
    expect(useDAWStore.getState().tracks[0].automationLanes.map(lane => lane.param)).toEqual(["plugin_track_0_0"]);
    commandManager.undo();
    for (let i = 0; i < 12; ++i) await Promise.resolve();
    expect(useDAWStore.getState().tracks[0].automationLanes).toEqual(expect.arrayContaining(before));
    expect(nativeBridge.setInstrumentState).toHaveBeenCalledWith("track", "saved");
  });
});
