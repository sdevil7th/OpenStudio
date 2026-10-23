import { describe, expect, it } from "vitest";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import { reverbParameterPresentation } from "../utils/reverbParameterPresentation";

const parameter: BuiltInParamDescriptor = { id: "roomSize", label: "Size", type: "continuous", min: 0, max: 1, value: .5, defaultValue: .5 };
describe("reverb presentation preserves native automation", () => {
  it("displays shaped duration in milliseconds and converts entered values back", () => {
    const view = reverbParameterPresentation(parameter, 36);
    expect(view.parameter).toMatchObject({ id: "roomSize", unit: "ms", min: 25, max: 2000, value: 1012.5, defaultValue: 1012.5 });
    expect(view.toNative(25)).toBe(0);
    expect(view.toNative(2000)).toBe(1);
    expect(view.toNative(500)).toBeCloseTo(475 / 1975);
    expect(view.toNative(view.parameter.defaultValue)).toBe(.5);
    expect(parameter.value).toBe(.5);
  });
  it("leaves other room controls and their native IDs untouched", () => {
    for (let type = 0; type < 41; ++type) if (type !== 36) {
      const view = reverbParameterPresentation(parameter, type);
      expect(view.parameter).toBe(parameter);
      expect(view.toNative(.42)).toBe(.42);
    }
  });
  it("resets Shimmer to its bank default without changing the stored current value", () => {
    const amount = { ...parameter, id: "shimmerAmount", value: .8, defaultValue: 0 };
    expect(reverbParameterPresentation(amount, 5).parameter).toMatchObject({ value: .8, defaultValue: .5 });
    expect(reverbParameterPresentation(amount, 0).parameter.defaultValue).toBe(0);
  });
});
