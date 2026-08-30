import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { CommandManager, commandManager } from "../store/commands";
import { useDAWStore } from "../store/useDAWStore";
import {
  createTimelineGestureUndoCommand,
  getTimelineTrackTopologyDelta,
  reconcileTimelineTrackTopology,
  type TimelineGestureSnapshot,
} from "../utils/timelineGestureUndo";

type StubTrack = { id: string; value: number };

function snapshot(
  tracks: readonly StubTrack[],
  isModified: boolean,
): TimelineGestureSnapshot<StubTrack> {
  return {
    tracks,
    selectedClipId: tracks.length > 0 ? tracks[tracks.length - 1].id : null,
    selectedClipIds: tracks.map((track) => track.id),
    isModified,
  };
}

describe("timeline gesture undo command", () => {
  it("owns one undo entry, restores dirty state, and reports topology in both directions", () => {
    const before = snapshot([{ id: "existing", value: 1 }], false);
    const after = snapshot([
      { id: "existing", value: 2 },
      { id: "generated", value: 3 },
    ], true);
    let live = snapshot(after.tracks, after.isModified);
    const topology: Array<{ added: string[]; removed: string[] }> = [];
    const manager = new CommandManager();

    manager.push(createTimelineGestureUndoCommand("Move timeline clip", before, after, {
      cloneTracks: (tracks) => tracks.map((track) => ({ ...track })),
      applySnapshot: (next) => { live = next; },
      afterApply: (previous, next) => {
        const delta = getTimelineTrackTopologyDelta(previous.tracks, next.tracks);
        topology.push({
          added: delta.added.map((track) => track.id),
          removed: delta.removed.map((track) => track.id),
        });
      },
    }));

    expect(manager.getUndoStack()).toHaveLength(1);
    expect(manager.undo()).toBe(true);
    expect(live).toMatchObject({
      tracks: [{ id: "existing", value: 1 }],
      selectedClipId: "existing",
      isModified: false,
    });
    expect(topology).toEqual([{ added: [], removed: ["generated"] }]);

    expect(manager.redo()).toBe(true);
    expect(live).toMatchObject({
      tracks: [
        { id: "existing", value: 2 },
        { id: "generated", value: 3 },
      ],
      selectedClipId: "generated",
      isModified: true,
    });
    expect(topology[topology.length - 1]).toEqual({ added: ["generated"], removed: [] });
  });

  it("adds before content sync, removes after it, and removes even when sync fails", async () => {
    const existing = { id: "existing" };
    const generated = { id: "generated" };
    const redoOrder: string[] = [];
    await reconcileTimelineTrackTopology([existing], [existing, generated], {
      addTrack: async (track) => { redoOrder.push(`add:${track.id}`); },
      syncContent: async () => { redoOrder.push("sync"); },
      removeTrack: async (track) => { redoOrder.push(`remove:${track.id}`); },
    });
    expect(redoOrder).toEqual(["add:generated", "sync"]);

    const undoOrder: string[] = [];
    await expect(reconcileTimelineTrackTopology([existing, generated], [existing], {
      addTrack: async (track) => { undoOrder.push(`add:${track.id}`); },
      syncContent: async () => {
        undoOrder.push("sync");
        throw new Error("clip sync failed");
      },
      removeTrack: async (track) => { undoOrder.push(`remove:${track.id}`); },
    })).rejects.toThrow("clip sync failed");
    expect(undoOrder).toEqual(["sync", "remove:generated"]);
  });
});

describe("compound timeline track insertion", () => {
  const originalState = useDAWStore.getState();

  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState({
      tracks: [],
      globalLocked: false,
      canUndo: false,
      canRedo: false,
    });
    vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("generated");
    vi.spyOn(nativeBridge, "setTrackType").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackRecordArm").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackInputMonitoring").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTrackInputChannels").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(originalState);
  });

  it("can insert a backend-precreated track without adding a second undo command", () => {
    useDAWStore.getState().addTrack({
      id: "generated",
      name: "Audio 2",
      type: "audio",
    }, {
      backendAlreadyCreated: true,
      recordUndo: false,
    });

    expect(useDAWStore.getState().tracks.map((track) => track.id)).toEqual(["generated"]);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(nativeBridge.addTrack).not.toHaveBeenCalled();
  });
});
