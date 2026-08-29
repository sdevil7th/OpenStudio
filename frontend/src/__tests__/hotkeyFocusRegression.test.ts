import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mainSource from "../../../Source/Main.cpp?raw";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { dispatchGlobalShortcut } from "../utils/globalShortcutDispatcher";
import { resetShortcutContextForTests } from "../utils/shortcutContext";

const originalState = {
  keyboardShortcutProfileId: useDAWStore.getState().keyboardShortcutProfileId,
  activeCustomKeyboardProfileId: useDAWStore.getState().activeCustomKeyboardProfileId,
  customShortcuts: useDAWStore.getState().customShortcuts,
  transport: useDAWStore.getState().transport,
  recordSession: useDAWStore.getState().recordSession,
  play: useDAWStore.getState().play,
  stop: useDAWStore.getState().stop,
  toggleLoop: useDAWStore.getState().toggleLoop,
};

let syntheticNow = 10_000_000;

function setTransportState(state: "stopped" | "playing" | "recording") {
  const current = useDAWStore.getState();
  useDAWStore.setState({
    transport: {
      ...current.transport,
      isPlaying: state !== "stopped",
      isPaused: false,
      isRecording: state === "recording",
    },
    recordSession: state === "recording"
      ? { id: "focus-regression-recording", startTime: 0, trackIds: [] }
      : null,
  });
}

function dispatchSpace(options: {
  role?: string;
  editable?: boolean;
  nonTextControl?: boolean;
  repeat?: boolean;
  source?: "browser" | "pluginWindow";
} = {}) {
  const preventDefault = vi.fn();
  const handled = dispatchGlobalShortcut({
    key: " ",
    code: "Space",
    source: options.source ?? "browser",
    repeat: options.repeat,
    targetIsEditable: options.editable,
    targetIsNonTextControl: options.nonTextControl,
    preventDefault,
  }, "windows", { role: options.role ?? "main" });
  return { handled, preventDefault };
}

beforeEach(() => {
  syntheticNow += 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => syntheticNow);
  resetShortcutContextForTests();
  useDAWStore.setState({
    keyboardShortcutProfileId: "openstudio",
    activeCustomKeyboardProfileId: null,
    customShortcuts: {},
    transport: {
      ...originalState.transport,
      isPlaying: false,
      isPaused: false,
      isRecording: false,
    },
    recordSession: null,
    play: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    toggleLoop: vi.fn(),
  });
});

afterEach(() => {
  resetShortcutContextForTests();
  useDAWStore.setState(originalState);
  vi.restoreAllMocks();
});

