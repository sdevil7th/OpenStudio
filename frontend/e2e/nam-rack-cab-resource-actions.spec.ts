import { expect, test, type Page } from "@playwright/test";

const NAM_ADDRESS = {
  trackId: "nam-cab-resource-actions-e2e",
  chain: "track",
  fxIndex: 0,
} as const;

function rackUrl(options: { fullRig?: boolean } = {}) {
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
    namFocus: "cab",
    namSection: "cab",
    ...(options.fullRig ? { mockNAMScenario: "full-rig" } : {}),
  });
  return `/?${params.toString()}`;
}

async function openCabSection(page: Page, options: { fullRig?: boolean } = {}) {
  await page.goto(rackUrl(options));
  const host = page.locator(
    '.nam-rack-design-port.nam-native-design-surface[data-design-section="cab"]',
  );
  await expect(host).toBeVisible({ timeout: 15_000 });
  await expect(host.locator('[data-qa="nam-cab-source-selector"]')).toBeVisible();
  return host;
}

async function readRackState(page: Page) {
  return page.evaluate(async (address) => {
    const moduleUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ moduleUrl);
    return nativeBridge.getBuiltInPluginState(address);
  }, NAM_ADDRESS);
}

async function readCabPath(page: Page) {
  const state = await readRackState(page);
  return String(state.modelState?.cabIRPath ?? "");
}

async function pathForCard(card: ReturnType<Page["locator"]>) {
  const itemId = await card.getAttribute("data-library-item-id");
  expect(itemId).toMatch(/^installed-ir:/);
  return decodeURIComponent(String(itemId).slice("installed-ir:".length));
}

test("installed IR cards use one verified, single-flight load path and the faceplate can unload it", async ({ page }) => {
  const host = await openCabSection(page);
  const cards = host.locator('.premium-rig-card[data-library-item-id^="installed-ir:"][aria-pressed="false"]');
  await expect(cards).toHaveCount(4);
  const firstCard = cards.nth(0);
  const secondCard = cards.nth(1);
  const selectedPath = await pathForCard(firstCard);

  await page.evaluate(async () => {
    const moduleUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ moduleUrl);
    const original = nativeBridge.setBuiltInPluginState.bind(nativeBridge);
    const testWindow = window as typeof window & {
      __namCabMutationCalls?: number;
      __namCabMutationPatches?: unknown[];
    };
    testWindow.__namCabMutationCalls = 0;
    testWindow.__namCabMutationPatches = [];
    nativeBridge.setBuiltInPluginState = async (address, patch) => {
      if (patch.modelState?.cabIRPath) {
        testWindow.__namCabMutationCalls = (testWindow.__namCabMutationCalls ?? 0) + 1;
        testWindow.__namCabMutationPatches?.push(patch);
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      }
      return original(address, patch);
    };
  });

  await firstCard.click();
  await expect(secondCard).toBeDisabled();
  await secondCard.evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __namCabMutationCalls?: number }).__namCabMutationCalls
  ))).toBe(1);
  await expect.poll(() => readCabPath(page)).toBe(selectedPath);
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __namCabMutationPatches?: Array<{
      values?: Record<string, number>;
      modelState?: Record<string, unknown>;
    }> }).__namCabMutationPatches?.[0]
  ))).toMatchObject({
    modelState: { cabIRPath: selectedPath, cabRequestedEnabled: true },
  });

  const unload = host.locator('[data-qa="nam-cab-ir-unload"]');
  await expect(unload).toBeVisible();
  await expect(unload).toHaveAccessibleName(/unload cabinet ir/i);
  await unload.click();
  await expect.poll(() => readCabPath(page)).toBe("");
  await expect(host.locator('[data-qa="nam-cab-source-selector"]')).toHaveAttribute(
    "data-cab-mode",
    "required",
  );
});

