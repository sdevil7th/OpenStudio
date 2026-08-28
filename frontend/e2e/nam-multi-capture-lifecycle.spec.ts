import { expect, test, type Page } from "@playwright/test";

const NAM_ADDRESS = {
  trackId: "nam-multi-capture-e2e",
  chain: "track",
  fxIndex: 0,
} as const;

const PACK_TITLE = "Headbangers Ball Amp Pack IR/RAW";

function sourceFlowUrl() {
  const session = {
    address: NAM_ADDRESS,
    title: "OpenStudio NAM Rack",
    fallbackName: "OpenStudio NAM Rack",
  };
  const params = new URLSearchParams({
    window: "pluginEditor",
    platform: "windows",
    windowChrome: "native",
    mockPlugin: "nam",
    sessionId: JSON.stringify(session),
    namView: "rack",
    namLibraryFlow: "amp",
    namQuery: "headbangers",
  });
  return `/?${params.toString()}`;
}

async function readRackState(page: Page) {
  return page.evaluate(async (address) => {
    const moduleUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ moduleUrl);
    return nativeBridge.getBuiltInPluginState(address);
  }, NAM_ADDRESS);
}

async function readAmpPath(page: Page) {
  const state = await readRackState(page);
  return String(state.modelState?.ampModelPath ?? "").replace(/\\/g, "/");
}

async function expectAmpPath(page: Page, modelId: number | null) {
  const modelSlug = modelId === null ? "" : ({
    6713901: "headbangers-ball-01-raw.nam",
    6713902: "headbangers-ball-01-ir.nam",
    6713904: "headbangers-ball-02-ir.nam",
  } as Record<number, string>)[modelId];
  await expect.poll(() => readAmpPath(page))
    .toEqual(modelId === null ? "" : expect.stringMatching(new RegExp(`/${modelSlug.replace(".", "\\.")}$`)));
}

test("multi-capture pack supports preview, use, replace, bypass, and unload", async ({ page }) => {
  await page.goto(sourceFlowUrl());

  const packCard = page.locator(".tone-feed-row").filter({ hasText: PACK_TITLE });
  await expect(packCard).toHaveCount(1);
  await expect(packCard).toContainText(/4 captures/i);

  const picker = page.locator('[data-qa="nam-tone-capture-picker"]:not([data-compact])');
  await expect(picker).toBeVisible();
  await expect(picker.locator(".nam-tone-capture-select")).toHaveCount(0);
  await packCard.getByRole("button", { name: "View 4 Captures" }).click();
  await expect(picker).toContainText("4 captures");
  await expect(picker.locator(".nam-tone-capture-select")).toHaveCount(4);

  const raw01Select = picker.locator(".nam-tone-capture-select").filter({ hasText: "Headbangers Ball 01 RAW" });
  const ir01Select = picker.locator(".nam-tone-capture-select").filter({ hasText: "Headbangers Ball 01 IR" });
  const raw01 = raw01Select.locator("..");
  const ir01 = ir01Select.locator("..");
  await expect(raw01).toContainText("RAW / AMP ONLY");
  await expect(ir01).toContainText("CAB EMBEDDED");
  const baselineAmpPath = await readAmpPath(page);
  expect(baselineAmpPath).not.toBe("");

  await ir01Select.focus();
  await page.keyboard.press("Space");
  await expect(ir01Select).toHaveAttribute("aria-pressed", "true");
  await expect(ir01).toHaveAttribute("data-selected", "true");
  await expect.poll(() => readAmpPath(page)).toBe(baselineAmpPath);

  await ir01.getByRole("button", { name: "Audition Headbangers Ball 01 IR" }).click();
  await expect(ir01).toHaveAttribute("data-audition", "true");
  await expectAmpPath(page, 6713902);

  await raw01.getByRole("button", { name: "Audition Headbangers Ball 01 RAW" }).click();
  await expect(raw01).toHaveAttribute("data-audition", "true");
  await expect(ir01).not.toHaveAttribute("data-audition", "true");
  await expectAmpPath(page, 6713901);

  await raw01.getByRole("button", { name: "Stop auditioning Headbangers Ball 01 RAW" }).click();
  await expect.poll(() => readAmpPath(page)).toBe(baselineAmpPath);

  await raw01.getByRole("button", { name: "Audition Headbangers Ball 01 RAW" }).click();
  await expectAmpPath(page, 6713901);
  await raw01.getByRole("button", { name: "Use Headbangers Ball 01 RAW" }).click();

  const nameplate = page.locator('[data-qa="nam-amp-capture-nameplate"]');
  await expect(nameplate).toHaveAttribute("data-state", "loaded");
  await expect(nameplate).toHaveAttribute("data-includes-cab", "false");
  await expect(nameplate).toContainText(/Headbangers Ball 01 RAW/i);
  await expectAmpPath(page, 6713901);

  const ampPower = page.locator('[data-param-id="ampEnabled"][role]').first();
  await ampPower.focus();
  await page.keyboard.press("Space");
  await expect.poll(async () => (await readRackState(page)).values?.ampEnabled).toBe(0);
  await page.keyboard.press("Space");
  await expect.poll(async () => (await readRackState(page)).values?.ampEnabled).toBe(1);

  await page.locator('[data-qa="nam-amp-capture-selector"]').click();
  await expect(picker).toBeVisible();
  const ir02 = picker.locator(".nam-tone-capture-select").filter({ hasText: "Headbangers Ball 02 IR" }).locator("..");
  await ir02.getByRole("button", { name: "Use Headbangers Ball 02 IR" }).click();

  await expect(nameplate).toHaveAttribute("data-state", "loaded");
  await expect(nameplate).toHaveAttribute("data-includes-cab", "true");
  await expect(nameplate).toContainText(/Headbangers Ball 02 IR/i);
  await expectAmpPath(page, 6713904);
  await expect.poll(async () => (await readRackState(page)).values?.cabEnabled).toBe(0);

  await page.locator('[data-qa="nam-amp-capture-unload"]').click();
  await expect(nameplate).toHaveAttribute("data-state", "empty");
  await expect(nameplate).toContainText("No amp capture loaded");
  await expectAmpPath(page, null);
});
