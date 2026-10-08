import { describe, expect, it } from "vitest";
import { parseFXStageState, type FXStageSlotState } from "../services/fxStageState";

const slot: FXStageSlotState = { automationKey: "instance", name: "Vendor", type: "vst3", pluginPath: "vendor.vst3",
  pluginFormat: "VST3", state: "opaque", bypassed: false, forceFloat: false };
describe("native FX stage boundary", () => {
  it("preserves complete opaque state and does not retain mutable payload references", () => {
    const payload = [{ ...slot }], parsed = parseFXStageState(payload);
    expect(parsed).toEqual(payload);
    payload[0].state = "changed";
    expect(parsed[0].state).toBe("opaque");
    expect(parseFXStageState([])).toEqual([]);
  });
  it.each([null, {}, [null], [{ ...slot, state: 12 }], [{ ...slot, bypassed: "false" }],
    [{ ...slot, pluginPath: "" }], [{ ...slot, type: "unsupported" }], [slot, slot], Array(129).fill(slot)])(
    "rejects malformed or ambiguous snapshots before they enter history", value => {
      expect(() => parseFXStageState(value)).toThrow();
    });
});
