import { nativeBridge } from "./NativeBridge";
import { commandManager } from "../store/commands";
import type { Track, AutomationLane } from "../store/useDAWStore";
import { getProjectEpoch } from "../utils/projectLifetime";
import { notifyFXChainChanged } from "../utils/fxChain";
import { syncAutomationLaneToBackend } from "../store/actions/storeHelpers";
import { automationParameterMetadata, builtInAutomationParamId, pluginAutomationParamId } from "../store/automationParams";
import { compatibleAutomationMetadata, recoveredAutomationLabel, resolveSavedSafeParameter, type UnavailableFXSlot } from "../utils/automationRecovery";
import { clearPluginParameterManifests } from "../utils/pluginParameterManifest";
import { resolveSavedMIDILearnParameter } from "../utils/midiLearnRecovery";
import { enqueueFXMutation as enqueue } from "../utils/fxMutationQueue";

interface Store {
  tracks: Track[];
  globalLocked: boolean;
  lockSettings: { envelopes: boolean };
  isProjectLoading: boolean;
  transport: { isPlaying: boolean; isRecording: boolean };
  showToast: (message: string, type: "error" | "info") => void;
}
type SetState = (update: Record<string, unknown> | ((state: Store) => Record<string, unknown>)) => void;

function shift(lanes: AutomationLane[], chain: "input" | "track", position: number, delta: number) {
  return lanes.map(lane => {
    const address = /^(builtin|plugin)_(input|track)_(\d+)_(.+)$/.exec(lane.param);
    return address?.[2] === chain && Number(address[3]) >= position
      ? { ...lane, param: `${address[1]}_${chain}_${Number(address[3]) + delta}_${address[4]}` } : { ...lane };
  });
}