test("temporary audition blocks cabinet replacement and unload", async ({ page }) => {
  const host = await openCabSection(page);
  const baselinePath = await readCabPath(page);
  await page.evaluate(async (address) => {
    const moduleUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ moduleUrl);
    await nativeBridge.setBuiltInPluginState(address, {
      uiState: {
        namActivePreview: {
          schemaVersion: 2,
          slot: "amp",
          title: "Temporary audition",
          localPath: "OpenStudio/NAM/previews/temporary-audition.nam",
          saved: false,
          action: "live-preview",
        },
      },
    });
  }, NAM_ADDRESS);

  // A discrete enum commit performs the rack's authoritative schema readback.
  // This mirrors the same refresh that follows source-flow preview operations.
  await host.locator('[data-qa="nam-instrument-profile"]').click();
  await page.waitForTimeout(250);

  await host.locator('[data-qa="nam-cab-ir-unload"]').click();
  await expect.poll(() => readCabPath(page)).toBe(baselinePath);
  await expect(page.locator('[data-qa="nam-preset-status"]')).toContainText(
    /unavailable while a temporary Capture audition is active/i,
  );

  const replacementCard = host.locator(
    '.premium-rig-card[data-library-item-id^="installed-ir:"][aria-pressed="false"]',
  ).first();
  await replacementCard.click();
  await expect.poll(() => readCabPath(page)).toBe(baselinePath);
});

test("Bass can mount every downloaded IR sequentially and recover from a failed load", async ({ page }) => {
  const host = await openCabSection(page);
  await host.locator('[data-qa="nam-instrument-profile"]').click();
  await expect.poll(async () => (await readRackState(page)).values?.instrumentProfile).toBe(1);
  const cards = host.locator('.premium-rig-card[data-library-item-id^="installed-ir:"]');
  expect(await cards.count()).toBeGreaterThan(1);
  const ids = await cards.evaluateAll(elements => elements.map(element => element.getAttribute("data-library-item-id")));
  for (const id of ids) {
    const card = host.locator(`[data-library-item-id=${JSON.stringify(id)}]`);
    const path = await pathForCard(card);
    await expect(card).toBeEnabled();
    await card.click();
    await expect.poll(() => readCabPath(page)).toBe(path);
    await expect.poll(async () => (await readRackState(page)).modelState?.hasCabIR).toBe(true);
    await expect(card).toHaveAttribute("aria-pressed", "true");
  }
  const previous = await readCabPath(page);
  await page.evaluate(async () => {
    const url = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ url);
    const original = nativeBridge.setBuiltInPluginState.bind(nativeBridge);
    let failNext = true;
    nativeBridge.setBuiltInPluginState = async (address, patch) => {
      if (patch.modelState?.cabIRPath && failNext) { failNext = false; return false; }
      return original(address, patch);
    };
  });
  const replacementId = await host.locator('.premium-rig-card[data-library-item-id^="installed-ir:"][aria-pressed="false"]').first().getAttribute("data-library-item-id");
  const replacement = host.locator(`[data-library-item-id=${JSON.stringify(replacementId)}]`);
  await replacement.click();
  await expect(page.locator('[data-qa="nam-preset-status"]')).toContainText(/failed|could not|not apply/i);
  expect(await readCabPath(page)).toBe(previous);
  await expect(replacement).toBeEnabled();
  await replacement.click();
  await expect.poll(() => readCabPath(page)).toBe(await pathForCard(replacement));
});

test("full-rig cabinet keeps the retained IR understandable and manageable", async ({ page }) => {
  const host = await openCabSection(page, { fullRig: true });
  const selector = host.locator('[data-qa="nam-cab-source-selector"]');
  await expect(selector).toHaveAttribute("data-cab-mode", "embedded");
  await expect(selector).toContainText("CAB INCLUDED / IR BYPASSED");
  await expect(host.locator('[data-qa="nam-retained-ir-note"]')).toContainText(
    /External IRs stay bypassed here/i,
  );

  const card = host.locator(
    '.premium-rig-card[data-library-item-id^="installed-ir:"][aria-pressed="false"]',
  ).first();
  const retainedPath = await pathForCard(card);
  await card.click();
  await expect.poll(() => readCabPath(page)).toBe(retainedPath);
  await expect.poll(async () => (await readRackState(page)).values?.cabEnabled).toBe(0);
  await expect(selector).toHaveAttribute("data-cab-mode", "embedded");

  await host.locator('[data-qa="nam-cab-ir-unload"]').click();
  await expect.poll(() => readCabPath(page)).toBe("");
  await expect.poll(async () => (await readRackState(page)).modelState?.ampIncludesCab).toBe(true);
  await expect(selector).toContainText("CABINET INCLUDED");
});

