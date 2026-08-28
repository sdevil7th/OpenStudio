import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRegisteredAction,
  getRegisteredActions,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  matchesActionShortcut,
} from "../utils/globalShortcutDispatcher";
import {
  activateShortcutContext,
  registerShortcutSurface,
  resetShortcutContextForTests,
} from "../utils/shortcutContext";

const originalStoreState = {
  customShortcuts: useDAWStore.getState().customShortcuts,
  deleteRazorEditContent: useDAWStore.getState().deleteRazorEditContent,
  deleteSelectedTracks: useDAWStore.getState().deleteSelectedTracks,
  deleteWithinTimeSelection: useDAWStore.getState().deleteWithinTimeSelection,
  deleteSelectedClips: useDAWStore.getState().deleteSelectedClips,
  duplicateSelectedClips: useDAWStore.getState().duplicateSelectedClips,
  moveMIDINotes: useDAWStore.getState().moveMIDINotes,
  scaleSelectedMIDINoteVelocity: useDAWStore.getState().scaleSelectedMIDINoteVelocity,
  setSelectedNoteIds: useDAWStore.getState().setSelectedNoteIds,
  pianoRollTrackId: useDAWStore.getState().pianoRollTrackId,
  pianoRollClipId: useDAWStore.getState().pianoRollClipId,
  selectedClipIds: useDAWStore.getState().selectedClipIds,
  selectedTrackIds: useDAWStore.getState().selectedTrackIds,
  razorEdits: useDAWStore.getState().razorEdits,
  timeSelection: useDAWStore.getState().timeSelection,
  toggleMixer: useDAWStore.getState().toggleMixer,
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length > 0) cleanups.pop()?.();
  resetShortcutContextForTests();
  useDAWStore.setState(originalStoreState);
});

