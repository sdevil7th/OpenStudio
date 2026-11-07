import { expect, test } from "@playwright/test";
import type { useDAWStore } from "../src/store/useDAWStore";
import type { commandManager } from "../src/store/commands";
declare global { interface Window { __crossfadeQA: { store: typeof useDAWStore; history: typeof commandManager } } }

test("contained and grouped crossfades have editable, matching gain previews and atomic undo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("App store module missing");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const commandUrl = "/src/store/commands/index.ts";
    const { commandManager: history } = await import(/* @vite-ignore */ commandUrl) as typeof import("../src/store/commands");
    const track = createDefaultTrack("crossfade-ui", "Crossfade UI");
    track.clips = [
      { id: "bed", name: "Original performance", filePath: "C:/bed.wav", startTime: 0, duration: 10,
        offset: 0, color: "#abc", sampleRate: 48000, volumeDB: 0, fadeIn: 0.3, fadeOut: 0,
        gainEnvelope: [{ time: 0, gain: 0.5 }, { time: 10, gain: 1.5 }] },
      { id: "insert", name: "Contained replacement", filePath: "C:/insert.wav", startTime: 2, duration: 2,
        offset: 0, color: "#abc", sampleRate: 48000, volumeDB: 0, fadeIn: 0, fadeOut: 0 },
      { id: "third", name: "Another replacement", filePath: "C:/third.wav", startTime: 6, duration: 2,
        offset: 0, color: "#abc", sampleRate: 48000, volumeDB: 0, fadeIn: 0, fadeOut: 0 },
    ];
    history.clear();
    store.setState({ tracks: [track], selectedClipIds: ["bed", "insert"], selectedClipId: "insert",
      showMixer: false, showPianoRoll: false, showPitchEditor: false, showGettingStarted: false,
      inputProfileOnboardingSeen: true, autoBackupEnabled: false, globalLocked: false,
      lockSettings: { ...store.getState().lockSettings, items: false }, syncClipsWithBackend: async () => {},
      transport: { ...store.getState().transport, isPlaying: false, isRecording: false } });
    window.__crossfadeQA = { store, history };
    if (!store.getState().editSelectedCrossfade()) throw new Error("Contained crossfade editor unavailable");
  });
  const dialog = page.getByRole("dialog", { name: "Crossfade Editor" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/2 clips · 2 handoffs/)).toBeVisible();
  await expect(dialog.getByRole("img", { name: /Resulting clip gain curves/ })).toBeVisible();
  await dialog.getByLabel("Automatic transition lengths").uncheck();
  await dialog.getByLabel("Crossfade transition length in seconds").fill("0.25");
  await dialog.getByLabel("Outgoing Curve").selectOption("1");
  await dialog.getByLabel("Incoming Curve").selectOption("1");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toBeHidden();
  const applied = await page.evaluate(() => {
    const state = window.__crossfadeQA.store.getState(), bed = state.tracks[0].clips[0];
    return { fadeIn: bed.fadeIn, base: bed.gainEnvelope, layer: bed.crossfadeLayers?.[0], undo: window.__crossfadeQA.history.getUndoStack().length };
  });
  expect(applied).toMatchObject({ fadeIn: 0.3, base: [{ time: 0, gain: 0.5 }, { time: 10, gain: 1.5 }],
    layer: { settings: { transitionLength: 0.25, fadeInShape: 1, fadeOutShape: 1 } }, undo: 1 });
  await page.evaluate(() => window.__crossfadeQA.store.getState().undo());
  expect(await page.evaluate(() => window.__crossfadeQA.store.getState().tracks[0].clips[0].crossfadeLayers)).toBeUndefined();
  await page.evaluate(() => {
    const store = window.__crossfadeQA.store;
    store.setState({ selectedClipIds: ["bed", "insert", "third"] });
    if (!store.getState().editSelectedCrossfade()) throw new Error("Grouped crossfade editor unavailable");
  });
  await expect(dialog.getByText(/3 clips · 4 handoffs/)).toBeVisible();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  expect(await page.evaluate(() => window.__crossfadeQA.store.getState().tracks[0].clips.every(clip => clip.crossfadeLayers?.length === 1))).toBe(true);
  await page.evaluate(() => window.__crossfadeQA.store.getState().editSelectedCrossfade());
  await dialog.getByRole("button", { name: "Remove Crossfade", exact: true }).click();
  expect(await page.evaluate(() => window.__crossfadeQA.store.getState().tracks[0].clips.every(clip => !clip.crossfadeLayers?.length))).toBe(true);
  await page.evaluate(() => {
    const store = window.__crossfadeQA.store;
    store.getState().undo();
    store.getState().splitClipAtPosition("bed", 1);
    const fragment = store.getState().tracks[0].clips.find(clip => clip.name === "Original performance")!;
    store.setState({ selectedClipIds: [fragment.id], selectedClipId: fragment.id });
    if (!store.getState().editSelectedCrossfade()) throw new Error("Split member lost its crossfade editor");
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/also affects the linked clips/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove Crossfade", exact: true })).toBeEnabled();
  await page.screenshot({ path: "../output/shared-project-qualification/crossfade-split-editor.png" });
  await dialog.getByRole("button", { name: "Remove Crossfade", exact: true }).click();
  expect(await page.evaluate(() => window.__crossfadeQA.store.getState().tracks[0].clips.every(clip => !clip.crossfadeLayers?.length))).toBe(true);
});
