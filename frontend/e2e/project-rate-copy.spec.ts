import { expect, test } from "@playwright/test";
import type { useDAWStore } from "../src/store/useDAWStore";
import type { commandManager } from "../src/store/commands";
import type { ProjectRateCopyResult } from "../src/services/NativeBridge";

declare global { interface Window { __rateCopyQA: { store: typeof useDAWStore; history: typeof commandManager;
  resolve: ((result: ProjectRateCopyResult) => void) | null; cancelled: string[] } } }

test("project-rate copies expose cancellation, preserve trim and support source Undo/Redo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("App store module missing");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const bridgeUrl = "/src/services/NativeBridge.ts", historyUrl = "/src/store/commands/index.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
    const { commandManager: history } = await import(/* @vite-ignore */ historyUrl) as typeof import("../src/store/commands");
    const track = createDefaultTrack("rate-copy-track", "Recording");
    track.clips = [{ id: "rate-copy-clip", name: "48 kHz recording", filePath: "C:/source.wav", startTime: 0,
      duration: 10, offset: 1, sourceLength: 12, sampleRate: 48000, color: "#4361ee", volumeDB: -3, fadeIn: 0.2, fadeOut: 0.4 }];
    const qa = window.__rateCopyQA = { store, history, resolve: null as ((value: ProjectRateCopyResult) => void) | null, cancelled: [] as string[] };
    nativeBridge.createProjectRateCopy = async () => await new Promise<ProjectRateCopyResult>(resolve => { qa.resolve = resolve; });
    nativeBridge.cancelProjectRateCopy = async id => { qa.cancelled.push(id); qa.resolve?.({ success: false, cancelled: true }); return true; };
    nativeBridge.replacePlaybackClipSource = async () => true;
    nativeBridge.refreshWaveformPeaks = async () => true;
    nativeBridge.getWaveformPeaks = async () => [];
    history.clear();
    store.setState({ tracks: [track], selectedClipId: "rate-copy-clip", selectedClipIds: ["rate-copy-clip"],
      projectSampleRate: 44100, pixelsPerSecond: 100, scrollX: 0, scrollY: 0, trackHeight: 100,
      showMixer: false, showGettingStarted: false, inputProfileOnboardingSeen: true, autoBackupEnabled: false,
      showPitchEditor: false, globalLocked: false, lockSettings: { ...store.getState().lockSettings, items: false },
      syncClipsWithBackend: async () => {} });
  });
  const openClipMenu = async () => {
    const point = await page.evaluate(() => {
      const stage = window.Konva.stages.find(stage => stage.height() > 50 && stage.container().closest(".timeline-container"))!;
      const box = stage.container().getBoundingClientRect(); return { x: box.x + 200, y: box.y + 45 };
    });
    await page.mouse.click(point.x, point.y, { button: "right" });
    await expect(page.getByText("Create 44.1 kHz Project-Rate Copy", { exact: true })).toBeVisible();
    await page.getByText("Create 44.1 kHz Project-Rate Copy", { exact: true }).click();
  };
  await openClipMenu();
  const cancel = page.getByRole("button", { name: "Cancel 44.1 kHz audio copy" });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(cancel).toBeHidden();
  expect(await page.evaluate(() => ({ path: window.__rateCopyQA.store.getState().tracks[0].clips[0].filePath,
    cancelled: window.__rateCopyQA.cancelled.length, undo: window.__rateCopyQA.history.getUndoStack().length })))
    .toEqual({ path: "C:/source.wav", cancelled: 1, undo: 0 });
  await openClipMenu();
  await expect(cancel).toBeVisible();
  await page.evaluate(() => window.__rateCopyQA.resolve?.({ success: true, filePath: "C:/copy44100.wav", sampleRate: 44100, duration: 12, numChannels: 1 }));
  await expect(cancel).toBeHidden();
  const clip = () => page.evaluate(() => window.__rateCopyQA.store.getState().tracks[0].clips[0]);
  await expect.poll(async () => (await clip()).filePath).toBe("C:/copy44100.wav");
  expect(await clip()).toMatchObject({ originalFilePath: "C:/source.wav", sampleRate: 44100, offset: 1, startTime: 0, duration: 10, volumeDB: -3, fadeIn: 0.2, fadeOut: 0.4 });
  expect(await page.evaluate(() => window.__rateCopyQA.history.getUndoStack().length)).toBe(1);
  await page.evaluate(() => window.__rateCopyQA.store.getState().undo());
  await expect.poll(async () => (await clip()).filePath).toBe("C:/source.wav");
  await page.evaluate(() => window.__rateCopyQA.store.getState().redo());
  await expect.poll(async () => (await clip()).filePath).toBe("C:/copy44100.wav");
});