/** One missing slot is an async transaction; failure retains its saved state and envelopes. */
export function retryUnavailableFX(set: SetState, get: () => Store, trackId: string, key: string): Promise<boolean> {
  const epoch = getProjectEpoch();
  return enqueue(async () => {
    const state = get(), track = state.tracks.find(item => item.id === trackId);
    const slot = track?.unavailableFX?.find(item => item.key === key);
    if (!track || !slot || state.globalLocked || state.lockSettings.envelopes || track.frozen
      || state.isProjectLoading || state.transport.isPlaying || state.transport.isRecording || epoch !== getProjectEpoch()) return false;
    set({ automationRecoveryBusy: true });
    const input = slot.chain === "input";
    const list = () => input ? nativeBridge.getTrackInputFX(trackId) : nativeBridge.getTrackFX(trackId);
    const remove = (index: number) => input ? nativeBridge.removeTrackInputFX(trackId, index) : nativeBridge.removeTrackFX(trackId, index);
    const reorder = (from: number, to: number) => input ? nativeBridge.reorderTrackInputFX(trackId, from, to) : nativeBridge.reorderTrackFX(trackId, from, to);
    const copy = (owner: Track) => ({ lanes: structuredClone(owner.automationLanes), safe: [...(owner.automationSafeParams ?? [])], missing: structuredClone(owner.unavailableFX ?? []) });
    const before = copy(track);
    const clearRoutes = async () => {
      const owner = get().tracks.find(item => item.id === trackId);
      for (const lane of owner?.automationLanes ?? []) {
        if (epoch !== getProjectEpoch()) return;
        if (lane.unavailableParameter || /^(builtin|plugin)_(input|track)_/.exec(lane.param)?.[2] !== slot.chain) continue;
        await nativeBridge.setAutomationMode(trackId, lane.param, "off");
        await nativeBridge.setAutomationPoints(trackId, lane.param, []);
      }
    };
    const apply = async (snapshot: ReturnType<typeof copy>) => {
      if (epoch !== getProjectEpoch()) return;
      const slots = await list();
      if (epoch !== getProjectEpoch()) return;
      set(current => ({ tracks: current.tracks.map(owner => owner.id === trackId ? { ...owner,
        automationLanes: structuredClone(snapshot.lanes), automationSafeParams: [...snapshot.safe], unavailableFX: structuredClone(snapshot.missing),
        [input ? "inputFxCount" : "trackFxCount"]: slots.length } : owner), isModified: true }));
      for (const lane of snapshot.lanes) if (epoch === getProjectEpoch() && !lane.unavailableParameter) await syncAutomationLaneToBackend(trackId, lane);
      if (epoch === getProjectEpoch()) notifyFXChainChanged({ trackId, chainType: slot.chain });
    };
    let installedId: string | undefined;
    let installedIndex = -1;
    const install = async () => {
      clearPluginParameterManifests(trackId, slot.chain);
      const initial = await list();
      if (epoch !== getProjectEpoch()) return false;
      const added = slot.pluginType === "builtin" ? await nativeBridge.addTrackBuiltInFX(trackId, slot.pluginPath, input)
        : slot.pluginType === "jsfx" ? await nativeBridge.addTrackJSFX(trackId, slot.pluginPath, input)
        : input ? await nativeBridge.addTrackInputFX(trackId, slot.pluginPath, false) : await nativeBridge.addTrackFX(trackId, slot.pluginPath, false);
      if (!added || epoch !== getProjectEpoch()) return false;
      const slots = await list(), appended = slots.length - 1;
      if (epoch !== getProjectEpoch()) return false;
      installedIndex = appended;
      installedId = slots[appended]?.instanceId;
      const ownsSlot = slots[appended]?.pluginPath === slot.pluginPath;
      let routesCleared = false;
      try {
      if (slots.length !== initial.length + 1 || !ownsSlot || initial.some((item, index) =>
        item.instanceId ? item.instanceId !== slots[index]?.instanceId : item.pluginPath !== slots[index]?.pluginPath)) throw new Error("The FX chain changed during recovery");
      if (slot.state && !await nativeBridge.setPluginState(trackId, appended, input, slot.state)) throw new Error("The saved FX state was rejected");
      if (epoch !== getProjectEpoch()) return false;
      if (!input && slot.sidechain && !await nativeBridge.setSidechainSource(trackId, appended, slot.sidechain)) throw new Error("The saved sidechain could not be restored");
      if (epoch !== getProjectEpoch()) return false;
      const parameters = await nativeBridge.getPluginParameters(trackId, appended, input);
      if (epoch !== getProjectEpoch()) return false;
      const restoredMappings = (slot.midiLearnMappings ?? []).filter(mapping => mapping.trackId === trackId && mapping.chainType === slot.chain).map(mapping => {
        const parameter = resolveSavedMIDILearnParameter(mapping, parameters);
        if (!parameter) throw new Error("A saved MIDI Learn parameter changed or is unavailable; review the plugin version or script");
        return { ...mapping, paramIndex: parameter.index };
      });
      const restoredSafe = (slot.safeParams ?? []).map(param => {
        const contract = slot.safeParameters?.find(entry => entry.param === param)
          ?? { param, metadata: before.lanes.find(lane => lane.unavailableParameter?.fxKey === key && lane.unavailableParameter.param === param)?.metadata };
        const parameter = resolveSavedSafeParameter(contract, parameters);
        if (!parameter) throw new Error("A saved Automation Safe control changed or is unavailable; review the plugin version or script");
        return parameter.builtIn && parameter.paramId ? builtInAutomationParamId(input, appended, parameter.paramId)
          : pluginAutomationParamId(input, appended, parameter.index);
      });
      const restored = new Map<string, AutomationLane>();
      for (const lane of before.lanes.filter(item => item.unavailableParameter?.fxKey === key)) {
        const address = /^(builtin|plugin)_(input|track)_\d+_(.+)$/.exec(lane.unavailableParameter!.param);
        const parameter = address && parameters.find(item => address[1] === "builtin" ? item.paramId === address[3]
          : lane.metadata?.hostParamId ? item.hostParamId === lane.metadata.hostParamId : item.index === Number(address[3]));
        if (!parameter || !compatibleAutomationMetadata(lane.metadata, automationParameterMetadata(parameter)))
          throw new Error("A saved automation parameter changed or is unavailable; review the plugin version or script");
        restored.set(lane.id, { ...lane, label: recoveredAutomationLabel(lane), unavailableParameter: undefined,
          metadata: automationParameterMetadata(parameter), param: parameter.builtIn && parameter.paramId
            ? builtInAutomationParamId(input, appended, parameter.paramId) : pluginAutomationParamId(input, appended, parameter.index) });
      }
      const target = Math.max(0, Math.min(initial.length, slot.originalIndex));
      await clearRoutes(); routesCleared = true;
      if (epoch !== getProjectEpoch()) return false;
      if (target !== appended && !await reorder(appended, target)) throw new Error("The recovered FX could not be placed in its original chain position");
      installedIndex = target;
      installedId = (await list())[target]?.instanceId;
      const shifted = shift(before.lanes, slot.chain, target, 1);
      const lanes = shifted.map(lane => {
        const restoredLane = restored.get(lane.id);
        if (!restoredLane) return lane;
        return { ...restoredLane, param: restoredLane.param.replace(`_${appended}_`, `_${target}_`) };
      });
      const safe = shift(before.safe.map(param => ({ param } as AutomationLane)), slot.chain, target, 1).map(lane => lane.param);
      for (const param of restoredSafe) safe.push(param.replace(`_${appended}_`, `_${target}_`));
      for (const lane of before.lanes) if (lane.unavailableParameter?.fxKey === key && lane.unavailableParameter.safe) {
        const restoredLane = lanes.find(item => item.id === lane.id); if (restoredLane) safe.push(restoredLane.param);
      }
      const missing: UnavailableFXSlot[] = before.missing.filter(item => item.key !== key);
      if (restoredMappings.length) {
        const activeMappings = await nativeBridge.getMIDILearnMappings();
        if (epoch !== getProjectEpoch()) return false;
        const assignedCCs = new Set(activeMappings.map(mapping => mapping.ccNumber));
        const available = restoredMappings.filter(mapping => !assignedCCs.has(mapping.ccNumber)).map(mapping => ({ ...mapping, pluginIndex: target }));
        if (available.length && !await nativeBridge.setMIDILearnMappings([...activeMappings, ...available])) throw new Error("The saved MIDI Learn controls could not be restored");
        if (available.length !== restoredMappings.length) get().showToast("Some saved MIDI Learn controls were already assigned. Existing assignments were preserved; relearn those controls if needed.", "info");
      }
      await apply({ lanes, safe: [...new Set(safe)], missing });
      return true;
      } catch (error) {
        if (epoch === getProjectEpoch() && ownsSlot) {
          const currentSlots = await list();
          const index = installedId ? currentSlots.findIndex(item => item.instanceId === installedId) : installedIndex;
          if (index < 0 || currentSlots[index]?.pluginPath !== slot.pluginPath || !await remove(index))
          {
            set({ projectRestoreError: "Could not roll back FX recovery" });
            throw new Error("Could not roll back FX recovery; the added slot needs review");
          }
        }
        if (epoch === getProjectEpoch() && routesCleared) await apply(before);
        throw error;
      }
    };
    const withBusy = async (operation: () => Promise<void>) => {
      if (epoch !== getProjectEpoch()) return;
      set({ automationRecoveryBusy: true });
      try { await operation(); } finally { if (epoch === getProjectEpoch()) set({ automationRecoveryBusy: false }); }
    };
    try {
      if (!await install()) return false;
      const restoredTrack = get().tracks.find(owner => owner.id === trackId);
      if (!restoredTrack || epoch !== getProjectEpoch()) return false;
      const after = copy(restoredTrack);
      commandManager.push({ type: "RECOVER_UNAVAILABLE_FX", description: `Recover ${slot.pluginPath}`, timestamp: Date.now(),
        execute: () => { void enqueue(() => withBusy(async () => {
          if (epoch !== getProjectEpoch()) return;
          if (await install()) await apply(after);
        })).catch(error => { if (epoch === getProjectEpoch()) get().showToast(`FX recovery: ${String(error)}`, "error"); }); },
        undo: () => { void enqueue(() => withBusy(async () => {
          if (epoch !== getProjectEpoch()) return;
          clearPluginParameterManifests(trackId, slot.chain);
          const slots = await list();
          const index = installedId ? slots.findIndex(item => item.instanceId === installedId) : installedIndex;
          if (epoch !== getProjectEpoch()) return;
          if (index < 0 || slots[index]?.pluginPath !== slot.pluginPath) throw new Error("The recovered FX instance is no longer present");
          await clearRoutes();
          if (epoch !== getProjectEpoch()) return;
          if (!await remove(index)) { await apply(after); throw new Error("The recovered FX could not be removed; original data is retained in history"); }
          await apply(before);
        })).catch(error => { if (epoch === getProjectEpoch()) get().showToast(`Undo FX recovery: ${String(error)}`, "error"); }); } });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      return true;
    } finally { if (epoch === getProjectEpoch()) set({ automationRecoveryBusy: false }); }
  }).catch(error => { if (epoch === getProjectEpoch()) get().showToast(`FX recovery: ${String(error)}. Original data was retained.`, "error"); return false; });
}
