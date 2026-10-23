import { expect, test, type Page } from "@playwright/test";
import type { AudioDeviceDraft, AudioDeviceSetupResponse } from "../src/services/NativeBridge";
import type { useDAWStore } from "../src/store/useDAWStore";

interface AudioSettingsQa {
  applied: AudioDeviceSetupResponse;
  queries: AudioDeviceDraft[];
  applies: AudioDeviceDraft[];
  queryFailuresRemaining: number;
  rejectApply: boolean;
  rejectPanelRestart: boolean;
  coerceAppliedBuffer?: number;
  store: typeof useDAWStore;
}
declare global { interface Window { audioSettingsQa: AudioSettingsQa } }


test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({ schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 15000 });

});

async function openSettingsFixture(page: Page, kind: "systems" | "systems-output-only" | "asio" | "asio-output-only" | "asio-input-only") {
  await page.evaluate(async kind => {
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const storeUrl = "/src/store/useDAWStore.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const asioDrivers = ["Audient ASIO", "Other ASIO"];
    const setup = (type: string, selectedDriver = "Audient ASIO"): AudioDeviceSetupResponse => {
      const asio = type === "ASIO";
      const driver = asioDrivers.includes(selectedDriver) ? selectedDriver : asioDrivers[0];
      const inputDevice = asio ? driver : type === "Initial" ? "Audient" : `${type} Input`;
      const outputDevice = asio ? driver : type === "Initial" ? "Audient" : `${type} Output`;
      return {
        current: { audioDeviceType: type, inputDevice, outputDevice, sampleRate: 48000, bufferSize: asio ? 8 : 256,
          inputChannelNames: ["Input 1", "Input 2"], outputChannelNames: ["Out 1", "Out 2"], numInputChannels: 2, numOutputChannels: 2 },
        availableTypes: asio ? ["ASIO"] : ["Initial", "ALSA", "JACK"],
        inputs: asio ? asioDrivers : [inputDevice], outputs: asio ? asioDrivers : [outputDevice],
        sampleRates: [48000], bufferSizes: asio ? [8, 16, 32] : [256, 512],
      };
    };
    const qa: AudioSettingsQa = window.audioSettingsQa = {
      applied: setup(kind.startsWith("systems") ? "Initial" : "ASIO", kind === "asio-input-only" ? "Other ASIO" : undefined), queries: [], applies: [],
      queryFailuresRemaining: 0, rejectApply: false, rejectPanelRestart: false, store: useDAWStore,
    };
    if (kind === "asio-output-only") qa.applied.current.inputDevice = "";
    if (kind === "asio-input-only") qa.applied.current.outputDevice = "";
    if (kind === "systems-output-only") {
      qa.applied.current.inputDevice = "";
      qa.applied.current.bufferSize = 8;
      qa.applied.bufferSizes = [8, 16, 32];
    }
    const resolve = (draft: AudioDeviceDraft) => {
      const resolved = setup(draft.audioDeviceType, draft.outputDevice || draft.inputDevice);
      if (draft.audioDeviceType === qa.applied.current.audioDeviceType) {
        resolved.current.inputDevice = draft.inputDevice;
        resolved.current.outputDevice = draft.outputDevice;
      }
      if (kind === "systems-output-only") resolved.bufferSizes = [8, 16, 32];
      if (resolved.sampleRates?.includes(draft.sampleRate)) resolved.current.sampleRate = draft.sampleRate;
      if (resolved.bufferSizes?.includes(draft.bufferSize)) resolved.current.bufferSize = draft.bufferSize;
      return resolved;
    };
    nativeBridge.getAudioDeviceSetup = async () => qa.applied;
    nativeBridge.queryAudioDeviceSetup = async draft => {
      qa.queries.push({ ...draft });
      if (qa.queryFailuresRemaining > 0) {
        --qa.queryFailuresRemaining;
        return { ...qa.applied, sampleRates: [], bufferSizes: [], capabilityStatus: "unavailable", error: "Cannot inspect the running ASIO driver." };
      }
      return resolve(draft);
    };
    nativeBridge.applyAudioDeviceSetup = async draft => {
      qa.applies.push({ ...draft });
      if (qa.rejectApply) return { success: false, error: "ASIO rejected the requested buffer size.", setup: qa.applied };
      if (draft.audioDeviceType === "JACK") return { success: false, error: "JACK has no available audio ports. Select ALSA.", setup: qa.applied };
      qa.applied = resolve(draft);
      if (qa.coerceAppliedBuffer) qa.applied.current.bufferSize = qa.coerceAppliedBuffer;
      return { success: true, setup: qa.applied };
    };
    nativeBridge.openAudioDeviceControlPanel = async () => {
      if (qa.rejectPanelRestart) {
        qa.applied = {
          ...qa.applied, sampleRates: [], bufferSizes: [],
          current: { ...qa.applied.current, inputDevice: "", outputDevice: "", sampleRate: 0, bufferSize: 0,
            inputChannelNames: [], outputChannelNames: [], numInputChannels: 0, numOutputChannels: 0,
            numActiveInputChannels: 0, numActiveOutputChannels: 0 },
        };
        return { success: false, opened: true, restartRequested: true,
          error: "The audio device did not reopen after its control panel closed." };
      }
      return { success: true, opened: true, restartRequested: false };
    };
    useDAWStore.setState({ showSettings: true });
  }, kind);
}

