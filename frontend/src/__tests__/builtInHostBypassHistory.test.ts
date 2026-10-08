import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { startBuiltInHostBypassHistory } from "../utils/builtInHostBypassHistory";
import { advanceProjectEpoch } from "../utils/projectLifetime";

const initial = useDAWStore.getState();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); commandManager.clear(); useDAWStore.setState(initial); });
function setup() {
  commandManager.clear(); useDAWStore.setState({ tracks: [createDefaultTrack("t", "Track", "#fff", "audio")], isModified: false });
  let event!: (value: any) => void;
  vi.spyOn(nativeBridge, "subscribe").mockImplementation((_name, callback) => { event = callback; return () => {}; });
  vi.spyOn(nativeBridge, "resolveBuiltInAddress").mockImplementation(async address => ({ ...address, fxIndex: 3 }));
  vi.spyOn(nativeBridge, "setBuiltInPluginState").mockResolvedValue(true);
  startBuiltInHostBypassHistory();
  return () => event({ trackId: "t", chain: "track", fxIndex: 0, instanceId: "processor-1", before: false, after: true });
}
describe("native editor host bypass history", () => {
  it("records detached edits and resolves the same instance after reordering for queued undo/redo", async () => {
    setup()(); await flush();
    expect(useDAWStore.getState().isModified).toBe(true);
    commandManager.undo(); commandManager.redo(); await flush();
    expect(vi.mocked(nativeBridge.setBuiltInPluginState).mock.calls.map(([address, state]) => [address.fxIndex, address.instanceId, state.hostBypassed, state.hostBypassHistoryReplay]))
      .toEqual([[3, "processor-1", false, true], [3, "processor-1", true, true]]);
  });
  it("does not replay old edits into a replacement project", async () => {
    setup()(); await flush(); advanceProjectEpoch(); commandManager.undo(); await flush();
    expect(nativeBridge.setBuiltInPluginState).not.toHaveBeenCalled();
  });
  it("marks replayed native changes without creating another history command", async () => {
    setup();
    vi.mocked(nativeBridge.subscribe).mock.calls[0][1]({ trackId: "t", chain: "track", fxIndex: 0, instanceId: "processor-1", before: true, after: false, historyReplay: true });
    await flush();
    expect(useDAWStore.getState().isModified).toBe(true); expect(commandManager.canUndo()).toBe(false);
  });
  it("ignores delayed events when their instance was deleted", async () => {
    const fire = setup();
    vi.mocked(nativeBridge.resolveBuiltInAddress).mockRejectedValue(new Error("Removed"));
    fire(); await flush();
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("does not dirty the project for a no-op native notification", async () => {
    setup();
    vi.mocked(nativeBridge.subscribe).mock.calls[0][1]({ trackId: "t", chain: "track", fxIndex: 0, instanceId: "processor-1", before: false, after: false });
    await flush();
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.canUndo()).toBe(false);
  });
  it("ignores an event arriving during project replacement", async () => {
    setup()(); advanceProjectEpoch(); await flush();
    expect(useDAWStore.getState().isModified).toBe(false);
    expect(commandManager.canUndo()).toBe(false);
  });
});
