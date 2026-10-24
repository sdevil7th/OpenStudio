import { expect, test, type Page } from "@playwright/test";
import { installFreeSuiteHarness, loadNativeFreeSuiteSchemas, mountFreeSuiteEditor, nativeFreeSuiteSchemasUnavailable } from "./support/freeSuiteHarness";

test.skip(nativeFreeSuiteSchemasUnavailable, "Export current native schemas with tools/run-free-suite-ui-regression.ps1 before this qualification suite.");
test.beforeEach(async ({ page }) => installFreeSuiteHarness(page, loadNativeFreeSuiteSchemas()));
test.afterEach(async ({ page }) => page.evaluate(() => window.freeSuiteQA?.dispose()));

interface ReverbResponseQA {
  pending: boolean;
  calls: { action: string; decay: number }[];
  finishWrite: (success: boolean) => void;
}
declare global { interface Window { reverbResponseQA: ReverbResponseQA } }

async function deferReverbWrite(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/services/NativeBridge.ts";
    const { nativeBridge: bridge } = await import(/* @vite-ignore */ path) as typeof import("../src/services/NativeBridge");
    const write = bridge.setBuiltInPluginParam.bind(bridge);
    const state: ReverbResponseQA = window.reverbResponseQA = { pending: false, calls: [], finishWrite: () => {} };
    bridge.setBuiltInPluginParam = (address, id, value) => new Promise<boolean>(resolve => {
      state.pending = true;
      state.finishWrite = success => {
        state.pending = false;
        if (success) void write(address, id, value).then(resolve);
        else resolve(false);
      };
    });
    bridge.reverbResponse = async action => {
      state.calls.push({ action, decay: window.freeSuiteQA.schema.parameters.find(p => p.id === "decayTime")!.value });
      return { success: true, complete: true, seconds: 5, sampleRate: 48000, tempoBpm: 120,
        peak: [Array<number>(640).fill(.01), Array<number>(640).fill(.01)],
        rms: [Array<number>(640).fill(.005), Array<number>(640).fill(.005)] };
    };
  });
}

for (const route of ["desktop", "Find"] as const) {
  for (const success of [true, false]) {
    test(`Reverb ${route} response waits for pending parameter writes and ${success ? "captures the accepted value" : "rejects a failed write"}`, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      const editor = await mountFreeSuiteEditor(page, "reverb", { reverbTypeAll: 0, decayTime: 2 });
      await deferReverbWrite(page);
      const decay = editor.locator('[data-param="decayTime"] input[type=number]').first();
      await decay.fill("3.25"); await decay.press("Enter");
      await expect.poll(() => page.evaluate(() => window.reverbResponseQA.pending)).toBe(true);
      if (route === "Find") {
        await editor.getByRole("button", { name: "Find a control or feature" }).click();
        await page.getByRole("textbox", { name: "Search controls and features" }).fill("Response analysis");
        await page.getByLabel("Search results").getByRole("button").first().click();
        await expect(editor.getByRole("tab", { name: "Response", exact: true })).toHaveAttribute("aria-selected", "true");
      }
      const render = editor.getByRole("button", { name: "Render response", exact: true });
      await render.click();
      await expect(render).toBeDisabled();
      // Let the UI settle while the real parameter writer is still in flight.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => window.reverbResponseQA.calls)).toEqual([]);
      await page.evaluate(success => window.reverbResponseQA.finishWrite(success), success);
      if (success) {
        await expect(editor.getByLabel("Response measurements")).toBeVisible();
        expect(await page.evaluate(() => window.reverbResponseQA.calls.filter(call => call.action === "render"))).toEqual([{ action: "render", decay: 3.25 }]);
      } else {
        await expect(editor.getByRole("alert").filter({ hasText: "Pending parameter changes could not be applied" })).toBeVisible();
        expect(await page.evaluate(() => window.reverbResponseQA.calls)).toEqual([]);
      }
      await expect(render).toBeEnabled();
    });
  }
}

test("Reverb response cancellation while flushing never starts a late render", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const editor = await mountFreeSuiteEditor(page, "reverb", { reverbTypeAll: 0, decayTime: 2 });
  await deferReverbWrite(page);
  const decay = editor.locator('[data-param="decayTime"] input[type=number]').first();
  await decay.fill("3.25"); await decay.press("Enter");
  await expect.poll(() => page.evaluate(() => window.reverbResponseQA.pending)).toBe(true);
  await editor.getByRole("button", { name: "Render response", exact: true }).click();
  await editor.getByRole("button", { name: "Cancel response", exact: true }).click();
  await page.evaluate(() => window.reverbResponseQA.finishWrite(true));
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes.some(write => write.id === "decayTime" && write.value === 3.25))).toBe(true);
  await expect(editor.getByRole("button", { name: "Render response", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.reverbResponseQA.calls)).toEqual([]);
});

