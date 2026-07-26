import { describe, expect, it } from "vitest";
import { builtInAutomationParamId, pluginAutomationParamId } from "../store/automationParams";

describe("stable built-in automation ids", () => {
  it("uses the schema parameter id instead of a fragile parameter-array index", () => {
    expect(builtInAutomationParamId(false, 2, "ampGainDb"))
      .toBe("builtin_track_2_ampGainDb");
    expect(builtInAutomationParamId(true, 0, "band0.freq"))
      .toBe("builtin_input_0_band0.freq");
  });

  it("keeps third-party plugin automation ids backward compatible", () => {
    expect(pluginAutomationParamId(false, 2, 17)).toBe("plugin_track_2_17");
  });
});
