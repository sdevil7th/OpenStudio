import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("openstudio_essentialControlsDismissed", "true"));
  await page.goto("/?platform=windows&windowChrome=native");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 20000 });
});

test("native menus never initiate window drag", async ({ page }) => {
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/services/NativeBridge.ts");
    (window as any).__windowCalls = 0;
    nativeBridge.startWindowDrag = async () => { (window as any).__windowCalls++; };
  });
  await expect(page.getByTestId("window-drag-region")).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Options menu" }).click();
  await page.getByRole("menuitem", { name: "Preferences..." }).click();
  await expect(page.getByRole("dialog", { name: /Preferences/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__windowCalls)).toBe(0);
});

test("device changes resolve small buffers before Apply", async ({ page }) => {
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/services/NativeBridge.ts");
    const setup = (name: string, sampleRate: number, bufferSize: number) => ({
      current: { audioDeviceType: "ASIO", inputDevice: name, outputDevice: name, sampleRate, bufferSize },
      availableTypes: ["ASIO"], inputs: ["Old", "Audient"], outputs: ["Old", "Audient"],
      sampleRates: [44100, 48000, 96000], bufferSizes: name === "Audient" ? [8, 16, 32, 64] : [128, 256, 512],
    });
    nativeBridge.getAudioDeviceSetup = async () => setup("Old", 44100, 256);
    nativeBridge.queryAudioDeviceSetup = async (draft) => setup(draft.outputDevice, 48000, 16);
    (window as any).__applies = 0;
    nativeBridge.applyAudioDeviceSetup = async () => { (window as any).__applies++; return { success: true, setup: setup("Audient", 48000, 16) }; };
  });
  await page.getByRole("button", { name: "Audio Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  await dialog.getByLabel("ASIO Driver", { exact: true }).selectOption("Audient");
  await expect(dialog.getByLabel("Sample Rate", { exact: true })).toHaveValue("48000");
  await expect(dialog.getByLabel("Buffer Size", { exact: true })).toHaveValue("16");
  await expect(dialog.getByLabel("Buffer Size", { exact: true }).locator("option")).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).__applies)).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Audio Settings: 44.1 kHz · 256 spl", exact: true })).toBeVisible();
});

test("audio import creates a track and undo removes it", async ({ page }) => {
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/services/NativeBridge.ts");
    const { useDAWStore } = await import("/src/store/useDAWStore.ts");
    useDAWStore.setState({ tracks: [], selectedTrackIds: [], selectedTrackId: null });
    nativeBridge.showImportFilesDialog = async (_title, filter) => { (window as any).__importFilter = filter; return ["C:/voice.wav"]; };
    nativeBridge.probeMediaFile = async () => ({ filePath: "C:/voice.wav", duration: 2, sampleRate: 48000, numChannels: 1 });
    nativeBridge.addPlaybackClip = async () => true;
  });
  await page.getByRole("menuitem", { name: "File menu" }).click();
  await page.getByRole("menuitem", { name: "Import", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Audio..." }).click();
  await expect.poll(async () => page.evaluate(async () => (await import("/src/store/useDAWStore.ts")).useDAWStore.getState().tracks.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__importFilter)).toContain("*.wav");
  await page.evaluate(async () => (await import("/src/store/useDAWStore.ts")).useDAWStore.getState().undo());
  expect(await page.evaluate(async () => (await import("/src/store/useDAWStore.ts")).useDAWStore.getState().tracks.length)).toBe(0);
});


test("practice countdown continues with dialog closed and supports pause/reset", async ({ page }) => {
  await page.getByRole("button", { name: "Metronome Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Metronome Settings", exact: true });
  await dialog.getByRole("button", { name: "Practice timer", exact: true }).click();
  await dialog.getByLabel("Practice duration in seconds").fill("3");
  await dialog.getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Pause timer", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Pause timer", exact: true }).click();
  await expect(dialog.locator("output")).toContainText("paused");
  await dialog.getByRole("button", { name: "Resume timer", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Practice timer finished", exact: true })).toBeVisible({ timeout: 7000 });
  await page.getByRole("button", { name: "Practice timer finished", exact: true }).click();
  await dialog.getByRole("button", { name: "Reset timer", exact: true }).click();
  await expect(dialog.locator("output")).toContainText("0:03");
  await expect(dialog.locator("output")).toContainText("idle");
  await dialog.getByLabel("Practice timer mode").selectOption("stopwatch");
  await expect(dialog.getByLabel("Practice duration in seconds")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(dialog.locator("output")).toContainText("running");
  await dialog.getByRole("button", { name: "Reset timer", exact: true }).click();
});


test("compact audio status and practice controls fit a small desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  const settings = page.getByRole("button", { name: "Audio Settings", exact: true });
  const status = page.getByRole("button", { name: /^Audio Settings:/ });
  await expect(status).toBeVisible();
  const gearBox = await settings.boundingBox();
  const statusBox = await status.boundingBox();
  expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(gearBox!.y);
  const menuBox = await page.getByRole("menubar", { name: "Main menu" }).boundingBox();
  expect(statusBox!.y).toBeLessThan(menuBox!.y + menuBox!.height);
  expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(1000);
  await page.screenshot({ path: "../output/playwright/workstation-native-layout.png" });
  await page.getByRole("button", { name: "Metronome Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Metronome Settings", exact: true });
  await expect(dialog.getByRole("button", { name: "Practice timer", exact: true })).toHaveAttribute("aria-expanded", "false");
  await dialog.getByRole("button", { name: "Practice timer", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Start timer", exact: true })).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1000);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  await page.screenshot({ path: "../output/playwright/workstation-practice-layout.png" });
});


test("Solo Safe gesture changes only safety and survives undo/redo", async ({ page }) => {
  await page.evaluate(async () => {
    const { useDAWStore, createDefaultTrack } = await import("/src/store/useDAWStore.ts");
    useDAWStore.setState({ tracks: [createDefaultTrack("reference", "Reference", "#5566aa", "audio")] });
  });
  const solo = page.getByRole("button", { name: "Solo track", exact: true });
  await solo.click({ button: "right" });
  await expect(solo).toHaveAttribute("title", "Solo Safe enabled; right-click to disable");
  const state = () => page.evaluate(async () => {
    const track = (await import("/src/store/useDAWStore.ts")).useDAWStore.getState().tracks[0];
    return { safe: !!track.soloSafe, solo: track.soloed, mute: track.muted };
  });
  expect(await state()).toEqual({ safe: true, solo: false, mute: false });
  await page.evaluate(async () => (await import("/src/store/useDAWStore.ts")).useDAWStore.getState().undo());
  expect((await state()).safe).toBe(false);
  await page.evaluate(async () => (await import("/src/store/useDAWStore.ts")).useDAWStore.getState().redo());
  expect((await state()).safe).toBe(true);
});
