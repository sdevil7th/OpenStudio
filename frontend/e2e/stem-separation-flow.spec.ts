import { expect, test as base } from "@playwright/test";
import type { AiHardwareStatus } from "../src/services/NativeBridge";

const test = base.extend<{ stemHardware: AiHardwareStatus | null }>({
  stemHardware: [null, { option: true }],
});

// Frontend publication/undo boundary. Actual installer, worker, tensor placement
// and WAV validation are exercised separately by qualify_ai_native.py.
test.beforeEach(async ({ page, stemHardware }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({ schemaVersion: 1,
      keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true }));
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
  });
  await page.goto("/");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 15000 });
  await page.evaluate(async (hardware) => {
    const storeUrl = "/src/store/useDAWStore.ts", bridgeUrl = "/src/services/NativeBridge.ts";
    const commandsUrl = "/src/store/commands/index.ts";
    const { useDAWStore, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl);
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { commandManager } = await import(/* @vite-ignore */ commandsUrl);
    commandManager.clear();
    const track = createDefaultTrack("source", "Song", "#628ea3", "audio");
    track.clips = [{ id: "source-clip", name: "Song", filePath: "mix.wav", startTime: 12,
      duration: 12, offset: 3, volumeDB: 0, fadeIn: 0, fadeOut: 0, sampleRate: 48000, color: "#628ea3" }];
    const qa = { mode: "waiting", requests: [] as unknown[], imports: 0, polls: 0, cancels: 0,
      release: null as null | (() => void), failImport: false, memoryReleases: 0, repairs: [] as unknown[] };
    (window as any).__stemQA = qa;
    const terminal = { state: "done", progress: 1, backend: "cuda", stemFiles:
      ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"].map(name => ({ name, filePath: name + ".wav" })) };
    nativeBridge.separateStemsAsync = async (...args: unknown[]) => { qa.requests.push(args); return { started: true }; };
    nativeBridge.getStemSeparationProgress = async () => {
      ++qa.polls;
      if (qa.mode === "late") {
        await new Promise<void>(resolve => { qa.release = resolve; });
        return terminal;
      }
      if (qa.mode === "done") return terminal;
      if (qa.mode === "missing") return { ...terminal, stemFiles: terminal.stemFiles.slice(0, 5) };
      return { state: "analyzing", progress: .4, backend: "cuda", diagnostics: {
        memoryPlan: { backend: "cuda", chunk_duration: 30, reason: "Sections selected for the observed host-memory budget." },
        executionDetails: { deviceReceipt: { cudaDeviceName: "NVIDIA qualification fixture" } } } };
    };
    nativeBridge.importMediaFile = async (path: string) => {
      ++qa.imports;
      if (qa.failImport && path === "Bass.wav") throw new Error("Unreadable Bass stem");
      return { filePath: path, duration: 31, sampleRate: 44100, numChannels: 2, format: "wav" };
    };
    nativeBridge.cancelStemSeparation = async () => { ++qa.cancels; };
    nativeBridge.releaseIdleAIMemory = async () => { ++qa.memoryReleases; return { success: true, released: true }; };
    useDAWStore.setState({ tracks: [track], trackGroups: [], canUndo: false, canRedo: false,
      aiToolsStatus: { ...useDAWStore.getState().aiToolsStatus, ...(hardware ? { hardware } : {}), available: true, state: "ready",
        installInProgress: false, features: { stemSeparation: { ready: true, compatible: true } } } });
    const readyStatus = useDAWStore.getState().aiToolsStatus;
    nativeBridge.installAiTools = async (options: unknown) => { qa.repairs.push(options); return { started: true, status: readyStatus }; };
    useDAWStore.getState().openStemSeparation("source", "source-clip", "Song", 12);
  }, stemHardware);
});

