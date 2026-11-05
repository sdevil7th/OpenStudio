import { expect, test, type Page } from "@playwright/test";
import type { useDAWStore } from "../src/store/useDAWStore";
import type { commandManager } from "../src/store/commands";
import type { ClipTempoAnalysis } from "../src/services/NativeBridge";

declare global {
  interface Window {
    __tempoUiQA: {
      store: typeof useDAWStore;
      history: typeof commandManager;
      pending: Array<(result: ClipTempoAnalysis) => void>;
      ranges: Array<{ start?: number; duration?: number }>;
      previews: Array<{ start: number; duration: number }>;
      resolvePreview: ((data: import("../src/services/NativeBridge").ClipTempoPreviewData) => void) | null;
      cancellations: string[];
      audio: { starts: number; stops: number; closes: number };
    };
  }
}

async function ready(page: Page, openDialog = true) {
  await page.goto("/");
  await page.getByText("Starting OpenStudio...", { exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(async (openDialog) => {
    const source = await (await fetch("/src/App.tsx")).text();
    const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
    if (!storeUrl) throw new Error("App store import not found");
    const { useDAWStore: store, createDefaultTrack } = await import(/* @vite-ignore */ storeUrl) as typeof import("../src/store/useDAWStore");
    const commandUrl = "/src/store/commands/index.ts";
    const { commandManager: history } = await import(/* @vite-ignore */ commandUrl) as typeof import("../src/store/commands");
    const bridgeUrl = "/src/services/NativeBridge.ts";
    const { nativeBridge } = await import(/* @vite-ignore */ bridgeUrl) as typeof import("../src/services/NativeBridge");
    const track = createDefaultTrack("tempo-track", "Tempo source", "#4361ee", "audio", []);
    track.clips = ["a", "b"].map((id) => ({ id, name: `Clip ${id}`, filePath: "C:/tempo-fixture.wav",
      duration: 8, startTime: id === "a" ? 3 : 12, offset: 0.5, sourceLength: 20,
      sampleRate: 48000, volumeDB: 0, fadeIn: 0, fadeOut: 0, color: track.color }));
    const pending: Array<(result: ClipTempoAnalysis) => void> = [];
    const ranges: Array<{ start?: number; duration?: number }> = [];
    const qa = window.__tempoUiQA = { store, history, pending, ranges,
      previews: [] as Array<{ start: number; duration: number }>, resolvePreview: null as ((data: import("../src/services/NativeBridge").ClipTempoPreviewData) => void) | null,
      cancellations: [] as string[], audio: { starts: 0, stops: 0, closes: 0 } };
    nativeBridge.cancelClipTempoAnalysis = async id => { qa.cancellations.push(id); return true; };
    // This checks scheduling/cancellation without using the computer's speakers.
    class SilentContext {
      state = "running"; currentTime = 0; sampleRate = 48000; destination = {};
      async resume() { this.state = "running"; }
      async close() { this.state = "closed"; qa.audio.closes++; }
      createBuffer(channels: number, count: number, sampleRate: number) {
        const data = Array.from({ length: channels }, () => new Float32Array(count));
        return { numberOfChannels: channels, duration: count / sampleRate, getChannelData: (channel: number) => data[channel] };
      }
      async decodeAudioData() { return this.createBuffer(1, 4 * 48000, 48000); }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createBufferSource() { return { buffer: null, playbackRate: { value: 1 }, onended: null,
        connect() {}, disconnect() {}, start() { qa.audio.starts++; }, stop() { qa.audio.stops++; } }; }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: SilentContext });
    nativeBridge.getClipTempoPreviewData = async (_trackId, _clipId, start = 0, duration = 4) => {
      qa.previews.push({ start, duration });
      return new Promise(resolve => { qa.resolvePreview = resolve; });
    };
    history.clear();
    store.setState({ tracks: [track], showGettingStarted: false, inputProfileOnboardingSeen: true,
      autoBackupEnabled: false, canUndo: false, canRedo: false, tempoDetectionTarget: null,
      analyzeTempoDetectionTarget: (start, duration) => { ranges.push({ start, duration }); return new Promise(resolve => pending.push(resolve)); },
      transport: { ...store.getState().transport, tempo: 120, isPlaying: false, isRecording: false } });
    if (openDialog) store.getState().openTempoDetection(track.id, "a");
  }, openDialog);
  if (openDialog) await expect(page.getByRole("dialog", { name: "Detect Clip Tempo" })).toBeVisible();
}

test("cancel, close and clip replacement retire native analysis request IDs", async ({ page }) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(1);
  await page.getByRole("button", { name: "Cancel analysis", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.cancellations.length)).toBe(1);
  await page.getByRole("button", { name: "Analyze range", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(2);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.cancellations.length)).toBe(2);
  await page.evaluate(() => window.__tempoUiQA.store.getState().openTempoDetection("tempo-track", "a"));
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(3);
  await page.evaluate(() => window.__tempoUiQA.store.getState().openTempoDetection("tempo-track", "b"));
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.cancellations.length)).toBe(3);
  expect(await page.evaluate(() => new Set(window.__tempoUiQA.cancellations).size)).toBe(3);
});