describe("editor shortcut registry", () => {
  it("keeps every central action id unique", () => {
    const actionIds = getRegisteredActions().map((action) => action.id);
    expect(new Set(actionIds).size).toBe(actionIds.length);
  });

  it("centrally defines the formerly hard-coded timeline bindings", () => {
    const duplicate = getRegisteredAction("edit.duplicateClips");
    const deleteAction = getRegisteredAction("edit.delete");

    expect(duplicate).toMatchObject({ shortcut: "Ctrl+D", shortcutScope: "timeline" });
    expect(deleteAction).toMatchObject({
      shortcut: "Delete",
      shortcutAliases: ["Backspace"],
      shortcutScope: "timeline",
    });
  });

  it("executes duplicate and preserves the timeline delete precedence", () => {
    const duplicateSelectedClips = vi.fn();
    const deleteRazorEditContent = vi.fn();
    const deleteSelectedTracks = vi.fn();
    const deleteSelectedClips = vi.fn();
    const deleteWithinTimeSelection = vi.fn();
    useDAWStore.setState({
      duplicateSelectedClips,
      deleteRazorEditContent,
      deleteSelectedTracks,
      deleteSelectedClips,
      deleteWithinTimeSelection,
      selectedClipIds: ["clip-a", "clip-b"],
      selectedTrackIds: ["track-a"],
      razorEdits: [{ trackId: "track-a", start: 0, end: 1 }],
      timeSelection: { start: 0, end: 1 },
    });

    getRegisteredAction("edit.duplicateClips")?.execute();
    expect(duplicateSelectedClips).toHaveBeenCalledTimes(1);

    getRegisteredAction("edit.delete")?.execute();
    expect(deleteRazorEditContent).toHaveBeenCalledTimes(1);
    expect(deleteSelectedTracks).not.toHaveBeenCalled();
    expect(deleteSelectedClips).not.toHaveBeenCalled();
    expect(deleteWithinTimeSelection).not.toHaveBeenCalled();

    useDAWStore.setState({ razorEdits: [] });
    getRegisteredAction("edit.delete")?.execute();
    expect(deleteSelectedClips).toHaveBeenCalledTimes(1);
    expect(deleteSelectedTracks).not.toHaveBeenCalled();

    useDAWStore.setState({ selectedClipIds: [] });
    getRegisteredAction("edit.delete")?.execute();
    expect(deleteWithinTimeSelection).toHaveBeenCalledTimes(1);
    expect(deleteSelectedTracks).not.toHaveBeenCalled();

    useDAWStore.setState({ timeSelection: null });
    getRegisteredAction("edit.delete")?.execute();
    expect(deleteSelectedTracks).toHaveBeenCalledTimes(1);
  });

  it("registers Piano Roll tools, edits, movement, and step input in piano scope", () => {
    const expected = [
      ["midi.tool.draw", "D"],
      ["midi.repeatSelection", "Shift+R"],
      ["midi.selectAll", "Ctrl+A"],
      ["midi.copySelection", "Ctrl+C"],
      ["midi.deleteSelection", "Delete"],
      ["midi.movePitchOctaveUp", "Shift+Up"],
      ["midi.stepInputC", "C"],
      ["midi.stepInputCSharp", "Shift+C"],
      ["midi.closeEditor", "Esc"],
    ];

    for (const [actionId, shortcut] of expected) {
      expect(getRegisteredAction(actionId)).toMatchObject({
        shortcut,
        shortcutScope: "piano_roll",
      });
    }
    expect(getRegisteredAction("midi.deleteSelection")?.shortcutAliases).toEqual(["Backspace"]);
  });

  it("registers Pitch Editor selection, correction, movement, merge, and tools", () => {
    const expected = [
      ["pitch.selectAll", "Ctrl+A"],
      ["pitch.correctSelectedToScale", "Q"],
      ["pitch.moveUp", "Up"],
      ["pitch.moveUpFine", "Shift+Up"],
      ["pitch.mergeSelectedNotes", "Ctrl+J"],
      ["pitch.tool.select", "1"],
      ["pitch.tool.split", "6"],
      ["pitch.closeEditor", "Esc"],
    ];

    for (const [actionId, shortcut] of expected) {
      expect(getRegisteredAction(actionId)).toMatchObject({
        shortcut,
        shortcutScope: "pitch_editor",
      });
    }
  });

  it("executes the formerly empty transpose and velocity actions through undo-aware store APIs", () => {
    const moveMIDINotes = vi.fn(() => ["moved-note"]);
    const scaleSelectedMIDINoteVelocity = vi.fn();
    const setSelectedNoteIds = vi.fn();
    const promptMock = vi.fn()
      .mockReturnValueOnce("2.6")
      .mockReturnValueOnce("125");
    vi.stubGlobal("prompt", promptMock);
    useDAWStore.setState({
      moveMIDINotes,
      scaleSelectedMIDINoteVelocity,
      setSelectedNoteIds,
      pianoRollTrackId: "track-a",
      pianoRollClipId: "clip-a",
      selectedNoteIds: ["note-a"],
    });

    getRegisteredAction("edit.transpose")?.execute();
    expect(moveMIDINotes).toHaveBeenCalledWith(
      "track-a",
      "clip-a",
      ["note-a"],
      0,
      3,
    );
    expect(setSelectedNoteIds).toHaveBeenCalledWith(["moved-note"]);

    getRegisteredAction("edit.velocityScale")?.execute();
    expect(scaleSelectedMIDINoteVelocity).toHaveBeenCalledWith(
      "track-a",
      "clip-a",
      1.25,
    );
    expect(getRegisteredAction("midi.transpose")?.execute).toBeTypeOf("function");
  });

  it("routes registry execution to only the active editor session", () => {
    const first = vi.fn(() => "handled" as const);
    const second = vi.fn(() => "handled" as const);
    cleanups.push(registerScopedActionExecutor(
      { kind: "piano_roll", sessionId: "first" },
      first,
    ));
    cleanups.push(registerScopedActionExecutor(
      { kind: "piano_roll", sessionId: "second" },
      second,
    ));

    activateShortcutContext({ kind: "piano_roll", sessionId: "second" });
    getRegisteredAction("midi.tool.draw")?.execute();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("midi.tool.draw");
  });

  it("honors custom scoped bindings and lets the editor win a global conflict", () => {
    const toggleMixer = vi.fn();
    const pianoAction = vi.fn();
    useDAWStore.setState({
      toggleMixer,
      customShortcuts: { "midi.tool.line": "Ctrl+M" },
    });
    cleanups.push(registerShortcutSurface(
      { kind: "piano_roll", sessionId: "custom" },
      (event) => {
        if (!matchesActionShortcut(event, "midi.tool.line")) return "unmatched";
        pianoAction();
        return "handled";
      },
    ));
    activateShortcutContext({ kind: "piano_roll", sessionId: "custom" });

    expect(dispatchGlobalShortcut({
      key: "m",
      ctrlKey: true,
      source: "browser",
    })).toBe(true);
    expect(pianoAction).toHaveBeenCalledTimes(1);
    expect(toggleMixer).not.toHaveBeenCalled();
    expect(matchesActionShortcut({ key: "l" }, "midi.tool.line")).toBe(false);
  });
});
