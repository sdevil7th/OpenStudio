import { expect, test, type Page } from "@playwright/test";
import type { createDefaultTrack, useDAWStore } from "../src/store/useDAWStore";
import type { commandManager } from "../src/store/commands";
import { runSingleKeyTransport } from "./support/singleKeyTransport";
import { runMidiAxisDrag } from "./support/midiAxisDrag";
import { runTrackSelectionCopy } from "./support/trackSelectionCopy";

declare global {
  interface Window {
    __timelineControlsQA: {
      store: typeof useDAWStore;
      createDefaultTrack: typeof createDefaultTrack;
      commandManager: typeof commandManager;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({
      schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true,
    }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
});

for (const [name, run] of [
  ["trusted transport keys ignore repeats and text entry", runSingleKeyTransport],
  ["MIDI note modifiers preserve the selected group and Undo", runMidiAxisDrag],
  ["track copy previews keep sources stationary and commit one Undo", runTrackSelectionCopy],
] as const) {
  test(name, async ({ page }, testInfo) => {
    const report = await run(page);
    expect(report.status).toBe("pass");
    expect(report.checks.length).toBeGreaterThan(0);
    await testInfo.attach("interaction-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  });
}

async function ready(page: Page) {
  await page.goto("/?platform=windows&windowChrome=native");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden();
  await page.evaluate(async () => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("App store import was not found");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const commandsUrl = "/src/store/commands/index.ts";
    const { commandManager } = await import(/* @vite-ignore */ commandsUrl) as typeof import("../src/store/commands");
    window.__timelineControlsQA = { store, createDefaultTrack, commandManager };
    const track = createDefaultTrack("ruler-track", "Ruler track", "#4361ee", "audio", []);
    store.setState({
      tracks: [track], selectedClipIds: [], selectedClipId: null, showMixer: false, showGettingStarted: false,
      showPianoRoll: false, showPitchEditor: false, inputProfileOnboardingSeen: true,
      pixelsPerSecond: 100, scrollX: 0, scrollY: 0, snapEnabled: false,
      mouseBehaviorProfileId: "openstudio", mouseModifiers: {}, timeSelection: null, projectRange: { start: 0, end: 20 },
      transport: { ...store.getState().transport, currentTime: 1, isPlaying: false, isRecording: false, loopEnabled: false },
    });
  });
}

async function rulerDrag(page: Page, dx: number, dy: number, x = 300, y = 18) {
  const bounds = await page.locator(".workspace-sticky-ruler canvas").first().boundingBox();
  if (!bounds) throw new Error("Visible ruler was not found");
  await page.mouse.move(bounds.x + x, bounds.y + y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + x + dx, bounds.y + y + dy, { steps: 5 });
  await page.mouse.up();
}

const view = (page: Page) => page.evaluate(() => {
  const state = window.__timelineControlsQA.store.getState();
  return { zoom: state.pixelsPerSecond, scrollX: state.scrollX, range: state.projectRange, selection: state.timeSelection, loop: state.transport.loopEnabled };
});

test("menu zoom uses the same complete range as keyboard actions", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ pixelsPerSecond: 900 }));
  await page.getByRole("menuitem", { name: "View menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Zoom In", exact: true }).click();
  await expect.poll(async () => (await view(page)).zoom).toBe(1000);
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ pixelsPerSecond: 2 }));
  await page.getByRole("menuitem", { name: "View menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Zoom Out", exact: true }).click();
  await expect.poll(async () => (await view(page)).zoom).toBeCloseTo(4 / 3);
});

