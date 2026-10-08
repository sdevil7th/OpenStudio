import { nativeBridge, type BuiltInPluginAddress } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { useDAWStore } from "../store/useDAWStore";
import { getProjectEpoch } from "./projectLifetime";

/** The main window owns project history, including edits from detached editors. */
export function startBuiltInHostBypassHistory() {
  let live = true;
  let events = Promise.resolve();
  const unsubscribe = nativeBridge.subscribe("builtInHostBypassChanged", payload => {
    if (!payload || typeof payload.instanceId !== "string" || !payload.instanceId
      || !["track", "input", "master"].includes(payload.chain)
      || typeof payload.before !== "boolean" || typeof payload.after !== "boolean"
      || payload.before === payload.after) return;
    if (payload.chain !== "master" && !useDAWStore.getState().tracks.some(track => track.id === payload.trackId)) return;
    const epoch = getProjectEpoch();
    const before = payload.before;
    const after = payload.after;
    const historyReplay = Boolean(payload.historyReplay);
    const address: BuiltInPluginAddress = { trackId: payload.trackId, chain: payload.chain, fxIndex: payload.fxIndex, instanceId: payload.instanceId };
    events = events.then(async () => {
      if (!live || epoch !== getProjectEpoch()) return;
      // Discard a delayed event for a deleted/replaced instance before dirtying
      // the project or appending a command to its history.
      await nativeBridge.resolveBuiltInAddress(address);
      if (!live || epoch !== getProjectEpoch()) return;
      useDAWStore.setState({ isModified: true });
      if (historyReplay) return;
      let pending = Promise.resolve();
      const apply = (bypassed: boolean) => {
        pending = pending.then(async () => {
          if (epoch !== getProjectEpoch()) return;
          const route = await nativeBridge.resolveBuiltInAddress(address);
          if (epoch !== getProjectEpoch()) return;
          if (!await nativeBridge.setBuiltInPluginState(route, { hostBypassed: bypassed, hostBypassHistoryReplay: true }))
            throw new Error("The effect is no longer available for bypass history.");
        }).catch(error => { if (epoch === getProjectEpoch()) useDAWStore.getState().showToast(String(error), "error"); });
      };
      commandManager.push({ type: "SET_BUILTIN_HOST_BYPASS", description: after ? "Bypass effect" : "Enable effect", timestamp: Date.now(),
        execute: () => apply(after), undo: () => apply(before) });
      useDAWStore.setState({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    }).catch(() => { /* A removed instance cannot contribute project history. */ });
  });
  return () => { live = false; unsubscribe(); };
}
