import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { createSuiteParameterWheel, parseSuiteParameterDraft } from "../utils/suiteParameterGesture";
import { BuiltInPluginParamHistory } from "../utils/builtInPluginParamHistory";

const originalProfile = useDAWStore.getState().mouseBehaviorProfileId;
const descriptor = (value = .5): BuiltInParamDescriptor => ({ id: "mix", label: "Mix", type: "continuous", min: 0, max: 1, value, defaultValue: .5 });
afterEach(() => { useDAWStore.setState({ mouseBehaviorProfileId: originalProfile }); vi.useRealTimers(); });

function control(initial = .5) {
  let parameter = descriptor(initial);
  const history = new BuiltInPluginParamHistory("chorus-instance");
  const commits: Promise<boolean>[] = [];
  const begin = vi.fn(() => { history.begin(parameter.id, parameter.label, parameter.value); });
  const commit = vi.fn(() => { commits.push(history.commit(async () => true)); });
  const change = vi.fn((value: number) => { history.update(parameter.id, value); parameter = { ...parameter, value }; });
  const wheel = createSuiteParameterWheel({ parameter: () => parameter, begin, commit, change });
  return { wheel, history, commits, begin, commit, change, value: () => parameter.value };
}

describe("suite knob gestures", () => {
  it("writes fractional packets once representable and keeps a wheel burst in one undo step", async () => {
    vi.useFakeTimers(); useDAWStore.setState({ mouseBehaviorProfileId: "cubase" });
    const knob = control();
    for (let i = 0; i < 9; i++) knob.wheel.wheel({ deltaY: -.1 });
    expect(knob.change).not.toHaveBeenCalled();
    for (let i = 9; i < 100; i++) knob.wheel.wheel({ deltaY: -.1 });
    expect(knob.value()).toBeCloseTo(.5008, 10);
    expect(knob.begin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180); await Promise.all(knob.commits);
    expect(knob.commit).toHaveBeenCalledTimes(1);
    expect(knob.history.getUndoEntries()).toHaveLength(1);
    const replay = vi.fn(async () => true);
    await expect(knob.history.undo(async () => true, replay)).resolves.toBe("applied");
    expect(replay.mock.calls[0]).toEqual([expect.objectContaining({ changes: [{ paramId: "mix", label: "Mix", before: .5, after: expect.closeTo(.5008, 10) }] }), "before"]);
    await expect(knob.history.redo(async () => true, replay)).resolves.toBe("applied");
    knob.wheel.dispose(); expect(knob.commit).toHaveBeenCalledTimes(1);
  });

  it("obeys profile fine/suppressed gestures and clamps without empty history", async () => {
    vi.useFakeTimers(); useDAWStore.setState({ mouseBehaviorProfileId: "cubase" });
    const normal = control(), fine = control(), boundary = control(1);
    normal.wheel.wheel({ deltaY: -100 }); fine.wheel.wheel({ deltaY: -100, shiftKey: true });
    expect(normal.value()).toBeCloseTo(.508); expect(fine.value()).toBeCloseTo(.502);
    expect(fine.wheel.wheel({ deltaY: -100, altKey: true }).operation).toBe("suppress");
    expect(fine.value()).toBeCloseTo(.502); expect(fine.commit).toHaveBeenCalledTimes(1);
    boundary.wheel.wheel({ deltaY: -100 }); expect(boundary.begin).not.toHaveBeenCalled();
    normal.wheel.dispose(); fine.wheel.dispose(); boundary.wheel.dispose();
    await Promise.all([...normal.commits, ...fine.commits]);
    expect(normal.history.getUndoEntries()).toHaveLength(1); expect(boundary.history.getUndoEntries()).toHaveLength(0);
  });

  it("closes a gesture exactly once on blur, unmount, or changing wheel direction", async () => {
    vi.useFakeTimers(); useDAWStore.setState({ mouseBehaviorProfileId: "cubase" });
    const knob = control();
    knob.wheel.wheel({ deltaY: -100 }); knob.wheel.wheel({ deltaY: 100 });
    expect(knob.commit).toHaveBeenCalledTimes(1);
    knob.wheel.reset(); knob.wheel.reset(); knob.wheel.dispose();
    await Promise.all(knob.commits);
    expect(knob.commit).toHaveBeenCalledTimes(2); expect(knob.history.getUndoEntries()).toHaveLength(2);
  });

  it("validates numeric drafts in native units and does not turn empty or invalid text into zero", () => {
    expect(parseSuiteParameterDraft("25", 100, descriptor())).toBe(.25);
    expect(parseSuiteParameterDraft("250", 100, descriptor())).toBe(1);
    expect(parseSuiteParameterDraft("", 100, descriptor())).toBeNull();
    expect(parseSuiteParameterDraft(" ", 100, descriptor())).toBeNull();
    expect(parseSuiteParameterDraft("NaN", 100, descriptor())).toBeNull();
    expect(parseSuiteParameterDraft("Infinity", 100, descriptor())).toBeNull();
  });
});
