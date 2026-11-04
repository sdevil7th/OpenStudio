import { expect, test, type Page } from "@playwright/test";
import type { useDAWStore } from "../src/store/useDAWStore";
import type {} from "./support/interactionFixtureTypes";

interface Request { file: string; spp: number; start: number; count: number; first: number; last: number }
declare global {
  interface Window {
    __packedWaveformQA: {
      calls: Request[];
      legacyCalls: number;
      hold: boolean;
      pending: Array<{ resolve: (value: unknown) => void; payload: unknown }>;
      listeners: Map<string, { name: string; callback: (value: unknown) => void }>;
      store: typeof useDAWStore;
      invalidate: () => void;
    };
  }
}

async function ready(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("openstudio.inputProfiles.v1", JSON.stringify({
      schemaVersion: 1, keyboardProfileId: "openstudio", mouseProfileId: "openstudio", onboardingSeen: true,
    }));
    const listeners = new Map<string, { name: string; callback: (value: unknown) => void }>();
    const qa = { calls: [] as Request[], legacyCalls: 0, listeners, hold: false,
      pending: [] as Array<{ resolve: (value: unknown) => void; payload: unknown }>,
      store: undefined as unknown as typeof useDAWStore,
      invalidate: () => {
        for (const item of listeners.values()) if (item.name === "peaksReady") item.callback({ filePath: "tiled.wav" });
      } };
    window.__packedWaveformQA = qa;
    let listenerId = 0;
    window.__JUCE__ = { backend: {
      addTrack: async (id?: string) => id ?? "unused",
      emitEvent: () => {},
      reportFrontendStartupState: async () => true,
      addEventListener: (name: string, callback: (value: unknown) => void) => {
        const token = String(++listenerId);
        listeners.set(token, { name, callback }); return token;
      },
      removeEventListener: (id: string) => { listeners.delete(id); },
      getWaveformPeaksPacked: async (file, spp, start, count, first = 0, last = -1) => {
        qa.calls.push({ file, spp, start, count, first, last });
        const peaks = Math.max(0, Math.min(count, Math.ceil(((last < 0 ? 48000 * 120 : last) - start) / spp)));
        const bytes = new Uint8Array(peaks * 2 * 2 * 4);
        const view = new DataView(bytes.buffer);
        for (let peak = 0; peak < peaks; peak++) {
          for (let channel = 0; channel < 2; channel++) {
            view.setFloat32((peak * 4 + channel * 2) * 4, -0.25 * (channel + 1), true);
            view.setFloat32((peak * 4 + channel * 2 + 1) * 4, 0.25 * (channel + 1), true);
          }
        }
        const payload = { format: "openstudio.waveform.f32", version: 1, byteOrder: "little", channels: 2,
          peakCount: peaks, byteLength: bytes.length, data: btoa(String.fromCharCode(...bytes)) };
        return qa.hold ? new Promise<unknown>((resolve) => qa.pending.push({ resolve, payload })) : payload;
      },
      getWaveformPeaks: async () => { qa.legacyCalls++; throw new Error("Unexpected legacy waveform request"); },
    } };
  });
  await page.goto("/?platform=windows&windowChrome=native");
  await expect(page.getByText("Starting OpenStudio...", { exact: true })).toBeHidden();
  const source = await (await page.request.get("/src/App.tsx")).text();
  const storeUrl = source.match(/from "([^"]*useDAWStore\.ts[^"]*)"/)?.[1];
  if (!storeUrl) throw new Error("Store module missing");
  await page.addScriptTag({ type: "module", content: `
    import { useDAWStore as store, createDefaultTrack } from ${JSON.stringify(storeUrl)};
    const qa = window.__packedWaveformQA;
    qa.store = store;
    const a = createDefaultTrack("tile-a", "Tiles A", "#4361ee", "audio", []);
    const b = createDefaultTrack("tile-b", "Tiles B", "#4cc9f0", "audio", [a]);
    const clip = { filePath: "tiled.wav", name: "Stereo source", startTime: 0, duration: 120,
      offset: 0, color: "#4361ee", volumeDB: 0, fadeIn: 0, fadeOut: 0, sampleRate: 48000 };
    a.clips = [{ ...clip, id: "tile-clip-a" }];
    b.clips = [{ ...clip, id: "tile-clip-b" }];
    store.setState({ tracks: [a, b], selectedTrackId: a.id, selectedTrackIds: [a.id], selectedClipIds: [],
      showMixer: false, showGettingStarted: false, showPianoRoll: false, showPitchEditor: false,
      inputProfileOnboardingSeen: true, pixelsPerSecond: 100, scrollX: 0, scrollY: 0,
      autoBackupEnabled: false, autoScrollDuringPlayback: false, projectRange: { start: 0, end: 120 },
      transport: { ...store.getState().transport, currentTime: 0, isPlaying: false, isRecording: false } });
  ` });
  await expect.poll(() => page.evaluate(() => window.__packedWaveformQA.calls.length)).toBeGreaterThan(0);
}