test("audio-system discovery resolves defaults without changing the live device", async ({ page }) => {
  await openSettingsFixture(page, "systems");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const audioSystem = dialog.getByLabel("Audio System", { exact: true });
  await expect(audioSystem).toHaveValue("Initial");
  await audioSystem.selectOption("ALSA");
  await expect(dialog.getByLabel("Input Device", { exact: true })).toHaveValue("ALSA Input");
  await expect(dialog.getByLabel("Output Device", { exact: true })).toHaveValue("ALSA Output");
  const requests = await page.evaluate(() => ({
    queries: window.audioSettingsQa.queries,
    applies: window.audioSettingsQa.applies,
  }));
  expect(requests.queries).toEqual([{ audioDeviceType: "ALSA", inputDevice: "Audient", outputDevice: "Audient", sampleRate: 0, bufferSize: 0 }]);
  expect(requests.applies).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.audioSettingsQa.applied)).toMatchObject({ current: { audioDeviceType: "Initial" } });
});

test("failed Apply publishes recovery while keeping the pending draft for correction", async ({ page }) => {
  await openSettingsFixture(page, "systems");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const audioSystem = dialog.getByLabel("Audio System", { exact: true });
  await expect(audioSystem).toHaveValue("Initial");
  await audioSystem.selectOption("JACK");
  await expect(dialog.getByLabel("Input Device", { exact: true })).toHaveValue("JACK Input");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByText("JACK has no available audio ports. Select ALSA.")).toBeVisible();
  await expect(audioSystem).toHaveValue("JACK");
  expect(await page.evaluate(() => window.audioSettingsQa.applied)).toMatchObject({ current: { audioDeviceType: "Initial" } });
  await audioSystem.selectOption("ALSA");
  await expect(dialog.getByLabel("Input Device", { exact: true })).toHaveValue("ALSA Input");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.audioSettingsQa.applied)).toMatchObject({ current: { audioDeviceType: "ALSA" } });
  expect(await page.evaluate(() => window.audioSettingsQa.applies)).toEqual([
    { audioDeviceType: "JACK", inputDevice: "JACK Input", outputDevice: "JACK Output", sampleRate: 48000, bufferSize: 256 },
    { audioDeviceType: "ALSA", inputDevice: "ALSA Input", outputDevice: "ALSA Output", sampleRate: 48000, bufferSize: 256 },
  ]);
});

test("ASIO buffer selection keeps 16 pending and sends 16 to Apply while the active device stays at 8", async ({ page }) => {
  await openSettingsFixture(page, "asio");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const buffer = dialog.getByLabel("Buffer Size", { exact: true });
  await expect(buffer).toHaveValue("8");
  await buffer.selectOption("16");
  await expect(buffer).toHaveValue("16");
  expect(await page.evaluate(() => ({ queries: window.audioSettingsQa.queries, applied: window.audioSettingsQa.applied.current.bufferSize, applies: window.audioSettingsQa.applies })))
    .toEqual({ queries: [{ audioDeviceType: "ASIO", inputDevice: "Audient ASIO", outputDevice: "Audient ASIO", sampleRate: 48000, bufferSize: 16 }], applied: 8, applies: [] });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(buffer).toHaveValue("16");
  await expect.poll(() => page.evaluate(() => window.audioSettingsQa.applied.current.bufferSize)).toBe(16);
  expect(await page.evaluate(() => window.audioSettingsQa.applies.map(draft => draft.bufferSize))).toEqual([16]);
});

