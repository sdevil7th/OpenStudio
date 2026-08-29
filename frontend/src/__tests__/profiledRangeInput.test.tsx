import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfiledRangeInput } from "../components/ui/ProfiledRangeInput";
import { useDAWStore } from "../store/useDAWStore";
import { getParameterWheelValue, resolveProfiledParameterWheel } from "../utils/parameterWheel";
import profiledRangeSource from "../components/ui/ProfiledRangeInput/ProfiledRangeInput.tsx?raw";
import builtInPluginSource from "../components/BuiltInPluginPanel.tsx?raw";
import channelEqSource from "../components/ChannelStripEQModal.tsx?raw";
import fxChainSource from "../components/FXChainPanel.tsx?raw";
import pitchCorrectorSource from "../components/PitchCorrectorPanel.tsx?raw";
import correctPitchSource from "../components/CorrectPitchModal.tsx?raw";
import pianoRollSource from "../components/PianoRoll.tsx?raw";
import controllerLaneSource from "../components/PianoRollControllerLaneSection.tsx?raw";
import preferencesSource from "../components/PreferencesModal.tsx?raw";

const allComponentSources = import.meta.glob("../components/**/*.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const originalMouseProfile = useDAWStore.getState().mouseBehaviorProfileId;

afterEach(() => {
  useDAWStore.setState({ mouseBehaviorProfileId: originalMouseProfile });
});

describe("ProfiledRangeInput", () => {
  it("stays visually bare and preserves caller styling and accessibility attributes", () => {
    const html = renderToStaticMarkup(
      <ProfiledRangeInput
        min={-12}
        max={12}
        step={0.1}
        value={1.5}
        onValueChange={() => undefined}
        className="existing-range-style"
        style={{ writingMode: "horizontal-tb" }}
        aria-label="Formant shift"
        title="Existing title"
      />,
    );

    expect(html).toContain('type="range"');
    expect(html).toContain('class="existing-range-style"');
    expect(html).toContain('aria-label="Formant shift"');
    expect(html).toContain('title="Existing title"');
    expect(html).not.toContain("profiled-range-wrapper");
  });

  it("resolves Cubase plain, fine, and unsupported modifier gestures exactly", () => {
    useDAWStore.setState({ mouseBehaviorProfileId: "cubase" });

    const plain = resolveProfiledParameterWheel({ deltaY: -100 }, "control");
    const fine = resolveProfiledParameterWheel({ deltaY: -100, shiftKey: true }, "control");
    const unsupported = resolveProfiledParameterWheel({ deltaY: -100, altKey: true }, "control");

    expect(plain).toMatchObject({
      ruleId: "cubase.parameter-adjust",
      operation: "adjust",
      precision: "normal",
      preventDefault: true,
      stopPropagation: true,
    });
    expect(fine).toMatchObject({
      ruleId: "cubase.parameter-fine-adjust",
      operation: "adjust",
      precision: "fine",
      preventDefault: true,
      stopPropagation: true,
    });
    expect(unsupported).toMatchObject({
      ruleId: "cubase.parameter-unsupported-wheel",
      operation: "suppress",
      preventDefault: true,
      stopPropagation: true,
    });
    expect(getParameterWheelValue(plain, {
      min: 0,
      max: 1,
      value: 0.5,
      step: 0.1,
    })).toBe(0.6);
    expect(getParameterWheelValue(fine, {
      min: 0,
      max: 1,
      value: 0.5,
      step: 0.1,
    })).toBe(0.51);
    expect(getParameterWheelValue(unsupported, {
      min: 0,
      max: 1,
      value: 0.5,
      step: 0.1,
    })).toBe(0.5);
  });

  it("owns resolved event cancellation and captures all edit completion paths", () => {
    expect(profiledRangeSource).toContain("resolveProfiledParameterWheel(event.nativeEvent, wheelSubtarget)");
    expect(profiledRangeSource).toContain("if (gesture.preventDefault) event.preventDefault()");
    expect(profiledRangeSource).toContain("if (gesture.stopPropagation) event.stopPropagation()");
    expect(profiledRangeSource).toContain('if (gesture.operation !== "adjust") {');
    expect(profiledRangeSource).toContain("getParameterWheelValue({ ...gesture, amount: emittedAmount }");
    expect(profiledRangeSource).toContain("beginEditTransaction(wheelEditRef.current, onBeginEdit, onCommitEdit)");
    expect(profiledRangeSource).toContain("createWheelDeltaAccumulator({");
    expect(profiledRangeSource).toContain("wheelAccumulatorRef.current?.consume(targetKey, gesture.amount)");
    expect(profiledRangeSource).toContain("accumulator.dispose()");
    expect(profiledRangeSource).toContain("onPointerCancel={handlePointerCancel}");
    expect(profiledRangeSource).toContain("onLostPointerCapture={handleLostPointerCapture}");
    expect(profiledRangeSource).toContain("onBlur={handleBlur}");
    expect(profiledRangeSource).toContain("commitEditTransaction(keyEdit)");
  });
});

describe("profiled native range coverage", () => {
  const coveredSources = [
    ["BuiltInPluginPanel", builtInPluginSource, 1],
    ["ChannelStripEQModal", channelEqSource, 3],
    ["FXChainPanel", fxChainSource, 2],
    ["PitchCorrectorPanel", pitchCorrectorSource, 2],
    ["CorrectPitchModal", correctPitchSource, 2],
    ["PianoRoll", pianoRollSource, 2],
    ["PianoRollControllerLaneSection", controllerLaneSource, 1],
    ["PreferencesModal", preferencesSource, 1],
  ] as const;

  it.each(coveredSources)("routes every %s range through ProfiledRangeInput", (_name, source, expectedCount) => {
    expect(source.match(/<ProfiledRangeInput\b/g) ?? []).toHaveLength(expectedCount);
    expect(source).not.toContain('type="range"');
  });

  it("leaves no unmanaged native range outside profiled controls and the existing NAM controls", () => {
    const filesWithNativeRanges = Object.entries(allComponentSources)
      .filter(([, source]) => /type\s*=\s*["']range["']/.test(source))
      .map(([path]) => path)
      .sort();
    const allowedNativeRangeImplementations = new Set<string>([
      "../components/NAMRackKnob.tsx",
      "../components/NAMRackPanel.tsx",
      "../components/ui/ProfiledRangeInput/ProfiledRangeInput.tsx",
      "../components/ui/Slider/Slider.tsx",
    ]);

    expect(filesWithNativeRanges.filter((path) => !allowedNativeRangeImplementations.has(path))).toEqual([]);
    expect(filesWithNativeRanges).toContain("../components/ui/ProfiledRangeInput/ProfiledRangeInput.tsx");
    expect(filesWithNativeRanges).toContain("../components/ui/Slider/Slider.tsx");
  });

  it("keeps plugin automation touch paired across pointer, wheel, key and cleanup commits", () => {
    expect(fxChainSource).toContain("onBeginEdit={() => {");
    expect(fxChainSource).toContain("beginAutomationParamTouch(");
    expect(fxChainSource).toContain("onCommitEdit={() => {");
    expect(fxChainSource).toContain("endAutomationParamTouch(");
  });
});
