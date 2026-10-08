import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredAction } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { dispatchGlobalShortcut, getEffectiveActionShortcuts } from "../utils/globalShortcutDispatcher";
import { resetShortcutContextForTests } from "../utils/shortcutContext";
import { formatShortcutForPlatform, type ShortcutPlatform } from "../utils/platform";
import { KEYBOARD_SHORTCUT_PROFILES } from "../utils/shortcutProfiles";
import { findShortcutAssignmentConflicts } from "../utils/shortcutAssignmentConflicts";

const original = useDAWStore.getState();
const actionId = "transport.metronomePractice";
const chord = (platform: ShortcutPlatform) => ({ key: " ", code: "Space", shiftKey: true,
  ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) });

beforeEach(() => {
  resetShortcutContextForTests();
  useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {},
    isProjectLoading: false, metronomePracticePending: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetShortcutContextForTests();
  useDAWStore.setState(original);
});

describe("dedicated click-only metronome shortcut", () => {
  for (const platform of ["windows", "macos", "linux", "other"] as const) {
    it.each(KEYBOARD_SHORTCUT_PROFILES.map(profile => profile.id))("dispatches only click-only playback for %s on " + platform, profileId => {
      useDAWStore.setState({ keyboardShortcutProfileId: profileId });
      const execute = vi.fn();
      const action = getRegisteredAction(actionId)!;
      expect(getEffectiveActionShortcuts(action, platform)).toEqual(["Ctrl+Shift+Space"]);
      expect(findShortcutAssignmentConflicts(actionId, "Ctrl+Shift+Space", platform)).toEqual([]);
      expect(dispatchGlobalShortcut(chord(platform), platform, { executeAction: execute })).toBe(true);
      expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: actionId }));
      expect(formatShortcutForPlatform("Ctrl+Shift+Space", platform)).toBe(platform === "macos" ? "Cmd+Shift+Space" : "Ctrl+Shift+Space");
    });
    it("reaches the action from focused buttons and sliders on " + platform, () => {
      const execute = vi.fn();
      expect(dispatchGlobalShortcut({ ...chord(platform), targetIsNonTextControl: true }, platform, { executeAction: execute })).toBe(true);
      expect(execute.mock.calls[0][0].id).toBe(actionId);
    });
  }
  it("keeps plain Space owned by transport and excludes extra/missing modifiers", () => {
    const execute = vi.fn();
    expect(dispatchGlobalShortcut({ key: " ", code: "Space" }, "windows", { executeAction: execute })).toBe(true);
    expect(execute.mock.calls[0][0].id).toBe("transport.play");
    for (const modifiers of [{ ctrlKey: true }, { shiftKey: true }, { ctrlKey: true, shiftKey: true, altKey: true }]) {
      execute.mockClear();
      expect(dispatchGlobalShortcut({ key: " ", code: "Space", ...modifiers }, "windows", { executeAction: execute })).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it("uses Command rather than physical Control on macOS", () => {
    const execute = vi.fn();
    expect(dispatchGlobalShortcut({ key: " ", code: "Space", ctrlKey: true, shiftKey: true }, "macos", { executeAction: execute })).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not repeatedly toggle while the key is held", () => {
    const execute = vi.fn();
    expect(dispatchGlobalShortcut({ ...chord("windows"), repeat: true }, "windows", { executeAction: execute })).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ isProjectLoading: true }, { metronomePracticePending: true }])("ignores unavailable playback changes: %j", state => {
    useDAWStore.setState(state);
    const execute = vi.fn();
    expect(dispatchGlobalShortcut(chord("windows"), "windows", { executeAction: execute })).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps text composition owned by the input method", () => {
    const execute = vi.fn();
    expect(dispatchGlobalShortcut({ ...chord("windows"), isComposing: true, targetIsEditable: true }, "windows", { executeAction: execute })).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("respects custom reassignment and explicit unbinding", () => {
    const execute = vi.fn();
    useDAWStore.setState({ customShortcuts: { [actionId]: "Ctrl+Shift+K" } });
    expect(dispatchGlobalShortcut(chord("windows"), "windows", { executeAction: execute })).toBe(false);
    expect(dispatchGlobalShortcut({ key: "k", code: "KeyK", ctrlKey: true, shiftKey: true }, "windows", { executeAction: execute })).toBe(true);
    expect(execute.mock.calls[0][0].id).toBe(actionId);
    execute.mockClear();
    useDAWStore.setState({ customShortcuts: { [actionId]: "" } });
    expect(dispatchGlobalShortcut(chord("windows"), "windows", { executeAction: execute })).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("forwards detached-window presses to the main state owner", () => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    const toggle = vi.fn().mockResolvedValue(true);
    useDAWStore.setState({ toggleMetronomePractice: toggle });
    expect(dispatchGlobalShortcut(chord("windows"), "windows", { role: "mixer" })).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ command: "action.execute", actionId }));
  });
  it.each([false, true])("does not alter transport, recording or Enable when executing (playing=%s)", async playing => {
    const practice = vi.spyOn(nativeBridge, "setMetronomePracticeEnabled").mockResolvedValue(true);
    const enable = vi.spyOn(nativeBridge, "setMetronomeEnabled").mockResolvedValue(true);
    const transport = { ...original.transport, isPlaying: playing, isRecording: playing, currentTime: 12.34 };
    const session = { id: "metronome-shortcut-record", startTime: 12.34, trackIds: [] };
    useDAWStore.setState({ transport, recordSession: session, metronomeEnabled: true, metronomePracticeEnabled: false });
    const tracks = useDAWStore.getState().tracks;
    for (const expected of [true, false]) {
      expect(dispatchGlobalShortcut(chord("windows"), "windows")).toBe(true);
      await vi.waitFor(() => expect(useDAWStore.getState().metronomePracticePending).toBe(false));
      expect(practice).toHaveBeenLastCalledWith(expected);
      expect(useDAWStore.getState()).toMatchObject({ transport, recordSession: session, metronomeEnabled: true, metronomePracticeEnabled: expected });
      expect(useDAWStore.getState().tracks).toBe(tracks);
    }
    expect(enable).not.toHaveBeenCalled();
  });
});
