import { describe, expect, it } from "vitest";
import { insertTrackCopies, trackDragSourceIds, type TrackCopySource } from "../utils/trackCopyPlanning";

describe("track drag copying", () => {
  const tracks = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const copies = [
    { sourceTrack: tracks[0], duplicate: { id: "a-copy" } },
    { sourceTrack: tracks[2], duplicate: { id: "c-copy" } },
  ];
  it("copies the selected group in project order when grabbing a selected row", () => {
    expect(trackDragSourceIds(tracks, ["c", "a", "missing"], "a")).toEqual(["a", "c"]);
    expect(trackDragSourceIds(tracks, ["c", "a"], "b")).toEqual(["b"]);
  });
  it("inserts the whole group at the drop row without moving the originals", () => {
    expect(insertTrackCopies(tracks, copies, "d").map((track) => track.id)).toEqual([
      "a", "b", "c", "a-copy", "c-copy", "d",
    ]);
    expect(tracks.map((track) => track.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("keeps normal duplicate placement when dropping back on the source", () => {
    expect(insertTrackCopies(tracks, copies).map((track) => track.id)).toEqual([
      "a", "a-copy", "b", "c", "c-copy", "d",
    ]);
  });

  const folderTracks: TrackCopySource[] = [
    { id: "folder", isFolder: true },
    { id: "child", parentFolderId: "folder" },
    { id: "nested", parentFolderId: "folder", isFolder: true },
    { id: "leaf", parentFolderId: "nested" },
    { id: "outside" },
  ];
  const folderCopies = folderTracks.slice(0, 4).map((sourceTrack) => ({
    sourceTrack,
    duplicate: { ...sourceTrack, id: `${sourceTrack.id}-copy`, parentFolderId: sourceTrack.parentFolderId ? `${sourceTrack.parentFolderId}-copy` : undefined },
  }));

  it("includes a selected folder's complete subtree and de-duplicates selected children", () => {
    expect(trackDragSourceIds(folderTracks, ["folder", "leaf"], "folder")).toEqual(["folder", "child", "nested", "leaf"]);
    expect(trackDragSourceIds(folderTracks, ["folder"], "outside")).toEqual(["outside"]);
  });

  it("inserts a duplicated folder after its original subtree without interleaving children", () => {
    const result = insertTrackCopies(folderTracks, folderCopies);
    expect(result.map((track) => track.id)).toEqual(["folder", "child", "nested", "leaf", "folder-copy", "child-copy", "nested-copy", "leaf-copy", "outside"]);
    expect(result.find((track) => track.id === "leaf-copy")?.parentFolderId).toBe("nested-copy");
  });

  it("places copied child roots at the destination hierarchy level without changing their originals", () => {
    const sourceTrack = folderTracks[1];
    const duplicate = { ...sourceTrack, id: "child-copy" };
    const result = insertTrackCopies(folderTracks, [{ sourceTrack, duplicate }], "folder");
    expect(result[0]).toEqual({ id: "child-copy", parentFolderId: undefined });
    expect(duplicate.parentFolderId).toBe("folder");
    expect(folderTracks[1].parentFolderId).toBe("folder");
  });

  it("reparents copied folder roots at a nested drop while retaining copied internal links", () => {
    const result = insertTrackCopies(folderTracks, folderCopies, "leaf");
    expect(result.find((track) => track.id === "folder-copy")?.parentFolderId).toBe("nested");
    expect(result.find((track) => track.id === "child-copy")?.parentFolderId).toBe("folder-copy");
    expect(result.find((track) => track.id === "leaf-copy")?.parentFolderId).toBe("nested-copy");
  });
});
