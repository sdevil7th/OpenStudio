import { expect, test, type Page } from "@playwright/test";
import type { nativeBridge as bridgeType } from "../src/services/NativeBridge";
import { primaryModifier } from "./support/platformInput";

const address = { trackId: "nam-fuzz-workflow-qa", chain: "track", fxIndex: 0 } as const;
const url = `/?${new URLSearchParams({ window: "pluginEditor", platform: "windows", windowChrome: "native", mockPlugin: "nam", sessionId: JSON.stringify({ address, title: "OpenStudio NAM Rack", fallbackName: "OpenStudio NAM Rack" }), namView: "rack", namFocus: "gate", namSection: "pre" })}`;
type PresetEntries = Awaited<ReturnType<typeof bridgeType.getBuiltInFXPresets>>;
interface ProfileCopyQa { entries: PresetEntries; calls: [string, string, 0 | 1][]; fail: boolean }
declare global { interface Window { namProfileCopyQa: ProfileCopyQa } }

async function openRack(page: Page) {
  await page.goto(url);
  await expect(page.getByRole("slider", { name: "Fuzz Clean blend", exact: true })).toBeVisible({ timeout: 15000 });
}

async function values(page: Page) {
  return page.evaluate(async address => {
    const path = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ path) as typeof import("../src/services/NativeBridge");
    return (await nativeBridge.getBuiltInPluginState(address))?.values;
  }, address);
}

test("Fuzz Clean pedal knob supports exact entry, cancel, keyboard, reset and Undo", async ({ page }) => {
  await openRack(page);
  const undoShortcut = `${await primaryModifier(page)}+z`;
  const knob = page.getByRole("slider", { name: "Fuzz Clean blend", exact: true });
  await expect(knob).toHaveAccessibleDescription(/Fuzz is bypassed/);
  await expect(knob).toHaveAccessibleDescription(/PRE EQ, Drive, Distortion/);
  await knob.focus();
  await knob.press("Enter");
  const number = page.getByRole("spinbutton", { name: "Fuzz Clean blend percentage", exact: true });
  await number.fill("38.4");
  await number.press("Enter");
  await expect(knob).toBeFocused();
  await expect(knob).toHaveAttribute("aria-valuenow", "0.384");
  await expect.poll(async () => (await values(page))?.fuzzCleanMix).toBeCloseTo(0.384);
  await knob.click({ button: "right" });
  await number.fill("75");
  await number.press("Escape");
  await expect(number).toHaveCount(0);
  await expect(knob).toBeFocused();
  await expect(knob).toHaveAttribute("aria-valuenow", "0.384");
  await knob.press("Shift+ArrowRight");
  await expect(knob).toHaveAttribute("aria-valuenow", "0.386");
  await knob.dblclick();
  await expect(knob).toHaveAttribute("aria-valuenow", "0");
  await page.keyboard.press(undoShortcut);
  await expect(knob).toHaveAttribute("aria-valuenow", "0.386");
  await page.keyboard.press(undoShortcut);
  await expect(knob).toHaveAttribute("aria-valuenow", "0.384");
  await page.keyboard.press(undoShortcut);
  await expect(knob).toHaveAttribute("aria-valuenow", "0");
});