test("Reverb response stays inside its workbench above output controls", async ({ page }, testInfo) => {
  for (const viewport of [{ width: 900, height: 680 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(viewport);
    const editor = await mountFreeSuiteEditor(page, "reverb", { reverbTypeAll: 1 });
    if (viewport.width >= 1920) {
      const response = editor.getByRole("complementary", { name: "Response analysis" });
      await expect(response).toBeVisible();
      const bounds = await response.evaluate(element => {
        const panel = element.getBoundingClientRect();
        const text = element.querySelector("p")!.getBoundingClientRect();
        const output = element.closest(".reverb-console")!.querySelector(".reverb-output")!.getBoundingClientRect();
        return { panelBottom: panel.bottom, textBottom: text.bottom, outputTop: output.top, overflow: element.scrollHeight - element.clientHeight };
      });
      expect(bounds.textBottom).toBeLessThanOrEqual(bounds.panelBottom + 1);
      expect(bounds.panelBottom).toBeLessThanOrEqual(bounds.outputTop + 1);
      expect(bounds.overflow).toBeLessThanOrEqual(1);
    }
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`free-suite-reverb-${viewport.width}.png`) });
  }
});

test("effect controls fit minimum, preferred and large editor hosts", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  for (const size of [{ width: 640, height: 480 }, { width: 1040, height: 680 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size);
    for (const pluginId of ["eq", "geq", "compressor", "gate", "limiter", "preamp", "saturator", "reverb", "delay", "chorus", "utility", "pitch"]) {
      const editor = await mountFreeSuiteEditor(page, pluginId);
      await expect(editor.getByRole("button", { name: "Find a control or feature" })).toBeVisible();
      const overflow = await editor.evaluate(root => Array.from(root.querySelectorAll<HTMLElement>("input,select,button,[role=slider]"))
        .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")
        .filter(element => { const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; })
        .map(element => element.getAttribute("aria-label") || element.textContent));
      expect(overflow, `${pluginId} at ${size.width}`).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${pluginId}-${size.width}.png`) });
    }
  }
});

test("exact entry, fine keyboard, reset and Undo keep native gesture boundaries", async ({ page }) => {
  const editor = await mountFreeSuiteEditor(page, "gate");
  const value = editor.getByRole("spinbutton", { name: "Open threshold value", exact: true });
  await value.fill("-36.5"); await value.press("Enter");
  await expect(value).toHaveValue("-36.5");
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures.filter(edit => edit.id === "threshold").map(edit => edit.begin))).toEqual([true, false]);
  const slider = editor.getByRole("slider", { name: "Open threshold", exact: true });
  await slider.focus(); await slider.press("Shift+ArrowUp");
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes.filter(write => write.id === "threshold").length)).toBe(2);
  await slider.dblclick();
  const defaultValue = await page.evaluate(() => window.freeSuiteQA.schema.parameters.find(parameter => parameter.id === "threshold")!.defaultValue);
  await expect(slider).toHaveAttribute("aria-valuenow", String(defaultValue));
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(slider).not.toHaveAttribute("aria-valuenow", String(defaultValue));
  await value.fill("-12"); await value.press("Escape");
  await expect(value).not.toHaveValue("-12");
});

test("Find reveals secondary controls without changing processing modes", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const editor = await mountFreeSuiteEditor(page, "chorus");
  await editor.getByRole("button", { name: "Find a control or feature" }).click();
  await page.getByRole("textbox", { name: "Search controls and features" }).fill("highCut");
  await page.getByLabel("Search results").getByRole("button").first().click();
  await expect(editor.getByRole("slider", { name: "High cut", exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
  await mountFreeSuiteEditor(page, "delay");
  await editor.getByRole("button", { name: "Find a control or feature" }).click();
  await page.getByRole("textbox", { name: "Search controls and features" }).fill("dualFeedback");
  await page.getByLabel("Search results").getByRole("button").first().click();
  await expect(page.getByRole("status").filter({ hasText: "not active in the current configuration" })).toBeVisible();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
});

test("Gate expansion and Classic limiter clearly retain inactive settings", async ({ page }) => {
  let editor = await mountFreeSuiteEditor(page, "gate", { expansionMode: 1, holdMs: 80, hysteresis: 6 });
  await expect(editor.getByRole("slider", { name: "Hold", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(editor.getByRole("slider", { name: "Hysteresis", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(editor.getByText("Expander uses a continuous gain curve.", { exact: false })).toBeVisible();
  editor = await mountFreeSuiteEditor(page, "limiter", { limitingStyleAll: 0 });
  await editor.getByRole("button", { name: "Timing & linking", exact: true }).click();
  await expect(editor.getByRole("slider", { name: "Attack", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(editor.getByRole("slider", { name: "Release", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
});

test("Convolution Find opens its real shaping pages without preparing audio", async ({ page }) => {
  const editor = await mountFreeSuiteEditor(page, "reverb", { reverbTypeAll: 7 });
  await editor.getByRole("button", { name: "Find a control or feature" }).click();
  await page.getByRole("textbox", { name: "Search controls and features" }).fill("Convolution Damping");
  await page.getByLabel("Search results").getByRole("button").first().click();
  await expect(editor.locator('[data-feature="ir-damping"]')).toBeVisible();
  await expect(editor.getByRole("button", { name: "Damping", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
});

test("Reverb Setup keeps saved return choices and independent balance", async ({ page }) => {
  for (const type of [0, 2, 4, 7, 19, 36, 40]) {
    const editor = await mountFreeSuiteEditor(page, "reverb", { reverbTypeAll: type, reverbReturnMode: 0, wetLevel: .33, dryLevel: .7 });
    await editor.getByRole("tab", { name: /^Setup/ }).click();
    await expect(editor.getByRole("combobox", { name: "Return level", exact: true })).toHaveValue("0");
    await expect(editor.locator('[data-param="wetLevel"] [role=slider]')).toHaveAttribute("aria-valuenow", "0.33");
    await expect(editor.locator('[data-param="dryLevel"] [role=slider]')).toHaveAttribute("aria-valuenow", "0.7");
    expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
  }
});

test("parallel mix exact entry and A/B copy preserve values through Undo", async ({ page }) => {
  const editor = await mountFreeSuiteEditor(page, "compressor");
  const mix = editor.getByRole("spinbutton", { name: "Parallel mix value", exact: true });
  await mix.fill("37.5"); await mix.press("Enter");
  await expect(mix).toHaveValue("37.5");
  await editor.getByRole("button", { name: "B", exact: true }).click();
  await expect(mix).toHaveValue("100");
  await mix.fill("62.5"); await mix.press("Enter");
  await editor.getByRole("button", { name: "Copy B to A", exact: true }).click();
  await editor.getByRole("button", { name: "A", exact: true }).click();
  await expect(mix).toHaveValue("62.5");
  await mix.fill("-20"); await mix.press("Escape");
  await expect(mix).toHaveValue("62.5");
  await mix.fill("40"); await mix.press("Enter");
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(mix).toHaveValue("62.5");
});

test("disabling a captured parameter drag closes its gesture and preserves the retained value", async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 680 });
  const editor = await mountFreeSuiteEditor(page, "gate", { expansionMode: 0, holdMs: 80 });
  const hold = editor.getByRole("slider", { name: "Hold", exact: true });
  await hold.scrollIntoViewIfNeeded();
  const bounds = await hold.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2, y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y - 12);
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes.filter(write => write.id === "holdMs").length)).toBeGreaterThan(0);
  await page.evaluate(() => window.freeSuiteQA.update({ expansionMode: 1 }));
  await expect(hold).toHaveAttribute("aria-disabled", "true");
  // The physical pointer is still down: disabling must close the native gesture immediately.
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures.filter(edit => edit.id === "holdMs").map(edit => edit.begin))).toEqual([true, false]);
  const retained = await page.evaluate(() => ({
    value: window.freeSuiteQA.schema.parameters.find(parameter => parameter.id === "holdMs")!.value,
    writes: window.freeSuiteQA.writes.filter(write => write.id === "holdMs").length,
  }));
  await page.mouse.move(x, y - 40); await page.mouse.up();
  expect(await page.evaluate(() => ({
    value: window.freeSuiteQA.schema.parameters.find(parameter => parameter.id === "holdMs")!.value,
    writes: window.freeSuiteQA.writes.filter(write => write.id === "holdMs").length,
  }))).toEqual(retained);
  expect(await page.evaluate(() => window.freeSuiteQA.gestures.filter(edit => edit.id === "holdMs").map(edit => edit.begin))).toEqual([true, false]);
  await page.evaluate(() => window.freeSuiteQA.update({ expansionMode: 0 }));
  const numeric = editor.getByRole("spinbutton", { name: "Hold value", exact: true });
  await numeric.fill("123.4567");
  await page.evaluate(() => window.freeSuiteQA.update({ expansionMode: 1, holdMs: 96.1256 }));
  await expect(numeric).toBeDisabled();
  await page.evaluate(() => window.freeSuiteQA.update({ expansionMode: 0 }));
  await expect(numeric).toBeEnabled();
  await expect(numeric).toHaveValue("96.126");
  expect(await page.evaluate(() => window.freeSuiteQA.writes.filter(write => write.id === "holdMs").length)).toBe(retained.writes);
});

test("untouched numeric fields preserve precision and external updates while deliberate edits stay reversible", async ({ page }) => {
  for (const scenario of [
    { plugin: "compressor", id: "mix", name: "Parallel mix", initial: .123456789, external: .876543219, factor: 100, draft: "42.1256", edited: .421256 },
    { plugin: "gate", id: "threshold", name: "Open threshold", initial: -36.123456789, external: -12.987654321, factor: 1, draft: "-24.5678", edited: -24.5678 },
  ]) {
    const editor = await mountFreeSuiteEditor(page, scenario.plugin, { [scenario.id]: scenario.initial });
    const numeric = editor.getByRole("spinbutton", { name: `${scenario.name} value`, exact: true });
    const slider = editor.getByRole("slider", { name: scenario.name, exact: true });
    await numeric.focus(); await numeric.evaluate(element => (element as HTMLInputElement).blur());
    expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures.map(edit => edit.begin))).toEqual([true, false]);
    await expect(editor.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    expect(await page.evaluate(id => window.freeSuiteQA.schema.parameters.find(parameter => parameter.id === id)!.value, scenario.id)).toBe(scenario.initial);
    await numeric.focus();
    await page.evaluate(({ id, external }) => window.freeSuiteQA.update({ [id]: external }), scenario);
    await expect.poll(async () => Number(await slider.evaluate(element => element.getAttribute("aria-valuenow") ?? (element as HTMLInputElement).value))).toBeCloseTo(scenario.external, 2);
    await numeric.evaluate(element => (element as HTMLInputElement).blur());
    await expect(numeric).toHaveValue(String(Number((scenario.external * scenario.factor).toFixed(3))));
    expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures.map(edit => edit.begin))).toEqual([true, false, true, false]);
    await expect(editor.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await page.evaluate(() => { window.freeSuiteQA.gestures = []; });
    await numeric.fill(scenario.draft); await numeric.press("Enter");
    await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes)).toEqual([{ id: scenario.id, value: expect.closeTo(scenario.edited, 12) }]);
    await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures.map(edit => edit.begin))).toEqual([true, false]);
    await editor.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(numeric).toHaveValue(String(Number((scenario.external * scenario.factor).toFixed(3))));
  }
});

test("wide effects reveal useful secondary controls and retain compact collapse", async ({ page }) => {
  await page.setViewportSize({ width: 3840, height: 2160 });
  const editor = await mountFreeSuiteEditor(page, "chorus");
  await expect(editor.getByRole("slider", { name: "High cut", exact: true })).toBeVisible();
  await expect(editor.getByRole("combobox", { name: "Character", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 940, height: 520 });
  await expect(editor.getByRole("slider", { name: "High cut", exact: true })).toBeHidden();
  await editor.getByRole("button", { name: "Detail +", exact: true }).click();
  await editor.getByRole("button", { name: "Tone", exact: true }).click();
  await expect(editor.getByRole("slider", { name: "High cut", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
});

test("Find reaches the Reverb machine control at compact and wide sizes", async ({ page }) => {
  for (const size of [{ width: 640, height: 480 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    const editor = await mountFreeSuiteEditor(page, "reverb");
    for (const query of ["reverbTypeAll", "Reverb machines"]) {
      await editor.getByRole("button", { name: "Find a control or feature" }).click();
      await page.getByRole("textbox", { name: "Search controls and features" }).fill(query);
      await page.getByLabel("Search results").getByRole("button").first().click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(size.width === 640 ? editor.getByRole("combobox", { name: "Reverb machine", exact: true }) : editor.getByRole("searchbox", { name: "Search reverb machines" })).toBeFocused();
      expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
    }
  }
});

test("Find explains disabled and inert settings with accessible focus and no writes", async ({ page }) => {
  const scenarios: { plugin: string; values: Record<string, number>; query: string }[] = [
    { plugin: "gate", values: { expansionMode: 1 }, query: "holdMs" },
    { plugin: "limiter", values: { limitingStyleAll: 0 }, query: "automaticRelease" },
    { plugin: "reverb", values: { sendMode: 1 }, query: "wetLevel" },
  ];
  for (const scenario of scenarios) {
    const editor = await mountFreeSuiteEditor(page, scenario.plugin, scenario.values);
    await editor.getByRole("button", { name: "Find a control or feature" }).click();
    await page.getByRole("textbox", { name: "Search controls and features" }).fill(scenario.query);
    await page.getByLabel("Search results").getByRole("button").first().click();
    const notice = page.getByRole("dialog").getByRole("status");
    await expect(notice).toContainText("not active in the current configuration");
    await expect(notice).toBeFocused();
    expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
  }
});
