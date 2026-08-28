import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  matchesActionShortcut,
} from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  dispatchActiveShortcut,
  getActiveShortcutContext,
  isEditableShortcutTarget,
  isNonTextControlShortcutTarget,
  registerShortcutSurface,
  resetShortcutContextForTests,
  shortcutExactlyMatches,
  shouldPreserveEditableShortcut,
  shouldPreserveNonTextControlShortcut,
  toPressedShortcut,
} from "../utils/shortcutContext";
import { canonicalizeShortcutEvent } from "../utils/platform";

const originalStoreActions = {
  undo: useDAWStore.getState().undo,
  saveProject: useDAWStore.getState().saveProject,
  selectAllTracks: useDAWStore.getState().selectAllTracks,
  toggleMixer: useDAWStore.getState().toggleMixer,
  toggleLoop: useDAWStore.getState().toggleLoop,
  nudgeClips: useDAWStore.getState().nudgeClips,
  copySelectedClips: useDAWStore.getState().copySelectedClips,
  openProjectSettings: useDAWStore.getState().openProjectSettings,
};
const originalSelectionState = {
  showPitchEditor: useDAWStore.getState().showPitchEditor,
  showPianoRoll: useDAWStore.getState().showPianoRoll,
  selectedClipId: useDAWStore.getState().selectedClipId,
  selectedClipIds: useDAWStore.getState().selectedClipIds,
  selectedNoteIds: useDAWStore.getState().selectedNoteIds,
  tracks: useDAWStore.getState().tracks,
  globalLocked: useDAWStore.getState().globalLocked,
  lockSettings: useDAWStore.getState().lockSettings,
};

afterEach(() => {
  resetShortcutContextForTests();
  useDAWStore.setState({
    ...originalStoreActions,
    ...originalSelectionState,
    customShortcuts: {},
  });
});

