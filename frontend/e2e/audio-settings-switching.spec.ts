import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({ schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 15000 });
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/services/NativeBridge.ts");
    const { useDAWStore } = await import("/src/store/useDAWStore.ts");
    const setup = (type: string) => ({
      current: { audioDeviceType: type, inputDevice: type === "Initial" ? "Audient" : `${type} Input`, outputDevice: type === "Initial" ? "Audient" : `${type} Output`, sampleRate: 48000, bufferSize: 256, inputChannelNames: ["Input 1", "Input 2"], outputChannelNames: ["Out 1", "Out 2"], numInputChannels: 2, numOutputChannels: 2 },
      availableTypes: ["Initial", "ALSA", "JACK"], inputs: [type === "Initial" ? "Audient" : `${type} Input`], outputs: [type === "Initial" ? "Audient" : `${type} Output`], sampleRates: [48000], bufferSizes: [256, 512],
    });
    let applied = setup("Initial");
    const queries: unknown[] = [], applies: unknown[] = [];
    Object.assign(window, { audioSetupQueries: queries, audioSetupApplies: applies });
    nativeBridge.getAudioDeviceSetup = async () => applied;
    nativeBridge.queryAudioDeviceSetup = async draft => {
      queries.push(draft);
      return setup(draft.audioDeviceType);
    };
    nativeBridge.applyAudioDeviceSetup = async draft => {
      applies.push(draft);
      if (draft.audioDeviceType === "JACK") return { success: false, error: "JACK has no available audio ports. Select ALSA.", setup: applied };
      applied = setup(draft.audioDeviceType);
      return { success: true, setup: applied };
    };
    useDAWStore.setState({ showSettings: true });
  });
});

test("audio-system discovery resolves defaults without changing the live device", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const audioSystem = dialog.getByLabel("Audio System", { exact: true });
  await expect(audioSystem).toHaveValue("Initial");
  await audioSystem.selectOption("ALSA");
  await expect(dialog.getByLabel("Input Device", { exact: true })).toHaveValue("ALSA Input");
  await expect(dialog.getByLabel("Output Device", { exact: true })).toHaveValue("ALSA Output");
  const requests = await page.evaluate(() => ({
    queries: (window as any).audioSetupQueries,
    applies: (window as any).audioSetupApplies,
  }));
  expect(requests.queries).toEqual([{ audioDeviceType: "ALSA", inputDevice: "Audient", outputDevice: "Audient", sampleRate: 0, bufferSize: 0 }]);
  expect(requests.applies).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(async () => (await import("/src/services/NativeBridge.ts")).nativeBridge.getAudioDeviceSetup())).toMatchObject({ current: { audioDeviceType: "Initial" } });
});

test("failed Apply publishes recovery while keeping the pending draft for correction", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Audio Settings", exact: true });
  const audioSystem = dialog.getByLabel("Audio System", { exact: true });
  await expect(audioSystem).toHaveValue("Initial");
  await audioSystem.selectOption("JACK");
  await expect(dialog.getByLabel("Input Device", { exact: true })).toHaveValue("JACK Input");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByText("JACK has no available audio ports. Select ALSA.")).toBeVisible();
  await expect(audioSystem).toHaveValue("JACK");
  expect(await page.evaluate(async () => (await import("/src/services/NativeBridge.ts")).nativeBridge.getAudioDeviceSetup())).toMatchObject({ current: { audioDeviceType: "Initial" } });
  await audioSystem.selectOption("ALSA");
  await expect(dialog.getByLabel("Input Device", { exact: true })).toHaveValue("ALSA Input");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(async () => (await import("/src/services/NativeBridge.ts")).nativeBridge.getAudioDeviceSetup())).toMatchObject({ current: { audioDeviceType: "ALSA" } });
  expect(await page.evaluate(() => (window as any).audioSetupApplies)).toEqual([
    { audioDeviceType: "JACK", inputDevice: "JACK Input", outputDevice: "JACK Output", sampleRate: 48000, bufferSize: 256 },
    { audioDeviceType: "ALSA", inputDevice: "ALSA Input", outputDevice: "ALSA Output", sampleRate: 48000, bufferSize: 256 },
  ]);
});
