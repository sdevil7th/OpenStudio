import { expect, test, type Page } from "@playwright/test";
import type { useDAWStore } from "../src/store/useDAWStore";
import type { commandManager } from "../src/store/commands";

declare global {
  interface Window {
    __mixerUiQA: { store: typeof useDAWStore; history: typeof commandManager };
  }
}

async function ready(page: Page) {
  await page.goto("/");
  await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("App store import not found");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const commandUrl = "/src/store/commands/index.ts";
    const { commandManager: history } = await import(/* @vite-ignore */ commandUrl) as typeof import("../src/store/commands");
    const track = createDefaultTrack("precision-track", "Precision", "#4361ee", "audio", []);
    history.clear();
    store.setState({ tracks: [track], showMixer: true, showPianoRoll: false, showPitchEditor: false,
      showClipLauncher: false, showGettingStarted: false, inputProfileOnboardingSeen: true,
      detachedPanels: [], mixerHeight: 340, autoBackupEnabled: false, masterVolume: 1,
      selectedTrackIds: [track.id], selectedTrackId: track.id, canUndo: false, canRedo: false,
      transport: { ...store.getState().transport, isPlaying: false, isRecording: false } });
    window.__mixerUiQA = { store, history };
  });
  await expect(page.getByRole("textbox", { name: "Volume in decibels for Precision", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide essential controls", exact: true }).click();
}

for (const editor of ["timeline", "piano_roll"] as const) {
  for (const termination of ["release", "escape", "cancel", "blur"] as const) {
    test(`pointer resize returns ${editor} ownership after ${termination}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1200 });
      await ready(page);
      if (editor === "piano_roll") {
        await page.evaluate(() => {
          const store = window.__mixerUiQA.store;
          const track = { ...store.getState().tracks[0], type: "midi" as const,
            midiClips: [{ id: "resize-note", name: "Phrase", startTime: 0, duration: 4, color: "#c66091", events: [] }] };
          store.setState({ tracks: [track], lowerZoneHeight: 440, mixerHeight: 220 });
          store.getState().openPianoRoll(track.id, "resize-note");
        });
      }
      const editorSurface = page.locator(editor === "timeline" ? ".timeline-container" : '[data-qa="piano-roll-grid-stage"]');
      await editorSurface.click({ position: { x: 100, y: 50 } });
      const activeContext = () => page.evaluate(async () => {
        const moduleUrl = "/src/utils/shortcutContext.ts";
        return (await import(/* @vite-ignore */ moduleUrl)).getActiveShortcutContext();
      });
      const before = await activeContext();
      expect(before.kind).toBe(editor);
      const handle = page.getByRole("separator", { name: "Resize mixer", exact: true });
      const box = (await handle.boundingBox())!;
      const previousHeight = Number(await handle.getAttribute("aria-valuenow"));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y - 35, { steps: 4 });
      if (termination === "escape") await page.keyboard.press("Escape");
      if (termination === "cancel") await handle.dispatchEvent("pointercancel");
      if (termination === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up();
      await expect(handle).not.toBeFocused();
      expect(await activeContext()).toEqual(before);
      expect(await page.evaluate(() => document.body.style.cursor)).toBe("");
      const after = await handle.getAttribute("aria-valuenow");
      if (termination === "escape") expect(Number(after)).toBe(previousHeight);
      await page.keyboard.press("ArrowUp");
      await expect(handle).toHaveAttribute("aria-valuenow", after!);
      await page.screenshot({ path: `../output/playwright/mixer-${editor}-${termination}.png` });
    });
  }
}

test("numeric track/master levels commit once, reject invalid drafts and cancel with Escape", async ({ page }) => {
  await ready(page);
  const level = page.getByRole("textbox", { name: "Volume in decibels for Precision", exact: true });
  await level.fill("-6.25");
  expect(await page.evaluate(() => window.__mixerUiQA.store.getState().tracks[0].volumeDB)).toBe(0);
  await level.press("Enter");
  await expect(level).toHaveValue("-6.3");
  expect(await page.evaluate(() => window.__mixerUiQA.store.getState().tracks[0].volumeDB)).toBe(-6.25);
  expect(await page.evaluate(() => window.__mixerUiQA.history.getUndoStack().length)).toBe(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(level).toHaveValue("0.0");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  // Focusing a rounded readout must preserve the finer stored precision.
  await level.focus();
  await level.press("Tab");
  expect(await page.evaluate(() => window.__mixerUiQA.store.getState().tracks[0].volumeDB)).toBe(-6.25);
  expect(await page.evaluate(() => window.__mixerUiQA.history.getUndoStack().length)).toBe(1);
  await level.fill("r");
  await level.press("Enter");
  await expect(level).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate(() => window.__mixerUiQA.store.getState().transport.isRecording)).toBe(false);
  await level.press("Escape");
  await expect(level).toHaveValue("-6.3");
  expect(await page.evaluate(() => window.__mixerUiQA.history.getUndoStack().length)).toBe(1);
  await level.fill("-inf");
  await level.press("Tab");
  await expect(level).toHaveValue("-∞");
  const master = page.getByRole("textbox", { name: "Volume in decibels for MASTER", exact: true });
  await master.fill("-3.5");
  await master.press("Enter");
  expect(await page.evaluate(() => window.__mixerUiQA.store.getState().masterVolume)).toBeCloseTo(10 ** (-3.5 / 20), 10);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(master).toHaveValue("0.0");
});

test("mixer resizing supports keyboard, pointer release, persistence and workspace bounds", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const handle = page.getByRole("separator", { name: "Resize mixer", exact: true });
  await handle.focus();
  await handle.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "356");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 60, { steps: 4 });
  await page.mouse.up();
  const after = Number(await handle.getAttribute("aria-valuenow"));
  expect(after).toBeGreaterThan(400);
  await page.mouse.move(box.x + 20, box.y - 120);
  await expect(handle).toHaveAttribute("aria-valuenow", String(after));
  expect(await page.evaluate(() => localStorage.getItem("openstudio_mixerHeight"))).toBe(String(after));
  await handle.press("End");
  const bounded = Number(await handle.getAttribute("aria-valuenow"));
  expect(bounded).toBeLessThanOrEqual(Number(await handle.getAttribute("aria-valuemax")));
  const workspace = await page.locator(".workspace").boundingBox();
  expect(workspace!.height).toBeGreaterThanOrEqual(179);
  await handle.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "96");
  await handle.dblclick();
  await expect(handle).toHaveAttribute("aria-valuenow", "340");
  expect(await page.evaluate(() => window.__mixerUiQA.history.getUndoStack().length)).toBe(0);
});

for (const width of [1280, 800]) {
  test(`mixer header shares one row with separate resize and window controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 600 });
    await ready(page);
    const mixer = page.getByRole("region", { name: "Mixer", exact: true });
    const header = mixer.locator("header");
    const handle = mixer.getByRole("separator", { name: "Resize mixer", exact: true });
    const detach = mixer.getByRole("button", { name: "Detach mixer into separate window" });
    const close = mixer.getByRole("button", { name: "Close mixer panel" });
    const bounds = (await header.boundingBox())!;
    const row = await Promise.all([header.getByText("Mixer", { exact: true }), handle, detach, close]
      .map(async control => (await control.boundingBox())!));
    for (const box of row) {
      expect(box.y).toBeGreaterThanOrEqual(bounds.y);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    for (let i = 1; i < row.length; i++) expect(row[i].x).toBeGreaterThanOrEqual(row[i - 1].x + row[i - 1].width);
    expect(bounds.y).toBeLessThanOrEqual((await mixer.boundingBox())!.y + 2);
    expect(row[1].height).toBeGreaterThanOrEqual(24);
    for (const control of [handle, detach, close]) {
      expect(await control.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
    }
    await handle.focus();
    await expect(handle).toBeFocused();
    await page.screenshot({ path: `../output/shared-project-qualification/nov04-review-comments/mixer-header-${width}.png` });
    const originalHeight = await handle.getAttribute("aria-valuenow");
    await page.mouse.move(row[1].x + row[1].width / 2, row[1].y + row[1].height / 2);
    await page.mouse.down();
    await page.mouse.move(row[1].x + row[1].width / 2, row[1].y - 40, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(handle).toHaveAttribute("aria-valuenow", originalHeight!);
    expect(await page.evaluate(() => window.__mixerUiQA.store.getState().selectedTrackIds)).toEqual(["precision-track"]);
    await handle.press("Tab");
    await expect(detach).toBeFocused();
    await detach.press("Tab");
    await expect(close).toBeFocused();
    await close.press("Enter");
    await expect(mixer).toBeHidden();
    expect(await page.evaluate(() => window.__mixerUiQA.store.getState().mixerHeight)).toBe(Number(originalHeight));
    // Check the pop-out bridge binding without opening an OS window from a browser fixture.
    await page.evaluate(async () => {
      const bridgeUrl = "/src/services/NativeBridge.ts";
      const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
      nativeBridge.openMixerWindow = async () => true;
      window.__mixerUiQA.store.setState({ showMixer: true });
    });
    await detach.click();
    await expect(mixer).toBeHidden();
    expect(await page.evaluate(() => window.__mixerUiQA.store.getState().detachedPanels)).toContain("mixer");
    expect(await page.evaluate(() => window.__mixerUiQA.store.getState().mixerHeight)).toBe(Number(originalHeight));
  });
}

test("piano roll note hover identifies pitch and velocity without editing the clip", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const store = window.__mixerUiQA.store;
    const track = { ...store.getState().tracks[0], type: "midi" as const,
      midiClips: [{ id: "hover-clip", name: "Hover notes", startTime: 0, duration: 4,
        offset: 0, color: "#4361ee", sourceLength: 4, events: [
          { type: "noteOn" as const, note: 84, velocity: 80, timestamp: 0.5 },
          { type: "noteOff" as const, note: 84, velocity: 0, timestamp: 1.5 },
        ] }] };
    store.setState({ tracks: [track], showMixer: false, lowerZoneHeight: 440, pixelsPerSecond: 100 });
    store.getState().openPianoRoll(track.id, "hover-clip");
  });
  const grid = page.locator('[data-qa="piano-roll-grid-stage"]');
  await expect(grid).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const stage = window.Konva?.stages.find(candidate => candidate.container().closest('[data-qa="piano-roll-grid-stage"]'));
    return stage?.find("Rect").some(node => node.opacity() === 0.85) ?? false;
  })).toBe(true);
  const note = await page.evaluate(() => {
    const stage = window.Konva.stages.find(candidate => candidate.container().closest('[data-qa="piano-roll-grid-stage"]'))!;
    const rect = stage.find("Rect").find(node => node.opacity() === 0.85)!;
    const box = stage.container().getBoundingClientRect();
    return { x: box.left + rect.x() + rect.width() / 2, y: box.top + rect.y() + rect.height() / 2 };
  });
  await page.mouse.move(note.x, note.y);
  const tooltip = grid.getByRole("tooltip");
  await expect(tooltip).toHaveText(/\(84\).*Velocity 80/);
  await expect(tooltip).toBeVisible();
  await page.mouse.move(note.x + 2, note.y);
  await expect(tooltip).toHaveText(/\(84\).*Velocity 80/);
  await page.mouse.move(10, 10);
  await expect(tooltip).toBeHidden();
  expect(await page.evaluate(() => window.__mixerUiQA.history.getUndoStack().length)).toBe(0);
});