test("packed waveform tiles are shared, remain stable during playback, and refetch after source invalidation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await expect.poll(() => page.evaluate(() => {
    const stage = window.Konva.stages.find((item) => item.height() > 50 && item.container().closest(".workspace"));
    return stage?.find("Line").filter((node) => node instanceof window.Konva.Line && node.closed()).length ?? 0;
  })).toBeGreaterThanOrEqual(4);
  const before = await page.evaluate(() => window.__packedWaveformQA.calls.length);
  await page.evaluate(() => {
    const { store } = window.__packedWaveformQA;
    store.setState({ transport: { ...store.getState().transport, currentTime: 1, isPlaying: true } });
  });
  // The old growing-prefix prefetch issued another full response each second.
  await page.waitForTimeout(2300);
  await page.evaluate(() => {
    const { store } = window.__packedWaveformQA;
    store.setState({ transport: { ...store.getState().transport, isPlaying: false } });
  });
  expect(await page.evaluate(() => window.__packedWaveformQA.calls.length)).toBe(before);
  const calls = await page.evaluate(() => window.__packedWaveformQA.calls);
  expect(calls.every((call) => call.count === 4096)).toBe(true);
  expect(new Set(calls.map((call) => JSON.stringify(call))).size).toBe(calls.length);
  expect(await page.evaluate(() => window.__packedWaveformQA.legacyCalls)).toBe(0);
  await page.evaluate(() => window.__packedWaveformQA.invalidate());
  await expect.poll(() => page.evaluate(() => window.__packedWaveformQA.calls.length)).toBeGreaterThan(before);
  // Exercise actual viewport geometry at another zoom without changing source bounds.
  await page.evaluate(() => window.__packedWaveformQA.store.setState({ pixelsPerSecond: 500, scrollX: 12000 }));
  await expect.poll(() => page.evaluate(() => window.__packedWaveformQA.calls.some((call) => call.spp < 256 && call.start > 0))).toBe(true);
  expect(errors).toEqual([]);
});

test("late packed responses cannot publish a retired source generation or release a newer request", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const qa = window.__packedWaveformQA;
    qa.hold = true;
    qa.invalidate();
  });
  await expect.poll(() => page.evaluate(() => window.__packedWaveformQA.pending.length)).toBeGreaterThan(0);
  const firstBatch = await page.evaluate(() => window.__packedWaveformQA.pending.length);
  await page.evaluate(() => window.__packedWaveformQA.invalidate());
  await expect.poll(() => page.evaluate(() => window.__packedWaveformQA.pending.length)).toBeGreaterThan(firstBatch);
  await page.evaluate((count) => {
    for (const item of window.__packedWaveformQA.pending.splice(0, count)) item.resolve(item.payload);
  }, firstBatch);
  await expect.poll(() => page.evaluate(() => {
    const stage = window.Konva.stages.find((item) => item.height() > 50 && item.container().closest(".workspace"));
    return stage?.find("Line").filter((node) => node instanceof window.Konva.Line && node.closed() && node.opacity() === 0.6).length ?? 0;
  })).toBe(0);
  const heldCalls = await page.evaluate(() => window.__packedWaveformQA.calls.length);
  await page.evaluate(() => {
    const qa = window.__packedWaveformQA;
    qa.store.setState({ scrollY: 1 });
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.__packedWaveformQA.calls.length)).toBe(heldCalls);
  await page.evaluate(() => {
    const qa = window.__packedWaveformQA;
    qa.hold = false;
    for (const item of qa.pending.splice(0)) item.resolve(item.payload);
  });
  await expect.poll(() => page.evaluate(() => {
    const stage = window.Konva.stages.find((item) => item.height() > 50 && item.container().closest(".workspace"));
    return stage?.find("Line").filter((node) => node instanceof window.Konva.Line && node.closed() && node.opacity() === 0.6).length ?? 0;
  })).toBe(4);
});
