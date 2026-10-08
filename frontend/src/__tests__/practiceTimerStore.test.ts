import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge, type PracticeTimerState } from "../services/NativeBridge";
import { usePracticeTimerStore } from "../store/practiceTimerStore";

vi.mock("../services/NativeBridge", () => ({ nativeBridge: {
  getPracticeTimer: vi.fn(), controlPracticeTimer: vi.fn(),
} }));

const idle: PracticeTimerState = { status: "idle", duration: 0, elapsed: 0 };

describe("practice timer polling", () => {
  beforeEach(() => {
    usePracticeTimerStore.setState({ ...idle, pending: false, error: "" });
    vi.mocked(nativeBridge.getPracticeTimer).mockReset().mockResolvedValue({ ...idle });
    vi.mocked(nativeBridge.controlPracticeTimer).mockReset().mockResolvedValue(true);
  });

  it("keeps identical idle polls silent while still reading the native timer", async () => {
    const initial = usePracticeTimerStore.getState();
    const changed = vi.fn();
    const unsubscribe = usePracticeTimerStore.subscribe(changed);
    try {
      await initial.refresh();
      await initial.refresh();
      expect(nativeBridge.getPracticeTimer).toHaveBeenCalledTimes(2);
      expect(usePracticeTimerStore.getState()).toBe(initial);
      expect(changed).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it("publishes native running progress and completion but skips repeated snapshots", async () => {
    const changed = vi.fn();
    const unsubscribe = usePracticeTimerStore.subscribe(changed);
    try {
      for (const state of [
        { status: "running", duration: 10, elapsed: 0 },
        { status: "running", duration: 10, elapsed: 0 },
        { status: "running", duration: 10, elapsed: 0.2 },
        { status: "finished", duration: 10, elapsed: 10 },
      ] satisfies PracticeTimerState[]) {
        vi.mocked(nativeBridge.getPracticeTimer).mockResolvedValueOnce(state);
        await usePracticeTimerStore.getState().refresh();
        expect(usePracticeTimerStore.getState()).toMatchObject(state);
      }
      expect(changed).toHaveBeenCalledTimes(3);
    } finally { unsubscribe(); }
  });

  it("preserves accepted pause, resume and reset updates", async () => {
    usePracticeTimerStore.setState({ status: "running", duration: 60, elapsed: 12 });
    const transitions = [
      ["pause", { status: "paused", duration: 60, elapsed: 12 }],
      ["resume", { status: "running", duration: 60, elapsed: 12 }],
      ["reset", idle],
    ] as const;
    for (const [action, state] of transitions) {
      vi.mocked(nativeBridge.getPracticeTimer).mockResolvedValueOnce(state);
      await usePracticeTimerStore.getState().control(action);
      expect(nativeBridge.controlPracticeTimer).toHaveBeenLastCalledWith(action, 0);
      expect(usePracticeTimerStore.getState()).toMatchObject({ ...state, pending: false, error: "" });
    }
  });

  it("does not let an older poll overwrite a confirmed control result", async () => {
    let finishPoll!: (state: PracticeTimerState) => void;
    vi.mocked(nativeBridge.getPracticeTimer).mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve; }));
    const refresh = usePracticeTimerStore.getState().refresh();
    const running: PracticeTimerState = { status: "running", duration: 30, elapsed: 0 };
    vi.mocked(nativeBridge.getPracticeTimer).mockResolvedValueOnce(running);
    await usePracticeTimerStore.getState().control("start", 30);
    finishPoll(idle);
    await refresh;
    expect(usePracticeTimerStore.getState()).toMatchObject({ ...running, pending: false });
  });
});
