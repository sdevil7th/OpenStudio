import { describe, expect, it, vi } from "vitest";
import {
  BuiltInPluginParamHistory,
  type BuiltInPluginHistoryReplay,
} from "../utils/builtInPluginParamHistory";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("built-in plugin parameter history", () => {
  it("records a knob drag as one undo step and replays redo", async () => {
    const history = new BuiltInPluginParamHistory("nam-window-a");
    const flush = vi.fn(async () => true);
    const replay = vi.fn<BuiltInPluginHistoryReplay>(async () => true);

    history.begin("drive", "Drive", 0.1);
    history.update("drive", 0.25);
    history.update("drive", 0.63);
    history.update("drive", 0.8);

    await expect(history.commit(flush)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(history.getUndoEntries()).toEqual([{
      instanceId: "nam-window-a",
      changes: [{
        paramId: "drive",
        label: "Drive",
        before: 0.1,
        after: 0.8,
      }],
    }]);

    await expect(history.undo(flush, replay)).resolves.toBe("applied");
    expect(replay).toHaveBeenNthCalledWith(1, expect.objectContaining({
      instanceId: "nam-window-a",
    }), "before");
    expect(history.getUndoEntries()).toHaveLength(0);
    expect(history.getRedoEntries()).toHaveLength(1);

    await expect(history.redo(flush, replay)).resolves.toBe("applied");
    expect(replay).toHaveBeenNthCalledWith(2, expect.objectContaining({
      instanceId: "nam-window-a",
    }), "after");
    expect(history.getUndoEntries()).toHaveLength(1);
    expect(history.getRedoEntries()).toHaveLength(0);
  });

  it("groups the bass profile and paired defaults into one atomic command", async () => {
    const history = new BuiltInPluginParamHistory("nam-bass-window");
    const flush = vi.fn(async () => true);
    const replay = vi.fn<BuiltInPluginHistoryReplay>(async () => true);

    history.begin("instrumentProfile", "Instrument", 0);
    history.update("instrumentProfile", 1);
    history.begin("gateThresholdDb", "Gate", -80);
    history.update("gateThresholdDb", -65);
    history.begin("eqHPFHz", "EQ HPF", 80);
    history.update("eqHPFHz", 35);

    await history.commit(flush);
    expect(history.getUndoEntries()).toEqual([{
      instanceId: "nam-bass-window",
      changes: [
        { paramId: "instrumentProfile", label: "Instrument", before: 0, after: 1 },
        { paramId: "gateThresholdDb", label: "Gate", before: -80, after: -65 },
        { paramId: "eqHPFHz", label: "EQ HPF", before: 80, after: 35 },
      ],
    }]);

    await history.undo(flush, replay);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0]?.[0].changes).toHaveLength(3);
    expect(replay.mock.calls[0]?.[1]).toBe("before");
  });

  it("keeps two detached processor instances isolated", async () => {
    const first = new BuiltInPluginParamHistory("nam-window-one");
    const second = new BuiltInPluginParamHistory("nam-window-two");
    const flush = async () => true;
    const replay = vi.fn<BuiltInPluginHistoryReplay>(async () => true);

    first.begin("drive", "Drive", 0.2);
    first.update("drive", 0.7);
    second.begin("drive", "Drive", 0.4);
    second.update("drive", 0.9);
    await Promise.all([first.commit(flush), second.commit(flush)]);

    await first.undo(flush, replay);
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: "nam-window-one",
    }), "before");
    expect(first.getUndoEntries()).toHaveLength(0);
    expect(second.getUndoEntries()).toHaveLength(1);
    expect(second.getRedoEntries()).toHaveLength(0);
  });

  it("waits for pending native writes before undoing the committed value", async () => {
    const history = new BuiltInPluginParamHistory("pending-write-window");
    const pendingFlush = deferred<boolean>();
    const replay = vi.fn<BuiltInPluginHistoryReplay>(async () => true);

    history.begin("drive", "Drive", 0.15);
    history.update("drive", 0.75);
    const commitResult = history.commit(() => pendingFlush.promise);
    const undoResult = history.undo(async () => true, replay);

    await Promise.resolve();
    expect(replay).not.toHaveBeenCalled();
    pendingFlush.resolve(true);

    await expect(commitResult).resolves.toBe(true);
    await expect(undoResult).resolves.toBe("applied");
    expect(replay).toHaveBeenCalledOnce();
    expect(replay.mock.calls[0]?.[1]).toBe("before");
  });

  it("queues a fast redo behind an in-flight undo", async () => {
    const history = new BuiltInPluginParamHistory("fast-redo-window");
    const finishUndo = deferred<boolean>();
    const directions: string[] = [];
    const replay: BuiltInPluginHistoryReplay = async (_entry, direction) => {
      directions.push(direction);
      return direction === "before" ? finishUndo.promise : true;
    };

    history.begin("outputTrimDb", "Output", 0);
    history.update("outputTrimDb", -3);
    await history.commit(async () => true);

    const undoResult = history.undo(async () => true, replay);
    await Promise.resolve();
    expect(history.canRedo()).toBe(true);
    const redoResult = history.redo(async () => true, replay);
    finishUndo.resolve(true);

    await expect(undoResult).resolves.toBe("applied");
    await expect(redoResult).resolves.toBe("applied");
    expect(directions).toEqual(["before", "after"]);
    expect(history.getUndoEntries()).toHaveLength(1);
    expect(history.getRedoEntries()).toHaveLength(0);
  });

  it("reports empty history and preserves a command after failed replay", async () => {
    const history = new BuiltInPluginParamHistory("failure-window");
    const flush = async () => true;
    const replay = vi.fn<BuiltInPluginHistoryReplay>(async () => false);

    await expect(history.undo(flush, replay)).resolves.toBe("empty");
    history.begin("mix", "Mix", 0.2);
    history.update("mix", 0.8);
    await history.commit(flush);

    await expect(history.undo(flush, replay)).resolves.toBe("failed");
    expect(history.getUndoEntries()).toHaveLength(1);
    expect(history.getRedoEntries()).toHaveLength(0);
  });
});
