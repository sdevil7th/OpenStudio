import { expect, test, type Page } from "@playwright/test";

interface RecordedRenderCall {
  source: string;
  startTime: number;
  endTime: number;
  filePath: string;
  format: string;
  bitDepth: number;
  includedClipIds?: string[];
}

async function installRenderRecorder(page: Page) {
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/services/NativeBridge.ts");
    const pageGlobal = window as Window & { __renderCalls: unknown[] };
    pageGlobal.__renderCalls = [];
    nativeBridge.renderProject = async (options) => {
      pageGlobal.__renderCalls.push(structuredClone(options));
      return true;
    };
    nativeBridge.renderProjectWithDither = async (options) => {
      pageGlobal.__renderCalls.push(structuredClone(options));
      return true;
    };
  });
}

async function readRenderCalls(page: Page): Promise<RecordedRenderCall[]> {
  return page.evaluate(() => (
    window as Window & { __renderCalls: RecordedRenderCall[] }
  ).__renderCalls);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await installRenderRecorder(page);
});

test("selected-item MP3 export preserves selection and bitrate across the UI bridge", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDefaultTrack, useDAWStore } = await import("/src/store/useDAWStore.ts");
    const current = useDAWStore.getState();
    const track = createDefaultTrack("audio-track", "Audio");
    track.clips = [{
      id: "selected-audio-clip",
      filePath: "C:\\Audio\\selected.wav",
      name: "Selected",
      startTime: 1,
      duration: 2,
      offset: 0,
      color: "#336699",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
      sampleRate: 44100,
    }];
    useDAWStore.setState({
      tracks: [track],
      selectedClipIds: ["selected-audio-clip"],
      projectName: "Selected Export",
      syncClipsWithBackend: async () => undefined,
      renderDialogOptions: {
        ...current.renderDialogOptions,
        source: "selected_items",
        bounds: "custom",
        startTime: 1,
        endTime: 3,
        directory: "C:\\Exports",
        fileName: "$project",
        format: "mp3",
        mp3Bitrate: 192,
        addTail: false,
      },
      showRenderModal: true,
    });
  });

  await expect(page.getByText("Render to File", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Render 1 file" }).click();
  await expect.poll(() => readRenderCalls(page)).toHaveLength(1);
  const [call] = await readRenderCalls(page);
  expect(call).toMatchObject({
    source: "selected_items",
    startTime: 1,
    endTime: 3,
    format: "mp3",
    bitDepth: 192,
    includedClipIds: ["selected-audio-clip"],
  });
});

test("stem-by-region exports reserve unique paths and report the complete job count", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDefaultTrack, useDAWStore } = await import("/src/store/useDAWStore.ts");
    const current = useDAWStore.getState();
    useDAWStore.setState({
      tracks: [
        createDefaultTrack("track-a", "Guitar"),
        createDefaultTrack("track-b", "Bass"),
      ],
      regions: [
        { id: "region-a", name: "Verse", startTime: 0, endTime: 2, color: "#123456" },
        { id: "region-b", name: "Chorus", startTime: 2, endTime: 4, color: "#654321" },
      ],
      projectName: "Collision Test",
      syncClipsWithBackend: async () => undefined,
      renderDialogOptions: {
        ...current.renderDialogOptions,
        source: "stems",
        bounds: "project_regions",
        startTime: 0,
        endTime: 4,
        directory: "C:\\Exports",
        fileName: "$project",
        format: "wav",
        addTail: false,
      },
      showRenderModal: true,
    });
  });

  await expect(page.getByRole("button", { name: "Render 6 files" })).toBeVisible();
  await page.getByRole("button", { name: "Render 6 files" }).click();
  await expect.poll(() => readRenderCalls(page)).toHaveLength(6);

  const calls = await readRenderCalls(page);
  expect(new Set(calls.map((call) => call.filePath.toLocaleLowerCase())).size).toBe(6);
  expect(calls.map((call) => call.source)).toEqual([
    "master",
    "stem:track-a",
    "stem:track-b",
    "master",
    "stem:track-a",
    "stem:track-b",
  ]);
  expect(calls.map(({ startTime, endTime }) => [startTime, endTime])).toEqual([
    [0, 2], [0, 2], [0, 2],
    [2, 4], [2, 4], [2, 4],
  ]);
});

