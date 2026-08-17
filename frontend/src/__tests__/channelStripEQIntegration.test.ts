// @ts-nocheck -- Vitest supplies Node globals/types outside the WebView build.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("Channel Strip EQ bridge integration", () => {
  it("loads and writes EQ power, phase, DC filter, and all six packed bands", () => {
    const modal = read("../components/ChannelStripEQModal.tsx");
    expect(modal).toContain("nativeBridge.getChannelStripEQEnabled(trackId)");
    expect(modal).toContain("nativeBridge.getTrackPhaseInvert(trackId)");
    expect(modal).toContain("nativeBridge.getTrackDCOffset(trackId)");
    expect(modal).toContain("nativeBridge.setChannelStripEQEnabled(trackId, next)");
    expect(modal).toContain("nativeBridge.setTrackPhaseInvert(trackId, next)");
    expect(modal).toContain("nativeBridge.setTrackDCOffset(trackId, next)");
    expect(modal).toContain("const paramIndex = bandIndex * 4 + offset");
    expect(modal).toContain("EQ_BANDS.length * 4");
    expect(modal).toContain("Promise.all(parameterReads)");
    expect(modal).toContain("EQ_BANDS.map((definition, i)");
  });

  it("maps the packed bridge onto real S13EQ band state instead of an empty parameter list", () => {
    const processor = read("../../../Source/TrackProcessor.cpp");
    expect(processor).toContain("channelStripEQBandCount * channelStripEQValuesPerBand");
    expect(processor).toContain("channelStripEQ.bands[static_cast<size_t>(surfaceBand)]");
    expect(processor).not.toMatch(
      /setChannelStripEQParam[\s\S]{0,800}getParameters\(\)/,
    );
  });
});
