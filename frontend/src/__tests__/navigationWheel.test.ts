import { afterEach, describe, expect, it } from "vitest";
import { useDAWStore } from "../store/useDAWStore";
import { resolveProfiledNavigationWheel } from "../utils/navigationWheel";
import { getParameterWheelValue } from "../utils/parameterWheel";

const originalProfile = useDAWStore.getState().mouseBehaviorProfileId;
afterEach(() => useDAWStore.setState({ mouseBehaviorProfileId: originalProfile }));

describe("EQ viewport pan wheel policy", () => {
  it("uses Cubase horizontal navigation while passing plain vertical scroll through", () => {
    useDAWStore.setState({ mouseBehaviorProfileId: "cubase" });
    const scroll = resolveProfiledNavigationWheel({ deltaY: 100 });
    expect(scroll).toMatchObject({ operation: "native-scroll", preventDefault: false, stopPropagation: false });
    const pan = resolveProfiledNavigationWheel({ deltaY: 100, shiftKey: true });
    expect(pan).toMatchObject({ ruleId: "cubase.shift-horizontal-scroll", operation: "adjust", target: "viewport", amount: -100 });
    expect(getParameterWheelValue(pan, { min: 0, max: 10, value: 5, step: .1 })).toBe(5.1);
  });

  it("uses REAPER Alt navigation without mistaking its plain zoom for a parameter edit", () => {
    useDAWStore.setState({ mouseBehaviorProfileId: "reaper" });
    expect(resolveProfiledNavigationWheel({ deltaY: 100 }).operation).toBe("native-scroll");
    expect(resolveProfiledNavigationWheel({ deltaY: 100, altKey: true })).toMatchObject({ ruleId: "reaper.horizontal-scroll", operation: "adjust", target: "viewport" });
  });
});
