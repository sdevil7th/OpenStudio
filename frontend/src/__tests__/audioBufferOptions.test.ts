import { describe, expect, it } from "vitest";
import {
  resolveAudioBufferSizeOptions,
  resolveAudioBufferSizeRequest,
} from "../utils/audioBufferOptions";

describe("audio-buffer options", () => {
  it("keeps every driver-reported size, including 8 samples", () => {
    expect(resolveAudioBufferSizeOptions([
      8,
      16,
      32,
      64,
      128,
      256,
      512,
    ])).toEqual([8, 16, 32, 64, 128, 256, 512]);
  });

  it("normalizes duplicate and invalid capability values only", () => {
    expect(resolveAudioBufferSizeOptions([
      256,
      8,
      64,
      8,
      0,
      Number.NaN,
    ])).toEqual([8, 64, 256]);
  });

  it("includes the active size when the driver capability list omits it", () => {
    expect(resolveAudioBufferSizeOptions([64, 128, 256], 32))
      .toEqual([32, 64, 128, 256]);
  });

  it("preserves a supported low-latency user choice without coercion", () => {
    expect(resolveAudioBufferSizeRequest(8, [8, 16, 32, 64]))
      .toBe(8);
  });

  it("uses a fallback only when the requested and reported data are absent", () => {
    expect(resolveAudioBufferSizeOptions([])).toEqual([512]);
    expect(resolveAudioBufferSizeRequest(undefined, [64, 128]))
      .toBe(64);
  });
});
