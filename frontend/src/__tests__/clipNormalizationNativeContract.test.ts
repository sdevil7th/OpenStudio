import { describe, expect, it } from "vitest";
import audioEngineHeader from "../../../Source/AudioEngine.h?raw";
import audioEngineSource from "../../../Source/AudioEngine.cpp?raw";
import mainComponentHeader from "../../../Source/MainComponent.h?raw";
import mainComponentSource from "../../../Source/MainComponent.cpp?raw";
import nativeBridgeSource from "../services/NativeBridge.ts?raw";

describe("clip normalization native contract", () => {
  it("exposes an asynchronous exact-range peak bridge from TypeScript through JUCE", () => {
    expect(nativeBridgeSource).toContain("getAudioPeakAmplitude?: (");
    expect(nativeBridgeSource).toContain("window.__JUCE__.backend.getAudioPeakAmplitude(");
    expect(mainComponentSource).toContain('.withNativeFunction ("getAudioPeakAmplitude"');
    expect(mainComponentSource).toContain("clipPeakAnalysisPool.addJob");
    expect(mainComponentSource).toContain("audioEngine.getAudioPeakAmplitude(");
    expect(mainComponentHeader).toContain("juce::ThreadPool clipPeakAnalysisPool");
    expect(audioEngineHeader).toContain("double getAudioPeakAmplitude(const juce::String& filePath");
  });

  it("reads the trimmed sample window in blocks and inspects every channel", () => {
    expect(audioEngineSource).toContain("std::floor(exactStart)");
    expect(audioEngineSource).toContain("std::ceil(juce::jmin(");
    expect(audioEngineSource).toContain("for (juce::int64 blockStart = startSample; blockStart < endSample;)");
    expect(audioEngineSource).toContain("for (int channel = 0; channel < numChannels; ++channel)");
    expect(audioEngineSource).toContain("for (int sample = 0; sample < samplesThisBlock; ++sample)");
    expect(audioEngineSource).toContain("peak = juce::jmax(peak, static_cast<double>(std::abs(value)))");
    expect(audioEngineSource).toContain("if (! std::isfinite(value))");
  });
});
