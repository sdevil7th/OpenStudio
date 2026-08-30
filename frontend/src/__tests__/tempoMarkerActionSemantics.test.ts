import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { useDAWStore } from "../store/useDAWStore";

const originalState = useDAWStore.getState();

beforeEach(() => {
  commandManager.clear();
  vi.spyOn(nativeBridge, "setTempoMarkers").mockResolvedValue(true);
  vi.spyOn(nativeBridge, "clearTempoMarkers").mockResolvedValue(true);
  useDAWStore.setState({
    tempoMarkers: [],
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    canUndo: false,
    canRedo: false,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("tempo marker transactions", () => {
  it("adds, updates, removes, undoes, and redoes stable IDs with exact backend sync", () => {
    useDAWStore.getState().addTempoMarker(-2, 500);
    let state = useDAWStore.getState();
    const markerId = state.tempoMarkers[0].id;
    expect(state.tempoMarkers).toEqual([{ id: markerId, time: 0, tempo: 300 }]);
    expect(nativeBridge.setTempoMarkers).toHaveBeenLastCalledWith([
      { id: markerId, time: 0, tempo: 300 },
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);

    state.undo();
    expect(useDAWStore.getState().tempoMarkers).toEqual([]);
    expect(nativeBridge.clearTempoMarkers).toHaveBeenCalled();
    state = useDAWStore.getState();
    state.redo();
    expect(useDAWStore.getState().tempoMarkers[0].id).toBe(markerId);

    commandManager.clear();
    useDAWStore.getState().updateTempoMarker(markerId, { time: 4, tempo: 5 });
    expect(useDAWStore.getState().tempoMarkers).toEqual([
      { id: markerId, time: 4, tempo: 10 },
    ]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tempoMarkers[0]).toEqual({ id: markerId, time: 0, tempo: 300 });

    commandManager.clear();
    useDAWStore.getState().removeTempoMarker(markerId);
    expect(useDAWStore.getState().tempoMarkers).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tempoMarkers[0].id).toBe(markerId);
  });

  it("rejects invalid, missing, unchanged, and locked mutations without sync or history", () => {
    useDAWStore.getState().addTempoMarker(Number.NaN, 120);
    useDAWStore.getState().addTempoMarker(1, Number.POSITIVE_INFINITY);
    useDAWStore.getState().removeTempoMarker("missing");
    expect(useDAWStore.getState().tempoMarkers).toEqual([]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(nativeBridge.setTempoMarkers).not.toHaveBeenCalled();

    useDAWStore.getState().addTempoMarker(1, 120);
    const marker = useDAWStore.getState().tempoMarkers[0];
    commandManager.clear();
    vi.mocked(nativeBridge.setTempoMarkers).mockClear();
    useDAWStore.getState().updateTempoMarker(marker.id, { time: 1, tempo: 120 });
    useDAWStore.getState().updateTempoMarker(marker.id, { time: Number.NaN });
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(nativeBridge.setTempoMarkers).not.toHaveBeenCalled();

    useDAWStore.setState({ globalLocked: true });
    useDAWStore.getState().removeTempoMarker(marker.id);
    useDAWStore.getState().updateTempoMarker(marker.id, { tempo: 140 });
    useDAWStore.getState().addTempoMarker(2, 140);
    expect(useDAWStore.getState().tempoMarkers).toEqual([marker]);

    useDAWStore.setState({
      globalLocked: false,
      lockSettings: { items: false, envelopes: false, timeSelection: false, markers: true },
    });
    useDAWStore.getState().removeTempoMarker(marker.id);
    expect(useDAWStore.getState().tempoMarkers).toEqual([marker]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });
});
