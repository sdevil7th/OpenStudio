import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type Track,
  type TrackType,
  useDAWStore,
} from "../store/useDAWStore";
import {
  buildTrackRenameChanges,
  getTrackNameEditKeyAction,
  resolveTrackRenameTargetIds,
  shouldCommitTrackNameEdit,
} from "../utils/trackRename";
import trackNameEditorSource from "../components/TrackNameEditor.tsx?raw";

const initialState = useDAWStore.getState();

function makeTrack(id: string, name: string, type: TrackType = "audio"): Track {
  return createDefaultTrack(id, name, "#3b82f6", type);
}

function resetStore(tracks: Track[] = []) {
  commandManager.clear();
  useDAWStore.setState({
    ...initialState,
    tracks,
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    isModified: false,
    canUndo: false,
    canRedo: false,
  });
}

describe("batch track rename helpers", () => {
  const tracks = [
    makeTrack("top", "Top"),
    makeTrack("middle", "Middle", "midi"),
    makeTrack("bottom", "Bottom", "ai"),
  ];

  it("orders selected targets by their visual project order", () => {
    expect(
      resolveTrackRenameTargetIds(
        tracks,
        ["bottom", "top", "middle"],
        "bottom",
      ),
    ).toEqual(["top", "middle", "bottom"]);
  });

  it("targets only an edited track outside the current selection", () => {
    expect(
      resolveTrackRenameTargetIds(tracks, ["top", "middle"], "bottom"),
    ).toEqual(["bottom"]);
  });

  it("builds suffixes in visual order while ignoring duplicates and missing ids", () => {
    expect(
      buildTrackRenameChanges(
        tracks,
        ["bottom", "missing", "top", "bottom", "middle"],
        "Example",
      ),
    ).toEqual([
      { id: "top", oldName: "Top", newName: "Example" },
      { id: "middle", oldName: "Middle", newName: "Example 1" },
      { id: "bottom", oldName: "Bottom", newName: "Example 2" },
    ]);
  });

  it("maps Enter and Escape while leaving IME composition untouched", () => {
    expect(getTrackNameEditKeyAction("Enter", false)).toBe("commit");
    expect(getTrackNameEditKeyAction("Escape", false)).toBe("cancel");
    expect(getTrackNameEditKeyAction("Enter", true)).toBeNull();
    expect(getTrackNameEditKeyAction("Enter", false, 229)).toBeNull();
    expect(getTrackNameEditKeyAction("a", false)).toBeNull();
  });

  it("does not commit a focus/blur cycle whose draft never changed", () => {
    expect(shouldCommitTrackNameEdit("Snare", "Snare")).toBe(false);
    expect(shouldCommitTrackNameEdit("Snare", "Snare 2")).toBe(true);
    expect(trackNameEditorSource).toContain(
      "if (!shouldCommitTrackNameEdit(initialDraftRef.current, draftRef.current))",
    );
  });
});

describe("batch track rename action", () => {
  beforeEach(() => resetStore());

  afterEach(() => resetStore());

  it("renames mixed track types in one undoable, dirty transaction", () => {
    const tracks = [
      makeTrack("audio", "Audio", "audio"),
      makeTrack("midi", "MIDI", "midi"),
      makeTrack("instrument", "Instrument", "instrument"),
      makeTrack("ai", "AI", "ai"),
      { ...makeTrack("folder", "Folder", "audio"), isFolder: true },
      makeTrack("bus", "Bus", "bus"),
    ];
    resetStore(tracks);
    useDAWStore.setState({
      selectedTrackId: "ai",
      selectedTrackIds: ["ai", "bus", "midi", "folder", "audio", "instrument"],
      lastSelectedTrackId: "ai",
    });

    const state = useDAWStore.getState();
    const targets = resolveTrackRenameTargetIds(
      state.tracks,
      state.selectedTrackIds,
      "ai",
    );
    state.renameTracks(targets, "Example");

    expect(useDAWStore.getState().tracks.map((track) => track.name)).toEqual([
      "Example",
      "Example 1",
      "Example 2",
      "Example 3",
      "Example 4",
      "Example 5",
    ]);
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(useDAWStore.getState().canUndo).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(commandManager.getUndoStack()[0].type).toBe("RENAME_TRACKS");

    // Selection changes after the edit are not part of rename history.
    useDAWStore.setState({
      selectedTrackId: "bus",
      selectedTrackIds: ["bus"],
      lastSelectedTrackId: "bus",
    });
    useDAWStore.getState().undo();

    expect(useDAWStore.getState().tracks.map((track) => track.name)).toEqual([
      "Audio",
      "MIDI",
      "Instrument",
      "AI",
      "Folder",
      "Bus",
    ]);
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["bus"]);
    expect(useDAWStore.getState().canRedo).toBe(true);
    expect(useDAWStore.getState().isModified).toBe(true);

    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks.map((track) => track.name)).toEqual([
      "Example",
      "Example 1",
      "Example 2",
      "Example 3",
      "Example 4",
      "Example 5",
    ]);
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["bus"]);
  });

  it("renames only an unselected edited track", () => {
    const tracks = [
      makeTrack("one", "One"),
      makeTrack("two", "Two"),
      makeTrack("three", "Three"),
    ];
    resetStore(tracks);
    useDAWStore.setState({ selectedTrackIds: ["one", "two"] });

    const state = useDAWStore.getState();
    const targets = resolveTrackRenameTargetIds(
      state.tracks,
      state.selectedTrackIds,
      "three",
    );
    state.renameTracks(targets, "Solo");

    expect(useDAWStore.getState().tracks.map((track) => track.name)).toEqual([
      "One",
      "Two",
      "Solo",
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("does not create history or dirty the project for a no-op", () => {
    resetStore([makeTrack("same", "Same")]);

    useDAWStore.getState().renameTracks(["same", "same", "missing"], "Same");

    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().canUndo).toBe(false);
    expect(useDAWStore.getState().isModified).toBe(false);
  });
});
