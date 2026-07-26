// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  mutateStoredNAMPreset,
  type NAMStoredPresetMutationBridge,
} from "../utils/namPresetLibrary";

function makeBridge(
  copyResult: boolean | Error,
  deleteResult: boolean | Error = true,
): NAMStoredPresetMutationBridge {
  return {
    copyBuiltInFXPreset: vi.fn(async () => {
      if (copyResult instanceof Error) throw copyResult;
      return copyResult;
    }),
    deleteBuiltInFXPreset: vi.fn(async () => {
      if (deleteResult instanceof Error) throw deleteResult;
      return deleteResult;
    }),
  };
}

describe("NAM stored preset library mutations", () => {
  it("wires Duplicate/Rename to stored payload APIs rather than live rack recall", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const handlersStart = panelSource.indexOf("const duplicateUserPreset");
    const handlersEnd = panelSource.indexOf("const togglePresetFavorite", handlersStart);
    const handlers = panelSource.slice(handlersStart, handlersEnd);

    expect(handlersStart).toBeGreaterThan(-1);
    expect(handlersEnd).toBeGreaterThan(handlersStart);
    expect(handlers.match(/mutateStoredNAMPreset\(/g)).toHaveLength(2);
    expect(handlers).not.toContain("loadBuiltInFXPreset");
    expect(handlers).not.toContain("saveBuiltInFXPreset");
    expect(handlers).not.toContain("setBuiltInPluginState");
    expect(handlers).toContain("could not be deleted. Both presets remain.");
  });

  it("duplicates the stored payload without deleting or recalling anything", async () => {
    const bridge = makeBridge(true);

    const result = await mutateStoredNAMPreset(
      bridge,
      "OpenStudio NAM Rack",
      "Studio Clean",
      "Studio Clean Copy",
      "duplicate",
    );

    expect(result).toEqual({ success: true, copied: true, sourceDeleted: false });
    expect(bridge.copyBuiltInFXPreset).toHaveBeenCalledWith(
      "OpenStudio NAM Rack",
      "Studio Clean",
      "Studio Clean Copy",
    );
    expect(bridge.deleteBuiltInFXPreset).not.toHaveBeenCalled();
    expect(Object.keys(bridge)).toEqual(["copyBuiltInFXPreset", "deleteBuiltInFXPreset"]);
  });

  it("does not delete the source when the renamed target cannot be saved", async () => {
    const bridge = makeBridge(false);

    const result = await mutateStoredNAMPreset(
      bridge,
      "OpenStudio NAM Rack",
      "Old Name",
      "New Name",
      "rename",
    );

    expect(result).toEqual({
      success: false,
      copied: false,
      sourceDeleted: false,
      failure: "copy-failed",
    });
    expect(bridge.deleteBuiltInFXPreset).not.toHaveBeenCalled();
  });

  it("deletes the source only after the renamed target is saved", async () => {
    const calls: string[] = [];
    const bridge: NAMStoredPresetMutationBridge = {
      copyBuiltInFXPreset: vi.fn(async () => {
        calls.push("copy");
        return true;
      }),
      deleteBuiltInFXPreset: vi.fn(async () => {
        calls.push("delete");
        return true;
      }),
    };

    const result = await mutateStoredNAMPreset(
      bridge,
      "OpenStudio NAM Rack",
      "Old Name",
      "New Name",
      "rename",
    );

    expect(calls).toEqual(["copy", "delete"]);
    expect(result).toEqual({ success: true, copied: true, sourceDeleted: true });
  });

  it.each([false, new Error("locked")])(
    "surfaces source deletion failure after the target was saved (%s)",
    async (deleteResult) => {
      const bridge = makeBridge(true, deleteResult);

      const result = await mutateStoredNAMPreset(
        bridge,
        "OpenStudio NAM Rack",
        "Old Name",
        "New Name",
        "rename",
      );

      expect(result).toEqual({
        success: false,
        copied: true,
        sourceDeleted: false,
        failure: "delete-failed",
      });
      expect(bridge.deleteBuiltInFXPreset).toHaveBeenCalledWith(
        "OpenStudio NAM Rack",
        "Old Name",
      );
    },
  );
});
