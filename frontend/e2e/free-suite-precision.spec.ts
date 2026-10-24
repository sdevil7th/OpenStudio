import { expect, test, type Page } from "@playwright/test";
import { installFreeSuiteHarness, loadNativeFreeSuiteSchemas, mountFreeSuiteEditor, nativeFreeSuiteSchemasUnavailable } from "./support/freeSuiteHarness";

test.skip(nativeFreeSuiteSchemasUnavailable, "Export native editor schemas with tools/run-free-suite-ui-regression.ps1 first.");
test.beforeEach(async ({ page }) => installFreeSuiteHarness(page, loadNativeFreeSuiteSchemas()));
test.afterEach(async ({ page }) => page.evaluate(() => window.freeSuiteQA?.dispose()));

async function findParameter(page: Page, id: string, inactive = false) {
  await page.getByRole("button", { name: "Find a control or feature" }).click();
  await page.getByRole("textbox", { name: "Search controls and features" }).fill(id);
  const result = page.getByRole("dialog").getByRole("button").filter({ has: page.locator("span", { hasText: new RegExp(`(?:^|[ ·])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
  await result.first().click();
  if (inactive) {
    const notice = page.getByRole("status").filter({ hasText: "not active in the current configuration" });
    await expect(notice).toBeFocused();
    await page.getByRole("dialog").getByRole("button", { name: "Close modal", exact: true }).click();
  }
  await expect(page.getByRole("dialog")).toBeHidden();
}

test("precision editors fit compact, preferred and 4K hosts with useful fader travel", async ({ page }, testInfo) => {
  for (const size of [{ width: 640, height: 480 }, { width: 1040, height: 680 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size);
    for (const id of ["eq", "geq", "utility", "pitch"]) {
      const editor = await mountFreeSuiteEditor(page, id);
      const outside = await editor.evaluate(root => Array.from(root.querySelectorAll<HTMLElement>("button,input,select,[role=slider]"))
        .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")
        .filter(element => { const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; })
        .map(element => element.getAttribute("aria-label") || element.textContent));
      expect(outside, `${id} at ${size.width}`).toEqual([]);
      if (id === "pitch") {
        const output = await editor.locator('[aria-label="Realtime processing"]').boundingBox();
        expect(output!.y + output!.height).toBeLessThanOrEqual(size.height);
      }
      if (id === "geq" && size.width === 3840) {
        const fader = await editor.locator(".graphic-eq-fader").first().boundingBox();
        expect(fader!.height).toBeLessThanOrEqual(500);
        expect(fader!.height).toBeGreaterThan(180);
      }
      await page.screenshot({ path: testInfo.outputPath(`${id}-${size.width}.png`) });
    }
  }
});

test("Pitch Find reveals source, formants and MIDI without altering saved settings", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const editor = await mountFreeSuiteEditor(page, "pitch", { signalPath: 1, scale: 0, noteEnable_1: 0, midiOutputEnabled: 0, midiOutputChannel: 7 });
  const before = await page.evaluate(() => window.freeSuiteQA.schema.parameters);
  for (const id of ["minFreqParam", "noteEnable_1", "formantShift", "midiOutputChannel"]) {
    await findParameter(page, id, id === "noteEnable_1" || id === "midiOutputChannel");
    await expect(editor.locator(`[data-param="${id}"]`)).toBeVisible();
  }
  await expect(editor.getByRole("slider", { name: "MIDI channel", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(editor.getByRole("spinbutton", { name: "MIDI channel value" })).toHaveValue("7");
  await editor.getByRole("button", { name: "Source", exact: true }).click();
  await expect(editor.getByRole("button", { name: "C#", exact: true })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "C#", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.freeSuiteQA.schema.parameters)).toEqual(before);
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
});

test("Pitch pages retain every live parameter and Custom switches keep absolute notes", async ({ page }) => {
  const editor = await mountFreeSuiteEditor(page, "pitch", { signalPath: 1, scale: 15, key: 4 });
  const covered = new Set<string>();
  for (const tab of ["Correction", "Source", "Formants", "MIDI output"]) {
    await editor.getByRole("button", { name: tab, exact: true }).first().click();
    const visible = await editor.locator("[data-param]").evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => element.getAttribute("data-param")!));
    visible.forEach(id => covered.add(id));
  }
  const required = await page.evaluate(() => window.freeSuiteQA.schema.parameters.filter(p => p.id !== "signalPath" && p.type !== "meter").map(p => p.id));
  expect(required.filter(id => !covered.has(id))).toEqual([]);
  await editor.getByRole("button", { name: "Source", exact: true }).click();
  await editor.getByRole("button", { name: "C#", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes[window.freeSuiteQA.writes.length - 1])).toEqual({ id: "noteEnable_1", value: 0 });
});

test("Graphic EQ Reset selected changes only the active selected bank", async ({ page }) => {
  const editor = await mountFreeSuiteEditor(page, "geq", { graphicMode: 0, geq0: 3, geq1: -4, third0: 6 });
  await editor.getByRole("button", { name: "Select 31 Hz", exact: true }).click();
  await editor.getByRole("button", { name: "Reset selected", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.fromEntries(window.freeSuiteQA.schema.parameters.filter(p => ["geq0", "geq1", "third0"].includes(p.id)).map(p => [p.id, p.value])))).toEqual({ geq0: 0, geq1: -4, third0: 6 });
  await editor.getByRole("button", { name: "31 third-octave", exact: true }).click();
  await expect(editor.locator('[data-param="third0"] input[type=number]')).toHaveValue("6");
});

test("Gain Phase Find opens spectral editing and all saved points remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const editor = await mountFreeSuiteEditor(page, "utility", { spectralPhaseEnabled: 0, spectralPhaseR47: 0.37 });
  await editor.getByRole("button", { name: "Find a control or feature" }).click();
  await page.getByRole("textbox", { name: "Search controls and features" }).fill("48 points");
  await page.getByRole("dialog").getByRole("button", { name: "Spectral phase 48 points per channel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(editor.getByRole("tab", { name: "Spectral", exact: true })).toHaveAttribute("aria-selected", "true");
  await editor.getByText("Edit saved phase points", { exact: true }).click();
  await editor.getByRole("combobox", { name: "Spectral phase frequency point" }).selectOption("47");
  await expect(editor.getByRole("combobox", { name: "Spectral phase frequency point" })).toHaveValue("47");
  await expect(editor.locator('[data-param="spectralPhaseR47"]')).toBeVisible();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
  await editor.getByRole("tab", { name: "Alignment", exact: true }).click();
  await editor.getByText("Capture settings", { exact: false }).click();
  await expect(editor.getByRole("combobox", { name: "Alignment capture duration" })).toBeVisible();
  await expect(editor.getByRole("combobox", { name: "Alignment routing policy" })).toBeVisible();
});

test("EQ Find reaches a late-band dynamics policy and existing phase settings", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const editor = await mountFreeSuiteEditor(page, "eq");
  await findParameter(page, "band10.dynamicThresholdMode");
  await expect(editor.getByRole("combobox", { name: "Dynamic threshold mode" })).toBeVisible();
  await expect(editor.getByRole("combobox", { name: "Band selection" })).toHaveValue("10");
  await findParameter(page, "phaseMode");
  await expect(editor.getByRole("combobox", { name: "Phase mode" })).toBeFocused();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
});