test("publishes six complete stems once, preserves placement and supports one undo/redo", async ({ page }) => {
  await page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts"; const { useDAWStore } = await import(/* @vite-ignore */ url);
    useDAWStore.setState({ trackGroups: [{ id: "previous-group", name: "Stems: Song",
      leadTrackId: "source", memberTrackIds: ["source"], linkedParams: ["volume"] }] });
  });
  await page.getByLabel("Processing device").selectOption("cpu-only");
  await page.getByText("Process in 30-second sections to reduce memory use", { exact: true }).click();
  await page.getByRole("button", { name: "Separate", exact: true }).click();
  await page.evaluate(() => { (window as any).__stemQA.mode = "done"; });
  const snapshot = () => page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    const s = useDAWStore.getState();
    return { tracks: s.tracks.length, muted: s.tracks[0].muted,
      clips: s.tracks.slice(1).map((t: any) => t.clips[0]), groups: s.trackGroups.length,
      groupIds: s.trackGroups.map((g: any) => g.id) };
  });
  await expect.poll(async () => (await snapshot()).tracks).toBe(7);
  const state = await snapshot();
  expect(state.muted).toBe(true);
  expect(state.groups).toBe(2);
  expect(state.clips).toHaveLength(6);
  for (const clip of state.clips) expect(clip).toMatchObject({ startTime: 12, duration: 12, sampleRate: 44100, offset: 3 });
  expect(await page.evaluate(() => (window as any).__stemQA.requests)).toEqual([
    ["source", "source-clip", { stems: ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"],
      filePath: "mix.wav", accelerationMode: "cpu-only", chunkDuration: 30, memoryMode: "automatic", performanceMode: "standard" }],
  ]);
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await snapshot()).tracks).toBe(1);
  expect((await snapshot()).muted).toBe(false);
  expect((await snapshot()).groupIds).toEqual(["previous-group"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await snapshot()).tracks).toBe(7);
  expect((await snapshot()).groupIds).toEqual(state.groupIds);
  expect(await page.evaluate(() => (window as any).__stemQA.imports)).toBe(6);
});

