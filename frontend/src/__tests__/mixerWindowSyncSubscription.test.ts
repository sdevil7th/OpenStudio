import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { startMixerUISync } from "../utils/mixerWindowSync";

const originalState = useDAWStore.getState();
let stopSync: (() => void) | null = null;

afterEach(() => {
  stopSync?.();
  stopSync = null;
  vi.restoreAllMocks();
  useDAWStore.setState(originalState);
});

describe("mixer window sync subscription", () => {
  it("ignores unchanged playhead availability and meter hot paths while publishing durable changes", () => {
    const publish = vi.spyOn(nativeBridge, "publishMixerUISnapshot").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "subscribe").mockReturnValue(() => {});
    useDAWStore.setState((state) => ({
      keyboardShortcutProfileId: "openstudio",
      canUndo: false,
      transport: { ...state.transport, currentTime: 1.25 },
      meterLevels: {},
      peakLevels: {},
      clippingStates: {},
      automatedParamValues: {},
    }));

    stopSync = startMixerUISync();
    expect(publish).toHaveBeenCalledTimes(1);

    useDAWStore.setState((state) => ({
      transport: { ...state.transport, currentTime: 1.3 },
    }));
    useDAWStore.setState({
      meterLevels: { track: 0.5 },
      peakLevels: { track: 0.75 },
      clippingStates: { track: false },
      automatedParamValues: { track: { volume: -3 } },
    });
    expect(publish).toHaveBeenCalledTimes(1);

    useDAWStore.setState({ keyboardShortcutProfileId: "reaper" });
    expect(publish).toHaveBeenCalledTimes(2);

    // Detached shortcut availability remains live even when the mixer payload
    // itself did not otherwise change.
    useDAWStore.setState({ canUndo: true });
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("publishes when hot playhead or razor state changes detached action availability", () => {
    const publish = vi.spyOn(nativeBridge, "publishMixerUISnapshot").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "subscribe").mockReturnValue(() => {});
    useDAWStore.setState((state) => ({
      canUndo: false,
      razorEdits: [],
      transport: { ...state.transport, currentTime: 0 },
    }));

    stopSync = startMixerUISync();
    expect(publish).toHaveBeenCalledTimes(1);

    // At a positive playhead position, previous-grid/boundary actions become
    // available even though currentTime is intentionally not in the durable
    // mixer snapshot dependency list.
    useDAWStore.setState((state) => ({
      transport: { ...state.transport, currentTime: 1.25 },
    }));
    expect(publish).toHaveBeenCalledTimes(2);

    useDAWStore.setState({ razorEdits: [{ trackId: "missing-track", start: 0, end: 1 }] });
    expect(publish).toHaveBeenCalledTimes(3);
  });
});
