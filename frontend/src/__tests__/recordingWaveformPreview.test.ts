import { describe, expect, it, vi } from "vitest";
import type { WaveformPeak } from "../services/NativeBridge";
import {
  MAX_RECORDING_PEAK_BASE_ENTRIES, MAX_RECORDING_PREVIEW_PEAKS, RECORDING_PEAK_STRIDE,
  planRecordingPreviewWindow, recordingPeakX, RecordingPreviewScheduler,
  type RecordingPreviewView, type RecordingWaveformCache,
} from "../utils/recordingWaveformPreview";

const peaks = (count: number): WaveformPeak[] => Array.from({ length: count }, () => ({
  channels: [{ min: -0.25, max: 0.5 }],
}));
function view(): RecordingPreviewView {
  return {
    clips: [{ trackId: "a", startTime: 0 }, { trackId: "b", startTime: 0 }],
    sampleRate: 44100, pixelsPerSecond: 100, width: 1280, scrollX: 55000, currentTime: 556,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function fixture() {
  let current: RecordingPreviewView | null = view();
  let suspended = false;
  let cache: RecordingWaveformCache = new Map();
  const request = vi.fn(async (_track: string, _spp: number, count: number, _start: number) => peaks(count));
  const publish = vi.fn((next: RecordingWaveformCache) => { cache = next; });
  const onError = vi.fn();
  const scheduler = new RecordingPreviewScheduler({
    readView: () => current, isSuspended: () => suspended, request, publish, onError,
  });
  return {
    scheduler, request, publish, onError,
    get cache() { return cache; },
    setView(next: RecordingPreviewView | null) { current = next; },
    suspend(value: boolean) { suspended = value; },
  };
}

describe("bounded live recording waveform windows", () => {
  it("covers the visible portion of long takes with complete aligned bins at every supported zoom", () => {
    for (const sampleRate of [8000, 44100, 48000, 96000, 384000])
      for (const pixelsPerSecond of [1, 34.784, 100, 1000])
        for (const width of [640, 3840, 16384]) {
          const current = { ...view(), sampleRate, pixelsPerSecond, width, scrollX: 550 * pixelsPerSecond };
          const window = planRecordingPreviewWindow(current, current.clips[0])!;
          expect(window).not.toBeNull();
          expect(window.numPixels).toBeLessThanOrEqual(MAX_RECORDING_PREVIEW_PEAKS);
          expect(window.samplesPerPixel % RECORDING_PEAK_STRIDE).toBe(0);
          expect(Number.isInteger(Math.log2(window.samplesPerPixel))).toBe(true);
          expect(window.startSample % window.samplesPerPixel).toBe(0);
          expect(window.startSample).toBeLessThanOrEqual(550 * sampleRate);
          const end = window.startSample + window.numPixels * window.samplesPerPixel;
          expect(end).toBeLessThanOrEqual(current.currentTime * sampleRate);
          const visibleEnd = Math.min(current.currentTime, 550 + width / pixelsPerSecond);
          expect(end).toBeGreaterThan(visibleEnd * sampleRate - window.samplesPerPixel);
        }
  });

  it("uses clip-relative samples and skips absent or incomplete visible data", () => {
    const current = { ...view(), clips: [{ trackId: "a", startTime: 550 }] };
    expect(planRecordingPreviewWindow(current, current.clips[0])?.startSample).toBe(0);
    expect(planRecordingPreviewWindow({ ...current, currentTime: 550.001 }, current.clips[0])).toBeNull();
    expect(planRecordingPreviewWindow({ ...current, scrollX: 0 }, current.clips[0])).toBeNull();
    for (const patch of [{ sampleRate: 0 }, { pixelsPerSecond: 0 }, { width: 0 }, { currentTime: NaN }])
      expect(planRecordingPreviewWindow({ ...current, ...patch }, current.clips[0])).toBeNull();
  });

  it("projects cached samples at the current zoom and scroll without shifting their audio time", () => {
    const data = { peaks: peaks(2), recordingStartTime: 10, sampleRate: 48000, samplesPerPixel: 512, startSample: 96000 };
    for (const zoom of [1, 34.784, 100, 1000]) {
      const x = recordingPeakX(data, 1, zoom, 320);
      expect((x + 320) / zoom).toBeCloseTo(12 + 512 / 48000, 10);
      expect(x - recordingPeakX(data, 0, zoom, 320)).toBeCloseTo(512 / 48000 * zoom, 10);
    }
  });
});

describe("live recording request lifecycle", () => {
  it("coalesces zoom and scroll changes while one old request is outstanding", async () => {
    const f = fixture();
    const pending = deferred<WaveformPeak[]>();
    f.request.mockImplementationOnce(() => pending.promise);
    const running = f.scheduler.poll();
    for (let step = 0; step < 12; step++) {
      f.setView({ ...view(), pixelsPerSecond: 50 - step, scrollX: 550 * (50 - step) });
      f.scheduler.invalidate();
      await f.scheduler.poll();
    }
    expect(f.request).toHaveBeenCalledTimes(1);
    pending.resolve(peaks(1));
    await running;
    await settle();
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.map(call => call[0])).toEqual(["a", "a", "b"]);
    expect(f.publish).toHaveBeenCalledTimes(2);
    const final = planRecordingPreviewWindow({ ...view(), pixelsPerSecond: 39, scrollX: 550 * 39 }, view().clips[0])!;
    expect(f.cache.get("a")?.samplesPerPixel).toBe(final.samplesPerPixel);
  });

  it("Stop clears the preview and prevents an obsolete second-track request or publication", async () => {
    const f = fixture();
    await f.scheduler.poll();
    const pending = deferred<WaveformPeak[]>();
    f.setView({ ...view(), currentTime: 557 });
    f.request.mockImplementationOnce(() => pending.promise);
    const running = f.scheduler.poll();
    const count = f.request.mock.calls.length;
    f.setView(null);
    f.scheduler.invalidate(true);
    const publications = f.publish.mock.calls.length;
    pending.resolve(peaks(100));
    await running;
    await settle();
    expect(f.cache.size).toBe(0);
    expect(f.request).toHaveBeenCalledTimes(count);
    expect(f.publish).toHaveBeenCalledTimes(publications);
  });

  it("ignores an unmounted completion and can resume after a StrictMode remount", async () => {
    const f = fixture();
    const pending = deferred<WaveformPeak[]>();
    f.request.mockImplementationOnce(() => pending.promise);
    const running = f.scheduler.poll();
    f.scheduler.setActive(false);
    pending.reject(new Error("old request"));
    await running;
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    f.scheduler.setActive(true);
    await f.scheduler.poll();
    expect(f.cache.size).toBe(2);
  });

  it("appends returned prefixes without refetching already completed bins", async () => {
    const f = fixture();
    f.request.mockImplementation(async (_track, _spp, count) => peaks(Math.min(100, count)));
    await f.scheduler.poll();
    const first = f.request.mock.calls.slice();
    f.setView({ ...view(), currentTime: 557 }); // Time alone must not invalidate the cache.
    await f.scheduler.poll();
    expect(f.request.mock.calls[2][3]).toBe(first[0][3] + 100 * first[0][1]);
    expect(f.cache.get("a")?.peaks.length).toBe(200);
    expect(f.cache.get("b")?.peaks.length).toBe(200);
  });

  it("bounds native work at minimum zoom for multi-hour takes and caps oversized responses", async () => {
    const f = fixture();
    f.setView({ ...view(), sampleRate: 384000, pixelsPerSecond: 1, scrollX: 10000, currentTime: 14400, width: 3840 });
    f.request.mockImplementation(async (_track, _spp, count) => peaks(count + 20));
    await f.scheduler.poll();
    for (const [track, spp, count] of f.request.mock.calls) {
      expect(count).toBeLessThanOrEqual(MAX_RECORDING_PREVIEW_PEAKS);
      expect(count * (spp / RECORDING_PEAK_STRIDE + 1)).toBeLessThanOrEqual(MAX_RECORDING_PEAK_BASE_ENTRIES);
      expect(f.cache.get(track)?.peaks.length).toBe(count);
    }
  });

  it("suspends fetching during a gesture and retires removed or newly recorded tracks", async () => {
    const f = fixture();
    f.suspend(true);
    await f.scheduler.poll();
    expect(f.request).not.toHaveBeenCalled();
    f.suspend(false);
    await f.scheduler.poll();
    f.setView({ ...view(), clips: [{ trackId: "a", startTime: 555 }] });
    f.scheduler.invalidate();
    await f.scheduler.poll();
    expect([...f.cache.keys()]).toEqual(["a"]);
    expect(f.cache.get("a")?.recordingStartTime).toBe(555);
    expect(f.cache.get("a")?.startSample).toBe(0);
  });
});
