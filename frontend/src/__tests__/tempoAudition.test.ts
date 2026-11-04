import { afterEach, describe, expect, it, vi } from "vitest";
import { TempoAuditionPlayer, tempoClickTimes, tempoFromBeatIntervals, tempoFromTapTimes } from "../utils/tempoAudition";

afterEach(() => vi.useRealTimers());

describe("tempo alignment controls", () => {
  it("keeps click phase in clip time across late preview windows and fractional BPM", () => {
    for (const bpm of [90, 137.23, 154.3, 239.97]) {
      const ticks = tempoClickTimes(bpm, 0.217, 300.125, 8);
      expect(ticks.length).toBeGreaterThan(0);
      for (const tick of ticks) {
        expect(tick.seconds).toBeGreaterThanOrEqual(0);
        expect(tick.seconds).toBeLessThan(8);
        expect(300.125 + tick.seconds).toBeCloseTo(0.217 + tick.beat * 60 / bpm, 10);
      }
    }
    expect(tempoClickTimes(NaN, 0, 0, 4)).toEqual([]);
  });
  it("uses median tap intervals and rejects invalid or stale taps", () => {
    expect(tempoFromTapTimes([0, 500, 1001, 1500, 2000])).toBeCloseTo(120, 1);
    expect(tempoFromTapTimes([0])).toBeNull();
    expect(tempoFromTapTimes([0, 50])).toBeNull();
    expect(tempoFromTapTimes([0, 5000])).toBeNull();
  });
  it("counts spaces between beats rather than inclusive beat labels", () => {
    expect(tempoFromBeatIntervals(10, 12, 4)).toBe(120);
    expect(tempoFromBeatIntervals(10, 12, 5)).toBe(150);
    expect(tempoFromBeatIntervals(10, 10, 4)).toBeNull();
    expect(tempoFromBeatIntervals(0, 4, 1.5)).toBeNull();
  });
});

class FakeSource {
  buffer: unknown; type = "sine"; frequency = { value: 440 }; playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  start = vi.fn(); stop = vi.fn(); connect = vi.fn(); disconnect = vi.fn();
}
class FakeContext {
  state = "running"; sampleRate = 48000; currentTime = 10; destination = {};
  sources: FakeSource[] = [];
  close = vi.fn(async () => { this.state = "closed"; });
  resume = vi.fn(async () => { this.state = "running"; });
  decodeAudioData = vi.fn(async (_data: ArrayBuffer) => this.createBuffer(1, 4 * 48000, 48000));
  createBuffer(channels: number, count: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(count));
    return { numberOfChannels: channels, duration: count / sampleRate, getChannelData: (channel: number) => data[channel] };
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
  createOscillator() { return this.createBufferSource(); }
  createGain() { return { gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; }
}

describe("isolated preview lifecycle", () => {
  it("plays source-only without a tempo and permits short windows between clicks", async () => {
    const context = new FakeContext();
    const player = new TempoAuditionPlayer(() => context as unknown as AudioContext);
    expect(await player.play({ bpm: NaN, phaseSeconds: NaN, rangeStartSeconds: 0, durationSeconds: 4, wavBase64: "AA==", clickLevel: 0 })).toBe(true);
    expect(context.sources).toHaveLength(1);
    player.stop();
    expect(await player.play({ bpm: 20, phaseSeconds: 1, rangeStartSeconds: 0, durationSeconds: 0.1, wavBase64: "AA==" })).toBe(true);
    expect(context.sources).toHaveLength(2);
    player.dispose();
  });
  it("retires a pending decode on Stop and never starts its late sources", async () => {
    const context = new FakeContext();
    let resolve!: (buffer: ReturnType<FakeContext["createBuffer"]>) => void;
    context.decodeAudioData.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const player = new TempoAuditionPlayer(() => context as unknown as AudioContext);
    const pending = player.play({ bpm: 120, phaseSeconds: 0.1, rangeStartSeconds: 0, durationSeconds: 4, wavBase64: "AA==" });
    await Promise.resolve(); await Promise.resolve();
    player.stop(); resolve(context.createBuffer(1, 4 * 48000, 48000));
    expect(await pending).toBe(false);
    expect(context.sources).toHaveLength(0);
    player.dispose(); expect(context.close).toHaveBeenCalledOnce();
  });
  it("schedules source and click on one clock and cancels every source", async () => {
    vi.useFakeTimers();
    const context = new FakeContext(), ended = vi.fn();
    const player = new TempoAuditionPlayer(() => context as unknown as AudioContext);
    expect(await player.play({ bpm: 120, phaseSeconds: 0.1, rangeStartSeconds: 0, durationSeconds: 4, wavBase64: "AA==", onEnded: ended })).toBe(true);
    expect(context.sources[0].start).toHaveBeenCalledWith(10.05, 0, 4);
    expect(context.sources[1].start).toHaveBeenCalledWith(10.15);
    expect(context.sources[2].start.mock.calls[0][0]).toBeCloseTo(10.65, 10);
    player.stop();
    expect(context.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
    vi.advanceTimersByTime(5000); expect(ended).not.toHaveBeenCalled();
    player.dispose();
  });
  it("bounds guide-note work and automatically retires a completed audition", async () => {
    vi.useFakeTimers();
    const context = new FakeContext(), ended = vi.fn();
    const player = new TempoAuditionPlayer(() => context as unknown as AudioContext);
    await player.play({ bpm: 120, phaseSeconds: 0, rangeStartSeconds: 0, durationSeconds: 4,
      notes: Array.from({ length: 10_000 }, () => ({ startSeconds: 0, durationSeconds: 4, pitch: 60, velocity: 80 })), onEnded: ended });
    expect(context.sources.length).toBeLessThanOrEqual(24);
    vi.advanceTimersByTime(4100); expect(ended).toHaveBeenCalledOnce();
    expect(context.sources.every(source => source.stop.mock.calls.length >= 1 && source.disconnect.mock.calls.length >= 1)).toBe(true);
    player.dispose();
  });
});
