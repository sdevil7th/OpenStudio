import { expect, test, type Page } from "@playwright/test";

const PROFILE_SETTINGS_KEY = "openstudio.inputProfiles.v1";
const PRIMARY_KEY = process.platform === "darwin" ? "Meta" : "Control";

async function timelineCanvasPatchHash(
  page: Page,
  clientX: number,
  clientY: number,
  radius = 10,
): Promise<number> {
  return page.evaluate(({ x, y, r }) => {
    let hash = 2166136261;
    let sampled = false;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>(".timeline-container canvas")) {
      const bounds = canvas.getBoundingClientRect();
      if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) continue;
      const context = canvas.getContext("2d");
      if (!context || bounds.width <= 0 || bounds.height <= 0) continue;
      const scaleX = canvas.width / bounds.width;
      const scaleY = canvas.height / bounds.height;
      const canvasX = Math.round((x - bounds.left) * scaleX);
      const canvasY = Math.round((y - bounds.top) * scaleY);
      const pixelRadiusX = Math.max(1, Math.round(r * scaleX));
      const pixelRadiusY = Math.max(1, Math.round(r * scaleY));
      const left = Math.max(0, canvasX - pixelRadiusX);
      const top = Math.max(0, canvasY - pixelRadiusY);
      const width = Math.min(canvas.width - left, pixelRadiusX * 2 + 1);
      const height = Math.min(canvas.height - top, pixelRadiusY * 2 + 1);
      if (width <= 0 || height <= 0) continue;
      const bytes = context.getImageData(left, top, width, height).data;
      sampled = true;
      for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
      }
    }
    if (!sampled) throw new Error(`No Timeline canvas covers (${x}, ${y})`);
    return hash >>> 0;
  }, { x: clientX, y: clientY, r: radius });
}

test("real automation lane owns point drag, Delete, and atomic undo", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((settingsKey) => {
    localStorage.removeItem(settingsKey);
    localStorage.removeItem("openstudio_essentialControlsDismissed");
  }, PROFILE_SETTINGS_KEY);
  await page.reload();

  await page.getByLabel("Keyboard profile").selectOption("ableton_live");
  await page.getByLabel("Mouse & scroll profile").selectOption("ableton_live");
  await page.getByRole("button", { name: "Use these profiles" }).click();
  await page.getByRole("button", { name: "Add new audio track" }).click();

  await page.getByRole("button", { name: "Open automation panel", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Envelopes" });
  await expect(dialog).toBeVisible();
  const volumeRow = dialog.getByText("Volume", { exact: true }).locator("..");
  await volumeRow.getByTitle("Show envelope").click();
  await expect(volumeRow.getByTitle("Hide envelope")).toBeVisible();
  await dialog.getByRole("button", { name: "Close modal" }).click();
  await expect(dialog).toBeHidden();
  await page.locator(".timeline-container").click({ position: { x: 180, y: 70 } });
  await page.keyboard.press("a");

  const laneHeader = page.locator("[data-automation-lane-id]").first();
  await expect(laneHeader).toBeVisible();
  const laneBounds = await laneHeader.boundingBox();
  const timelineBounds = await page.locator(".timeline-container").boundingBox();
  expect(laneBounds).not.toBeNull();
  expect(timelineBounds).not.toBeNull();
  const pointX = timelineBounds!.x + Math.min(280, timelineBounds!.width * 0.35);
  const pointY = laneBounds!.y + laneBounds!.height * 0.55;

  const emptyHash = await timelineCanvasPatchHash(page, pointX, pointY);
  await page.mouse.move(pointX, pointY);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY))
    .not.toBe(emptyHash);

  const originalPointHash = await timelineCanvasPatchHash(page, pointX, pointY);
  const movedX = pointX + 64;
  const movedY = pointY - 12;
  const emptyDestinationHash = await timelineCanvasPatchHash(page, movedX, movedY);
  await page.mouse.move(pointX, pointY);
  await page.mouse.down();
  await page.mouse.move(movedX, movedY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => timelineCanvasPatchHash(page, movedX, movedY))
    .not.toBe(emptyDestinationHash);
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY))
    .not.toBe(originalPointHash);
  const movedOriginHash = await timelineCanvasPatchHash(page, pointX, pointY);
  const movedDestinationHash = await timelineCanvasPatchHash(page, movedX, movedY);

  await page.keyboard.press(`${PRIMARY_KEY}+Z`);
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY))
    .not.toBe(movedOriginHash);
  await expect.poll(() => timelineCanvasPatchHash(page, movedX, movedY))
    .not.toBe(movedDestinationHash);

  // The point drag activated the real automation shortcut context. Ableton's
  // Tab selects the next point and Delete removes that selected point.
  await page.keyboard.press("Tab");
  const selectedHash = await timelineCanvasPatchHash(page, pointX, pointY);
  await page.keyboard.press("Delete");
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY))
    .not.toBe(selectedHash);
  const deletedHash = await timelineCanvasPatchHash(page, pointX, pointY);

  await page.keyboard.press(`${PRIMARY_KEY}+Z`);
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY))
    .not.toBe(deletedHash);
});

