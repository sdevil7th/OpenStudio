import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { advanceProjectEpoch } from "../utils/projectLifetime";

const initial = useDAWStore.getState();
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function gate() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
function bridgeWithNativeFlush() {
  const listeners = new Map<string, (data: unknown) => void>();
  const acknowledge = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("window", { __JUCE__: { backend: {
    addTrack: vi.fn(), acknowledgeAutomationEditorFlush: acknowledge,
    addEventListener: (id: string, listener: (data: unknown) => void) => { listeners.set(id, listener); },
  } } });
  const Bridge = nativeBridge.constructor as new () => typeof nativeBridge;
  return { bridge: new Bridge(), acknowledge, request: (token: string) => listeners.get("automationEditorFlushRequested")!(token) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useDAWStore.setState(initial); });

describe("editor automation Stop drain", () => {
  it("acknowledges only after every editor has delivered its final writes", async () => {
    const { bridge, acknowledge, request } = bridgeWithNativeFlush(), first = gate(), second = gate();
    bridge.registerAutomationEditorFlush(() => first.promise);
    bridge.registerAutomationEditorFlush(() => second.promise);
    request("stop-1"); await settle(); expect(acknowledge).not.toHaveBeenCalled();
    second.resolve(true); await settle(); expect(acknowledge).not.toHaveBeenCalled();
    first.resolve(true); await settle(); expect(acknowledge).toHaveBeenCalledWith("stop-1", true);
  });
  it.each([false, new Error("editor write rejected")])("acknowledges a failed drain explicitly (%s)", async failure => {
    const { bridge, acknowledge, request } = bridgeWithNativeFlush();
    bridge.registerAutomationEditorFlush(() => failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure));
    request("stop-failure"); await settle(); expect(acknowledge).toHaveBeenCalledWith("stop-failure", false);
  });
  it("keeps an already enrolled editor drain alive when its panel unregisters", async () => {
    const { bridge, acknowledge, request } = bridgeWithNativeFlush(), pending = gate();
    const remove = bridge.registerAutomationEditorFlush(() => pending.promise);
    request("stop-closing"); remove(); await settle(); expect(acknowledge).not.toHaveBeenCalled();
    pending.resolve(true); await settle(); expect(acknowledge).toHaveBeenCalledWith("stop-closing", true);
    request("stop-empty"); await settle(); expect(acknowledge).toHaveBeenCalledWith("stop-empty", true);
  });
  it("does not seek or close a replacement project's session after an old Stop drain", async () => {
    const pending = gate();
    useDAWStore.setState({ ...initial, transport: { ...initial.transport, isPlaying: true, currentTime: 3 } });
    vi.spyOn(nativeBridge, "setTransportPlaying").mockReturnValue(pending.promise);
    const recording = vi.spyOn(nativeBridge, "setTransportRecording"), position = vi.spyOn(nativeBridge, "setTransportPosition");
    const end = vi.spyOn(useDAWStore.getState(), "endAutomationWriteSession");
    const stopping = useDAWStore.getState().stop(); advanceProjectEpoch(); pending.resolve(true); await stopping;
    expect(recording).not.toHaveBeenCalled(); expect(position).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
  });
});
