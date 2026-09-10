import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { metronomePracticeActions } from "../store/actions/metronomePractice";
import { shouldAutoStopPlayback } from "../utils/transportAutoStop";

vi.mock("../services/NativeBridge", () => ({ nativeBridge: {
  setMetronomePracticeEnabled: vi.fn(), setMetronomeEnabled: vi.fn(), setMetronomeVolume: vi.fn(),
} }));

function fixture(enabled = false, practice = false) {
  let state = { metronomeEnabled: enabled, metronomeVolume: 0.5,
    metronomePracticeEnabled: practice, metronomePracticePending: false, metronomePracticeError: "" };
  const actions = metronomePracticeActions(patch => { state = { ...state, ...patch }; }, () => state);
  return { actions, state: () => state };
}

describe("metronome click-only ownership", () => {
  beforeEach(() => {
    vi.mocked(nativeBridge.setMetronomePracticeEnabled).mockReset().mockResolvedValue(true);
    vi.mocked(nativeBridge.setMetronomeEnabled).mockReset().mockResolvedValue(true);
    vi.mocked(nativeBridge.setMetronomeVolume).mockReset().mockResolvedValue(true);
  });

  it("waits for native acceptance and does not modify transport or track state", async () => {
    const { actions, state } = fixture();
    const start = actions.setMetronomePracticeEnabled(true);
    expect(state().metronomePracticePending).toBe(true);
    expect(state().metronomePracticeEnabled).toBe(false);
    expect(await start).toBe(true);
    expect(state()).toEqual({ metronomeEnabled: false, metronomeVolume: 0.5,
      metronomePracticeEnabled: true, metronomePracticePending: false, metronomePracticeError: "" });
    await actions.setMetronomePracticeEnabled(false);
    expect(state().metronomePracticeEnabled).toBe(false);
  });

  it.each([false, new Error("Device disconnected")])("reports native rejection without claiming playback started: %s", async rejection => {
    const bridge = vi.mocked(nativeBridge.setMetronomePracticeEnabled);
    if (rejection instanceof Error) bridge.mockRejectedValueOnce(rejection);
    else bridge.mockResolvedValueOnce(rejection);
    const { actions, state } = fixture();
    expect(await actions.setMetronomePracticeEnabled(true)).toBe(false);
    expect(state().metronomePracticeEnabled).toBe(false);
    expect(state().metronomePracticePending).toBe(false);
    expect(state().metronomePracticeError).not.toBe("");
    expect(await actions.setMetronomePracticeEnabled(true)).toBe(true);
    expect(state().metronomePracticeError).toBe("");
  });

  it("a project reset supersedes a start that has not reached native code", async () => {
    const { actions, state } = fixture();
    const start = actions.setMetronomePracticeEnabled(true);
    const reset = actions.setMetronomePracticeEnabled(false);
    expect(await start).toBe(false);
    expect(await reset).toBe(true);
    expect(nativeBridge.setMetronomePracticeEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(state().metronomePracticeEnabled).toBe(false);
  });

  it("orders an in-flight start and later stop; a stale completion cannot re-enable the UI", async () => {
    let finish!: (accepted: boolean) => void;
    vi.mocked(nativeBridge.setMetronomePracticeEnabled).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { actions, state } = fixture();
    const start = actions.setMetronomePracticeEnabled(true);
    await Promise.resolve();
    const stop = actions.setMetronomePracticeEnabled(false);
    finish(true);
    await start;
    expect(state().metronomePracticeEnabled).toBe(false);
    await stop;
    expect(vi.mocked(nativeBridge.setMetronomePracticeEnabled).mock.calls).toEqual([[true], [false]]);
    expect(state().metronomePracticePending).toBe(false);
  });

  it("does not stop an explicitly started empty transport while click-only is active", () => {
    const decision = shouldAutoStopPlayback({
      tracks: [], metronomeEnabled: false, metronomePracticeEnabled: true, nextTime: 1,
      transport: { isPlaying: true, isRecording: false, currentTime: 0, loopEnabled: false, loopStart: 0, loopEnd: 0 },
    });
    expect(decision.shouldStop).toBe(false);
  });

  it.each([[false, true], [true, true], [true, false]])(
    "Enable switches both modes off when either is active (%s / %s)", async (enabled, practice) => {
      const { actions, state } = fixture(enabled, practice);
      await actions.toggleMetronome();
      expect(state()).toMatchObject({ metronomeEnabled: false, metronomePracticeEnabled: false, metronomePracticePending: false });
      expect(nativeBridge.setMetronomePracticeEnabled).toHaveBeenCalledExactlyOnceWith(false);
      expect(nativeBridge.setMetronomeEnabled).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("enables the usual playback preference without starting click-only when both modes are off", async () => {
    const { actions, state } = fixture();
    await actions.toggleMetronome();
    expect(state()).toMatchObject({ metronomeEnabled: true, metronomePracticeEnabled: false });
    expect(nativeBridge.setMetronomeVolume).toHaveBeenCalledExactlyOnceWith(0.5);
    expect(nativeBridge.setMetronomeEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not claim Enable is off if native code cannot stop click-only playback", async () => {
    const { actions, state } = fixture(true, true);
    vi.mocked(nativeBridge.setMetronomePracticeEnabled).mockResolvedValueOnce(false);
    await actions.toggleMetronome();
    expect(state()).toMatchObject({ metronomeEnabled: true, metronomePracticeEnabled: true, metronomePracticePending: false });
    expect(state().metronomePracticeError).not.toBe("");
    expect(nativeBridge.setMetronomeEnabled).not.toHaveBeenCalled();
  });

  it("reports a partial failure honestly after stopping practice but failing to disable the ordinary click", async () => {
    const { actions, state } = fixture(true, true);
    vi.mocked(nativeBridge.setMetronomeEnabled).mockResolvedValueOnce(false);
    await actions.toggleMetronome();
    expect(state()).toMatchObject({ metronomeEnabled: true, metronomePracticeEnabled: false });
    expect(state().metronomePracticeError).not.toBe("");
  });

  it("the metronome toggle cancels a pending click-only start instead of enabling another mode", async () => {
    const { actions, state } = fixture();
    const start = actions.setMetronomePracticeEnabled(true);
    const off = actions.toggleMetronome();
    await start;
    await off;
    expect(state()).toMatchObject({ metronomeEnabled: false, metronomePracticeEnabled: false, metronomePracticePending: false });
    expect(nativeBridge.setMetronomePracticeEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(nativeBridge.setMetronomeEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("retains a confirmed Enable preference when click-only is queued behind it", async () => {
    let finish!: (accepted: boolean) => void;
    vi.mocked(nativeBridge.setMetronomeEnabled).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { actions, state } = fixture();
    const enable = actions.toggleMetronome();
    for (let i = 0; i < 10; ++i) await Promise.resolve();
    expect(nativeBridge.setMetronomeEnabled).toHaveBeenCalledExactlyOnceWith(true);
    const start = actions.setMetronomePracticeEnabled(true);
    finish(true);
    await enable;
    await start;
    expect(state()).toMatchObject({ metronomeEnabled: true, metronomePracticeEnabled: true, metronomePracticePending: false });
  });

  it("keeps the indicator on if a superseded start succeeds but the following stop fails", async () => {
    let finish!: (accepted: boolean) => void;
    vi.mocked(nativeBridge.setMetronomePracticeEnabled)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(false);
    const { actions, state } = fixture();
    const start = actions.setMetronomePracticeEnabled(true);
    await Promise.resolve();
    const off = actions.toggleMetronome();
    finish(true);
    await start;
    await off;
    expect(state().metronomePracticeEnabled).toBe(true);
    expect(state().metronomePracticeError).not.toBe("");
  });
});