describe("shortcut edit-context routing", () => {
  it("routes only to the active surface and restores its declared fallback", () => {
    const timelineHandler = vi.fn(() => "handled" as const);
    const pitchHandler = vi.fn(() => "claimed_noop" as const);
    const unregisterTimeline = registerShortcutSurface(
      { kind: "timeline" },
      timelineHandler,
    );
    const unregisterPitch = registerShortcutSurface(
      { kind: "pitch_editor" },
      pitchHandler,
      { kind: "timeline" },
    );

    activateShortcutContext({ kind: "timeline" });
    expect(dispatchActiveShortcut({ key: "c", ctrlKey: true })).toBe("handled");
    expect(timelineHandler).toHaveBeenCalledTimes(1);
    expect(pitchHandler).not.toHaveBeenCalled();

    activateShortcutContext({ kind: "pitch_editor" });
    expect(dispatchActiveShortcut({ key: "z", ctrlKey: true })).toBe("claimed_noop");
    expect(pitchHandler).toHaveBeenCalledTimes(1);

    unregisterPitch();
    expect(getActiveShortcutContext()).toEqual({ kind: "timeline" });
    unregisterTimeline();
  });

  it("isolates handlers for two piano-roll sessions", () => {
    const firstSession = vi.fn(() => "handled" as const);
    const secondSession = vi.fn(() => "handled" as const);
    registerShortcutSurface(
      { kind: "piano_roll", sessionId: "detached-one" },
      firstSession,
    );
    registerShortcutSurface(
      { kind: "piano_roll", sessionId: "detached-two" },
      secondSession,
    );

    activateShortcutContext({ kind: "piano_roll", sessionId: "detached-two" });
    expect(dispatchActiveShortcut({ key: "q" })).toBe("handled");
    expect(firstSession).not.toHaveBeenCalled();
    expect(secondSession).toHaveBeenCalledTimes(1);
  });

  it("restores the previous handler when a same-context owner unmounts", () => {
    const baseHandler = vi.fn(() => "handled" as const);
    const temporaryHandler = vi.fn(() => "claimed_noop" as const);
    const unregisterBase = registerShortcutSurface(
      { kind: "timeline" },
      baseHandler,
    );
    const unregisterTemporary = registerShortcutSurface(
      { kind: "timeline" },
      temporaryHandler,
    );
    activateShortcutContext({ kind: "timeline" });

    expect(dispatchActiveShortcut({ key: "s", repeat: true })).toBe("claimed_noop");
    expect(temporaryHandler).toHaveBeenCalledWith({ key: "s", repeat: true });
    expect(baseHandler).not.toHaveBeenCalled();

    unregisterTemporary();
    expect(getActiveShortcutContext()).toEqual({ kind: "timeline" });
    expect(dispatchActiveShortcut({ key: "s" })).toBe("handled");
    expect(baseHandler).toHaveBeenCalledTimes(1);

    unregisterBase();
    expect(getActiveShortcutContext()).toEqual({ kind: "application" });
  });

  it("classifies text editors and non-text controls without requiring DOM globals", () => {
    const targetMatching = (fragment: string) => ({
      closest: (selectors: string) => selectors.includes(fragment) ? {} : null,
    }) as unknown as EventTarget;

    const textInput = targetMatching("input[type='text']");
    const select = targetMatching("select");
    const range = targetMatching("input[type='range']");
    const button = targetMatching("button");
    const contentEditable = targetMatching("[contenteditable='true']");
    const generic = targetMatching("[data-not-a-control]");

    expect(isEditableShortcutTarget(textInput)).toBe(true);
    expect(isNonTextControlShortcutTarget(textInput)).toBe(false);
    expect(isEditableShortcutTarget(select)).toBe(true);
    expect(isNonTextControlShortcutTarget(select)).toBe(false);
    expect(isEditableShortcutTarget(range)).toBe(false);
    expect(isNonTextControlShortcutTarget(range)).toBe(true);
    expect(isEditableShortcutTarget(button)).toBe(false);
    expect(isNonTextControlShortcutTarget(button)).toBe(true);
    expect(isEditableShortcutTarget(contentEditable)).toBe(true);
    expect(isEditableShortcutTarget(generic)).toBe(false);
    expect(isNonTextControlShortcutTarget(generic)).toBe(false);
    expect(isEditableShortcutTarget(null)).toBe(false);
    expect(isNonTextControlShortcutTarget(null)).toBe(false);
  });

  it("requires exact modifiers and preserves native editing chords", () => {
    expect(shortcutExactlyMatches({ key: "z", ctrlKey: true }, "Ctrl+Z")).toBe(true);
    expect(shortcutExactlyMatches(
      { key: "z", ctrlKey: true, altKey: true },
      "Ctrl+Z",
    )).toBe(false);
    expect(toPressedShortcut({ key: "ArrowLeft", shiftKey: true })).toBe("Shift+Left");
    expect(shouldPreserveEditableShortcut({ key: "a", ctrlKey: true })).toBe(true);
    expect(shouldPreserveEditableShortcut({ key: "s", ctrlKey: true })).toBe(false);
    expect(shouldPreserveEditableShortcut({ key: " " })).toBe(true);
    expect(shouldPreserveEditableShortcut({ key: "Enter", altKey: true })).toBe(true);
    expect(shouldPreserveEditableShortcut({ key: "Enter", altKey: true }, true)).toBe(false);
    expect(shouldPreserveEditableShortcut({ key: "ArrowLeft", ctrlKey: true }, true)).toBe(true);
    expect(shouldPreserveNonTextControlShortcut({ key: "ArrowLeft" })).toBe(true);
    expect(shouldPreserveNonTextControlShortcut({ key: "l" })).toBe(false);
  });

  it("keeps macOS Command, Control, and Option distinct during exact matching", () => {
    expect(canonicalizeShortcutEvent({ key: "z", metaKey: true }, "macos")).toBe("Ctrl+Z");
    expect(canonicalizeShortcutEvent({ key: "z", ctrlKey: true }, "macos")).toBe("Alt+Z");
    expect(canonicalizeShortcutEvent({
      key: "z",
      metaKey: true,
      ctrlKey: true,
    }, "macos")).toBe("Ctrl+Alt+Z");
    expect(canonicalizeShortcutEvent({ key: "z", altKey: true }, "macos")).toBe("Option+Z");
    expect(canonicalizeShortcutEvent({
      key: "z",
      ctrlKey: true,
      altKey: true,
    }, "macos")).toBe("Alt+Option+Z");
    expect(canonicalizeShortcutEvent({
      key: "z",
      metaKey: true,
      ctrlKey: true,
      altKey: true,
    }, "macos")).toBe("Ctrl+Alt+Option+Z");
    expect(canonicalizeShortcutEvent({
      key: "z",
      ctrlKey: true,
      altKey: true,
    }, "other")).toBe("Ctrl+Alt+Z");
    expect(canonicalizeShortcutEvent({ key: "Alt", altKey: true }, "macos")).toBeNull();
    expect(canonicalizeShortcutEvent({ key: "å", altKey: true }, "macos")).toBe("Option+Å");
  });

  it("preserves composition and native macOS text-editing chords", () => {
    expect(shouldPreserveEditableShortcut(
      { key: "a", metaKey: true },
      false,
      "macos",
    )).toBe(true);
    expect(shouldPreserveEditableShortcut(
      { key: "e", ctrlKey: true },
      true,
      "macos",
    )).toBe(true);
    expect(shouldPreserveEditableShortcut(
      { key: "e", altKey: true },
      false,
      "macos",
    )).toBe(true);
    expect(shouldPreserveEditableShortcut(
      { key: "Enter", altKey: true },
      true,
      "macos",
    )).toBe(false);
    expect(shouldPreserveEditableShortcut({
      key: "@",
      ctrlKey: true,
      altKey: true,
      getModifierState: (modifier) => modifier === "AltGraph",
    })).toBe(true);
    expect(shouldPreserveEditableShortcut({ key: "z", isComposing: true })).toBe(true);
    expect(shouldPreserveNonTextControlShortcut({ key: "Tab" })).toBe(true);
    expect(shouldPreserveNonTextControlShortcut({
      key: "ArrowLeft",
      ctrlKey: true,
    })).toBe(false);
  });

  it("claims empty editor undo without falling through to project history", () => {
    const projectUndo = vi.fn();
    useDAWStore.setState({ undo: projectUndo });
    registerShortcutSurface(
      { kind: "pitch_editor" },
      (event) => matchesActionShortcut(event, "edit.undo") ? "claimed_noop" : "unmatched",
      { kind: "timeline" },
    );
    activateShortcutContext({ kind: "pitch_editor" });

    expect(dispatchGlobalShortcut({ key: "z", ctrlKey: true, source: "browser" })).toBe(true);
    expect(projectUndo).not.toHaveBeenCalled();
  });

  it("does not expose contextual history from application-only surfaces", () => {
    const projectUndo = vi.fn();
    useDAWStore.setState({ undo: projectUndo });
    activateShortcutContext({ kind: "application" });

    expect(dispatchGlobalShortcut({ key: "z", ctrlKey: true, source: "browser" })).toBe(false);
    expect(projectUndo).not.toHaveBeenCalled();
  });

  it("uses a custom action binding instead of retaining the default", () => {
    const toggleMixer = vi.fn();
    useDAWStore.setState({
      toggleMixer,
      customShortcuts: { "view.toggleMixer": "Ctrl+Shift+M" },
    });

    expect(dispatchGlobalShortcut({ key: "m", ctrlKey: true, source: "browser" })).toBe(false);
    expect(dispatchGlobalShortcut({
      key: "m",
      ctrlKey: true,
      shiftKey: true,
      source: "browser",
    })).toBe(true);
    expect(toggleMixer).toHaveBeenCalledTimes(1);
  });

  it("dispatches explicit physical-position and Windows-key custom bindings", () => {
    const toggleMixer = vi.fn();
    useDAWStore.setState({
      toggleMixer,
      customShortcuts: { "view.toggleMixer": "Control+Code:KeyZ" },
    });

    expect(dispatchGlobalShortcut({
      key: "y",
      code: "KeyZ",
      ctrlKey: true,
      source: "browser",
    })).toBe(true);
    expect(toggleMixer).toHaveBeenCalledTimes(1);
    expect(dispatchGlobalShortcut({
      key: "z",
      code: "KeyY",
      ctrlKey: true,
      source: "browser",
    })).toBe(false);

    useDAWStore.setState({
      customShortcuts: { "view.toggleMixer": "Meta+Code:KeyM" },
    });
    expect(dispatchGlobalShortcut({
      key: "m",
      code: "KeyM",
      metaKey: true,
      source: "browser",
    })).toBe(true);
    expect(toggleMixer).toHaveBeenCalledTimes(2);
    expect(dispatchGlobalShortcut({
      key: "m",
      code: "KeyM",
      ctrlKey: true,
      source: "browser",
    })).toBe(false);
  });

  it("accepts multiple custom bindings at runtime without conflating numpad keys", () => {
    const toggleMixer = vi.fn();
    useDAWStore.setState({
      toggleMixer,
      customShortcuts: {
        "view.toggleMixer": ["Ctrl+M", "Control+Code:KeyZ"],
      } as unknown as Record<string, string>,
    });

    expect(dispatchGlobalShortcut({
      key: "m",
      code: "KeyM",
      ctrlKey: true,
      source: "browser",
    })).toBe(true);
    expect(dispatchGlobalShortcut({
      key: "y",
      code: "KeyZ",
      ctrlKey: true,
      source: "browser",
    })).toBe(true);
    expect(toggleMixer).toHaveBeenCalledTimes(2);

    useDAWStore.setState({
      customShortcuts: { "view.toggleMixer": "Ctrl+1" },
    });
    expect(matchesActionShortcut(
      { key: "1", code: "Numpad1", ctrlKey: true, location: 3 },
      "view.toggleMixer",
    )).toBe(false);
    expect(matchesActionShortcut(
      { key: "1", code: "Digit1", ctrlKey: true },
      "view.toggleMixer",
    )).toBe(true);
  });

  it("consumes repeated one-shot bindings but executes repeatable actions", () => {
    const toggleMixer = vi.fn();
    const nudgeClips = vi.fn();
    const track = createDefaultTrack("nudge-track", "Nudge", "#123456", "audio", []);
    track.clips = [{
      id: "nudge-clip",
      filePath: "C:/nudge.wav",
      name: "Nudge",
      startTime: 1,
      duration: 1,
      offset: 0,
      color: "#123456",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
    }];
    useDAWStore.setState({
      toggleMixer,
      nudgeClips,
      tracks: [track],
      selectedClipId: "nudge-clip",
      selectedClipIds: ["nudge-clip"],
      globalLocked: false,
      lockSettings: { ...useDAWStore.getState().lockSettings, items: false },
    });

    expect(dispatchGlobalShortcut({
      key: "m",
      ctrlKey: true,
      repeat: true,
      source: "browser",
    })).toBe(true);
    expect(toggleMixer).not.toHaveBeenCalled();

    registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });
    expect(dispatchGlobalShortcut({
      key: "ArrowLeft",
      repeat: true,
      source: "browser",
    })).toBe(true);
    expect(nudgeClips).toHaveBeenCalledWith("left");
  });

  it("lets an editor resolve conflicts before unused keys fall through globally", () => {
    const toggleLoop = vi.fn();
    const toggleMixer = vi.fn();
    const pianoHandler = vi.fn((event) => (
      shortcutExactlyMatches(event, "L") ? "handled" as const : "unmatched" as const
    ));
    useDAWStore.setState({ toggleLoop, toggleMixer });
    registerShortcutSurface(
      { kind: "piano_roll", sessionId: "active-editor" },
      pianoHandler,
    );
    activateShortcutContext({ kind: "piano_roll", sessionId: "active-editor" });

    expect(dispatchGlobalShortcut({ key: "l", source: "browser" })).toBe(true);
    expect(toggleLoop).not.toHaveBeenCalled();

    expect(dispatchGlobalShortcut({ key: "m", ctrlKey: true, source: "browser" })).toBe(true);
    expect(toggleMixer).toHaveBeenCalledTimes(1);
  });

  it("uses active context rather than editor visibility for scoped actions", () => {
    const selectAllTracks = vi.fn();
    useDAWStore.setState({
      selectAllTracks,
      showPitchEditor: true,
      showPianoRoll: true,
      selectedNoteIds: ["stale-midi-note"],
    });
    registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });

    expect(dispatchGlobalShortcut({ key: "a", ctrlKey: true, source: "browser" })).toBe(true);
    expect(selectAllTracks).toHaveBeenCalledTimes(1);
  });

  it("does not route from stale timeline selection while piano owns the key", () => {
    const copySelectedClips = vi.fn();
    useDAWStore.setState({
      copySelectedClips,
      selectedClipId: "stale-clip",
      selectedClipIds: ["stale-clip"],
      selectedNoteIds: [],
    });
    registerShortcutSurface(
      { kind: "piano_roll", sessionId: "selection-owner" },
      (event) => shortcutExactlyMatches(event, "Ctrl+C") ? "claimed_noop" : "unmatched",
    );
    activateShortcutContext({ kind: "piano_roll", sessionId: "selection-owner" });

    expect(dispatchGlobalShortcut({ key: "c", ctrlKey: true, source: "browser" })).toBe(true);
    expect(copySelectedClips).not.toHaveBeenCalled();
  });

  it("leaves native input editing alone while allowing application shortcuts", () => {
    const saveProject = vi.fn();
    const selectAllTracks = vi.fn();
    useDAWStore.setState({ saveProject, selectAllTracks });
    registerShortcutSurface({ kind: "timeline" }, () => "unmatched");
    activateShortcutContext({ kind: "timeline" });

    expect(dispatchGlobalShortcut({
      key: "a",
      ctrlKey: true,
      source: "browser",
      targetIsEditable: true,
    })).toBe(false);
    expect(selectAllTracks).not.toHaveBeenCalled();

    expect(dispatchGlobalShortcut({
      key: "s",
      ctrlKey: true,
      source: "browser",
      targetIsEditable: true,
    })).toBe(true);
    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it("allows an exact registered modifier chord from a focused input", () => {
    const openProjectSettings = vi.fn();
    useDAWStore.setState({ openProjectSettings });

    expect(dispatchGlobalShortcut({
      key: "Enter",
      altKey: true,
      source: "browser",
      targetIsEditable: true,
    })).toBe(true);
    expect(openProjectSettings).toHaveBeenCalledTimes(1);
  });

  it("routes globals from non-text controls while preserving their native keys", () => {
    const toggleLoop = vi.fn();
    useDAWStore.setState({ toggleLoop });
    activateShortcutContext({ kind: "application" });

    expect(dispatchGlobalShortcut({
      key: "l",
      source: "browser",
      targetIsNonTextControl: true,
    })).toBe(true);
    expect(toggleLoop).toHaveBeenCalledTimes(1);

    expect(dispatchGlobalShortcut({
      key: " ",
      code: "Space",
      source: "browser",
      targetIsNonTextControl: true,
    })).toBe(false);
  });
});
