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
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const qa = { repaired: 0, imported: 0, dismissed: [] as string[] };
    (window as any).__workQA = qa;
    useDAWStore.setState({ tracks: [], isModified: false });
    nativeBridge.discoverProjectRecovery = async () => [];
    nativeBridge.workRecovery = async (action: string, id: string) => {
      if (action === "discover") return [{ id: "session/take", kind: "recording", status: "recording",
        path: "C:/Recorded Audio/Bass live input.wav", duration: 12.5, startTime: 5, droppedSamples: 512, ignoredTailBytes: 1 }];
      if (action === "repair") { qa.repaired++; return { repairedPath: "C:/Recovery/repair.wav" }; }
      if (action === "dismiss") { qa.dismissed.push(id); return true; }
      return false;
    };
    nativeBridge.importMediaFile = async () => { qa.imported++; return { filePath: "C:/Recovery/repair.wav", duration: 12.5, sampleRate: 48000, numChannels: 1, format: "wav" }; };
    nativeBridge.previewAudioFile = async () => true;
    nativeBridge.stopPreview = async () => true;
    window.dispatchEvent(new Event("openstudio:discover-recovery"));
  });
});

test("interrupted recording preview, one-step import and undo are reachable at compact geometry", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 640 });
  const dialog = page.getByRole("dialog", { name: "Recover an interrupted session" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/512.*known dropped samples/)).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await dialog.getByRole("button", { name: "Preview copy" }).click();
  await expect(dialog.getByRole("button", { name: "Stop preview" })).toBeVisible();
  await page.screenshot({ path: "../output/playwright/work-recovery-compact.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Import recovered audio" }).click();
  await expect(dialog).toBeHidden();
  const result = await page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    return { qa: (window as any).__workQA, tracks: useDAWStore.getState().tracks };
  });
  expect(result.qa).toEqual({ repaired: 1, imported: 1, dismissed: [] });
  expect(result.tracks).toHaveLength(1);
  expect(result.tracks[0].clips[0].startTime).toBe(5);
  await page.getByRole("toolbar", { name: "Main Toolbar" }).getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(() => page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    return useDAWStore.getState().tracks.length;
  })).toBe(0);
});

test("dismissing a previewed recovery item stops its audio before closing", async ({ page }) => {
  await page.evaluate(async () => {
    const url = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ url);
    (window as any).__previewStops = 0;
    nativeBridge.stopPreview = async () => { ++(window as any).__previewStops; return true; };
  });
  const dialog = page.getByRole("dialog", { name: "Recover an interrupted session" });
  await dialog.getByRole("button", { name: "Preview copy" }).click();
  await expect(dialog.getByRole("button", { name: "Stop preview" })).toBeVisible();
  await dialog.getByRole("button", { name: "Dismiss reminder" }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__previewStops)).toBe(1);
});

test("repair failures keep the reminder and original file visible", async ({ page }) => {
  await page.evaluate(async () => {
    const url = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ url);
    const actual = nativeBridge.workRecovery;
    nativeBridge.workRecovery = async (action: string, ...args: unknown[]) => action === "repair"
      ? { error: "Recovery disk is full; original retained" } : actual(action, ...args);
  });
  await page.getByRole("button", { name: "Import recovered audio" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Recovery disk is full" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__workQA.dismissed)).toEqual([]);
});

test("AI recovery restarts the saved request and completed audio resumes an undoable import", async ({ page }) => {
  await page.getByRole("button", { name: "Later" }).click();
  await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts", storeUrl = "/src/store/useDAWStore.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { useDAWStore, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl);
    const track = createDefaultTrack("ai", "Recovered AI request", "#60a5fa", "ai");
    useDAWStore.setState({ tracks: [track] });
    nativeBridge.workRecovery = async (action: string) => action === "discover"
      ? [{ id: "session/ai", kind: "ai", status: "queued", projectId: useDAWStore.getState().projectPersistentId,
        trackId: "ai", modelId: "stable-audio-3-medium", workflowId: "text-to-audio", params: { seed: 123, prompt: "Bass" } }]
      : action === "createAI" ? "new/ai" : true;
    nativeBridge.startAIGeneration = async (...args: unknown[]) => {
      (window as any).__restartedAI = args;
      return { started: true, requestId: "restarted" };
    };
    nativeBridge.getAIGenerationProgress = async () => ({ state: "done", progress: 1, requestId: "restarted", outputFile: "C:/AI/result.wav" });
    window.dispatchEvent(new Event("openstudio:discover-recovery"));
  });
  await page.getByRole("button", { name: "Restart generation" }).click();
  expect(await page.evaluate(() => (window as any).__restartedAI[3])).toMatchObject({ seed: 123, _openStudioRecoveryId: "new/ai" });
  await expect.poll(() => page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    return useDAWStore.getState().tracks[0].clips.map(clip => clip.recoveryJobId);
  })).toEqual(["new/ai"]);
  await page.getByRole("toolbar", { name: "Main Toolbar" }).getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(() => page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    return useDAWStore.getState().tracks[0].clips.length;
  })).toBe(0);
});

test("batch converter uses the folder picker, locks in-flight controls and preserves existing filenames", async ({ page }) => {
  await page.getByRole("button", { name: "Later" }).click();
  await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts", storeUrl = "/src/store/useDAWStore.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    nativeBridge.showOpenDialog = async () => "C:/Input/bass.wav";
    nativeBridge.browseForFolder = async () => "C:/Output";
    nativeBridge.fileExists = async (path: string) => path === "C:/Output/bass.wav";
    nativeBridge.convertAudioFile = async (...args: unknown[]) => {
      (window as any).__conversionArgs = args;
      return new Promise<boolean>(resolve => { (window as any).__finishConversion = resolve; });
    };
    useDAWStore.getState().toggleBatchConverter();
  });
  const dialog = page.getByRole("dialog", { name: "Batch File Converter" });
  await dialog.getByRole("button", { name: "Browse File" }).click();
  await dialog.getByRole("button", { name: "Convert 1 Files" }).click();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__conversionArgs[1])).toBe("C:/Output/bass-converted-1.wav");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).__finishConversion(false));
  await expect(dialog.getByRole("alert")).toHaveText("Conversion failed");
  await page.setViewportSize({ width: 720, height: 640 });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "../output/playwright/converter-compact.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
});