describe("hotkey focus and window regression contract", () => {
  it.each([
    ["stopped", "play"],
    ["playing", "stop"],
    ["recording", "stop"],
  ] as const)(
    "reserves active-profile Space for transport from a focused non-text control while %s",
    (transportState, expectedAction) => {
      const play = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      useDAWStore.setState({ play, stop });
      setTransportState(transportState);

      const { handled, preventDefault } = dispatchSpace({ nonTextControl: true });

      expect(handled).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(play).toHaveBeenCalledTimes(expectedAction === "play" ? 1 : 0);
      expect(stop).toHaveBeenCalledTimes(expectedAction === "stop" ? 1 : 0);
    },
  );

  it.each([
    ["main maximize button", "main"],
    ["NAM Rack control", "pluginEditor"],
    ["detached MIDI control", "midiEditor"],
    ["detached Mixer control", "mixer"],
  ])("claims Space instead of leaving it with a focused %s", (_label, role) => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    const { handled, preventDefault } = dispatchSpace({ role, nonTextControl: true });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    if (role === "main") {
      expect(useDAWStore.getState().play).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
    } else {
      expect(publish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({
        command: "transport.toggle",
      }));
      expect(useDAWStore.getState().play).not.toHaveBeenCalled();
    }
  });

  it("returns Space to a focused control when Play is explicitly unbound", () => {
    useDAWStore.setState({
      customShortcuts: { "transport.play": { common: [] } },
    });
    const { handled, preventDefault } = dispatchSpace({ nonTextControl: true });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useDAWStore.getState().play).not.toHaveBeenCalled();
  });

  it("uses a remapped Play key from a focused control and leaves Space native", () => {
    useDAWStore.setState({
      customShortcuts: { "transport.play": { common: ["P"] } },
    });

    const space = dispatchSpace({ nonTextControl: true });
    expect(space.handled).toBe(false);
    expect(space.preventDefault).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    expect(dispatchGlobalShortcut({
      key: "p",
      code: "KeyP",
      source: "browser",
      targetIsNonTextControl: true,
      preventDefault,
    }, "windows", { role: "main" })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useDAWStore.getState().play).toHaveBeenCalledOnce();
  });

  it("does not let another global action assigned to Space steal native control activation", () => {
    useDAWStore.setState({
      customShortcuts: {
        "transport.play": { common: [] },
        "transport.loop": { common: ["Space"] },
      },
    });
    const { handled, preventDefault } = dispatchSpace({ nonTextControl: true });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useDAWStore.getState().toggleLoop).not.toHaveBeenCalled();
  });

  it("preserves stopped editable Space but consumes the active Play binding while running", () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ stop });

    setTransportState("stopped");
    const stopped = dispatchSpace({ editable: true });
    expect(stopped.handled).toBe(false);
    expect(stopped.preventDefault).not.toHaveBeenCalled();

    syntheticNow += 1_000;
    setTransportState("playing");
    const playing = dispatchSpace({ editable: true });
    expect(playing.handled).toBe(true);
    expect(playing.preventDefault).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();

    syntheticNow += 1_000;
    setTransportState("recording");
    const recording = dispatchSpace({ editable: true });
    expect(recording.handled).toBe(true);
    expect(recording.preventDefault).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("honors unbound and remapped Play inside an editable field", () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({
      stop,
      customShortcuts: { "transport.play": { common: [] } },
    });
    setTransportState("playing");

    const unboundSpace = dispatchSpace({ editable: true });
    expect(unboundSpace.handled).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    useDAWStore.setState({
      customShortcuts: { "transport.play": { common: ["P"] } },
    });
    const stoppedEditableP = vi.fn();
    setTransportState("stopped");
    expect(dispatchGlobalShortcut({
      key: "p",
      code: "KeyP",
      source: "browser",
      targetIsEditable: true,
      preventDefault: stoppedEditableP,
    }, "windows", { role: "main" })).toBe(false);
    expect(stoppedEditableP).not.toHaveBeenCalled();

    setTransportState("playing");
    const runningEditableP = vi.fn();
    expect(dispatchGlobalShortcut({
      key: "p",
      code: "KeyP",
      source: "browser",
      targetIsEditable: true,
      preventDefault: runningEditableP,
    }, "windows", { role: "main" })).toBe(true);
    expect(runningEditableP).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["pluginEditor", "midiEditor", "mixer"])(
    "forwards an editable-field stop from the detached %s exactly once",
    (role) => {
      const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
      setTransportState("recording");

      const { handled, preventDefault } = dispatchSpace({ role, editable: true });

      expect(handled).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({
        command: "transport.stop",
      }));
    },
  );

  it("consumes key repeat without replaying transport locally or remotely", () => {
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);

    const main = dispatchSpace({ nonTextControl: true, repeat: true });
    expect(main.handled).toBe(true);
    expect(main.preventDefault).toHaveBeenCalledOnce();
    expect(useDAWStore.getState().play).not.toHaveBeenCalled();

    const detached = dispatchSpace({
      role: "pluginEditor",
      nonTextControl: true,
      repeat: true,
    });
    expect(detached.handled).toBe(true);
    expect(detached.preventDefault).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("deduplicates a browser/native double delivery into one transport action", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ play });
    setTransportState("stopped");

    const browser = dispatchSpace({ nonTextControl: true, source: "browser" });
    syntheticNow += 25;
    const native = dispatchSpace({ source: "pluginWindow" });

    expect(browser.handled).toBe(true);
    expect(native.handled).toBe(true);
    expect(browser.preventDefault).toHaveBeenCalledOnce();
    expect(native.preventDefault).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });

  it("routes native plug-in shortcuts only to the authoritative main WebView", () => {
    expect(mainSource).toMatch(
      /broadcastEventToRole\s*\(\s*MainComponent::WindowRole::main\s*,\s*"nativeGlobalShortcut"/,
    );
    expect(mainSource).not.toContain('broadcastEventToAll("nativeGlobalShortcut", payload)');
  });
});