test("visible ruler keeps plain range dragging and routes custom actions", async ({ page }) => {
  await ready(page);
  await rulerDrag(page, 100, 0);
  expect(await view(page)).toMatchObject({ zoom: 100, range: { start: 3, end: 4 }, selection: null, loop: false });
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ mouseModifiers: { ruler_click: { none: "none" } } }));
  const beforeNoop = await view(page);
  await rulerDrag(page, 80, 40);
  expect(await view(page)).toEqual(beforeNoop);
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ mouseModifiers: { ruler_click: { none: "time_select" } } }));
  await rulerDrag(page, 100, 0);
  expect(await view(page)).toMatchObject({ zoom: 100, range: { start: 3, end: 4 }, selection: { start: 1, end: 4 } });
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ mouseModifiers: { ruler_click: { none: "loop_set" } } }));
  await rulerDrag(page, 100, 0, 400);
  expect(await view(page)).toMatchObject({ zoom: 100, range: { start: 4, end: 5 }, loop: true });
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ mouseModifiers: { ruler_click: { none: "zoom_to" } } }));
  await rulerDrag(page, 100, 0);
  const zoomed = await view(page);
  expect(zoomed.zoom).toBeGreaterThan(100);
  expect(zoomed.scrollX / zoomed.zoom).toBeCloseTo(3);
  expect(zoomed.range).toEqual({ start: 4, end: 5 });
});

test("mapped ruler handles remain project-range edits and vendor no-ops stay inactive", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ projectRange: { start: 2, end: 5 } }));
  await rulerDrag(page, 100, 0, 200, 4);
  expect((await view(page)).range).toEqual({ start: 3, end: 5 });
  await page.evaluate(() => window.__timelineControlsQA.store.setState({ mouseBehaviorProfileId: "audacity", mouseModifiers: {} }));
  const before = await view(page);
  await page.keyboard.down("Alt");
  await rulerDrag(page, 100, 40);
  await page.keyboard.up("Alt");
  expect(await view(page)).toEqual(before);
});

test("copying a collapsed folder includes children and supports atomic Undo/Redo", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const { store, createDefaultTrack, commandManager } = window.__timelineControlsQA;
    commandManager.clear();
    const folder = createDefaultTrack("folder", "Collapsed Folder", "#4361ee", "audio", []);
    folder.isFolder = true;
    folder.folderCollapsed = true;
    const child = createDefaultTrack("child", "Hidden Child", "#4361ee", "audio", [folder]);
    child.parentFolderId = folder.id;
    const outside = createDefaultTrack("outside", "Outside", "#4361ee", "audio", [folder, child]);
    store.setState({ tracks: [folder, child, outside], selectedTrackId: folder.id, selectedTrackIds: [folder.id], trackHeight: 100 });
  });
  const source = await page.locator('[data-track-id="folder"]').boundingBox();
  if (!source) throw new Error("Folder header was not found");
  await page.keyboard.down("Control");
  await page.mouse.move(source.x + 60, source.y + 90);
  await page.mouse.down();
  await page.mouse.move(source.x + 170, source.y + 90, { steps: 5 });
  await expect(page.locator('[data-track-drag-copy="true"]')).toContainText("Hidden Child");
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect.poll(() => page.evaluate(() => window.__timelineControlsQA.store.getState().tracks.length)).toBe(5);
  const snapshot = await page.evaluate(() => {
    const { store, commandManager } = window.__timelineControlsQA;
    return { tracks: store.getState().tracks, undo: commandManager.getUndoStack().length };
  });
  expect(snapshot.undo).toBe(1);
  expect(snapshot.tracks.map((track) => track.name)).toEqual(["Collapsed Folder", "Hidden Child", "Collapsed Folder (copy)", "Hidden Child (copy)", "Outside"]);
  expect(snapshot.tracks[3].parentFolderId).toBe(snapshot.tracks[2].id);
  await page.evaluate(() => window.__timelineControlsQA.store.getState().undo());
  await expect.poll(() => page.evaluate(() => window.__timelineControlsQA.store.getState().tracks.length)).toBe(3);
  await page.evaluate(() => window.__timelineControlsQA.store.getState().redo());
  await expect.poll(() => page.evaluate(() => window.__timelineControlsQA.store.getState().tracks)).toEqual(snapshot.tracks);
});
