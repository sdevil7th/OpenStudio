import type { FXStageSlotState } from "../services/fxStageState";
import type { StoreApi } from "zustand";
import { nativeBridge } from "../services/NativeBridge";
import type { AutomationLane, DAWState, DAWActions } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { getProjectEpoch } from "./projectLifetime";
import { notifyFXChainChanged } from "./fxChain";
import { syncAutomationLaneToBackend } from "../store/actions/storeHelpers";
import { clearPluginParameterManifests, registerPluginParameterManifest, validatePluginAutomationLane } from "./pluginParameterManifest";
import { savedAutomationAddress, resolveSavedSafeParameter, type SavedSafeParameter } from "./automationRecovery";

export type StageChain = "master" | "monitor";
type StageStore = Pick<StoreApi<DAWState & DAWActions>, "getState" | "setState">;
type MissingStages = NonNullable<DAWState["unavailableFXStages"]>;
let stageStore: StageStore;
export function bindStageFXHistoryStore(store: StageStore) { stageStore = store; }
const isStageLane = (lane: Pick<AutomationLane, "param" | "unavailableParameter">, chain: StageChain) => {
  const param = lane.unavailableParameter?.parameterOnly ? lane.unavailableParameter.param : lane.param;
  return param.startsWith(`builtin_${chain}_`) || param.startsWith(`plugin_${chain}_`);
};
const restoreMissingStage = (live: MissingStages, saved: MissingStages, chain: StageChain): MissingStages => {
  const next = { ...live };
  if (saved[chain]) next[chain] = structuredClone(saved[chain]);
  else delete next[chain];
  return next;
};
const clone = (lanes: AutomationLane[]) => lanes.map(lane => ({ ...lane, points: lane.points.map(point => ({ ...point })) }));
let pending: Promise<unknown> = Promise.resolve();
const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
  const result = pending.then(work, work);
  pending = result.catch(() => undefined);
  return result;
};

