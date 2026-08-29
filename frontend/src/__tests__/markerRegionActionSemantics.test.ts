import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredAction } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import { useDAWStore } from "../store/useDAWStore";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import { activateShortcutContext, resetShortcutContextForTests } from "../utils/shortcutContext";

const originalState = useDAWStore.getState();

beforeEach(() => {
  commandManager.clear();
  resetShortcutContextForTests();
  activateShortcutContext({ kind: "application" });
  useDAWStore.setState({
    markers: [],
    regions: [],
    timeSelection: null,
    globalLocked: false,
    lockSettings: { ...originalState.lockSettings, markers: false },
    transport: { ...originalState.transport, currentTime: 3.5 },
    keyboardShortcutProfileId: "openstudio",
    customShortcuts: {},
    canUndo: false,
    canRedo: false,
    isModified: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  commandManager.clear();
  resetShortcutContextForTests();
  useDAWStore.setState(originalState);
});

describe("marker and region command semantics", () => {
  it("adds a marker from the hotkey as one undoable command with a stable id", () => {
    const action = getRegisteredAction("insert.marker")!;
    expect(action.canHandleShortcut?.()).toBe(true);
    expect(dispatchGlobalShortcut({ key: "m", code: "KeyM", source: "browser" }, "windows"))
      .toBe(true);

    const marker = useDAWStore.getState().markers[0];
    expect(marker).toMatchObject({ time: 3.5, name: "Marker 1" });
    expect(useDAWStore.getState().isModified).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().markers).toEqual([]);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().markers).toEqual([marker]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
  });

  it("adds only a non-empty named marker and a normalized non-empty region", () => {
    const prompt = vi.fn()
      .mockReturnValueOnce("   ")
      .mockReturnValueOnce("  Chorus  ");
    vi.stubGlobal("prompt", prompt);
    const named = getRegisteredAction("insert.markerNamed")!;
    named.execute();
    expect(useDAWStore.getState().markers).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    named.execute();
    expect(useDAWStore.getState().markers[0]).toMatchObject({ name: "Chorus", time: 3.5 });

    useDAWStore.setState({ timeSelection: { start: 8, end: 2 } });
    const region = getRegisteredAction("insert.regionFromSelection")!;
    expect(region.canHandleShortcut?.()).toBe(true);
    region.execute();
    expect(useDAWStore.getState().regions[0]).toMatchObject({
      name: "Region 1",
      startTime: 2,
      endTime: 8,
    });
    expect(commandManager.getUndoStack()).toHaveLength(2);
  });

  it("updates and removes marker/region data with one reversible command each", () => {
    useDAWStore.getState().addMarker(1, "Verse");
    useDAWStore.getState().addRegion(2, 6, "Body");
    commandManager.clear();
    useDAWStore.setState({ canUndo: false, canRedo: false });
    const marker = useDAWStore.getState().markers[0];
    const region = useDAWStore.getState().regions[0];

    useDAWStore.getState().updateMarker(marker.id, { name: "Intro", time: -2, id: "spoofed" });
    expect(useDAWStore.getState().markers[0]).toMatchObject({ id: marker.id, name: "Intro", time: 0 });
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().markers[0]).toEqual(marker);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().markers[0].id).toBe(marker.id);

    useDAWStore.getState().updateRegion(region.id, { startTime: 9, endTime: 3, id: "spoofed" });
    expect(useDAWStore.getState().regions[0]).toMatchObject({ id: region.id, startTime: 3, endTime: 9 });
    useDAWStore.getState().removeMarker(marker.id);
    useDAWStore.getState().removeRegion(region.id);
    expect(commandManager.getUndoStack()).toHaveLength(4);
    expect(useDAWStore.getState()).toMatchObject({ markers: [], regions: [] });

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().regions[0].id).toBe(region.id);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().markers[0].id).toBe(marker.id);
  });

  it("rejects invalid/no-op mutations and leaves insert chords unavailable while marker editing is locked", () => {
    useDAWStore.getState().addMarker(1, "One");
    useDAWStore.getState().addRegion(2, 4, "Range");
    const marker = useDAWStore.getState().markers[0];
    const region = useDAWStore.getState().regions[0];
    commandManager.clear();

    useDAWStore.getState().updateMarker(marker.id, { name: marker.name });
    useDAWStore.getState().updateMarker(marker.id, { time: Number.NaN });
    useDAWStore.getState().updateRegion(region.id, { startTime: region.startTime });
    useDAWStore.getState().updateRegion(region.id, { endTime: Number.POSITIVE_INFINITY });
    useDAWStore.getState().removeMarker("missing");
    useDAWStore.getState().removeRegion("missing");
    useDAWStore.getState().addMarker(Number.NaN);
    useDAWStore.getState().addRegion(2, 2);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, markers: true },
      timeSelection: { start: 2, end: 4 },
    }));
    expect(getRegisteredAction("insert.marker")?.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("insert.markerNamed")?.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("insert.regionFromSelection")?.canHandleShortcut?.()).toBe(false);
    expect(dispatchGlobalShortcut({ key: "m", code: "KeyM", source: "browser" }, "windows"))
      .toBe(false);
    expect(useDAWStore.getState().markers).toEqual([marker]);
    getRegisteredAction("insert.regionFromSelection")?.execute();
    useDAWStore.getState().removeMarker(marker.id);
    useDAWStore.getState().removeRegion(region.id);
    expect(useDAWStore.getState().markers).toEqual([marker]);
    expect(useDAWStore.getState().regions).toEqual([region]);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    useDAWStore.setState((state) => ({
      lockSettings: { ...state.lockSettings, markers: false },
      globalLocked: true,
    }));
    expect(getRegisteredAction("insert.marker")?.canHandleShortcut?.()).toBe(false);
    expect(getRegisteredAction("insert.regionFromSelection")?.canHandleShortcut?.()).toBe(false);
    expect(dispatchGlobalShortcut({ key: "m", code: "KeyM", source: "browser" }, "windows"))
      .toBe(false);
    getRegisteredAction("insert.marker")?.execute();
    expect(useDAWStore.getState().markers).toEqual([marker]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});
