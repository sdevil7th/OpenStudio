import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await expect(page.getByText(/Something went wrong/)).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Main Toolbar" })).toBeVisible();
});

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
    const qa = { dismissed: [] as string[], writes: [] as unknown[][], restores: [] as unknown[][] };
    (window as any).__recoveryQA = qa;
    nativeBridge.discoverProjectRecovery = async () => [{ id: "session/document", path: "C:/Recovery/copy.osproj",
      projectName: "Recovered bass arrangement with a long project name", sourcePath: "", savedAt: 1788600000000 }];
    nativeBridge.dismissProjectRecovery = async (id: string) => { qa.dismissed.push(id); return true; };
    nativeBridge.loadProjectFromFile = async () => JSON.stringify({ tracks: [], projectName: "Recovered bass arrangement", tempo: 100 });
    nativeBridge.saveProjectToFile = async (...args: unknown[]) => { qa.writes.push(args); return true; };
    useDAWStore.setState({ tracks: [], isModified: false });
    const actualOpen = useDAWStore.getState().requestOpenProject;
    useDAWStore.setState({ requestOpenProject: async (...args: unknown[]) => { qa.restores.push(args); return actualOpen(...args); } });
    window.dispatchEvent(new Event("openstudio:discover-recovery"));
  });
});

test("restore opens an unsaved copy, retains original evidence, and untitled backup needs no dialog", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Recover an interrupted session" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Untitled — never saved/)).toBeVisible();
  await dialog.getByRole("button", { name: "Restore copy" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    const state = useDAWStore.getState();
    return { name: state.projectName, path: state.projectPath, dirty: state.isModified, loading: state.isProjectLoading };
  })).toEqual({ name: "Recovered bass arrangement", path: null, dirty: true, loading: false });
  await page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    await useDAWStore.getState().saveProject(false, true);
  });
  const qa = await page.evaluate(() => (window as any).__recoveryQA);
  expect(qa.writes).toHaveLength(1);
  expect(qa.writes[0][0]).toBe("");
  expect(qa.writes[0][2]).toBe(true);
  expect(qa.dismissed).not.toContain("session/document");
});

test("recovery geometry, Later and explicit dismissal work at compact sizes", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 640 });
  const dialog = page.getByRole("dialog", { name: "Recover an interrupted session" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "../output/playwright/recovery-dialog-review.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "Later" }).click();
  expect(await page.evaluate(() => (window as any).__recoveryQA.dismissed)).toEqual([]);
  await page.getByRole("menuitem", { name: "File menu", exact: true }).click();
  await page.getByText("Check Interrupted Session Recovery...", { exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Dismiss reminder" }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__recoveryQA.dismissed)).toEqual(["session/document"]);
});

test("plugin-free recovery is explicitly selected and explains the omitted FX", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Recover an interrupted session" });
  await dialog.getByText("Open without plugins for troubleshooting").click();
  await expect(dialog.getByText(/Instruments and FX will not be loaded/)).toBeVisible();
  await dialog.getByRole("button", { name: "Restore copy" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__recoveryQA.restores)).toEqual([
    ["C:/Recovery/copy.osproj", { recoveryCopy: true, bypassFX: true }],
  ]);
});

test("malformed saved grid settings fall back without crashing the restored UI", async ({ page }) => {
  await page.evaluate(async () => {
    const url = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ url);
    nativeBridge.loadProjectFromFile = async () => JSON.stringify({ tracks: [], projectName: "Malformed settings",
      gridSize: { invalid: true }, snapType: 42 });
  });
  await page.getByRole("button", { name: "Restore copy" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const url = "/src/store/useDAWStore.ts";
    const { useDAWStore } = await import(/* @vite-ignore */ url);
    return { grid: useDAWStore.getState().gridSize, snap: useDAWStore.getState().snapType };
  })).toEqual({ grid: "use_quantize", snap: "grid" });
});

test("recording failures remain visible until acknowledged and do not stop monitoring", async ({ page }) => {
  await page.getByRole("button", { name: "Later" }).click();
  await page.evaluate(async () => {
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl);
    nativeBridge.onRecordingWriteFailure = (callback: (data: unknown) => void) => {
      callback([{ trackId: "bass", path: "C:/Recordings/bass.wav", reason: 1 }]);
      return () => {};
    };
    // Mount the production component against an explicit native-event boundary.
    const reactUrl = "/node_modules/.vite/deps/react.js", domUrl = "/node_modules/.vite/deps/react-dom_client.js";
    const componentUrl = "/src/components/RecordingFailureBanner.tsx";
    const { default: React } = await import(/* @vite-ignore */ reactUrl);
    const { default: ReactDOM } = await import(/* @vite-ignore */ domUrl);
    const { RecordingFailureBanner } = await import(/* @vite-ignore */ componentUrl);
    const host = document.createElement("div");
    document.querySelector(".app-container")!.prepend(host);
    ReactDOM.createRoot(host).render(React.createElement(RecordingFailureBanner));
  });
  await expect(page.getByRole("alert").getByText("Recording storage failed")).toBeVisible();
  await expect(page.getByRole("alert").getByText(/Other tracks and monitoring continue/)).toBeVisible();
  await page.getByRole("alert").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("alert").getByText("Recording storage failed")).toHaveCount(0);
});