export function editFXStage(chain: StageChain, description: string, mutate: () => Promise<boolean | void>): Promise<boolean> {
  const epoch = getProjectEpoch();
  return enqueue(async () => {
    if (epoch !== getProjectEpoch()) return false;
    const before = await nativeBridge.getFXStageState(chain);
    if (epoch !== getProjectEpoch()) return false;
    // Browser fixture/older backend: retain its existing behavior.
    if (!before) return (await mutate()) !== false && epoch === getProjectEpoch();
    const beforeLanes = clone(stageStore.getState().masterAutomationLanes.filter(lane => isStageLane(lane, chain)));
    const isStageParam = (param: string) => isStageLane({ param }, chain);
    const beforeSafe = (stageStore.getState().masterAutomationSafeParams ?? []).filter(isStageParam);
    const beforeSafeContracts = structuredClone((stageStore.getState().masterAutomationSafeParameters ?? []).filter(entry => isStageParam(entry.param)));
    const beforeMissing = structuredClone(stageStore.getState().unavailableFXStages ?? {});
    const bindCurrentStage = async (lanes: AutomationLane[], safe: string[], missing: typeof beforeMissing, contracts: SavedSafeParameter[]) => {
      const restoredSlots = await (chain === "master" ? nativeBridge.getMasterFX() : nativeBridge.getMonitoringFX());
      if (epoch !== getProjectEpoch()) return;
      const schemas = await Promise.all(restoredSlots.map(slot => nativeBridge.getPluginParameters(chain, slot.index, false)));
      if (epoch !== getProjectEpoch()) return;
      const registered = new Set<string>();
      schemas.forEach((parameters, index) => {
        const prefixes = new Set(parameters.map(parameter => parameter.automationId && savedAutomationAddress(parameter.automationId)?.prefix).filter((prefix): prefix is string => Boolean(prefix)));
        for (const prefix of prefixes) { registerPluginParameterManifest("master", prefix, parameters, restoredSlots[index]?.pluginPath ?? ""); registered.add(prefix); }
      });
      for (const lane of lanes) {
        const address = savedAutomationAddress(lane.unavailableParameter?.param ?? lane.param);
        if (address && lane.metadata && !registered.has(address.prefix)) registerPluginParameterManifest("master", address.prefix, [], "");
      }
      const boundLanes = lanes.map(lane => validatePluginAutomationLane("master", lane));
      const boundSafe = safe.map(param => {
        const address = savedAutomationAddress(param);
        if (!address) return param;
        const schema = schemas.find(parameters => parameters.some(parameter => parameter.automationId?.startsWith(address.prefix)));
        const contract = contracts.find(entry => entry.param === param) ?? { param, metadata: lanes.find(lane => lane.param === param)?.metadata };
        // An unavailable stage retains protection for later Retry. Legacy
        // documents without metadata keep their documented index fallback.
        if (!schema && (missing[chain]?.length || !contract.metadata)) return param;
        const parameter = schema && resolveSavedSafeParameter(contract, schema);
        if (!parameter) throw new Error("A restored Automation Safe control changed or is unavailable");
        return parameter.automationId ?? `${address.prefix}${address.kind === "builtin" ? parameter.paramId : parameter.index}`;
      });
      const boundContracts = contracts.map(entry => ({ ...entry, param: boundSafe[safe.indexOf(entry.param)] ?? entry.param }));
      return { lanes: boundLanes, safe: boundSafe, contracts: boundContracts };
    };
    const beforeModified = stageStore.getState().isModified;
    let after: FXStageSlotState[];
    try {
      if ((await mutate()) === false) return false;
      if (epoch !== getProjectEpoch()) return false;
      clearPluginParameterManifests("master", chain);
      const captured = await nativeBridge.getFXStageState(chain);
      if (epoch !== getProjectEpoch()) return false;
      if (!captured) throw new Error("The changed FX stage could not be captured");
      after = captured;
    } catch (error) {
      if (epoch !== getProjectEpoch()) return false;
      try {
        const liveLanes = stageStore.getState().masterAutomationLanes.filter(lane => isStageLane(lane, chain));
        for (const param of new Set([...liveLanes, ...beforeLanes].map(lane => lane.unavailableParameter?.param ?? lane.param))) {
          if (!await nativeBridge.setAutomationPoints("master", param, [])) throw new Error("The changed FX envelope could not be suspended");
          if (epoch !== getProjectEpoch()) return false;
        }
        if (!await nativeBridge.setFXStageState(chain, before)) throw new Error("The audio engine rejected rollback");
        if (epoch !== getProjectEpoch()) return false;
        clearPluginParameterManifests("master", chain);
        const bound = await bindCurrentStage(beforeLanes, beforeSafe, beforeMissing, beforeSafeContracts);
        if (!bound || epoch !== getProjectEpoch()) return false;
        stageStore.setState(state => ({
          masterAutomationLanes: [...state.masterAutomationLanes.filter(lane => !isStageLane(lane, chain)), ...bound.lanes],
          masterAutomationSafeParams: [...(state.masterAutomationSafeParams ?? []).filter(param => !isStageParam(param)), ...bound.safe],
          masterAutomationSafeParameters: [...(state.masterAutomationSafeParameters ?? []).filter(entry => !isStageParam(entry.param)), ...bound.contracts],
          unavailableFXStages: restoreMissingStage(state.unavailableFXStages ?? {}, beforeMissing, chain),
          ...(chain === "master" ? { masterFxCount: before.length } : {}), isModified: state.isModified || beforeModified,
        }));
        for (const lane of bound.lanes) {
          if (epoch !== getProjectEpoch()) return false;
          await syncAutomationLaneToBackend("master", lane);
        }
        notifyFXChainChanged({ trackId: "master", chainType: chain });
      } catch (rollbackError) {
        if (epoch !== getProjectEpoch()) return false;
        stageStore.setState({ projectRestoreError: `FX change rollback failed: ${String(rollbackError)}. Original failure: ${String(error)}`, isModified: true });
      }
      throw error;
    }
    const keys = after.map(slot => `_${slot.automationKey}_`);
    const afterLanes = clone(stageStore.getState().masterAutomationLanes.filter(lane => isStageLane(lane, chain)
      && keys.some(key => (lane.unavailableParameter?.param ?? lane.param).includes(key))));
    const afterSafe = (stageStore.getState().masterAutomationSafeParams ?? []).filter(param => isStageParam(param) && keys.some(key => param.includes(key)));
    const afterSafeContracts = structuredClone((stageStore.getState().masterAutomationSafeParameters ?? []).filter(entry => afterSafe.includes(entry.param)));
    const afterMissing = structuredClone(stageStore.getState().unavailableFXStages ?? {});
    const applyLanes = (lanes: AutomationLane[], safe: string[], missing = afterMissing, contracts = afterSafeContracts) => {
      stageStore.setState(state => ({ masterAutomationLanes: [
        ...state.masterAutomationLanes.filter(lane => !isStageLane(lane, chain)), ...clone(lanes),
      ], masterAutomationSafeParams: [...(state.masterAutomationSafeParams ?? []).filter(param => !isStageParam(param)), ...safe],
        masterAutomationSafeParameters: [...(state.masterAutomationSafeParameters ?? []).filter(entry => !isStageParam(entry.param)), ...structuredClone(contracts)],
        unavailableFXStages: restoreMissingStage(state.unavailableFXStages ?? {}, missing, chain),
        ...(chain === "master" ? { masterFxCount: after.length } : {}), isModified: true }));
      notifyFXChainChanged({ trackId: "master", chainType: chain });
    };
    const restore = async (slots: FXStageSlotState[], lanes: AutomationLane[], safe: string[], missing: typeof beforeMissing, contracts: SavedSafeParameter[]) => {
      if (epoch !== getProjectEpoch()) return;
      const live = await nativeBridge.getFXStageState(chain);
      if (!live || epoch !== getProjectEpoch()) return;
      const liveLanes = clone(stageStore.getState().masterAutomationLanes.filter(lane => isStageLane(lane, chain)));
      const liveSafe = (stageStore.getState().masterAutomationSafeParams ?? []).filter(isStageParam);
      const liveContracts = structuredClone((stageStore.getState().masterAutomationSafeParameters ?? []).filter(entry => isStageParam(entry.param)));
      const liveMissing = structuredClone(stageStore.getState().unavailableFXStages ?? {});
      clearPluginParameterManifests("master", chain);
      let installed = false;
      try {
        // Retire numeric routes before replacing processors. Fresh manifests
        // must resolve saved SDK IDs before Read can reach the restored stage.
        const routes = new Set([...liveLanes, ...lanes].map(lane => lane.unavailableParameter?.param ?? lane.param));
        for (const param of routes) if (savedAutomationAddress(param)?.chain === chain) {
          if (!await nativeBridge.setAutomationPoints("master", param, [])) throw new Error("The old FX envelope could not be suspended");
          if (epoch !== getProjectEpoch()) return;
        }
        if (!await nativeBridge.setFXStageState(chain, slots)) throw new Error("The audio engine rejected FX stage restoration");
        installed = true;
        if (epoch !== getProjectEpoch()) return;
        const bound = await bindCurrentStage(lanes, safe, missing, contracts);
        if (!bound || epoch !== getProjectEpoch()) return;
        applyLanes(bound.lanes, bound.safe, missing, bound.contracts);
        if (chain === "master") stageStore.setState({ masterFxCount: slots.length });
        for (const lane of bound.lanes) {
          if (epoch !== getProjectEpoch()) return;
          await syncAutomationLaneToBackend("master", lane);
        }
      } catch (error) {
        if (epoch !== getProjectEpoch()) return;
        clearPluginParameterManifests("master", chain);
        try {
          if (installed && !await nativeBridge.setFXStageState(chain, live)) throw new Error("The audio engine rejected rollback");
          if (epoch !== getProjectEpoch()) return;
          const rebound = await bindCurrentStage(liveLanes, liveSafe, liveMissing, liveContracts);
          if (!rebound || epoch !== getProjectEpoch()) return;
          applyLanes(rebound.lanes, rebound.safe, liveMissing, rebound.contracts);
          if (chain === "master") stageStore.setState({ masterFxCount: live.length });
          for (const lane of rebound.lanes) {
            if (epoch !== getProjectEpoch()) return;
            await syncAutomationLaneToBackend("master", lane);
          }
        } catch (rollbackError) {
          if (epoch !== getProjectEpoch()) return;
          const message = `FX undo rollback failed: ${String(rollbackError)}. Original failure: ${String(error)}`;
          // Neither processor state nor protection can be established. Keep
          // routes suspended and preserve the saved document until reopening.
          stageStore.setState({ projectRestoreError: message, isModified: true });
          throw new Error(message);
        }
        throw error;
      }
    };
    applyLanes(afterLanes, afterSafe);
    commandManager.push({ type: "EDIT_FX_STAGE", description, timestamp: Date.now(),
      execute: () => { void enqueue(() => restore(after, afterLanes, afterSafe, afterMissing, afterSafeContracts)).catch(report); },
      undo: () => { void enqueue(() => restore(before, beforeLanes, beforeSafe, beforeMissing, beforeSafeContracts)).catch(report); } });
    stageStore.setState({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    return true;
  }).catch(error => { if (epoch === getProjectEpoch()) report(error); return false; });
}
function report(error: unknown) { stageStore.getState().showToast(`FX chain change: ${String(error)}`, "error"); }
