import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDisplayEffectiveShortcut } from "../store/actionRegistry";
import { useDAWStore, type Track } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  matchesActionShortcut,
} from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  registerShortcutSurface,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

describe("runtime shortcut profile dispatch", () => {
  const original = {
    keyboardShortcutProfileId: useDAWStore.getState().keyboardShortcutProfileId,
    customShortcuts: useDAWStore.getState().customShortcuts,
    transport: useDAWStore.getState().transport,
    toggleRecord: useDAWStore.getState().toggleRecord,
    toggleTrackArmed: useDAWStore.getState().toggleTrackArmed,
    toggleTrackMute: useDAWStore.getState().toggleTrackMute,
    toggleTrackSolo: useDAWStore.getState().toggleTrackSolo,
    toggleSelectedTracksArmed: useDAWStore.getState().toggleSelectedTracksArmed,
    toggleSelectedTracksMute: useDAWStore.getState().toggleSelectedTracksMute,
    toggleSelectedTracksSolo: useDAWStore.getState().toggleSelectedTracksSolo,
    toggleStepInput: useDAWStore.getState().toggleStepInput,
    selectedTrackIds: useDAWStore.getState().selectedTrackIds,
    tracks: useDAWStore.getState().tracks,
  };

  beforeEach(() => {
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });
  });

  afterEach(() => {
    resetShortcutContextForTests();
    useDAWStore.setState(original);
  });

  it("switches matching immediately without rewriting factory shortcuts", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "pro_tools" });
    expect(matchesActionShortcut({ key: "e", code: "KeyE", ctrlKey: true }, "edit.splitAtCursor")).toBe(true);
    expect(matchesActionShortcut({ key: "s", code: "KeyS" }, "edit.splitAtCursor")).toBe(false);
  });

  it("lets a custom binding override the active profile", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "pro_tools",
      customShortcuts: { "edit.splitAtCursor": "Code:KeyK" },
    });
    expect(matchesActionShortcut({ key: "k", code: "KeyK" }, "edit.splitAtCursor")).toBe(true);
    expect(matchesActionShortcut({ key: "e", code: "KeyE", ctrlKey: true }, "edit.splitAtCursor")).toBe(false);
  });

  it("keeps physical key profiles stable when the produced layout label changes", () => {
    useDAWStore.setState({ customShortcuts: { "tools.splitTool": "Code:KeyB" } });
    expect(matchesActionShortcut({ key: "x", code: "KeyB" }, "tools.splitTool")).toBe(true);
  });

  it("treats an explicit empty custom binding as unassigned", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "pro_tools",
      customShortcuts: { "edit.splitAtCursor": "" },
    });
    expect(matchesActionShortcut({ key: "e", code: "KeyE", ctrlKey: true }, "edit.splitAtCursor")).toBe(false);
    expect(getDisplayEffectiveShortcut("edit.splitAtCursor")).toBe("");
  });

  it("does not let factory-scoped R tools shadow a profile's global Record", () => {
    const toggleRecord = vi.fn();
    const toggleTrackArmed = vi.fn();
    const current = useDAWStore.getState();
    useDAWStore.setState({
      keyboardShortcutProfileId: "garageband",
      transport: { ...current.transport, isRecording: true },
      toggleRecord,
      toggleTrackArmed,
    });
    registerShortcutSurface({ kind: "piano_roll", sessionId: "profile-record-test" }, () => "unmatched");
    activateShortcutContext({ kind: "piano_roll", sessionId: "profile-record-test" });

    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "transport.record")).toBe(true);
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "track.toggleSelectedArm")).toBe(false);
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "midi.tool.range")).toBe(false);
    expect(dispatchGlobalShortcut({ key: "r", code: "KeyR", source: "browser" })).toBe(true);
    expect(toggleRecord).toHaveBeenCalledTimes(1);
    expect(toggleTrackArmed).not.toHaveBeenCalled();
  });

  it("makes GarageBand selected-track M/S commands reachable from Timeline focus", () => {
    const toggleSelectedTracksMute = vi.fn(() => true);
    const toggleSelectedTracksSolo = vi.fn(() => true);
    useDAWStore.setState({
      keyboardShortcutProfileId: "garageband",
      selectedTrackIds: ["track-1"],
      toggleSelectedTracksMute,
      toggleSelectedTracksSolo,
    });
    registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });

    expect(matchesActionShortcut({ key: "m", code: "KeyM" }, "insert.marker")).toBe(false);
    expect(matchesActionShortcut({ key: "s", code: "KeyS" }, "edit.splitAtCursor")).toBe(false);
    expect(dispatchGlobalShortcut({ key: "m", code: "KeyM", source: "browser" })).toBe(true);
    expect(dispatchGlobalShortcut({ key: "s", code: "KeyS", source: "browser" })).toBe(true);
    expect(toggleSelectedTracksMute).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksSolo).toHaveBeenCalledTimes(1);
  });

  it("makes Cakewalk Alt+M/S/R selected-track commands reachable from Timeline focus", () => {
    const toggleSelectedTracksMute = vi.fn(() => true);
    const toggleSelectedTracksSolo = vi.fn(() => true);
    const toggleSelectedTracksArmed = vi.fn(() => true);
    const track = { id: "track-1", armed: false, recordSafe: false } as Track;
    useDAWStore.setState({
      keyboardShortcutProfileId: "cakewalk_sonar",
      selectedTrackIds: [track.id],
      tracks: [track],
      toggleSelectedTracksMute,
      toggleSelectedTracksSolo,
      toggleSelectedTracksArmed,
    });
    registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });

    for (const key of ["m", "s", "r"] as const) {
      expect(dispatchGlobalShortcut({ key, code: `Key${key.toUpperCase()}`, altKey: true, source: "browser" })).toBe(true);
    }
    expect(toggleSelectedTracksMute).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksSolo).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksArmed).toHaveBeenCalledTimes(1);
  });

  it("does not let scoped R fallbacks steal REAPER loop or Pro Tools zoom", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "reaper" });
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "transport.loop")).toBe(true);
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "track.toggleSelectedArm")).toBe(false);
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "midi.tool.range")).toBe(false);

    useDAWStore.setState({ keyboardShortcutProfileId: "pro_tools" });
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "view.zoomOut")).toBe(true);
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "track.toggleSelectedArm")).toBe(false);
    expect(matchesActionShortcut({ key: "r", code: "KeyR" }, "midi.tool.range")).toBe(false);
  });

  it.each(["macos", "windows"] as const)("does not equate Renoise Edit Mode Esc with Piano Roll step input on %s", (platform) => {
    const toggleStepInput = vi.fn();
    useDAWStore.setState({
      keyboardShortcutProfileId: "renoise",
      toggleStepInput,
    });
    registerShortcutSurface({ kind: "piano_roll", sessionId: `renoise-${platform}` }, () => "unmatched");
    activateShortcutContext({ kind: "piano_roll", sessionId: `renoise-${platform}` });

    expect(matchesActionShortcut(
      { key: "Escape", code: "Escape" },
      "midi.closeEditor",
      platform,
    )).toBe(false);
    expect(matchesActionShortcut(
      { key: "Escape", code: "Escape" },
      "midi.toggleStepInput",
      platform,
    )).toBe(false);
    expect(dispatchGlobalShortcut(
      { key: "Escape", code: "Escape", source: "browser" },
      platform,
    )).toBe(false);
    expect(toggleStepInput).not.toHaveBeenCalled();
  });
});