test("ASIO successful coercion keeps OK open and reports requested versus accepted buffer", async ({ page }) => {
  await openSettingsFixture(page, "asio");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const buffer = dialog.getByLabel("Buffer Size", { exact: true });
  await buffer.selectOption("16");
  await expect(buffer).toHaveValue("16");
  await page.evaluate(() => { window.audioSettingsQa.coerceAppliedBuffer = 8; });
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status").filter({ hasText: "Requested 16 samples; the driver accepted 8 samples." })).toBeVisible();
  await expect(buffer).toHaveValue("8");
  expect(await page.evaluate(() => window.audioSettingsQa.applies.map(draft => draft.bufferSize))).toEqual([16]);
  await dialog.getByLabel("ASIO Driver", { exact: true }).selectOption("Other ASIO");
  await expect(dialog.getByLabel("ASIO Driver", { exact: true })).toHaveValue("Other ASIO");
  await expect(dialog.getByRole("status").filter({ hasText: "Requested 16 samples; the driver accepted 8 samples." })).toBeHidden();
  await expect(dialog.getByRole("status").filter({ hasText: "Changes are pending" })).toBeVisible();
  expect(await page.evaluate(() => window.audioSettingsQa.applied.current.outputDevice)).toBe("Audient ASIO");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("failed ASIO discovery preserves pending 16, blocks Apply and supports Retry and correction", async ({ page }) => {
  await openSettingsFixture(page, "asio");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const buffer = dialog.getByLabel("Buffer Size", { exact: true });
  await expect(buffer).toHaveValue("8");
  await page.evaluate(() => { window.audioSettingsQa.queryFailuresRemaining = 1; });
  await buffer.selectOption("16");
  await expect(dialog.getByText("Cannot inspect the running ASIO driver.", { exact: false })).toBeVisible();
  await expect(buffer).toHaveValue("16");
  await expect(buffer.locator('option[value="16"]')).toHaveText("16 samples (pending)");
  await expect(buffer.locator('option[value="16"]')).toBeDisabled();
  await expect(buffer.locator('option[value="8"]')).toHaveCount(0);
  await expect(dialog.getByLabel("Sample Rate", { exact: true })).toHaveValue("48000");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.audioSettingsQa.applied.current.bufferSize)).toBe(8);
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByText("Cannot inspect the running ASIO driver.", { exact: false })).toBeHidden();
  await expect(buffer).toHaveValue("16");
  await expect(buffer.locator('option[value="16"]')).toBeEnabled();
  expect(await page.evaluate(() => window.audioSettingsQa.queries.map(draft => draft.bufferSize))).toEqual([16, 16]);
  await buffer.selectOption("32");
  await expect(buffer).toHaveValue("32");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioSettingsQa.applied.current.bufferSize)).toBe(32);
  expect(await page.evaluate(() => window.audioSettingsQa.applies.map(draft => draft.bufferSize))).toEqual([32]);
});

test("failed ASIO Apply retains pending 16 and reports actual 8 before a successful retry", async ({ page }) => {
  await openSettingsFixture(page, "asio");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const buffer = dialog.getByLabel("Buffer Size", { exact: true });
  await expect(buffer).toHaveValue("8");
  await buffer.selectOption("16");
  await expect(buffer).toHaveValue("16");
  await page.evaluate(() => { window.audioSettingsQa.rejectApply = true; });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByText("ASIO rejected the requested buffer size.", { exact: false })).toBeVisible();
  await expect(buffer).toHaveValue("16");
  expect(await page.evaluate(() => ({ active: window.audioSettingsQa.applied.current.bufferSize, published: window.audioSettingsQa.store.getState().audioDeviceSetup?.bufferSize })))
    .toEqual({ active: 8, published: 8 });
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await page.evaluate(() => { window.audioSettingsQa.rejectApply = false; });
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioSettingsQa.applied.current.bufferSize)).toBe(16);
  expect(await page.evaluate(() => window.audioSettingsQa.applies.map(draft => draft.bufferSize))).toEqual([16, 16]);
});

