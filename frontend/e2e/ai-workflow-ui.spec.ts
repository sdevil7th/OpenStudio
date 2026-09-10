import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({ schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 15000 });
  await page.evaluate(async () => {
    const moduleUrl = "/src/store/useDAWStore.ts";
    const { useDAWStore, createDefaultTrack } = await import(/* @vite-ignore */ moduleUrl);
    const track = createDefaultTrack("ai-ui-test", "Bass arrangement with a very long name that must never cover track controls", "#628ea3", "ai");
    const reference = createDefaultTrack("audio-ui-test", "Bass DI", "#8d976f", "audio");
    const current = useDAWStore.getState();
    useDAWStore.setState({ tracks: [reference, track], trackHeight: 110, tcpWidth: 260,
      aiToolsStatus: { ...current.aiToolsStatus, musicModels: {
        "minimax-music-3": { ready: true, modelReady: true, runtimeReady: true },
        "stable-audio-3-medium": { ready: true, modelReady: true, runtimeReady: true },
      } },
    });
  });
});

test("AI header controls remain inside a narrow track and model forms expose only supported controls", async ({ page }) => {
  const header = page.locator('[data-qa="ai-track-header"]');
  await expect(header).toBeVisible();
  const bounds = await header.boundingBox();
  for (const control of await header.locator('button, [role="slider"], input').all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
  }
  await page.screenshot({ path: "../output/playwright/ai-track-header-review.png" });
  await header.getByRole("button", { name: "Open AI generation parameters" }).click();
  await page.getByLabel("Model", { exact: true }).selectOption("minimax-music-3");
  await expect(page.getByLabel("Workflow", { exact: true })).toHaveValue("structured-song");
  await expect(page.getByLabel("Workflow", { exact: true }).locator("option")).toHaveCount(2);
  await page.screenshot({ path: "../output/playwright/ai-song-form-review.png", animations: "disabled" });
  await page.getByLabel("Model", { exact: true }).selectOption("stable-audio-3-medium");
  await expect(page.getByLabel("Workflow", { exact: true })).toHaveValue("text-to-audio");
  await expect(page.getByText("Negative Prompt", { exact: true })).toHaveCount(0);
  await expect(page.getByText("CFG Scale", { exact: true })).toHaveCount(0);
  await expect(page.getByText("LoRA Path", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 720, height: 640 });
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(720);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "../output/playwright/ai-form-compact-review.png", animations: "disabled" });
});

test("MiniMax form submits its model and sections, ignores stale progress, and cancels without importing late output", async ({ page }) => {
  await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const storeUrl = "/src/store/useDAWStore.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const qa = { requests: [] as unknown[], polls: 0, imports: 0, cancels: 0, release: null as null | (() => void) };
    (window as any).__aiReview = qa;
    nativeBridge.startAIGeneration = async (...args: unknown[]) => {
      qa.requests.push(args);
      return { started: true, requestId: "current-song" };
    };
    nativeBridge.getAIGenerationProgress = async () => {
      if (++qa.polls === 1) return { state: "done", requestId: "previous-song", outputFile: "old.wav" };
      await new Promise<void>(resolve => { qa.release = resolve; });
      return { state: "done", requestId: "current-song", outputFile: "cancelled.wav" };
    };
    nativeBridge.cancelAIGeneration = async () => { ++qa.cancels; return true; };
    useDAWStore.setState({ addGeneratedAudioClip: async () => { ++qa.imports; } });
  });
  await page.locator('[data-qa="ai-track-header"]').getByRole("button", { name: "Open AI generation parameters" }).click();
  await page.getByLabel("Model", { exact: true }).selectOption("minimax-music-3");
  await page.getByLabel("Music description", { exact: true }).fill("Soul, 95 BPM, warm bass and drums");
  await page.getByLabel("Vocal direction", { exact: true }).fill("Warm female lead");
  await page.getByLabel("Verse", { exact: true }).fill("A quiet street beneath the rain");
  await page.getByLabel("Chorus", { exact: true }).fill("We find our way back home again");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiReview.polls)).toBe(2);
  expect(await page.evaluate(() => (window as any).__aiReview.requests)).toEqual([
    ["ai-ui-test", "minimax-music-3", "structured-song", expect.objectContaining({ verse: "A quiet street beneath the rain", vocals: "Warm female lead" })],
  ]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__aiReview.cancels)).toBe(1);
  await page.evaluate(() => (window as any).__aiReview.release?.());
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__aiReview.imports)).toBe(0);
});

