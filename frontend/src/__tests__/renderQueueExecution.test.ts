import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultRenderDialogOptions, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();

function queuedOptions(overrides: Record<string, unknown> = {}) {
  return {
    ...createDefaultRenderDialogOptions(),
    bounds: "custom" as const,
    startTime: 0,
    endTime: 2,
    directory: "C:\\Exports",
    fileName: "$project",
    addTail: false,
    projectName: "Queue Test",
    ...overrides,
  };
}

describe("render queue execution", () => {
  beforeEach(() => {
    useDAWStore.setState({
      renderQueue: [],
      tracks: [],
      regions: [],
      selectedTrackIds: [],
      selectedClipIds: [],
      selectedRegionIds: [],
      razorEdits: [],
      syncClipsWithBackend: async () => undefined,
    });
    vi.spyOn(nativeBridge, "clearPitchPreviewRoutesForCorrectedSources").mockResolvedValue(0);
    vi.spyOn(nativeBridge, "clearAllPitchPreviewRoutes").mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useDAWStore.setState({
      ...initialState,
      renderQueue: [],
    });
  });

  it("preserves MP3 bitrate and marks a successful job done", async () => {
    const render = vi.spyOn(nativeBridge, "renderProject").mockResolvedValue(true);
    useDAWStore.setState({
      renderQueue: [{
        id: "mp3-job",
        options: queuedOptions({ format: "mp3", mp3Bitrate: 192 }),
        status: "pending",
      }],
    });

    await useDAWStore.getState().executeRenderQueue();

    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      format: "mp3",
      bitDepth: 192,
      source: "master",
    }));
    expect(useDAWStore.getState().renderQueue[0]).toMatchObject({ status: "done" });
  });

  it("marks a native false result as an error instead of a completed export", async () => {
    vi.spyOn(nativeBridge, "renderProject").mockResolvedValue(false);
    useDAWStore.setState({
      renderQueue: [{
        id: "failed-job",
        options: queuedOptions(),
        status: "pending",
      }],
    });

    await useDAWStore.getState().executeRenderQueue();

    expect(useDAWStore.getState().renderQueue[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("Audio engine rejected"),
    });
  });

  it("expands stem-by-region jobs without overwriting duplicate wildcard paths", async () => {
    const render = vi.spyOn(nativeBridge, "renderProject").mockResolvedValue(true);
    useDAWStore.setState({
      renderQueue: [{
        id: "stems-job",
        options: queuedOptions({
          source: "stems",
          bounds: "project_regions",
          tracks: [
            { id: "track-a", name: "Guitar" },
            { id: "track-b", name: "Bass" },
          ],
          regions: [
            { id: "region-a", name: "Verse", startTime: 0, endTime: 1, color: "#111111" },
            { id: "region-b", name: "Chorus", startTime: 1, endTime: 2, color: "#222222" },
          ],
        }),
        status: "pending",
      }],
    });

    await useDAWStore.getState().executeRenderQueue();

    expect(render).toHaveBeenCalledTimes(6);
    const calls = render.mock.calls.map(([options]) => options);
    expect(new Set(calls.map((options) => options.filePath.toLocaleLowerCase())).size).toBe(6);
    expect(calls.map((options) => options.source)).toEqual([
      "master", "stem:track-a", "stem:track-b",
      "master", "stem:track-a", "stem:track-b",
    ]);
  });

  it("keeps selected clip IDs and route for dithered queued exports", async () => {
    const render = vi.spyOn(nativeBridge, "renderProjectWithDither").mockResolvedValue(true);
    useDAWStore.setState({
      renderQueue: [{
        id: "selected-job",
        options: queuedOptions({
          source: "selected_items_master",
          selectedClipIds: ["clip-a"],
          dither: true,
          ditherType: "shaped",
          bitDepth: 16,
        }),
        status: "pending",
      }],
    });

    await useDAWStore.getState().executeRenderQueue();

    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      source: "selected_items_master",
      includedClipIds: ["clip-a"],
      ditherType: "shaped",
    }));
  });
});