for (const kind of ["audio", "midi"] as const) {
  test(`${kind} tempo detection is reachable from the clip menu and searchable Command Palette`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await ready(page, false);
    await page.evaluate(kind => {
      const store = window.__tempoUiQA.store;
      const original = store.getState().tracks[0];
      const track = kind === "audio" ? original : { ...original, type: "midi" as const, clips: [],
        midiClips: [{ id: "a", name: "Clip a", startTime: 3, duration: 8, offset: 0,
          color: original.color, sourceLength: 8, events: [
            { type: "noteOn" as const, note: 60, velocity: 80, timestamp: 0 },
            { type: "noteOff" as const, note: 60, velocity: 0, timestamp: 1 },
          ] }] };
      store.setState({ tracks: [track], pixelsPerSecond: 100, scrollX: 0, scrollY: 0, trackHeight: 100,
        showMixer: false, showPianoRoll: false, showPitchEditor: false });
    }, kind);
    const point = await page.evaluate(() => {
      const stage = window.Konva.stages.find(stage => stage.height() > 50 && stage.container().closest(".timeline-container"))!;
      const box = stage.container().getBoundingClientRect();
      return { x: box.x + 400, y: box.y + 45 };
    });
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.getByText("Detect Tempo...", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Detect Clip Tempo" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.mouse.click(point.x, point.y);
    await page.getByRole("menuitem", { name: "Help menu", exact: true }).click();
    await page.getByText("Command Palette", { exact: true }).click();
    await page.getByPlaceholder("Type a command...").fill("tempo");
    await page.getByText("Detect Selected Clip Tempo...", { exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.__tempoUiQA.store.getState().tempoDetectionTarget))
      .toEqual({ trackId: "tempo-track", clipId: "a" });
    expect(await page.evaluate(() => window.__tempoUiQA.store.getState().transport.tempo)).toBe(120);
    expect(await page.evaluate(() => window.__tempoUiQA.history.getUndoStack().length)).toBe(0);
  });
}

test("tempo dialog ignores canceled work and applies only the chosen candidate with one undo", async ({ page }) => {
  await ready(page);
  await expect(page.getByRole("status", { name: "Tempo analysis status" })).toContainText("Analyzing");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => window.__tempoUiQA.pending[0]({ bpm: 123, confidence: 0.8, beatOffsetSeconds: 0.1, candidates: [], source: "audio" }));
  await expect(page.getByRole("dialog", { name: "Detect Clip Tempo" })).toBeHidden();
  expect(await page.evaluate(() => window.__tempoUiQA.store.getState().transport.tempo)).toBe(120);
  await page.evaluate(() => window.__tempoUiQA.store.getState().openTempoDetection("tempo-track", "a"));
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(2);
  await page.evaluate(() => window.__tempoUiQA.pending[1]({ bpm: 95, confidence: 0.82, beatOffsetSeconds: 0.25, candidates: [], source: "audio" }));
  await expect(page.getByLabel("Detected tempo in BPM")).toHaveValue("95");
  await expect(page.getByRole("img", { name: /Visual beat spacing/ })).toBeVisible();
  await expect(page.getByLabel("Tempo click phase")).toHaveValue("0.250");
  await page.getByRole("button", { name: "190 BPM (2×)", exact: true }).click();
  expect(await page.evaluate(() => window.__tempoUiQA.store.getState().transport.tempo)).toBe(120);
  const before = await page.evaluate(() => window.__tempoUiQA.store.getState().tracks[0].clips);
  await page.getByRole("button", { name: "Apply Project Tempo", exact: true }).click();
  expect(await page.evaluate(() => window.__tempoUiQA.store.getState().transport.tempo)).toBe(190);
  expect(await page.evaluate(() => window.__tempoUiQA.store.getState().tracks[0].clips)).toEqual(before);
  expect(await page.evaluate(() => window.__tempoUiQA.history.getUndoStack().length)).toBe(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await page.evaluate(() => window.__tempoUiQA.store.getState().transport.tempo)).toBe(120);
});

