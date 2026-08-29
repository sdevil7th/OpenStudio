import { afterEach, describe, expect, it } from "vitest";
import { getSliderWheelSubtarget } from "../components/ui/Slider/Slider";
import { useDAWStore } from "../store/useDAWStore";
import { resolveProfiledParameterWheel } from "../utils/parameterWheel";
import { getShortcutPlatform } from "../utils/platform";
import sliderSource from "../components/ui/Slider/Slider.tsx?raw";
import knobSource from "../components/ui/Knob/Knob.tsx?raw";
import {
  beginEditTransaction,
  commitEditTransaction,
  createEditTransactionLifecycle,
} from "../components/ui/editTransactionLifecycle";

const originalMouseProfile = useDAWStore.getState().mouseBehaviorProfileId;

function hostPrimaryModifier(): { ctrlKey: true } | { metaKey: true } {
  return getShortcutPlatform() === "macos" ? { metaKey: true } : { ctrlKey: true };
}

afterEach(() => {
  useDAWStore.setState({ mouseBehaviorProfileId: originalMouseProfile });
});

describe("profiled Slider wheel routing", () => {
  it("captures an edit's original commit and ends cancel/lost-capture races exactly once", () => {
    const events: string[] = [];
    const lifecycle = createEditTransactionLifecycle();
    expect(beginEditTransaction(
      lifecycle,
      () => events.push("begin"),
      () => events.push("original commit"),
    )).toBe(true);
    expect(beginEditTransaction(
      lifecycle,
      () => events.push("duplicate begin"),
      () => events.push("replacement commit"),
    )).toBe(false);
    expect(commitEditTransaction(lifecycle)).toBe(true);
    expect(commitEditTransaction(lifecycle)).toBe(false);
    expect(events).toEqual(["begin", "original commit"]);
  });

  it("captures the commit callback at wheel begin and keeps cleanup identity stable", () => {
    for (const source of [sliderSource, knobSource]) {
      expect(source).toContain("const wheelCommitCallbackRef = useRef");
      expect(source).toContain("wheelCommitCallbackRef.current = onCommitEdit");
      expect(source).toContain("const commitWheelEdit = useCallback(() => {");
      expect(source).toContain("}, []);");
      expect(source).toContain("createWheelDeltaAccumulator({");
      expect(source).toContain("onReset: () => commitWheelEditRef.current()");
      expect(source).toContain("accumulator.dispose()");
      expect(source).not.toContain("wheelCommitTimerRef");
    }
    expect(sliderSource).toContain("onKeyDown={handleTransactionalKeyDown}");
    expect(sliderSource).not.toContain("onKeyDown={onKeyDown}");
  });

  it("routes pointer drags, cancellation, resets, and cleanup through transactions", () => {
    expect(sliderSource).toContain("const applyDiscreteValue = useCallback");
    expect(sliderSource).toContain("applyDiscreteValue(defaultValue)");
    expect(sliderSource).toContain("beginEditTransaction(pointerEditRef.current, onBeginEdit, onCommitEdit)");
    expect(sliderSource).toContain("onPointerCancel={handlePanPointerEnd}");
    expect(sliderSource).toContain("onLostPointerCapture={handlePanPointerEnd}");
    expect(sliderSource).toContain("useEffect(() => () => commitPointerEdit(), [commitPointerEdit])");
    expect(sliderSource).not.toContain("document.addEventListener('mouseup'");

    expect(knobSource).toContain("beginEditTransaction(dragEditRef.current, onBeginEdit, onCommitEdit)");
    expect(knobSource).toContain("onPointerCancel={handlePointerCancel}");
    expect(knobSource).toContain("onLostPointerCapture={handlePointerCancel}");
    expect(knobSource).toContain("useEffect(() => () => commitDragEdit(), [commitDragEdit])");
  });

  it("opts only vertical faders into the console-fader hit target", () => {
    expect(getSliderWheelSubtarget("vertical", "fader")).toBe("console_fader");
    expect(getSliderWheelSubtarget("horizontal", "fader")).toBe("control");
    expect(getSliderWheelSubtarget("vertical", "default")).toBe("control");
    expect(getSliderWheelSubtarget("horizontal", "pan")).toBe("control");
  });

  it("makes Cakewalk plain/fine fader adjustment reachable and suppresses unsafe group edits", () => {
    useDAWStore.setState({ mouseBehaviorProfileId: "cakewalk_sonar" });
    const subtarget = getSliderWheelSubtarget("vertical", "fader");
    const resolve = (modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => (
      resolveProfiledParameterWheel({ ...modifiers, deltaY: -120 }, subtarget)
    );

    expect(resolve({})).toMatchObject({
      ruleId: "cakewalk-sonar.console-fader",
      operation: "adjust",
      precision: "normal",
    });
    expect(resolve({ shiftKey: true })).toMatchObject({
      ruleId: "cakewalk-sonar.console-fader-fine",
      operation: "adjust",
      precision: "fine",
    });
    expect(resolve(hostPrimaryModifier())).toMatchObject({
      ruleId: "cakewalk-sonar.console-all-faders",
      operation: "suppress",
    });
    expect(resolve({ ...hostPrimaryModifier(), shiftKey: true })).toMatchObject({
      ruleId: "cakewalk-sonar.console-selected-faders",
      operation: "suppress",
    });
  });
});
