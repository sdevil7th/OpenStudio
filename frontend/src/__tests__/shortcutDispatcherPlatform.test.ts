import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  matchesActionShortcut,
} from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  registerShortcutSurface,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

describe("platform-explicit shortcut dispatch", () => {
  const original = {
    keyboardShortcutProfileId: useDAWStore.getState().keyboardShortcutProfileId,
    customShortcuts: useDAWStore.getState().customShortcuts,
    tracks: useDAWStore.getState().tracks,
    selectedClipId: useDAWStore.getState().selectedClipId,
    selectedClipIds: useDAWStore.getState().selectedClipIds,
    transport: useDAWStore.getState().transport,
    splitClipAtPlayhead: useDAWStore.getState().splitClipAtPlayhead,
  };

  beforeEach(() => {
    resetShortcutContextForTests();
    useDAWStore.setState({
      keyboardShortcutProfileId: "pro_tools",
      customShortcuts: {},
      selectedClipIds: ["selected-clip"],
    });
    registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });
  });

  afterEach(() => {
    resetShortcutContextForTests();
    useDAWStore.setState(original);
  });

  it("matches the portable primary modifier as Control on Windows and Command on macOS", () => {
    const windowsEvent = { key: "e", code: "KeyE", ctrlKey: true };
    const macEvent = { key: "e", code: "KeyE", metaKey: true };

    expect(matchesActionShortcut(windowsEvent, "edit.splitAtCursor", "windows")).toBe(true);
    expect(matchesActionShortcut(windowsEvent, "edit.splitAtCursor", "macos")).toBe(false);
    expect(matchesActionShortcut(macEvent, "edit.splitAtCursor", "macos")).toBe(true);
    expect(matchesActionShortcut(macEvent, "edit.splitAtCursor", "windows")).toBe(false);
  });

  it("runs the real scoped registry action with an explicit target platform", () => {
    const splitClipAtPlayhead = vi.fn();
    const track = createDefaultTrack("split-track", "Split", "#123456", "audio", []);
    track.clips = [{
      id: "selected-clip",
      filePath: "C:/split.wav",
      name: "Split",
      startTime: 0,
      duration: 2,
      offset: 0,
      color: "#123456",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
    }];
    useDAWStore.setState((state) => ({
      splitClipAtPlayhead,
      tracks: [track],
      selectedClipId: "selected-clip",
      selectedClipIds: ["selected-clip"],
      transport: { ...state.transport, currentTime: 1 },
    }));

    expect(dispatchGlobalShortcut(
      { key: "e", code: "KeyE", metaKey: true, source: "test" },
      "macos",
    )).toBe(true);
    expect(splitClipAtPlayhead).toHaveBeenCalledTimes(1);

    expect(dispatchGlobalShortcut(
      { key: "e", code: "KeyE", metaKey: true, source: "test" },
      "windows",
    )).toBe(false);
    expect(splitClipAtPlayhead).toHaveBeenCalledTimes(1);
  });
});
