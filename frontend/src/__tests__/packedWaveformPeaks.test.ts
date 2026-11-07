import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLegacyWaveformPeaks, decodePackedWaveformPeaks } from "../utils/packedWaveformPeaks";
import { nativeBridge } from "../services/NativeBridge";

function packed(samples: number[], channels = 1) {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return { format: "openstudio.waveform.f32", version: 1, byteOrder: "little", channels,
    peakCount: channels === 0 ? 0 : samples.length / (channels * 2), byteLength: bytes.length,
    data: btoa(String.fromCharCode(...bytes)) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); (nativeBridge as unknown as { isNative: boolean }).isNative = false; });

describe("lossless packed waveform transport", () => {
  it("preserves stereo Float32 extrema including signed zero, subnormals and extremes", () => {
    const values = [-0, 0, -Math.fround(2 ** -149), Math.fround(2 ** -149),
      -Math.fround(3.4028234663852886e38), Math.fround(3.4028234663852886e38), -0.125, 0.75];
    const decoded = decodePackedWaveformPeaks(packed(values, 2));
    const actual = decoded.flatMap((peak) => peak.channels.flatMap((channel) => [channel.min, channel.max]));
    expect(actual.length).toBe(values.length);
    actual.forEach((value, index) => expect(Object.is(value, values[index])).toBe(true));
  });

  it("accepts explicit empty data while rejecting unknown versions, byte order, dimensions and truncated data", () => {
    expect(decodePackedWaveformPeaks(packed([], 0))).toEqual([]);
    const valid = packed([-0.5, 0.75]);
    for (const patch of [{ version: 2 }, { byteOrder: "big" }, { channels: -1 }, { channels: 65 },
      { channels: 0 }, { peakCount: 0.5 }, { peakCount: 32769 }, { byteLength: 7 },
      { data: "!!!=" }, { data: valid.data.slice(0, -4) }, { error: "source failed" }]) {
      expect(() => decodePackedWaveformPeaks({ ...valid, ...patch })).toThrow();
    }
    expect(() => decodePackedWaveformPeaks(packed([NaN, 1]))).toThrow(/Non-finite/);
    expect(() => decodePackedWaveformPeaks(packed([-1, Infinity]))).toThrow(/Non-finite/);
  });

  it("uses packed native data without invoking the legacy bridge and retains all range arguments", async () => {
    const modern = vi.fn().mockResolvedValue(packed([-0.125, 0.75], 1));
    const legacy = vi.fn();
    vi.stubGlobal("window", { __JUCE__: { backend: { getWaveformPeaksPacked: modern, getWaveformPeaks: legacy } } });
    (nativeBridge as unknown as { isNative: boolean }).isNative = true;
    expect(await nativeBridge.getWaveformPeaks("trimmed.wav", 1024, 4096, 4096, 4133, 9011))
      .toEqual([{ channels: [{ min: -0.125, max: 0.75 }] }]);
    expect(modern).toHaveBeenCalledWith("trimmed.wav", 1024, 4096, 4096, 4133, 9011);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("falls back to exact legacy data after malformed packed data, and fails when no fallback exists", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const modern = vi.fn().mockResolvedValue({ format: "unknown" });
    const legacy = vi.fn().mockResolvedValue([1, -0.5, 0.25]);
    vi.stubGlobal("window", { __JUCE__: { backend: { getWaveformPeaksPacked: modern, getWaveformPeaks: legacy } } });
    (nativeBridge as unknown as { isNative: boolean }).isNative = true;
    expect(await nativeBridge.getWaveformPeaks("legacy.wav", 256, 0, 4096))
      .toEqual([{ channels: [{ min: -0.5, max: 0.25 }] }]);
    expect(legacy).toHaveBeenCalledOnce();
    legacy.mockResolvedValue([1, NaN, 1]);
    await expect(nativeBridge.getWaveformPeaks("legacy.wav", 256, 0, 4096)).rejects.toThrow(/Invalid legacy/);
    delete window.__JUCE__!.backend.getWaveformPeaks;
    await expect(nativeBridge.getWaveformPeaks("legacy.wav", 256, 0, 4096)).rejects.toThrow(/Unsupported/);
  });

  it("rejects invalid legacy fallback dimensions instead of supplying zero or invented peaks", () => {
    for (const value of [null, [0], [65], [2, 0, 1], [1, -1, NaN], [1, "0", 1]]) {
      expect(() => decodeLegacyWaveformPeaks(value)).toThrow();
    }
    expect(decodeLegacyWaveformPeaks([])).toEqual([]);
  });
});
