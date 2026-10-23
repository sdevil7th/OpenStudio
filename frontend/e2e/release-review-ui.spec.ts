import { expect, test, type Page } from "@playwright/test";
import { installFreeSuiteHarness, loadNativeFreeSuiteSchemas, mountFreeSuiteEditor, nativeFreeSuiteSchemasUnavailable } from "./support/freeSuiteHarness";

type NAMReleaseQA = {
  frames: number;
  blocks: number;
  emergency: boolean;
  acceptSave: boolean;
  writes: { path: string; document: Record<string, unknown> }[];
  projectWrites: number;
};
declare global { interface Window { namReleaseQA: NAMReleaseQA } }

async function openNAM(page: Page, manager = false) {
  const session = { address: { trackId: "nam-release-review", chain: "track", fxIndex: 0 }, title: "OpenStudio NAM Rack", fallbackName: "OpenStudio NAM Rack" };
  const query = new URLSearchParams({ window: "pluginEditor", platform: "windows", windowChrome: "native", mockPlugin: "nam", sessionId: JSON.stringify(session), namView: "rack", namSection: "post", namFocus: "reverb", namPresetManager: manager ? "1" : "0" });
  await page.goto(`/?${query}`);
  await page.locator(".nam-rack-design-port.nam-native-design-surface").first().waitFor();
  // Static module import keeps initialization rooted across Vite dependency loads.
  const source = await (await page.request.get("/src/components/NAMRackPanel.tsx")).text();
  const bridgeUrl = source.match(/from "([^"]*NativeBridge\.ts[^"]*)"/)?.[1];
  if (!bridgeUrl) throw new Error("NAM bridge module was not found");
  await page.addScriptTag({ type: "module", content: `
    import { nativeBridge } from ${JSON.stringify(bridgeUrl)};
    const state = window.namReleaseQA = { frames: 18911, blocks: 20000, emergency: false, acceptSave: false, writes: [], projectWrites: 0 };
    nativeBridge.getNAMRackDiagnostics = async () => ({
      processedBlockCount: state.blocks, rackOutputSafetyGuardHitCount: state.frames,
      rackOutputEmergencyMuteActive: state.emergency, rackOutputEmergencyMuteTripCount: 0,
      lastRawInputPeakDb: -90, lastInputPeakDb: -90, lastOutputPeakDb: -90
    });
    nativeBridge.saveJsonDocumentToFile = async (path, json) => {
      state.writes.push({ path, document: JSON.parse(json) }); return state.acceptSave;
    };
    nativeBridge.saveProjectToFile = async () => { state.projectWrites++; throw new Error("Preset reached project-only writer"); };
    nativeBridge.showSaveDialog = async () => "C:/review/Tele Clean.osnampreset";
  ` });
  await page.waitForFunction(() => Boolean(window.namReleaseQA));
}

