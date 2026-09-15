import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({ schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 15000 });
  await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts", storeUrl = "/src/store/useDAWStore.ts";
    const reactUrl = "/node_modules/.vite/deps/react.js", domUrl = "/node_modules/.vite/deps/react-dom_client.js";
    const browserUrl = "/src/components/PluginBrowser.tsx";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const { default: React } = await import(/* @vite-ignore */ reactUrl);
    const { default: ReactDOM } = await import(/* @vite-ignore */ domUrl);
    const { PluginBrowser, invalidatePluginCatalogCache } = await import(/* @vite-ignore */ browserUrl);
    nativeBridge.getAvailablePlugins = async () => [{ name: "Test Gain", manufacturer: "Regression", category: "Fx",
      fileOrIdentifier: "C:/Test/Gain.vst3", identifier: "gain-id", isInstrument: false, pluginFormatName: "VST3",
      isolationAvailable: true, isolatedHosting: false, isolationLatencySamples: 1024, isolationLatencyMs: 21.33, hasARA: true }];
    nativeBridge.getAvailableJSFX = async () => [];
    const qa = { preference: [] as unknown[], added: [] as unknown[], closed: false };
    (window as any).__hostingQA = qa;
    nativeBridge.setIsolatedPluginHosting = async (...args: unknown[]) => {
      qa.preference = args;
      return new Promise<boolean>(resolve => { (window as any).__finishHosting = resolve; });
    };
    useDAWStore.setState({ addTrackFXWithUndo: async (...args: unknown[]) => { qa.added = args; return true; } });
    invalidatePluginCatalogCache();
    const host = document.createElement("div"); document.body.append(host);
    const root = ReactDOM.createRoot(host);
    root.render(React.createElement(PluginBrowser, { trackId: "test", targetChain: "track", trackType: "audio",
      onClose: () => { qa.closed = true; root.unmount(); } }));
  });
});

test("isolation is opt-in, saves before Add and explains latency and ARA limitations", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 640 });
  const checkbox = page.getByRole("checkbox", { name: "Isolate Test Gain" });
  await expect(checkbox).not.toBeChecked();
  await checkbox.click(); // Committed state changes only after durable native acknowledgement.
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__hostingQA.preference)).toEqual(["gain-id", true]);
  await page.evaluate(() => (window as any).__finishHosting(true));
  await expect(checkbox).toBeChecked();
  await expect(page.getByText(/Adds 1024 samples.*21.3 ms/)).toBeVisible();
  await expect(page.getByText(/ARA integration is unavailable/)).toBeVisible();
  const surface = page.getByText("Plugin Browser - TRACK FX").locator("../..");
  expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "../output/playwright/plugin-isolation-compact.png", animations: "disabled" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__hostingQA.added)).toEqual(["test", "gain-id", "track"]);
});

test("failed preference write keeps the previous mode and makes failure visible", async ({ page }) => {
  const checkbox = page.getByRole("checkbox", { name: "Isolate Test Gain" });
  await checkbox.click();
  await page.evaluate(() => (window as any).__finishHosting(false));
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByText(/hosting preference could not be saved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
});