test("changing clips retires the previous result and low-confidence MIDI estimates remain editable", async ({ page }) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(1);
  await page.evaluate(() => window.__tempoUiQA.store.getState().openTempoDetection("tempo-track", "b"));
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(2);
  await page.evaluate(() => window.__tempoUiQA.pending[0]({ bpm: 145, confidence: 0.9, beatOffsetSeconds: 0, candidates: [], source: "audio" }));
  await expect(page.getByRole("status", { name: "Tempo analysis status" })).toContainText("Analyzing");
  await page.evaluate(() => window.__tempoUiQA.pending[1]({ bpm: 80, confidence: 0.3, beatOffsetSeconds: 0.5, candidates: [], source: "midi-estimate", warning: "Note patterns may imply several pulses." }));
  await expect(page.getByLabel("Detected tempo in BPM")).toHaveValue("80");
  await expect(page.getByText("MIDI beat-grid estimate", { exact: true })).toBeVisible();
  const apply = page.getByRole("button", { name: "Apply Project Tempo", exact: true });
  await expect(page.getByText(/This pulse is uncertain/)).toBeVisible();
  await expect(apply).toBeEnabled();
  await page.getByLabel("Detected tempo in BPM").fill("999");
  await expect(apply).toBeDisabled();
  expect(await page.evaluate(() => window.__tempoUiQA.store.getState().transport.tempo)).toBe(120);
});

test("manual count, range analysis and source-click audition remain cancellable without transport changes", async ({ page }) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(1);
  await page.evaluate(() => window.__tempoUiQA.pending[0]({ bpm: 0, confidence: 0, beatOffsetSeconds: 0, candidates: [], source: "audio", error: "No repeated pulse" }));
  await expect(page.getByRole("button", { name: "Audition clip + click", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Source only", exact: true })).toBeEnabled();
  await page.getByLabel("Tempo analysis range start").fill("1");
  await page.getByLabel("Tempo analysis range end").fill("3");
  await page.getByText("Set tempo by counting beats in the selected range", { exact: true }).click();
  await page.getByLabel("Beat intervals in tempo range").fill("5");
  await page.getByRole("button", { name: /Use counted tempo/ }).click();
  await expect(page.getByLabel("Detected tempo in BPM")).toHaveValue("150.00");
  await expect(page.getByLabel("Tempo click phase")).toHaveValue("1.000");
  await page.getByRole("button", { name: "Analyze range", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.pending.length)).toBe(2);
  expect(await page.evaluate(() => window.__tempoUiQA.ranges[1])).toEqual({ start: 1, duration: 2 });
  await page.getByRole("button", { name: "Cancel analysis", exact: true }).click();
  await page.evaluate(() => window.__tempoUiQA.pending[1]({ bpm: 99, confidence: 0.9, beatOffsetSeconds: 0, candidates: [], source: "audio" }));
  await expect(page.getByLabel("Detected tempo in BPM")).toHaveValue("150.00");
  await page.getByLabel("Tempo preview start").fill("1.25");
  await page.getByRole("button", { name: "Audition clip + click", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.previews.length)).toBe(1);
  await page.getByRole("button", { name: "Stop audition", exact: true }).click();
  await page.evaluate(() => window.__tempoUiQA.resolvePreview?.({ wavBase64: "AA==", durationSeconds: 4, rangeStartSeconds: 1.25, filePath: "C:/tempo-fixture.wav", sourceOffsetSeconds: 0.5, clipDurationSeconds: 8 }));
  expect(await page.evaluate(() => window.__tempoUiQA.audio.starts)).toBe(0);
  await page.getByRole("button", { name: "Audition clip + click", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tempoUiQA.previews.length)).toBe(2);
  await page.evaluate(() => window.__tempoUiQA.resolvePreview?.({ wavBase64: "AA==", durationSeconds: 4, rangeStartSeconds: 1.25, filePath: "C:/tempo-fixture.wav", sourceOffsetSeconds: 0.5, clipDurationSeconds: 8 }));
  await expect(page.getByRole("status", { name: "Tempo audition status" })).toContainText("Playing");
  expect(await page.evaluate(() => window.__tempoUiQA.audio.starts)).toBeGreaterThan(1);
  await page.getByLabel("Tempo click phase").fill("0.1");
  await expect(page.getByRole("status", { name: "Tempo audition status" })).toHaveText("");
  const calls = await page.evaluate(() => window.__tempoUiQA.previews.length);
  await page.getByRole("button", { name: "Source only", exact: true }).click();
  await expect(page.getByRole("status", { name: "Tempo audition status" })).toContainText("Playing");
  expect(await page.evaluate(() => window.__tempoUiQA.previews.length)).toBe(calls);
  await page.getByLabel("Detected tempo in BPM").fill("155");
  await expect(page.getByRole("status", { name: "Tempo audition status" })).toContainText("Playing");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Detect Clip Tempo" })).toBeHidden();
  const state = await page.evaluate(() => ({ audio: window.__tempoUiQA.audio,
    transport: window.__tempoUiQA.store.getState().transport, history: window.__tempoUiQA.history.getUndoStack().length }));
  expect(state.audio.closes).toBeGreaterThanOrEqual(1);
  expect(state.audio.stops).toBeGreaterThanOrEqual(state.audio.starts);
  expect(state.transport.isPlaying).toBe(false); expect(state.transport.tempo).toBe(120); expect(state.history).toBe(0);
});