test("generation survives a collapsed folder, imports once while hidden, and remains undoable", async ({ page }) => {
  await page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts";
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const commandUrl = "/src/store/commands/index.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { commandManager } = await import(/* @vite-ignore */ commandUrl);
    commandManager.clear();
    useDAWStore.setState(state => ({ tracks: state.tracks.map(track => track.id === "audio-ui-test"
      ? { ...track, isFolder: true, folderCollapsed: false } : { ...track, parentFolderId: "audio-ui-test" }) }));
    const qa = { finish: false, imports: 0 };
    (window as any).__hiddenAI = qa;
    nativeBridge.startAIGeneration = async () => ({ started: true, requestId: "hidden-job" });
    nativeBridge.getAIGenerationProgress = async () => qa.finish
      ? { state: "done", progress: 1, requestId: "hidden-job", outputFile: "generated.wav" }
      : { state: "generating", progress: 0.4, requestId: "hidden-job" };
    nativeBridge.importMediaFile = async () => { ++qa.imports; return { filePath: "generated.wav", duration: 2, sampleRate: 48000, numChannels: 2, format: "wav" }; };
    nativeBridge.addPlaybackClip = async () => true;
    nativeBridge.removePlaybackClipById = async () => true;
  });
  const header = page.locator('[data-qa="ai-track-header"]');
  await header.getByRole("button", { name: "Open AI generation parameters" }).click();
  await page.getByLabel("Model", { exact: true }).selectOption("stable-audio-3-medium");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  // Close just the form, not the app-owned job, then genuinely unmount the header.
  await page.getByRole("dialog").getByRole("button", { name: /Close/ }).first().click();
  await page.getByTitle("Collapse folder", { exact: true }).click();
  await expect(header).toHaveCount(0);
  await page.evaluate(() => { (window as any).__hiddenAI.finish = true; });
  await expect.poll(() => page.evaluate(() => (window as any).__hiddenAI.imports)).toBe(1);
  await page.getByTitle("Expand folder", { exact: true }).click();
  await expect(header).toBeVisible();
  const clipCount = () => page.evaluate(async () => {
    const moduleUrl = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ moduleUrl);
    return useDAWStore.getState().tracks.find((track: any) => track.id === "ai-ui-test").clips.length;
  });
  await expect.poll(clipCount).toBe(1);
  await page.keyboard.press("Control+z");
  await expect(header).toHaveCount(0); // Undo the more recent folder expansion first.
  await page.keyboard.press("Control+z");
  await expect.poll(clipCount).toBe(0);
  expect(await page.evaluate(() => (window as any).__hiddenAI.imports)).toBe(1);
});

test("processor fault badge updates without reopening the chain and clears on explicit reset", async ({ page }) => {
  await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const qa = { fault: 0, bypassed: false, changed: () => {} };
    (window as any).__faultQA = qa;
    nativeBridge.onProcessorFaultsChanged = (callback: () => void) => { qa.changed = callback; return () => {}; };
    nativeBridge.getTrackFX = async () => [{ index: 0, name: "Long-named third-party processor safety fixture", type: "vst3", runtimeFault: qa.fault, bypassed: qa.bypassed }];
    nativeBridge.bypassTrackFX = async (_id: string, _index: number, bypassed: boolean) => {
      qa.bypassed = bypassed;
      if (!bypassed) { qa.fault = 0; qa.changed(); }
      return true;
    };
  });
  await page.getByTitle("FX Chain", { exact: true }).first().click();
  await expect(page.getByRole("status", { name: "", exact: true }).filter({ hasText: "Audio fault" })).toHaveCount(0);
  await page.evaluate(() => { const qa = (window as any).__faultQA; qa.fault = 2; qa.changed(); });
  const badge = page.getByText("Audio fault", { exact: true });
  await expect(badge).toBeVisible();
  const slot = badge.locator("xpath=ancestor::div[contains(@class,'fx-slot-item')]");
  expect(await slot.evaluate(element => {
    const box = element.getBoundingClientRect();
    return [...element.querySelectorAll('button, input, [role="status"]')].every(control => {
      const bounds = control.getBoundingClientRect();
      return bounds.left >= box.left && bounds.right <= box.right + 1;
    });
  })).toBe(true);
  await page.screenshot({ path: "../output/playwright/processor-fault-review.png", animations: "disabled" });
  await page.getByRole("checkbox", { name: "Bypass Long-named third-party processor safety fixture", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enable Long-named third-party processor safety fixture", exact: true }).click();
  await expect(badge).toHaveCount(0);
});

for (const workflow of ["variation", "inpaint-selection", "continue-clip"] as const) {
  test(`Stable Audio ${workflow} form preserves source coordinates and cancellation ownership`, async ({ page }) => {
    await page.evaluate(async ({ workflow }) => {
      const storeUrl = "/src/store/useDAWStore.ts";
      const bridgeUrl = "/src/services/NativeBridge.ts";
      const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
      const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
      const qa = { request: null as any, imports: 0, release: null as null | (() => void) };
      (window as any).__aiSourceReview = qa;
      nativeBridge.startAIGeneration = async (...args: unknown[]) => { qa.request = args; return { started: true, requestId: "source-edit" }; };
      nativeBridge.getAIGenerationProgress = async () => {
        await new Promise<void>(resolve => { qa.release = resolve; });
        return { state: "done", requestId: "source-edit", outputFile: "cancelled-source.wav" };
      };
      nativeBridge.cancelAIGeneration = async () => true;
      useDAWStore.setState(state => ({
        tracks: state.tracks.map(track => track.id !== "audio-ui-test" ? track : { ...track, clips: [{
          id: "source-edit-clip", name: "Bass DI", filePath: "C:/fixture/source.wav", startTime: 10, offset: 2,
          duration: 4, sourceLength: 12, sampleRate: 48000, volumeDB: 0, fadeIn: 0, fadeOut: 0,
        }] }),
        timeSelection: { start: 12, end: 13 },
        addGeneratedSourceAudioClip: async () => { ++qa.imports; },
      }));
      useDAWStore.getState().openAIClipGeneration("audio-ui-test", "source-edit-clip", workflow, "stable-audio-3-medium");
    }, { workflow });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("option", { name: "MiniMax Music 3" })).toHaveCount(0);
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__aiSourceReview.release))).toBe(true);
    const request = await page.evaluate(() => (window as any).__aiSourceReview.request);
    expect(request.slice(0, 3)).toEqual(["audio-ui-test", "stable-audio-3-medium", workflow]);
    expect(request[3].source).toMatchObject({ clipOffset: 2, clipDuration: 4 });
    if (workflow === "inpaint-selection") expect(request[3].source.inpaintRange).toEqual({ start: 2, end: 3 });
    await page.getByRole("button", { name: /Cancel/, exact: false }).last().click();
    await page.evaluate(() => (window as any).__aiSourceReview.release?.());
    await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__aiSourceReview.imports)).toBe(0);
  });
}