test("NAM output protection distinguishes recent reductions from history and keeps complete guidance readable", async ({ page }, testInfo) => {
  await openNAM(page);
  const status = page.locator(".premium-stage-status");
  await expect(status).toContainText("Earlier output peaks were reduced");
  await expect(status).toHaveAttribute("data-tone", "info");
  await page.evaluate(() => { window.namReleaseQA.frames++; window.namReleaseQA.blocks++; });
  await expect(status).toContainText("Output peaks reduced recently");
  await expect(status).toHaveAttribute("data-tone", "warning");
  await expect(status).toContainText("Earlier output peaks were reduced", { timeout: 6000 });
  await expect(status).toHaveAttribute("data-tone", "info");

  for (const size of [{ width: 640, height: 480 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size);
    await status.focus();
    await expect(status).toBeFocused();
    const geometry = await status.evaluate(element => {
      const bounds = element.getBoundingClientRect(), text = element.querySelector("span")!;
      const style = getComputedStyle(text), focus = getComputedStyle(element);
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
        clipped: text.scrollWidth > text.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
        textOverflow: style.textOverflow, whiteSpace: style.whiteSpace, fontSize: parseFloat(style.fontSize),
        focusWidth: parseFloat(focus.outlineWidth), role: element.getAttribute("role") };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(size.width);
    expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(size.height);
    expect(geometry.clipped).toBe(false); expect(geometry.textOverflow).not.toBe("ellipsis");
    expect(geometry.whiteSpace).not.toBe("nowrap"); expect(geometry.fontSize).toBeGreaterThanOrEqual(12);
    expect(geometry.focusWidth).toBeGreaterThan(0); expect(geometry.role).toBe("status");
    await page.screenshot({ path: testInfo.outputPath(`nam-protection-${size.width}.png`) });
  }
  await page.evaluate(() => { window.namReleaseQA.emergency = true; });
  await expect(status).toContainText("NAM Rack safety mute is active");
  await expect(status).toHaveAttribute("data-tone", "error");
  await page.evaluate(() => { window.namReleaseQA.emergency = false; window.namReleaseQA.frames = 0; window.namReleaseQA.blocks = 0; });
  await expect(status).not.toContainText("output peaks were reduced");
});

test("NAM metadata rejects failed disk saves without updating its cache, and portable export uses the JSON writer", async ({ page }) => {
  await openNAM(page, true);
  const manager = page.getByRole("dialog", { name: /Preset/ });
  const before = await page.evaluate(() => localStorage.getItem("openstudio_nam_rack_preset_metadata"));
  const favorite = async () => {
    await page.getByRole("button", { name: "Actions for Tele Clean Saved", exact: true }).click();
    await page.getByRole("menuitem", { name: "Favorite", exact: true }).click();
  };
  await favorite();
  await expect(manager).toContainText("Preset details could not be saved");
  expect(await page.evaluate(() => localStorage.getItem("openstudio_nam_rack_preset_metadata"))).toBe(before);
  expect(await page.evaluate(() => window.namReleaseQA.writes)).toHaveLength(1);
  await page.evaluate(() => { window.namReleaseQA.acceptSave = true; });
  await favorite();
  await expect(manager).not.toContainText("Preset details could not be saved");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("openstudio_nam_rack_preset_metadata") || "{}")["Tele Clean Saved"]?.favorite)).toBe(true);
  const metadata = await page.evaluate(() => window.namReleaseQA.writes[1]);
  expect(metadata.path).toContain(".metadata.json"); expect(metadata.document.kind).toBe("openstudio.namRackPresetMetadata");
  expect(metadata.document).not.toHaveProperty("tracks");

  await page.evaluate(() => { window.namReleaseQA.acceptSave = false; });
  await page.getByRole("button", { name: "Actions for Tele Clean Saved", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export", exact: true }).click();
  await expect(manager).toContainText("Preset could not be exported");
  expect(await page.evaluate(() => window.namReleaseQA.projectWrites)).toBe(0);
  const portable = await page.evaluate(() => window.namReleaseQA.writes[window.namReleaseQA.writes.length - 1]);
  expect(portable.document.kind).toBe("openstudio.namRackPreset"); expect(portable.document).toHaveProperty("state");
  expect(portable.document).not.toHaveProperty("tracks");
});

test("InstrumentSlider preserves untouched precision, commits once, cancels Escape and follows external updates", async ({ page }) => {
  test.skip(nativeFreeSuiteSchemasUnavailable, "Native editor schemas required for instrument qualification");
  await page.setViewportSize({ width: 640, height: 480 });
  await installFreeSuiteHarness(page, loadNativeFreeSuiteSchemas());
  const editor = await mountFreeSuiteEditor(page, "synth", { macro1: .1234567 });
  await editor.getByRole("button", { name: "Modulation", exact: true }).click();
  await editor.getByRole("button", { name: "Macros", exact: true }).click();
  const input = editor.getByRole("spinbutton", { name: "Macro 1 value", exact: true });
  const neutralFocus = editor.getByRole("button", { name: "Macros", exact: true });
  await expect(input).toHaveValue("12.346");
  await input.focus(); await neutralFocus.focus();
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toEqual([]);
  // The editor opens/closes host automation gestures on focus. Without a value
  // change that must produce neither a parameter write nor an undo command.
  await expect(editor.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures)).toEqual([{ id: "macro1", begin: true }, { id: "macro1", begin: false }]);
  await page.evaluate(() => { window.freeSuiteQA.gestures = []; });
  expect(await page.evaluate(() => window.freeSuiteQA.schema.parameters.find(p => p.id === "macro1")?.value)).toBe(.1234567);

  await input.fill("23.4567"); await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.writes.length)).toBe(1);
  const committed = await page.evaluate(() => window.freeSuiteQA.writes[0]);
  expect(committed.id).toBe("macro1"); expect(committed.value).toBeCloseTo(.234567, 12);
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.gestures.filter(event => event.id === "macro1"))).toEqual([{ id: "macro1", begin: true }, { id: "macro1", begin: false }]);
  await input.fill("80"); await input.press("Escape");
  await expect(input).toHaveValue("23.457");
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toHaveLength(1);

  await input.focus();
  await page.evaluate(() => window.freeSuiteQA.update({ macro1: .7654321 }));
  await neutralFocus.focus();
  await expect(input).toHaveValue("76.543");
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toHaveLength(1);
  await input.fill("40");
  await page.evaluate(() => window.freeSuiteQA.update({ macro1: .6 }));
  await input.press("Escape");
  await expect(input).toHaveValue("60");
  expect(await page.evaluate(() => window.freeSuiteQA.writes)).toHaveLength(1);
  await editor.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.freeSuiteQA.schema.parameters.find(p => p.id === "macro1")?.value)).toBe(.1234567);
  await expect(editor.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.evaluate(() => window.freeSuiteQA.dispose());
});