test("cancelled in-flight polls cannot publish into a later separation", async ({ page }) => {
  await page.evaluate(() => { (window as any).__stemQA.mode = "late"; });
  await page.getByRole("button", { name: "Separate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__stemQA.release))).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => { (window as any).__stemQA.mode = "waiting"; });
  await page.getByRole("button", { name: "Separate", exact: true }).click();
  await page.evaluate(() => { (window as any).__stemQA.release(); });
  await expect(page.getByText(/Separating stems/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__stemQA.imports)).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("an unreadable stem rejects the complete publication", async ({ page }) => {
  await page.evaluate(() => { Object.assign((window as any).__stemQA, { mode: "done", failImport: true }); });
  await page.getByRole("button", { name: "Separate", exact: true }).click();
  await expect(page.getByText("Unreadable Bass stem", { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts"; const { useDAWStore } = await import(/* @vite-ignore */ url);
    return useDAWStore.getState().tracks.length;
  })).toBe(1);
});

test("a missing requested stem rejects the complete publication", async ({ page }) => {
  await page.evaluate(() => { (window as any).__stemQA.mode = "missing"; });
  await page.getByRole("button", { name: "Separate", exact: true }).click();
  await expect(page.getByText("The separator did not return every requested stem. No tracks were added.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__stemQA.imports)).toBe(0);
});

test("memory details and idle release remain usable in compact windows", async ({ page }) => {
  await page.getByRole("button", { name: "Separate", exact: true }).click();
  await page.getByText("Processing details", { exact: true }).click();
  await expect(page.getByText("NVIDIA qualification fixture", { exact: true })).toBeVisible();
  for (const width of [390, 720, 1280]) {
    await page.setViewportSize({ width, height: 760 });
    const dialog = page.getByRole("dialog");
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    const box = (await cancel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeGreaterThanOrEqual(28);
  }
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts"; const { useDAWStore } = await import(/* @vite-ignore */ url);
    useDAWStore.getState().openAiToolsSetup("stemSeparation");
  });
  const release = page.getByRole("button", { name: "Release idle AI memory", exact: true });
  await release.click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Idle AI memory released");
  await release.focus();
  await expect(release).toBeFocused();
  await page.setViewportSize({ width: 390, height: 760 });
  const repair = page.getByRole("button", { name: "Repair Stem Separation", exact: true });
  const box = (await repair.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await repair.click();
  await expect.poll(() => page.evaluate(() => (window as any).__stemQA.repairs.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__stemQA.repairs[0])).toMatchObject({
    repairRuntime: true, selectedFeatures: ["stemSeparation"], userConfirmedDownload: true,
  });
});

test.describe("macOS stem processing", () => {
  test.use({ stemHardware: { platform: "macos", gpuBackend: "mps", gpuName: "Apple Silicon" } });

  test("macOS offers section processing while rolling buffers are unavailable", async ({ page }) => {
    await expect(page.getByRole("checkbox", { name: "Use rolling output buffers" })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Process in 30-second sections to reduce memory use" })).toBeEnabled();
  });
});

test("stem repair is queued without starting setup in the DAW", async ({ page }) => {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts", bridgeUrl = "/src/services/NativeBridge.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    nativeBridge.installAiTools = async () => ({
      started: false, message: "AI maintenance is scheduled. Save your work, close all OpenStudio windows and reopen OpenStudio to continue.",
    });
    useDAWStore.getState().openAiToolsSetup("stemSeparation");
  });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.getByRole("button", { name: "Repair Stem Separation" }).click();
  const notice = page.getByRole("status", { name: "AI runtime repair" });
  await expect(notice).toContainText("close all OpenStudio windows");
  await expect(page.getByRole("button", { name: "Cancel Setup" })).toHaveCount(0);
  const bounds = (await notice.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});

test.describe("Linux AMD stem processing", () => {
  test.use({ stemHardware: { platform: "linux", gpuBackend: "rocm", gpuArchitecture: "gfx1151", gpuName: "Radeon 8060S" } });

  test("rolling buffers and the qualified AMD request reach the worker options", async ({ page }) => {
    await page.getByLabel("AMD performance").selectOption("qualified-fast");
    await page.getByText("Use rolling output buffers", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Process in 30-second sections to reduce memory use" })).toBeDisabled();
    await page.getByRole("button", { name: "Separate", exact: true }).click();
    expect(await page.evaluate(() => (window as any).__stemQA.requests[0][2])).toMatchObject({
      accelerationMode: "auto", chunkDuration: 0, memoryMode: "streaming-preview", performanceMode: "qualified-fast",
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByLabel("Processing device").selectOption("cpu-only");
    await expect(page.getByLabel("AMD performance")).toBeDisabled();
  });
});

test("generation memory preference reaches native requests without entering project data", async ({ page }) => {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts";
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const status = useDAWStore.getState().aiToolsStatus;
    useDAWStore.setState({ aiToolsStatus: { ...status,
      hardware: { platform: "windows", gpuBackend: "cuda", gpuName: "NVIDIA GeForce RTX 4080" },
      musicModels: { ...status.musicModels, "stable-audio-3-medium": {
        modelId: "stable-audio-3-medium", installed: true, ready: true, compatible: true,
      } },
    } as any });
    nativeBridge.getAiToolsStatus = async () => useDAWStore.getState().aiToolsStatus;
    useDAWStore.getState().openAiToolsSetup("audioGeneration", "stable-audio-3-medium");
  });
  await page.getByLabel("Generation execution").selectOption("fp8-storage");
  await expect(page.getByLabel("Generation execution")).toHaveValue("fp8-storage");
  await page.getByLabel("Generation execution").focus();
  await expect(page.getByLabel("Generation execution")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 760 });
  const control = (await page.getByLabel("Generation execution").boundingBox())!;
  expect(control.x).toBeGreaterThanOrEqual(0);
  expect(control.x + control.width).toBeLessThanOrEqual(390);
  expect(control.height).toBeGreaterThanOrEqual(28);
  const result = await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const storeUrl = "/src/store/useDAWStore.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const before = JSON.stringify(useDAWStore.getState().tracks);
    const requests: Record<string, unknown>[] = [];
    const checks: Record<string, unknown>[] = [];
    Object.defineProperty(nativeBridge, "isNative", { value: true, configurable: true });
    (window as any).__JUCE__ = { backend: {
      startAIGeneration: async (_track: string, _model: string, _workflow: string, payload: string) => {
        requests.push(JSON.parse(payload)); return { started: false, error: "qualification transport only" };
      },
      getAIGenerationPreflight: async (_model: string, _workflow: string, payload: string) => {
        checks.push(JSON.parse(payload)); return { status: "ready", memory: [], notes: [] };
      },
    } };
    const params = { prompt: "A song", duration: 30, modelVariant: "original" };
    await nativeBridge.getAIGenerationPreflight("stable-audio-3-medium", "text-to-audio", params);
    await nativeBridge.startAIGeneration("source", "stable-audio-3-medium", "text-to-audio", params);
    await nativeBridge.startAIGeneration("source", "stable-audio-3-medium", "text-to-audio", { ...params, modelVariant: "int8" });
    return { requests, checks, params, projectUnchanged: before === JSON.stringify(useDAWStore.getState().tracks) };
  });
  expect(result.requests[0].generationOptimization).toBe("fp8-storage");
  expect(result.checks[0].generationOptimization).toBe("fp8-storage");
  expect(result.requests[1]).not.toHaveProperty("generationOptimization");
  expect(result.params).not.toHaveProperty("generationOptimization");
  expect(result.projectUnchanged).toBe(true);
  await page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    const status = useDAWStore.getState().aiToolsStatus;
    useDAWStore.setState({ aiToolsStatus: { ...status,
      hardware: { ...status.hardware, gpuName: "NVIDIA GeForce RTX 3060" } } });
  });
  await expect(page.getByRole("option", { name: "Lower GPU memory — FP8 storage" })).toBeDisabled();
  await page.getByLabel("Generation execution").selectOption("standard");
  await expect(page.getByLabel("Generation execution")).toHaveValue("standard");
});

test("AMD startup selection checks architecture and stays outside project parameters", async ({ page }) => {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts";
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const status = useDAWStore.getState().aiToolsStatus;
    useDAWStore.setState({ aiToolsStatus: { ...status,
      hardware: { platform: "linux", gpuBackend: "rocm", gpuName: "AMD ROCm GPU", gpuArchitecture: "gfx1151" },
      musicModels: { ...status.musicModels, "ace-step-v15-xl-turbo": { installed: true, ready: true } },
    } as any });
    nativeBridge.getAiToolsStatus = async () => useDAWStore.getState().aiToolsStatus;
    useDAWStore.getState().openAiToolsSetup("audioGeneration", "ace-step-v15-xl-turbo");
  });
  const option = page.getByRole("option", { name: "Faster startup — qualified AMD" });
  await expect(option).toBeEnabled();
  await page.getByLabel("Generation execution").selectOption("rocm-fast-startup");
  await page.getByLabel("Generation execution").focus();
  await expect(page.getByLabel("Generation execution")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 760 });
  const bounds = (await page.getByLabel("Generation execution").boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  const result = await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const storeUrl = "/src/store/useDAWStore.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const before = JSON.stringify(useDAWStore.getState().tracks);
    const requests: Record<string, unknown>[] = [];
    Object.defineProperty(nativeBridge, "isNative", { value: true, configurable: true });
    (window as any).__JUCE__ = { backend: {
      startAIGeneration: async (_track: string, _model: string, _workflow: string, payload: string) => {
        requests.push(JSON.parse(payload)); return { started: false, error: "transport only" };
      },
      getAIGenerationPreflight: async (_model: string, _workflow: string, payload: string) => {
        requests.push(JSON.parse(payload)); return { status: "ready", memory: [], notes: [] };
      },
    } };
    const params = { prompt: "Song", duration: 30, modelVariant: "original" };
    await nativeBridge.getAIGenerationPreflight("ace-step-v15-xl-turbo", "text-to-music", params);
    await nativeBridge.startAIGeneration("source", "ace-step-v15-xl-turbo", "text-to-music", params);
    await nativeBridge.startAIGeneration("source", "ace-step-v15-xl-turbo", "text-to-music", { ...params, modelVariant: "int8" });
    return { requests, params, projectUnchanged: before === JSON.stringify(useDAWStore.getState().tracks) };
  });
  expect(result.requests.slice(0, 2).map((r) => r.generationOptimization)).toEqual(["rocm-fast-startup", "rocm-fast-startup"]);
  expect(result.requests[2]).not.toHaveProperty("generationOptimization");
  expect(result.params).not.toHaveProperty("generationOptimization");
  expect(result.projectUnchanged).toBe(true);
  await page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    const status = useDAWStore.getState().aiToolsStatus;
    useDAWStore.setState({ aiToolsStatus: { ...status, hardware: { ...status.hardware, gpuArchitecture: "gfx1100" } } });
  });
  await expect(option).toBeDisabled();
  await page.getByLabel("Generation execution").selectOption("standard");
});