test("secondary output repeats the exact source and range with its own codec settings", async ({ page }) => {
  await page.evaluate(async () => {
    const { useDAWStore } = await import("/src/store/useDAWStore.ts");
    const current = useDAWStore.getState();
    useDAWStore.setState({
      projectName: "Dual Format",
      syncClipsWithBackend: async () => undefined,
      secondaryOutputEnabled: true,
      secondaryOutputFormat: "mp3",
      secondaryOutputBitDepth: 24,
      renderDialogOptions: {
        ...current.renderDialogOptions,
        source: "master",
        bounds: "custom",
        startTime: 2,
        endTime: 5,
        directory: "C:\\Exports",
        fileName: "$project",
        format: "wav",
        bitDepth: 24,
        mp3Bitrate: 256,
        addTail: false,
      },
      showRenderModal: true,
    });
  });

  await page.getByRole("button", { name: "Render 2 files" }).click();
  await expect.poll(() => readRenderCalls(page)).toHaveLength(2);
  const [primary, secondary] = await readRenderCalls(page);
  expect(primary).toMatchObject({
    source: "master",
    startTime: 2,
    endTime: 5,
    format: "wav",
    bitDepth: 24,
  });
  expect(secondary).toMatchObject({
    source: "master",
    startTime: 2,
    endTime: 5,
    format: "mp3",
    bitDepth: 256,
  });
  expect(primary.filePath).toMatch(/\.wav$/i);
  expect(secondary.filePath).toMatch(/\.mp3$/i);
});

test("region matrix preserves MP3 bitrate and distinct output planning", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDefaultTrack, useDAWStore } = await import("/src/store/useDAWStore.ts");
    useDAWStore.setState({
      tracks: [
        createDefaultTrack("matrix-a", "Guitar"),
        createDefaultTrack("matrix-b", "Bass"),
      ],
      regions: [
        { id: "matrix-region-a", name: "Verse", startTime: 0, endTime: 1, color: "#123456" },
        { id: "matrix-region-b", name: "Chorus", startTime: 1, endTime: 2, color: "#654321" },
      ],
      projectName: "Matrix Export",
      syncClipsWithBackend: async () => undefined,
      showRegionRenderMatrix: true,
    });
  });

  await expect(page.getByText("Region Render Matrix", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select All" }).click();
  await page.getByText("Directory:", { exact: true }).locator("..").getByRole("textbox").fill("C:\\Exports");
  await page.getByText("Format:", { exact: true }).locator("..").locator("select").selectOption("mp3");
  await page.getByText("Bitrate:", { exact: true }).locator("..").locator("select").selectOption("192");
  await page.getByRole("button", { name: "Render 4 files" }).click();
  await expect.poll(() => readRenderCalls(page)).toHaveLength(4);

  const calls = await readRenderCalls(page);
  expect(calls.every((call) => call.format === "mp3" && call.bitDepth === 192)).toBe(true);
  expect(new Set(calls.map((call) => call.filePath.toLocaleLowerCase())).size).toBe(4);
});

test("region matrix surfaces a native render rejection instead of showing completion", async ({ page }) => {
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/services/NativeBridge.ts");
    const { createDefaultTrack, useDAWStore } = await import("/src/store/useDAWStore.ts");
    nativeBridge.renderProject = async (options) => {
      (window as Window & { __renderCalls: unknown[] }).__renderCalls.push(structuredClone(options));
      return false;
    };
    useDAWStore.setState({
      tracks: [createDefaultTrack("failed-matrix-track", "Guitar")],
      regions: [{
        id: "failed-matrix-region",
        name: "Verse",
        startTime: 0,
        endTime: 1,
        color: "#123456",
      }],
      syncClipsWithBackend: async () => undefined,
      showRegionRenderMatrix: true,
    });
  });

  await page.getByRole("button", { name: "Select All" }).click();
  await page.getByText("Directory:", { exact: true }).locator("..").getByRole("textbox").fill("C:\\Exports");
  let rejectionMessage = "";
  page.once("dialog", async (dialog) => {
    rejectionMessage = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Render 1 file" }).click();
  await expect.poll(() => rejectionMessage).toContain("Audio engine rejected");
  await expect(page.getByText("Region Render Matrix", { exact: true })).toBeVisible();
});
