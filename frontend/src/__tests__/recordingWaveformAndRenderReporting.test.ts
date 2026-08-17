import { describe, expect, it } from "vitest";
import timelineSource from "../components/Timeline.tsx?raw";
import renderModalSource from "../components/RenderModal.tsx?raw";
import nativeBridgeSource from "../services/NativeBridge.ts?raw";
import mainComponentSource from "../../../Source/MainComponent.cpp?raw";

describe("live recording waveform regression guards", () => {
  it("requests only the missing recording peak tail", () => {
    expect(timelineSource).toContain(
      "const startSample = previousPeaks.length * samplesPerPixel",
    );
    expect(timelineSource).toContain(
      "Math.ceil(Math.max(0, recordedSamples - startSample) / samplesPerPixel)",
    );
    expect(timelineSource).toContain(
      "samplesPerPixel,\n            missingPixels,\n            startSample",
    );
    expect(timelineSource).toContain("if (inFlight) return;");
    expect(nativeBridgeSource).toContain("startSample = 0");
    expect(nativeBridgeSource).toContain(
      "numPixels,\n        startSample",
    );
  });

  it("sizes and clips the preview from actual returned peaks", () => {
    expect(timelineSource).toContain(
      "const widthPixels = peaks.length * samplesPerPixel / deviceSR * pixelsPerSecond",
    );
    expect(timelineSource).toContain("const firstVisiblePeak = Math.max(");
    expect(timelineSource).toContain("const lastVisiblePeak = Math.min(");
  });
});

describe("render result reporting regression guards", () => {
  it("does not impose the generic 15-second bridge timeout on offline renders", () => {
    expect(mainComponentSource).toContain(
      "const NO_TIMEOUT_FUNCTIONS = ['scanForPlugins', 'renderProject', 'renderProjectWithDither']",
    );
  });

  it("checks native boolean results and distinguishes later-stage failures", () => {
    expect(renderModalSource).toContain("if (!success)");
    expect(renderModalSource).toContain("Audio engine rejected the ${params.source} render");
    expect(renderModalSource).toContain(
      "Primary render completed, but the secondary ${secondaryOutputFormat.toUpperCase()} output failed",
    );
    expect(renderModalSource).toContain("primary file${renderedFiles.length === 1 ? \" was\" : \"s were\"} rendered successfully");
  });
});
