import { expect, test, type Page } from "@playwright/test";
import { primaryModifier } from "./support/platformInput";
import type { useDAWStore } from "../src/store/useDAWStore";
import type { nativeBridge } from "../src/services/NativeBridge";

declare global {
  interface Window {
    __midiWorkflowQA: {
      store: typeof useDAWStore;
      exports: Parameters<typeof nativeBridge.exportProjectMIDI>[];
    };
  }
}

async function ready(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("App store import not found");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
    const track = createDefaultTrack("midi-workflow", "MIDI workflow", "#c66091", "midi", []);
    track.midiClips = ["a", "b", "c"].map((id, i) => ({ id, name: `Phrase ${id}`,
      startTime: 1 + i * 3, duration: 2, offset: 0, color: track.color, loopEnabled: false,
      events: [{ type: "noteOn", note: 60 + i, channel: 1, velocity: 90, timestamp: 0 },
        { type: "noteOff", note: 60 + i, channel: 1, velocity: 30, timestamp: 1.5 }] }));
    window.__midiWorkflowQA = { store, exports: [] };
    nativeBridge.showSaveDialog = async () => "C:/qa/selected.mid";
    nativeBridge.exportProjectMIDI = async (...args) => { window.__midiWorkflowQA.exports.push(args); return true; };
    store.setState({ tracks: [track], showGettingStarted: false, inputProfileOnboardingSeen: true,
      autoBackupEnabled: false, showMixer: false, showPianoRoll: false, showPitchEditor: false,
      selectedClipIds: [], selectedClipId: null, selectedTrackIds: [], selectedTrackId: null,
      mouseBehaviorProfileId: "openstudio", keyboardShortcutProfileId: "openstudio",
      mouseModifiers: {}, customShortcuts: {}, pixelsPerSecond: 100, scrollX: 0, scrollY: 0,
      trackHeight: 100, toolMode: "select", transport: { ...store.getState().transport, isPlaying: false, isRecording: false } });
  });
  await expect.poll(() => page.evaluate(() => window.Konva?.stages.some(s => s.height() > 50 && s.container().closest(".timeline-container")) ?? false)).toBe(true);
  return page.evaluate(() => {
    const stage = window.Konva.stages.find(s => s.height() > 50 && s.container().closest(".timeline-container"))!;
    const box = stage.container().getBoundingClientRect();
    return { x: box.x, y: box.y + 45 };
  });
}

async function selectTwo(page: Page, point: { x: number; y: number }, edge = false) {
  const modifier = await primaryModifier(page);
  await page.keyboard.down(modifier);
  await page.mouse.click(point.x + (edge ? 102 : 200), point.y);
  await page.mouse.click(point.x + (edge ? 402 : 500), point.y);
  await page.keyboard.up(modifier);
  await expect.poll(() => page.evaluate(() => window.__midiWorkflowQA.store.getState().selectedClipIds)).toEqual(["a", "b"]);
  await page.mouse.click(point.x + 500, point.y, { button: "right" });
  await expect.poll(() => page.evaluate(() => window.__midiWorkflowQA.store.getState().selectedClipIds)).toEqual(["a", "b"]);
}

test("Primary-modifier click followed by right-click exposes Join and preserves the selected clips", async ({ page }) => {
  const point = await ready(page);
  await selectTwo(page, point);
  await expect(page.getByText(/^Join Selected MIDI Clips/)).toBeVisible();
  await page.getByText(/^Join Selected MIDI Clips/).click();
  await expect.poll(() => page.evaluate(() => window.__midiWorkflowQA.store.getState().tracks[0].midiClips.length)).toBe(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__midiWorkflowQA.store.getState().tracks[0].midiClips.length)).toBe(3);
});

test("Primary-modifier click at clip edges also toggles selection without an accidental resize", async ({ page }) => {
  const point = await ready(page);
  await selectTwo(page, point, true);
  await expect(page.getByText(/^Join Selected MIDI Clips/)).toBeVisible();
});

test("the selected export menu writes every selected clip to one file without joining", async ({ page }) => {
  const point = await ready(page);
  await selectTwo(page, point);
  await page.getByText("Export Selected MIDI Clips (2)...", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__midiWorkflowQA.exports.length)).toBe(1);
  const exported = await page.evaluate(() => window.__midiWorkflowQA.exports[0]);
  expect(exported[1]).toHaveLength(1);
  expect(exported[1][0].clips.map((c: { id: string; startTime: number }) => [c.id, c.startTime])).toEqual([["a", 0], ["b", 3]]);
  expect(await page.evaluate(() => window.__midiWorkflowQA.store.getState().tracks[0].midiClips.length)).toBe(3);
});

test("empty-space range feedback explains the blue region and exposes Clear and Set loop", async ({ page }) => {
  const point = await ready(page);
  const modifier = await primaryModifier(page);
  await page.keyboard.down(modifier);
  await page.mouse.move(point.x + 150, point.y + 130);
  await page.mouse.down();
  await page.mouse.move(point.x + 600, point.y + 130, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up(modifier);
  await expect(page.getByLabel("Timeline gesture feedback")).toContainText("Time selection:");
  expect(await page.evaluate(() => window.__midiWorkflowQA.store.getState().selectedClipIds)).toEqual([]);
  await page.getByRole("button", { name: "Set loop", exact: true }).click();
  const state = await page.evaluate(() => {
    const s = window.__midiWorkflowQA.store.getState();
    return { range: s.timeSelection, loopStart: s.transport.loopStart, loopEnd: s.transport.loopEnd };
  });
  expect(state.loopStart).toBe(state.range!.start);
  expect(state.loopEnd).toBe(state.range!.end);
  await page.getByRole("button", { name: "Clear time selection", exact: true }).click();
  await expect(page.getByLabel("Timeline gesture feedback")).toBeHidden();
});

test("slip feedback ends on release while the retained source offset remains visible", async ({ page }) => {
  const point = await ready(page);
  await page.evaluate(() => {
    const store = window.__midiWorkflowQA.store;
    store.setState({ tracks: store.getState().tracks.map(t => ({ ...t, midiClips: t.midiClips.map(c => ({ ...c, offset: 1, sourceLength: 5 })) })) });
  });
  const modifier = await primaryModifier(page);
  await page.keyboard.down(modifier);
  await page.keyboard.down("Shift");
  await page.mouse.move(point.x + 200, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 230, point.y, { steps: 5 });
  await expect(page.getByLabel("Timeline gesture feedback")).toHaveText("Slip contents");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.up(modifier);
  await expect(page.getByLabel("Timeline gesture feedback")).toBeHidden();
  expect(await page.evaluate(() => window.__midiWorkflowQA.store.getState().tracks[0].midiClips[0].offset)).toBeCloseTo(0.7, 3);
});
