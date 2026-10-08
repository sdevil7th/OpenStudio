import { expect, test, type Page } from "@playwright/test";

type PitchFixtureWindow = Window & {
  __pitchFixture: {
    daw: typeof import("../src/store/useDAWStore").useDAWStore;
    createDefaultTrack: typeof import("../src/store/useDAWStore").createDefaultTrack;
    pitch: typeof import("../src/store/pitchEditorStore").usePitchEditorStore;
    bridge: typeof import("../src/services/NativeBridge").nativeBridge;
  };
};

test("two pitch views share edits and undo, preserve viewport, and survive docking", async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, deviceScaleFactor: 2 });
  let main: Page;
  let remote: Page | undefined;
  let checkpoint: any;
  let viewId = "native-view-1";
  let ready = false;
  const deliver = async (page: Page | undefined, event: string, payload: any) => {
    if (page && !page.isClosed()) await page.evaluate(({ event, payload }) => (window as any).__pitchDeliver?.(event, payload), { event, payload });
  };
  await context.exposeBinding("__pitchRelay", async ({ page }, operation, payload) => {
    if (operation === "publish") {
      checkpoint = { ...checkpoint, ...payload, pitch: { ...checkpoint?.pitch, ...payload.pitch } };
      await deliver(remote, "pitchEditorSnapshot", payload);
      return true;
    }
    if (operation === "get") return { snapshot: checkpoint, viewId };
    if (operation === "open") return true;
    if (operation === "close") { ready = false; await deliver(main, "pitchEditorClosed", { viewId }); return true; }
    if (operation === "acceptReady") { ready = true; return true; }
    if (["ready", "command", "heartbeat"].includes(operation) && page === remote) {
      await deliver(main, "pitchEditorCommand", { ...payload, operation, viewId });
      return true;
    }
    return false;
  });
  // Install the test transport before either React root mounts. All editor and
  // controller code remains production code; only native message delivery is simulated.
  // Retain the stores loaded by that root rather than dynamically importing them
  // inside evaluate, where Chromium can collect an unresolved module promise.
  await context.route(/\/src\/(App|PitchEditorWindowApp)\.tsx(?:\?|$)/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: `
      import { nativeBridge as __pitchTestBridge } from "/src/services/NativeBridge.ts";
      import { useDAWStore as __pitchTestDAW, createDefaultTrack as __pitchTestTrack } from "/src/store/useDAWStore.ts";
      import { usePitchEditorStore as __pitchTestStore } from "/src/store/pitchEditorStore.ts";
      window.__pitchFixture = { daw: __pitchTestDAW, createDefaultTrack: __pitchTestTrack, pitch: __pitchTestStore, bridge: __pitchTestBridge };
      __pitchTestBridge.pitchEditorSession = (operation, payload) => window.__pitchRelay(operation, payload);
      window.__pitchDeliver = (event, payload) => { for (const cb of __pitchTestBridge.eventListeners.get(event) || []) cb(payload); };
      ${source}` });
  });
  await context.addInitScript(() => {
    localStorage.setItem("openstudio_essentialControlsDismissed", "true");
    // Exercise the macOS 12-compatible canvas cache fallback as well.
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    Object.defineProperty(window, "OffscreenCanvas", { value: undefined, configurable: true });
  });
  main = await context.newPage();
  await main.goto("/?platform=windows&windowChrome=native");
  await expect(main.getByText("Starting OpenStudio...", { exact: true })).toBeHidden({ timeout: 25000 });
  await expect(main.getByRole("button", { name: "Audio Settings", exact: true })).toBeVisible();
  await main.evaluate(() => {
    const { daw: useDAWStore, createDefaultTrack, pitch: usePitchEditorStore, bridge: nativeBridge } = (window as PitchFixtureWindow).__pitchFixture;
    nativeBridge.applyPitchCorrection = async () => ({ success: true, outputFile: "" });
    const track = { ...createDefaultTrack("pitch-qa", "Vocal"), clips: [{ id: "clip-qa", name: "Voice", filePath: "C:/fixture.wav", startTime: 0, duration: 3, offset: 0, color: "#ffaa33", volumeDB: 0, fadeIn: 0, fadeOut: 0, locked: false }] };
    useDAWStore.setState({ tracks: [track], pixelsPerSecond: 75, scrollX: 123 });
    useDAWStore.getState().openPitchEditor(track.id, "clip-qa", 0);
    const note = { id: "note-qa", startTime: 0.5, endTime: 1.5, detectedPitch: 60, correctedPitch: 60, driftCorrectionAmount: 0, vibratoDepth: 1, vibratoRate: 0, transitionIn: 0, transitionOut: 0, formantShift: 0, gain: 0, voiced: true, pitchDrift: [] };
    usePitchEditorStore.setState({ notes: [note], selectedNoteIds: [note.id], analyzedRanges: [[0, 3]],
      contour: { sampleRate: 48000, hopSize: 256, frames: { times: [0.5, 1], midi: [60, 60], confidence: [1, 1], rms: [0.1, 0.1], voiced: [true, true] }, notes: [note] } });
  });
  await expect(main.getByRole("button", { name: "Detach pitch editor" })).toBeVisible();
  await main.getByRole("button", { name: "Detach pitch editor" }).click();
  remote = await context.newPage();
  await remote.goto("/?window=pitchEditor&sessionId=native-view-1&windowChrome=native");
  await expect(remote.locator("canvas")).toBeVisible();
  await expect.poll(() => ready).toBe(true);
  await expect(main.getByText("Pitch editor is open in its own window.")).toBeVisible();
  const remoteFailures: string[] = [];
  remote.on("pageerror", error => remoteFailures.push(String(error)));
  const remotePitch = () => remote!.evaluate(() => (window as PitchFixtureWindow).__pitchFixture.pitch.getState().notes[0]?.correctedPitch);
  await remote.evaluate(() => {
    const { pitch: usePitchEditorStore, bridge: nativeBridge } = (window as PitchFixtureWindow).__pitchFixture;
    nativeBridge.applyPitchCorrection = async () => { throw new Error("Detached view attempted to own rendering"); };
    const s = usePitchEditorStore.getState();
    s.beginInteractivePreview("note-qa"); s.pushUndo("Pitch +4");
    s.updateNote("note-qa", { correctedPitch: 62 }); s.updateNote("note-qa", { correctedPitch: 64 }); s.commitNoteEdit();
    s.setZoomX(300); s.setScrollX(0.25);
  });
  await expect.poll(remotePitch).toBe(64);
  await remote.evaluate(() => (window as PitchFixtureWindow).__pitchFixture.pitch.getState().undo());
  await expect.poll(remotePitch).toBe(60);
  await remote.evaluate(() => (window as PitchFixtureWindow).__pitchFixture.pitch.getState().redo());
  await expect.poll(remotePitch).toBe(64);
  const geometry = await remote.locator("canvas").evaluate((canvas: HTMLCanvasElement) => ({ backing: canvas.width, css: canvas.getBoundingClientRect().width, ratio: devicePixelRatio }));
  expect(geometry.backing).toBeCloseTo(geometry.css * geometry.ratio, 0);
  await remote.setViewportSize({ width: 900, height: 600 });
  await expect(remote.getByRole("button", { name: "Dock", exact: true })).toBeVisible();
  await remote.screenshot({ path: "../output/playwright/detached-pitch-900-dpr2.png" });
  await remote.evaluate(() => {
    const listeners = new Map<string, (payload: unknown) => void>();
    (window as any).__failureCalls = [];
    (window as any).__JUCE__ = { backend: {
      addEventListener: (name: string, callback: (payload: unknown) => void) => { listeners.set(name, callback); return name; },
      removeEventListener: (name: string) => listeners.delete(name),
      emitEvent: (_name: string, payload: { name: string; resultId: number }) => {
        (window as any).__failureCalls.push(payload.name);
        listeners.get("__juce__complete")?.({ promiseId: payload.resultId, result: true });
      },
    } };
    window.dispatchEvent(new ErrorEvent("error", { message: "Simulated detached view failure" }));
  });
  // Startup reports may also reach this late-installed backend. Verify that the
  // failure handler requests exactly one close without counting those reports.
  await expect.poll(() => remote!.evaluate(() => ((window as any).__failureCalls as string[]).filter(name => name === "closeWindow"))).toEqual(["closeWindow"]);
  await remote.getByRole("button", { name: "Dock", exact: true }).click();
  await remote.close(); remote = undefined;
  await expect(main.getByRole("button", { name: "Detach pitch editor" })).toBeVisible();
  expect(await main.evaluate(() => {
    const { pitch, daw } = (window as PitchFixtureWindow).__pitchFixture;
    const p = pitch.getState();
    const d = daw.getState();
    return [p.notes[0].correctedPitch, p.zoomX, p.scrollX, d.pixelsPerSecond, d.scrollX];
  })).toEqual([64, 300, 0.25, 75, 123]);
  expect(remoteFailures).toEqual([]);
  viewId = "retired";
  await context.close();
});
