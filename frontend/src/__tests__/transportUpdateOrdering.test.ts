import { advanceProjectEpoch } from "../utils/projectLifetime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
const initial = useDAWStore.getState();
const bridge = nativeBridge as unknown as { isNative: boolean; transportRequestToken: string; transportRequestsPending: number };
const originalNative = bridge.isNative;
function gate() { let resolve!: (value: boolean) => void; const promise = new Promise<boolean>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  bridge.isNative = true; bridge.transportRequestToken = ""; bridge.transportRequestsPending = 0;
  useDAWStore.setState({ ...initial, transport: { ...initial.transport, isPlaying: false, currentTime: 0 } });
});
afterEach(() => { bridge.isNative = originalNative; bridge.transportRequestToken = ""; bridge.transportRequestsPending = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); useDAWStore.setState(initial); });
describe("native transport request ordering", () => {
  it.each(["pause", "stop"] as const)("does not end a new write session while the old %s position request is pending", async action => {
    const pending = gate();
    vi.spyOn(nativeBridge, "setTransportPlaying").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "setTransportRecording").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "hasAnyActiveARA").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "clearPitchPreviewRoutesForCorrectedSources").mockResolvedValue(0);
    let resolvePosition!: (value: number) => void;
    const position = new Promise<number>(done => { resolvePosition = done; });
    vi.spyOn(nativeBridge, "getTransportPosition").mockReturnValue(position);
    vi.spyOn(nativeBridge, "setTransportPosition").mockResolvedValue(true);
    const endSession = vi.fn();
    useDAWStore.setState({ endAutomationWriteSession: endSession, syncClipsWithBackend: async () => {},
      prepareAutomationAutoJoin: async () => true });
    const stopping = useDAWStore.getState()[action]();
    await vi.waitFor(() => expect(nativeBridge.getTransportPosition).toHaveBeenCalled());
    if (action === "pause") {
      await useDAWStore.getState().play();
      resolvePosition(3);
    } else {
      vi.mocked(nativeBridge.setTransportPosition).mockReturnValueOnce(pending.promise);
      resolvePosition(3);
      await vi.waitFor(() => expect(nativeBridge.setTransportPosition).toHaveBeenCalled());
      await useDAWStore.getState().play();
      pending.resolve(true);
    }
    await stopping;
    expect(endSession).not.toHaveBeenCalled();
  });
  it.each(["play", "project", "rejected"])("does not end the automation session after a superseded or rejected Pause: %s", async supersededBy => {
    const pending = gate();
    vi.spyOn(nativeBridge, "setTransportPlaying").mockImplementation(async playing => playing ? true : pending.promise);
    vi.spyOn(nativeBridge, "setTransportPosition").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "hasAnyActiveARA").mockResolvedValue(false);
    vi.spyOn(nativeBridge, "clearPitchPreviewRoutesForCorrectedSources").mockResolvedValue(0);
    const endSession = vi.fn();
    useDAWStore.setState({ endAutomationWriteSession: endSession, syncClipsWithBackend: async () => {},
      prepareAutomationAutoJoin: async () => true });
    const pausing = useDAWStore.getState().pause();
    if (supersededBy === "play") await useDAWStore.getState().play();
    if (supersededBy === "project") advanceProjectEpoch();
    pending.resolve(supersededBy !== "rejected");
    await pausing;
    expect(endSession).not.toHaveBeenCalled();
  });

  it("ends the write session at the pause position when Pause is accepted", async () => {
    vi.spyOn(nativeBridge, "setTransportPlaying").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "getTransportPosition").mockResolvedValue(3.5);
    const endSession = vi.fn();
    useDAWStore.setState({ endAutomationWriteSession: endSession,
      transport: { ...initial.transport, isPlaying: true, currentTime: 3 } });
    await useDAWStore.getState().pause();
    expect(endSession).toHaveBeenCalledExactlyOnceWith(3.5);
  });
  it("keeps a seek from being overwritten by stale native events before and after acknowledgement", async () => {
    const pending = gate(), calls: { action: string; value: number | boolean; token: string }[] = [];
    vi.stubGlobal("window", { __JUCE__: { backend: {
      setTransportPosition: vi.fn(), setTransportStateWithToken: async (action: string, value: number | boolean, token: string) => { calls.push({ action, value, token }); return pending.promise; },
    } } });
    const seek = useDAWStore.getState().seekTo(2);
    expect(useDAWStore.getState().transport.currentTime).toBe(2);
    expect(nativeBridge.isTransportUpdateCurrent({ requestToken: "prior" })).toBe(false);
    if (nativeBridge.isTransportUpdateCurrent({ requestToken: "prior" })) useDAWStore.getState().setCurrentTime(0);
    pending.resolve(true); await seek;
    expect(useDAWStore.getState().transport.currentTime).toBe(2);
    expect(nativeBridge.isTransportUpdateCurrent({ requestToken: "prior" })).toBe(false);
    expect(nativeBridge.isTransportUpdateCurrent({ requestToken: calls[0].token })).toBe(true);
    expect(calls[0]).toMatchObject({ action: "position", value: 2 });
  });
  it("only accepts the newest seek/start/stop request, including out-of-order completions", async () => {
    const first = gate(), second = gate(), tokens: string[] = [];
    vi.stubGlobal("window", { __JUCE__: { backend: { setTransportPosition: vi.fn(), setTransportPlaying: vi.fn(),
      setTransportStateWithToken: (_action: string, _value: number | boolean, token: string) => { tokens.push(token); return tokens.length === 1 ? first.promise : second.promise; },
    } } });
    const seek = nativeBridge.setTransportPosition(2), start = nativeBridge.setTransportPlaying(true);
    second.resolve(true); await start;
    expect(nativeBridge.isTransportUpdateCurrent({ requestToken: tokens[1] })).toBe(true);
    first.resolve(true); await seek;
    expect(nativeBridge.isTransportUpdateCurrent({ requestToken: tokens[0] })).toBe(false);
    expect(nativeBridge.isTransportUpdateCurrent({ requestToken: tokens[1] })).toBe(true);
  });
  it("retains the old backend contract and suppresses updates while its seek is pending", async () => {
    const pending = gate(), legacy = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("window", { __JUCE__: { backend: { setTransportPosition: legacy } } });
    const seek = nativeBridge.setTransportPosition(2);
    expect(legacy).toHaveBeenCalledWith(2);
    expect(nativeBridge.isTransportUpdateCurrent({})).toBe(false);
    pending.resolve(true); await seek;
    expect(nativeBridge.isTransportUpdateCurrent({})).toBe(true);
  });
  it("flushes the final native capture batch with the Stop response", async () => {
    const callback = vi.fn(), listeners = (nativeBridge as any).eventListeners as Map<string, Set<unknown>>;
    listeners.set("pluginParameterEdit",new Set([callback]));
    vi.stubGlobal("window",{__JUCE__:{backend:{setTransportPlaying:vi.fn(),setTransportStateWithToken:vi.fn().mockResolvedValue({success:true,parameterEdits:[{phase:"value",capturedTime:2,capturedWhileRolling:true}]})}}});
    expect(await nativeBridge.setTransportPlaying(false)).toBe(true);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({transportFlush:true,capturedTime:2}));
    listeners.delete("pluginParameterEdit");
  });
  it("does not deliver a late Stop batch into a different project", async () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise(done => {resolve=done;});
    const callback = vi.fn(), listeners = (nativeBridge as any).eventListeners as Map<string, Set<unknown>>;
    listeners.set("pluginParameterEdit",new Set([callback]));
    vi.stubGlobal("window",{__JUCE__:{backend:{setTransportPlaying:vi.fn(),setTransportStateWithToken:()=>promise}}});
    const stopping=nativeBridge.setTransportPlaying(false); advanceProjectEpoch();
    resolve({success:true,parameterEdits:[{phase:"value",capturedTime:2}]}); await stopping;
    expect(callback).not.toHaveBeenCalled(); listeners.delete("pluginParameterEdit");
  });
  it("does not leave synchronization blocked when a native request fails", async () => {
    bridge.transportRequestToken = "previous";
    vi.stubGlobal("window", { __JUCE__: { backend: { setTransportRecording: vi.fn(), setTransportStateWithToken: vi.fn().mockResolvedValue(false) } } });
    expect(await nativeBridge.setTransportRecording(true)).toBe(false);
    expect(nativeBridge.isTransportUpdateCurrent({ requestToken: "previous" })).toBe(true);
    expect(bridge.transportRequestsPending).toBe(0);
  });
});