test("real MIDI track automation lane creates, deletes, and restores a pitch-bend point", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((settingsKey) => {
    localStorage.removeItem(settingsKey);
    localStorage.removeItem("openstudio_essentialControlsDismissed");
  }, PROFILE_SETTINGS_KEY);
  await page.reload();

  await page.getByLabel("Keyboard profile").selectOption("ableton_live");
  await page.getByLabel("Mouse & scroll profile").selectOption("ableton_live");
  await page.getByRole("button", { name: "Use these profiles" }).click();
  await page.getByRole("menuitem", { name: "Insert menu" }).click();
  await page.getByRole("menuitem", { name: /New MIDI Track/ }).click();

  await page.getByRole("button", { name: "Open automation panel", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Envelopes" });
  await expect(dialog).toBeVisible();
  const pitchBendRow = dialog.getByText("MIDI Pitch Bend", { exact: true }).locator("..");
  await pitchBendRow.getByTitle("Show envelope").click();
  await expect(pitchBendRow.getByTitle("Hide envelope")).toBeVisible();
  await dialog.getByRole("button", { name: "Close modal" }).click();

  await page.locator(".timeline-container").click({ position: { x: 180, y: 70 } });
  await page.keyboard.press("a");
  const laneHeader = page.locator("[data-automation-lane-id]").first();
  await expect(laneHeader).toBeVisible();
  const laneBounds = await laneHeader.boundingBox();
  const timelineBounds = await page.locator(".timeline-container").boundingBox();
  expect(laneBounds).not.toBeNull();
  expect(timelineBounds).not.toBeNull();
  const pointX = timelineBounds!.x + Math.min(300, timelineBounds!.width * 0.38);
  const pointY = laneBounds!.y + laneBounds!.height * 0.42;

  const beforeCreate = await timelineCanvasPatchHash(page, pointX, pointY);
  await page.mouse.click(pointX, pointY);
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY)).not.toBe(beforeCreate);

  await page.keyboard.press("Tab");
  const beforeDelete = await timelineCanvasPatchHash(page, pointX, pointY);
  await page.keyboard.press("Delete");
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY)).not.toBe(beforeDelete);
  const deleted = await timelineCanvasPatchHash(page, pointX, pointY);
  await page.keyboard.press(`${PRIMARY_KEY}+Z`);
  await expect.poll(() => timelineCanvasPatchHash(page, pointX, pointY)).not.toBe(deleted);
});

test("Space stops an active recording instead of leaving transport paused", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((settingsKey) => {
    localStorage.removeItem(settingsKey);
    localStorage.removeItem("openstudio_essentialControlsDismissed");
  }, PROFILE_SETTINGS_KEY);
  await page.reload();

  await page.getByLabel("Keyboard profile").selectOption("openstudio");
  await page.getByLabel("Mouse & scroll profile").selectOption("openstudio");
  await page.getByRole("button", { name: "Use these profiles" }).click();
  await page.getByRole("button", { name: "Add new audio track" }).click();
  await page.getByRole("button", { name: "Arm track for recording", exact: true }).click();
  await page.getByRole("contentinfo", { name: "Transport controls" })
    .getByRole("button", { name: "Record", exact: true })
    .click();

  const recordingStatus = page.getByLabel("Transport status: Recording");
  await expect(recordingStatus).toBeVisible();

  // Give the Timeline ownership, matching the reported real-app path that
  // previously routed Space through transport.play -> pause().
  await page.locator(".timeline-container").click({ position: { x: 180, y: 70 } });
  await page.keyboard.press("Space");

  await expect(page.getByLabel("Transport status: Stopped")).toBeVisible();
  await expect(recordingStatus).toBeHidden();
});