test("compiler setup becomes selectable after validated native preparation", async ({ page }) => {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts", bridgeUrl = "/src/services/NativeBridge.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const status = useDAWStore.getState().aiToolsStatus;
    useDAWStore.setState({ aiToolsStatus: { ...status, state: "ready", installInProgress: false,
      hardware: { platform: "windows", gpuBackend: "cuda", gpuName: "NVIDIA GeForce RTX 4080" },
      musicModels: { ...status.musicModels, "stable-audio-3-medium": { installed: true, ready: true,
        optimizations: { compile: { ready: false } } } },
    } as any });
    nativeBridge.getAiToolsStatus = async () => useDAWStore.getState().aiToolsStatus;
    Object.defineProperty(nativeBridge, "isNative", { value: true, configurable: true });
    (window as any).__compilerRequests = [];
    nativeBridge.installAiTools = Object.getPrototypeOf(nativeBridge).installAiTools.bind(nativeBridge);
    (window as any).__JUCE__ = { backend: {
      installAiTools: async (payload: string) => {
        (window as any).__compilerRequests.push(JSON.parse(payload));
        return { started: false, message: "AI maintenance is scheduled. Reopen OpenStudio to continue." };
      },
    } };
    useDAWStore.getState().openAiToolsSetup("audioGeneration", "stable-audio-3-medium");
  });
  const compiled = page.getByRole("option", { name: "Compile repeated blocks — optional setup" });
  await expect(compiled).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 760 });
  const prepare = page.getByRole("button", { name: "Prepare optional compilation", exact: true });
  await prepare.focus();
  await expect(prepare).toBeFocused();
  const bounds = (await prepare.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await prepare.click();
  await expect(page.getByRole("status", { name: "AI runtime repair" })).toContainText("scheduled");
  await expect(compiled).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel Setup" })).toHaveCount(0);
  // The next DAW session sees the validated result through its ordinary status refresh.
  await page.evaluate(async () => {
    const storeUrl = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ storeUrl);
    const before = useDAWStore.getState().aiToolsStatus;
    useDAWStore.getState().applyAiToolsStatusUpdate({ ...before, musicModels: { ...before.musicModels,
      "stable-audio-3-medium": { ...before.musicModels["stable-audio-3-medium"], optimizations: { compile: { ready: true } } } } });
  });
  await expect(compiled).toBeEnabled();
  await expect(page.getByRole("button", { name: "Repair compiler setup", exact: true })).toBeVisible();
  await page.getByLabel("Generation execution").selectOption("compile");
  const requests = await page.evaluate(() => (window as any).__compilerRequests);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ prepareOptimization: "compile", userConfirmedDownload: true,
    modelId: "stable-audio-3-medium", modelVariant: "original", selectedFeatures: ["audioGeneration"] });
  const transport = await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    const records: Record<string, unknown>[] = [];
    (window as any).__JUCE__.backend.startAIGeneration = async (_track: string, _model: string, _workflow: string, json: string) => {
      records.push(JSON.parse(json)); return { started: false, error: "transport only" };
    };
    const params = { prompt: "A song", duration: 30, modelVariant: "original" };
    await nativeBridge.startAIGeneration("source", "stable-audio-3-medium", "text-to-audio", params);
    await nativeBridge.startAIGeneration("source", "stable-audio-3-medium", "text-to-audio", { ...params, modelVariant: "int8" });
    return { records, params };
  });
  expect(transport.records[0].generationOptimization).toBe("compile");
  expect(transport.records[1]).not.toHaveProperty("generationOptimization");
  expect(transport.params).not.toHaveProperty("generationOptimization");
});