for (const direction of ["output-only", "input-only"] as const) {
  test(`ASIO ${direction} scalar edits preserve the disabled side and show the active driver`, async ({ page }) => {
    await openSettingsFixture(page, `asio-${direction}`);
    const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
    const driver = dialog.getByLabel("ASIO Driver", { exact: true });
    const selectedDriver = direction === "input-only" ? "Other ASIO" : "Audient ASIO";
    const names = {
      inputDevice: direction === "input-only" ? selectedDriver : "",
      outputDevice: direction === "output-only" ? selectedDriver : "",
    };
    await expect(driver).toHaveValue(selectedDriver);
    const buffer = dialog.getByLabel("Buffer Size", { exact: true });
    await expect(buffer).toHaveValue("8");
    await buffer.selectOption("16");
    await expect(buffer).toHaveValue("16");
    expect(await page.evaluate(() => window.audioSettingsQa.queries))
      .toEqual([{ audioDeviceType: "ASIO", ...names, sampleRate: 48000, bufferSize: 16 }]);
    expect(await page.evaluate(() => window.audioSettingsQa.applied.current))
      .toMatchObject({ ...names, bufferSize: 8 });
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.audioSettingsQa.applied.current))
      .toMatchObject({ ...names, bufferSize: 16 });
    expect(await page.evaluate(() => window.audioSettingsQa.applies))
      .toEqual([{ audioDeviceType: "ASIO", ...names, sampleRate: 48000, bufferSize: 16 }]);

    const nextDriver = direction === "input-only" ? "Audient ASIO" : "Other ASIO";
    await driver.selectOption(nextDriver);
    await expect(driver).toHaveValue(nextDriver);
    expect(await page.evaluate(() => {
      const queries = window.audioSettingsQa.queries;
      return queries[queries.length - 1];
    }))
      .toEqual({ audioDeviceType: "ASIO", inputDevice: nextDriver, outputDevice: nextDriver, sampleRate: 0, bufferSize: 0 });
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.audioSettingsQa.applied.current))
      .toMatchObject({ inputDevice: nextDriver, outputDevice: nextDriver });
  });
}

test("separate output-only endpoints stay visibly disabled while changing buffer8 to16", async ({ page }) => {
  await openSettingsFixture(page, "systems-output-only");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const input = dialog.getByLabel("Input Device", { exact: true });
  const output = dialog.getByLabel("Output Device", { exact: true });
  await expect(input).toHaveValue("");
  await expect(input.locator('option:checked')).toHaveText("Disabled");
  await expect(output).toHaveValue("Audient");
  const buffer = dialog.getByLabel("Buffer Size", { exact: true });
  await expect(buffer).toHaveValue("8");
  await buffer.selectOption("16");
  await expect(buffer).toHaveValue("16");
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => window.audioSettingsQa.queries))
    .toEqual([{ audioDeviceType: "Initial", inputDevice: "", outputDevice: "Audient", sampleRate: 48000, bufferSize: 16 }]);
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioSettingsQa.applied.current))
    .toMatchObject({ inputDevice: "", outputDevice: "Audient", bufferSize: 16 });
  expect(await page.evaluate(() => window.audioSettingsQa.applies))
    .toEqual([{ audioDeviceType: "Initial", inputDevice: "", outputDevice: "Audient", sampleRate: 48000, bufferSize: 16 }]);
});

test("failed ASIO panel restart publishes no open device and supports selecting a recovery device", async ({ page }) => {
  await openSettingsFixture(page, "asio");
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const buffer = dialog.getByLabel("Buffer Size", { exact: true });
  await expect(buffer).toHaveValue("8");
  await page.evaluate(() => { window.audioSettingsQa.rejectPanelRestart = true; });
  await dialog.getByRole("button", { name: "Open ASIO Control Panel", exact: true }).click();
  await expect(dialog.getByText("The audio device did not reopen after its control panel closed.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No audio device is currently open. Select a device and choose Apply to restore audio.", { exact: true })).toBeVisible();
  await expect(buffer).toHaveValue("0");
  await expect(buffer.locator('option[value="8"]')).toHaveCount(0);
  await expect(dialog.getByLabel("Sample Rate", { exact: true })).toHaveValue("0");
  await expect(dialog.getByLabel("ASIO Driver", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.audioSettingsQa.store.getState().audioDeviceSetup))
    .toMatchObject({ inputDevice: "", outputDevice: "", sampleRate: 0, bufferSize: 0 });

  await dialog.getByLabel("ASIO Driver", { exact: true }).selectOption("Audient ASIO");
  await expect(buffer).toHaveValue("8");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioSettingsQa.store.getState().audioDeviceSetup))
    .toMatchObject({ inputDevice: "Audient ASIO", outputDevice: "Audient ASIO", sampleRate: 48000, bufferSize: 8 });
  await expect(dialog.getByText("No audio device is currently open. Select a device and choose Apply to restore audio.", { exact: true })).toBeHidden();
});