for (const viewport of [{ width: 640, height: 480 }, { width: 900, height: 600 }, { width: 1280, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
  test(`Fuzz Clean is integrated without overlapping controls at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openRack(page);
    const knob = page.getByRole("slider", { name: "Fuzz Clean blend", exact: true });
    await knob.scrollIntoViewIfNeeded();
    await expect(page.locator('[data-qa="nam-fuzz-clean-access"]')).toHaveCount(0);
    await expect(page.locator('.octaver-fuzz [role="slider"]')).toHaveCount(7);
    const geometry = await page.evaluate(() => {
      const pedal = document.querySelector(".octaver-fuzz")!.getBoundingClientRect();
      const controls = [...document.querySelectorAll<HTMLElement>(".octaver-fuzz .control-hit")].map(control => {
        const box = control.getBoundingClientRect();
        return { id: control.dataset.paramId, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      });
      return { pedal: { left: pedal.left, top: pedal.top, right: pedal.right, bottom: pedal.bottom }, controls };
    });
    expect(geometry.controls.map(control => control.id)).toEqual(expect.arrayContaining([
      "fuzzCleanMix", "fuzzVoice", "octaverDownMix", "octaverUpMix", "octaverDirectMix",
      "fuzzDrive", "fuzzTone", "fuzzLevelDb", "octaverEnabled", "fuzzEnabled",
    ]));
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(geometry.pedal.left);
      expect(control.top).toBeGreaterThanOrEqual(geometry.pedal.top);
      expect(control.right).toBeLessThanOrEqual(geometry.pedal.right);
      expect(control.bottom).toBeLessThanOrEqual(geometry.pedal.bottom);
      expect(control.width).toBeGreaterThanOrEqual(24);
      expect(control.height).toBeGreaterThanOrEqual(24);
      for (const other of geometry.controls.filter(other => other.id !== control.id)) {
        const overlaps = control.left < other.right && control.right > other.left
          && control.top < other.bottom && control.bottom > other.top;
        expect(overlaps, `${control.id} overlaps ${other.id}`).toBe(false);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`fuzz-integrated-${viewport.width}.png`) });
    await knob.focus();
    await expect(knob).toBeFocused();
    await expect(knob).toHaveCSS("outline-style", "solid");
    await page.screenshot({ path: testInfo.outputPath(`fuzz-keyboard-focus-${viewport.width}.png`) });
    await knob.press("Enter");
    const number = page.getByRole("spinbutton", { name: "Fuzz Clean blend percentage", exact: true });
    await expect(number).toBeInViewport();
    const entry = await number.boundingBox();
    expect(entry!.x).toBeGreaterThanOrEqual(geometry.pedal.left);
    expect(entry!.x + entry!.width).toBeLessThanOrEqual(geometry.pedal.right);
    await number.press("Escape");
    await expect(knob).toBeFocused();
    for (const id of ["octaverEnabled", "fuzzEnabled"]) {
      const foot = page.locator(`.octaver-fuzz [data-param-id="${id}"][role="button"]`);
      await foot.focus();
      await expect(foot).toBeInViewport({ ratio: 0.999 });
    }
  });
}

for (const width of [1280, 900, 640]) {
test(`profile review at ${width}px creates only an explicitly confirmed library copy and reports duplicate or failed copies`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 640 ? 480 : 900 });
  await openRack(page);
  if (width <= 900) {
    await page.getByRole("button", { name: /^Guitar instrument profile/ }).click();
    await expect.poll(async () => (await values(page))?.instrumentProfile).toBe(1);
  }
  await page.evaluate(async () => {
    const path = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ path) as typeof import("../src/services/NativeBridge");
    const qa: ProfileCopyQa = window.namProfileCopyQa = { entries: [{ name: "Historical Bass", path: "qa/Historical Bass.ospreset", instrumentProfile: "guitar", metadata: { instrumentProfile: "bass", updatedAt: Date.now() } }], calls: [], fail: false };
    nativeBridge.getBuiltInFXPresets = async () => structuredClone(qa.entries);
    nativeBridge.copyNAMRackPresetWithInstrumentProfile = async (source, target, profile) => {
      qa.calls.push([source, target, profile]);
      if (qa.fail) return false;
      qa.entries.push({ name: target, path: `qa/${target}.ospreset`, instrumentProfile: profile ? "bass" : "guitar", metadata: { instrumentProfile: profile ? "bass" : "guitar", updatedAt: Date.now() } });
      return true;
    };
  });
  const before = await values(page);
  await page.getByRole("button", { name: /Open preset library/ }).click();
  const library = page.getByRole("dialog", { name: "Preset Library", exact: true });
  await library.getByRole("button", { name: "Refresh", exact: true }).click();
  await library.getByRole("button", { name: /Profile review/ }).click();
  await expect(library.getByRole("button", { name: /Historical Bass/ }).first()).toContainText("Label: Bass · Saved sound: Guitar");
  await expect(library.locator('[data-modal-panel="true"]')).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath(`profile-review-${width}.png`) });
  const openCopy = async () => {
    if (width <= 900) {
      await library.getByRole("button", { name: "Actions for Historical Bass", exact: true }).click();
      await page.getByRole("menuitem", { name: "Create Bass copy…", exact: true }).click();
    } else {
      await library.getByRole("button", { name: "Create Bass copy…", exact: true }).click();
    }
  };
  const confirm = page.getByRole("dialog", { name: "Create Bass copy", exact: true });
  await openCopy();
  await expect(confirm).toContainText("does not load it or change the original");
  await expect(confirm.locator('[data-modal-panel="true"]')).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath(`profile-confirm-${width}.png`) });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.namProfileCopyQa.calls)).toEqual([]);
  await openCopy();
  await confirm.getByRole("textbox", { name: "Create Bass copy" }).fill("Historical Bass");
  await confirm.getByRole("button", { name: "Create copy", exact: true }).click();
  await expect(library.getByRole("status")).toContainText("already exists");
  expect(await page.evaluate(() => window.namProfileCopyQa.calls)).toEqual([]);
  await page.evaluate(() => { window.namProfileCopyQa.fail = true; });
  await openCopy();
  await confirm.getByRole("button", { name: "Create copy", exact: true }).click();
  await expect(library.getByRole("status")).toContainText("could not be created");
  await page.evaluate(() => { window.namProfileCopyQa.fail = false; });
  await openCopy();
  await confirm.getByRole("textbox", { name: "Create Bass copy" }).fill("Bass Audition");
  await confirm.getByRole("button", { name: "Create copy", exact: true }).click();
  await expect(library.getByRole("status")).toContainText("Created Bass Audition with the Bass profile");
  expect(await values(page)).toEqual(before);
  expect(await page.evaluate(() => window.namProfileCopyQa.entries.map(({ name, instrumentProfile }) => ({ name, instrumentProfile })))).toEqual([{ name: "Historical Bass", instrumentProfile: "guitar" }, { name: "Bass Audition", instrumentProfile: "bass" }]);
  expect(await page.evaluate(() => window.namProfileCopyQa.calls)).toEqual([["Historical Bass", "Historical Bass Bass Copy", 1], ["Historical Bass", "Bass Audition", 1]]);
});
}
