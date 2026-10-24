import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { getRegisteredAction } from "../store/actionRegistry";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  getEffectiveActionShortcuts,
  matchesActionShortcut,
  resolveRegistryShortcutAction,
} from "../utils/globalShortcutDispatcher";
import { activateShortcutContext, resetShortcutContextForTests } from "../utils/shortcutContext";

const original = useDAWStore.getState();
const platforms = ["windows", "macos"] as const;
let testNow = Date.now();

beforeEach(() => {
  resetShortcutContextForTests();
  const track = createDefaultTrack("record-track", "Record", "#123456", "audio", []);
  track.armed = true;
  useDAWStore.setState({
    ...original,
    tracks: [track],
    selectedTrackId: track.id,
    selectedTrackIds: [track.id],
    keyboardShortcutProfileId: "openstudio",
    customShortcuts: {},
    stepInputEnabled: false,
  });
  vi.spyOn(Date, "now").mockImplementation(() => testNow += 200);
});

afterEach(() => {
  resetShortcutContextForTests();
  useDAWStore.setState(original);
  vi.restoreAllMocks();
});

describe("single-key transport and zoom", () => {
  it.each(platforms)("records from every editor scope on %s", platform => {
    const toggleRecord = vi.fn();
    useDAWStore.setState({ toggleRecord });
    for (const kind of ["timeline", "timeline_ruler", "track_control_panel", "mixer", "piano_roll", "pitch_editor"] as const) {
      activateShortcutContext(kind === "piano_roll" ? { kind, sessionId: "record-test" } : { kind });
      for (const recordMode of ["normal", "overdub", "replace"] as const) {
        useDAWStore.setState({ recordMode });
        expect(dispatchGlobalShortcut({ key: "r", code: "KeyR", source: "test" }, platform)).toBe(true);
      }
    }
    expect(toggleRecord).toHaveBeenCalledTimes(18);
    expect(matchesActionShortcut({ key: "r", code: "KeyR", ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) }, "transport.record", platform)).toBe(true);
    expect(matchesActionShortcut({ key: "*", code: "NumpadMultiply", location: 3 }, "transport.record", platform)).toBe(true);
    expect(matchesActionShortcut({ key: "*", code: "Digit8", shiftKey: true }, "transport.record", platform)).toBe(false);
  });

  it("does not record while typing or repeatedly toggle a held key", () => {
    const toggleRecord = vi.fn();
    useDAWStore.setState({ toggleRecord });
    expect(dispatchGlobalShortcut({ key: "r", code: "KeyR", source: "test", targetIsEditable: true }, "windows")).toBe(false);
    expect(dispatchGlobalShortcut({ key: "r", code: "KeyR", source: "test", repeat: true }, "windows")).toBe(true);
    expect(toggleRecord).not.toHaveBeenCalled();
  });

  it("forwards detached editor Record to the main transport", () => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    activateShortcutContext({ kind: "piano_roll", sessionId: "detached-record" });
    expect(dispatchGlobalShortcut({ key: "r", code: "KeyR", source: "test" }, "windows", { role: "midi" })).toBe(true);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ command: "action.execute", actionId: "transport.record" }));
  });

  it.each(platforms)("keeps track arm and MIDI range reachable on %s", platform => {
    const event = { key: "R", code: "KeyR", shiftKey: true, ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) };
    activateShortcutContext({ kind: "track_control_panel" });
    expect(resolveRegistryShortcutAction(event, platform, { canHandleAction: () => true })?.action.id).toBe("track.toggleSelectedArm");
    activateShortcutContext({ kind: "piano_roll", sessionId: "range-test" });
    expect(resolveRegistryShortcutAction(event, platform, { canHandleAction: () => true })?.action.id).toBe("midi.tool.range");
  });

  it("seeks to absolute zero and reveals the project beginning with 1 or Home", async () => {
    const setPosition = vi.spyOn(nativeBridge, "setTransportPosition").mockResolvedValue(true);
    const seekTo = vi.spyOn(useDAWStore.getState(), "seekTo");
    const selection = { start: 12, end: 20 };
    useDAWStore.setState({
      scrollX: 800,
      scrollY: 140,
      timeSelection: selection,
      transport: { ...original.transport, currentTime: 14, isPlaying: false, isRecording: false, loopEnabled: true, loopStart: 12, loopEnd: 20 },
    });
    activateShortcutContext({ kind: "pitch_editor" });
    expect(resolveRegistryShortcutAction({ key: "1", code: "Digit1" }, "windows", { canHandleAction: () => true })?.action.id).toBe("transport.rewind");
    expect(matchesActionShortcut({ key: "Home", code: "Home" }, "transport.rewind", "windows")).toBe(true);
    await getRegisteredAction("transport.rewind")?.execute();
    expect(seekTo).toHaveBeenCalledWith(0);
    expect(setPosition).toHaveBeenCalledWith(0);
    expect(useDAWStore.getState()).toMatchObject({ scrollX: 0, scrollY: 140, timeSelection: selection, transport: { currentTime: 0, loopStart: 12, loopEnd: 20 } });
    expect(matchesActionShortcut({ key: "v", code: "KeyV" }, "pitch.tool.select", "windows")).toBe(true);
  });

  it("accepts main-keyboard and numpad zoom keys over the full timeline range", () => {
    for (const event of [
      { key: "+", code: "Equal", shiftKey: true },
      { key: "=", code: "Equal" },
      { key: "+", code: "NumpadAdd", location: 3 },
    ]) expect(matchesActionShortcut(event, "view.zoomIn", "windows")).toBe(true);
    for (const event of [
      { key: "-", code: "Minus" },
      { key: "-", code: "NumpadSubtract", location: 3 },
    ]) expect(matchesActionShortcut(event, "view.zoomOut", "windows")).toBe(true);

    useDAWStore.setState({ pixelsPerSecond: 900 });
    getRegisteredAction("view.zoomIn")?.execute();
    expect(useDAWStore.getState().pixelsPerSecond).toBe(1000);
    useDAWStore.setState({ pixelsPerSecond: 1.1 });
    getRegisteredAction("view.zoomOut")?.execute();
    expect(useDAWStore.getState().pixelsPerSecond).toBe(1);
  });

  it("preserves source profiles and explicit custom overrides", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "ardour" });
    expect(matchesActionShortcut({ key: "+", code: "NumpadAdd" }, "view.zoomIn", "windows")).toBe(false);
    expect(matchesActionShortcut({ key: "+", code: "NumpadAdd" }, "edit.nudgeRight", "windows")).toBe(true);
    useDAWStore.setState({ keyboardShortcutProfileId: "cubase" });
    activateShortcutContext({ kind: "timeline" });
    expect(resolveRegistryShortcutAction({ key: "1", code: "Digit1" }, "windows", { canHandleAction: () => true })?.action.id).toBe("tools.selectTool");
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: { "transport.record": "F12", "view.zoomIn": "" } });
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "transport.record", "windows")).toBe(false);
    expect(matchesActionShortcut({ key: "F12", code: "F12" }, "transport.record", "windows")).toBe(true);
    expect(getEffectiveActionShortcuts(getRegisteredAction("view.zoomIn")!, "windows")).toEqual([]);
  });
});