test("the source drawer becomes a keyboard-accessible slide-over on narrow racks", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 760 });
  const host = await openCabSection(page);
  const toggle = host.locator('[data-qa="nam-rig-drawer-toggle"]');
  const drawer = host.locator(".premium-rig-drawer");

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).not.toBeVisible();

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName(/Close cabinet IR drawer/i);
  await expect(drawer).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).not.toBeVisible();
});

test("instrument profile migrates only the paired Gate default and leaves Graphic EQ filters explicit", async ({ page }) => {
  const host = await openCabSection(page);
  const profile = host.locator('[data-qa="nam-instrument-profile"]');
  const phase = host.locator('[data-param-id="cabPhaseInvert"][role]').first();

  await page.evaluate(async (address) => {
    const moduleUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ moduleUrl);
    await nativeBridge.setBuiltInPluginState(address, {
      values: { gateThresholdDb: -80, eqHPFHz: 80 },
    });
  }, NAM_ADDRESS);
  // Refresh the React schema through a normal discrete control readback.
  await phase.click();
  await page.waitForTimeout(200);

  const initialPath = await readCabPath(page);
  const initialReference = (await readRackState(page)).values?.calibrationReferenceDbu;
  await profile.click();
  await expect.poll(async () => {
    const values = (await readRackState(page)).values;
    return [values?.instrumentProfile, values?.gateThresholdDb, Math.round(values?.eqHPFHz ?? 0)];
  }).toEqual([1, -65, 80]);
  const direct = host.locator('[data-param-id="cabDirectMix"][role="slider"]').first();
  await expect(direct).toBeVisible();
  await direct.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await readRackState(page)).values?.cabDirectMix ?? 0)
    .toBeGreaterThan(0);
  await expect.poll(() => readCabPath(page)).toBe(initialPath);
  await expect.poll(async () => (await readRackState(page)).values?.calibrationReferenceDbu)
    .toBe(initialReference);

  await profile.click();
  await expect.poll(async () => {
    const values = (await readRackState(page)).values;
    return [values?.instrumentProfile, values?.gateThresholdDb, Math.round(values?.eqHPFHz ?? 0)];
  }).toEqual([0, -80, 80]);

  await page.evaluate(async (address) => {
    const moduleUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ moduleUrl);
    await nativeBridge.setBuiltInPluginState(address, {
      values: { gateThresholdDb: -70, eqHPFHz: 55 },
    });
  }, NAM_ADDRESS);
  await phase.click();
  await page.waitForTimeout(200);
  await profile.click();
  await expect.poll(async () => {
    const values = (await readRackState(page)).values;
    return [values?.instrumentProfile, values?.gateThresholdDb, values?.eqHPFHz];
  }).toEqual([1, -70, 55]);
});

test("Room ambience stays independent from the stereo IR toggle", async ({ page }) => {
  const host = await openCabSection(page);
  const roomBay = host.locator('[data-qa="nam-cab-room-bay"]');
  const roomPower = roomBay.locator('[data-param-id="cabRoomEnabled"]');
  const roomAmount = roomBay.locator('[data-param-id="cabRoomAmount"][role="slider"]');
  const roomWidth = roomBay.locator('[data-param-id="cabRoomWidth"][role="slider"]');
  const stereoIR = host.locator('[data-param-id="cabIRStereo"][role]').first();

  await expect(roomBay).toBeVisible();
  await expect(roomPower).toBeEnabled();
  await expect(roomAmount).toBeVisible();
  await expect(roomWidth).toBeVisible();
  await expect(stereoIR).toBeVisible();

  const before = (await readRackState(page)).values ?? {};
  await stereoIR.click();
  await expect.poll(async () => (await readRackState(page)).values?.cabIRStereo)
    .not.toBe(before.cabIRStereo);
  await expect.poll(async () => (await readRackState(page)).values?.cabRoomEnabled)
    .toBe(before.cabRoomEnabled);

  const stereoAfterToggle = (await readRackState(page)).values?.cabIRStereo;
  await roomPower.click();
  await expect.poll(async () => (await readRackState(page)).values?.cabRoomEnabled)
    .not.toBe(before.cabRoomEnabled);
  await expect.poll(async () => (await readRackState(page)).values?.cabIRStereo)
    .toBe(stereoAfterToggle);

  const amountBefore = Number((await readRackState(page)).values?.cabRoomAmount ?? 0);
  await roomAmount.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => Number((await readRackState(page)).values?.cabRoomAmount ?? 0))
    .toBeGreaterThan(amountBefore);
});
