import { expect, test } from "@playwright/test";
import { installFreeSuiteHarness, loadNativeFreeSuiteSchemas, mountFreeSuiteEditor, nativeFreeSuiteSchemasUnavailable } from "./support/freeSuiteHarness";

// Generate this fixture with the native editor-schemas regression group, or set
// OPENSTUDIO_FREE_SUITE_SCHEMAS. A browser fixture does not assert DSP quality.
test.skip(nativeFreeSuiteSchemasUnavailable, "Export native schemas and run this suite with: powershell -File tools/run-free-suite-ui-regression.ps1 (from the repository root)");
test.beforeEach(async ({ page }) => installFreeSuiteHarness(page, loadNativeFreeSuiteSchemas()));
test.afterEach(async ({ page }) => page.evaluate(() => window.freeSuiteQA?.dispose()));

test("instrument primary views fit compact, preferred and 4K hosts with pinned output", async ({ page }, testInfo) => {
  for (const size of [{ width: 640, height: 480 }, { width: 1040, height: 680 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size);
    for (const pluginId of ["synth", "piano", "guitar", "drums"]) {
      const editor = await mountFreeSuiteEditor(page, pluginId);
      const geometry = await editor.evaluate(root => {
        const workspace = root.querySelector<HTMLElement>(".instrument-workspace")!;
        const output = root.querySelector<HTMLElement>('[data-param="outputGain"]')!.getBoundingClientRect();
        const outside = Array.from(root.querySelectorAll<HTMLElement>("input,select,button,[role=slider]"))
          .filter(element => element.getClientRects().length).filter(element => {
            const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1;
          });
        return { horizontal: workspace.scrollWidth - workspace.clientWidth, outside: outside.length, outputTop: output.top, outputBottom: output.bottom };
      });
      expect(geometry.horizontal).toBeLessThanOrEqual(1);
      expect(geometry.outside).toBe(0);
      expect(geometry.outputTop).toBeGreaterThan(0);
      expect(geometry.outputBottom).toBeLessThanOrEqual(size.height);
      await page.screenshot({ path: testInfo.outputPath(`${pluginId}-${size.width}.png`) });
    }
  }
});

test("compact Synth navigation preserves editable routes and native gestures", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const editor = await mountFreeSuiteEditor(page, "synth");
  await editor.getByRole("button", { name: "Filter", exact: true }).click();
  const cutoff = editor.getByRole("slider", { name: "Cutoff", exact: true });
  await expect(cutoff).toHaveAttribute("aria-disabled", "true");
  await editor.getByRole("combobox", { name: "Filter type", exact: true }).selectOption("1");
  await expect(cutoff).not.toHaveAttribute("aria-disabled", "true");
  await cutoff.focus(); await cutoff.press("ArrowUp");
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes.some(write => write.id === "filterCutoff"))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures.some(edit => edit.id === "filterCutoff" && !edit.begin))).toBe(true);
  await editor.getByRole("button", { name: "Modulation", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Route 8 destination", exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Macros", exact: true }).click();
  await expect(editor.getByRole("slider", { name: "Macro 4", exact: true })).toBeVisible();
  await editor.getByRole("spinbutton", { name: "Macro 4 value", exact: true }).fill("35");
  await editor.getByRole("spinbutton", { name: "Macro 4 value", exact: true }).press("Enter");
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes.some(write => write.id === "macro4" && write.value === .35))).toBe(true);
});

test("compact drum banks keep note-off ownership and exclusive output controls", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const editor = await mountFreeSuiteEditor(page, "drums", { articulationEngine: 1 });
  const kick = editor.getByRole("button", { name: /Audition Kick, MIDI input 36/ });
  await kick.focus(); await kick.press("Enter");
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.audition.some(event => event.note === 36 && !event.on))).toBe(true);
  await editor.getByRole("button", { name: "Cymbals & extras", exact: true }).click();
  await expect(kick).toBeHidden();
  await editor.getByRole("button", { name: "Selected piece", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Output", exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Character", exact: true }).click();
  await expect(editor.locator('[data-param="hihatTightness"] [role="slider"]')).toHaveAttribute("aria-disabled", "true");
  await expect(editor.getByText("Hi-hat Tightness and Kit apply to Legacy voices. Their values are retained.")).toBeVisible();
});

test("Guitar sound and Piano voicing remain reachable with the keyboard visible", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  for (const pluginId of ["guitar", "piano"]) {
    const editor = await mountFreeSuiteEditor(page, pluginId);
    const tone = editor.getByRole("slider", { name: "Tone", exact: true });
    await expect(tone).toBeVisible();
    const box = await tone.boundingBox();
    const footer = await editor.locator(".instrument-keyboard-section").boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(footer!.y);
    const audition = editor.getByRole("button", { name: "Audition C3, MIDI 48", exact: true });
    // Space remains the profile's transport shortcut; Enter auditions a focused key.
    await audition.focus(); await audition.press("Enter");
    await expect.poll(() => page.evaluate(() => window.freeSuiteQA.audition.some(event => event.note === 48 && !event.on))).toBe(true);
  }
});

test("feature search reveals compact controls and the owned drum mapping dialog without changing sound", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const synth = await mountFreeSuiteEditor(page, "synth");
  await synth.getByRole("button", { name: "Find a control or feature", exact: true }).click();
  await page.getByLabel("Search controls and features", { exact: true }).fill("matrix8TargetFull");
  await page.getByRole("button", { name: /^Route 8 Destination/ }).click();
  await expect(synth.getByRole("combobox", { name: "Route 8 destination", exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);

  const drums = await mountFreeSuiteEditor(page, "drums");
  await drums.getByRole("button", { name: "Find a control or feature", exact: true }).click();
  await page.getByLabel("Search controls and features", { exact: true }).fill("Drum map and MIDI learn");
  await page.getByRole("button", { name: /^Drum map and MIDI learn/ }).click();
  const map = page.getByRole("dialog", { name: "Drum MIDI map", exact: true });
  await map.getByRole("combobox", { name: "Incoming drum note", exact: true }).selectOption("127");
  await map.getByRole("combobox", { name: "Drum destination note", exact: true }).selectOption("-1");
  await map.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
  expect(await page.evaluate(() => window.freeSuiteQA.schema.parameters.find(parameter => parameter.id === "noteMap127")?.value)).toBe(127);
});
