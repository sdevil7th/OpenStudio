import type { StoreApi } from "zustand";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import type { DAWState, DAWActions, Track, AutomationLane } from "../store/useDAWStore";
import { getProjectEpoch } from "./projectLifetime";
import { graphProblem } from "./projectValidation";
import { parseSendAutomationParamId } from "../store/automationParams";
import { syncAutomationLaneToBackend } from "../store/actions/storeHelpers";

type Sends = Track["sends"];
type Send = Sends[number];
type Store = Pick<DAWState & DAWActions, "tracks" | "showToast" | "endAutomationParamTouch">;
type Setter = StoreApi<DAWState & DAWActions>["setState"];
const cloneLanes = (lanes: AutomationLane[]) => structuredClone(lanes);
const sameSends = (left: Sends, right: Sends) => JSON.stringify(left) === JSON.stringify(right);
const sendDestination = (lane: AutomationLane) => parseSendAutomationParamId(lane.param)?.destinationId;
let pending: Promise<unknown> = Promise.resolve();

// Indices belong to the current ordered graph, so structural edits and their
// history share a queue. Continuous gestures can still update surviving sends.
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const operation = pending.then(work, work);
  pending = operation.catch(() => undefined);
  return operation;
}

function copyChangedField<K extends keyof Send>(next: Send, before: Send, after: Send, key: K) {
  if (before[key] !== after[key]) next[key] = after[key];
}

function mergeSendChange(before: Sends, after: Sends, live: Sends): Sends {
  return after.map(send => {
    const original = before.find(item => item.destTrackId === send.destTrackId);
    const current = live.find(item => item.destTrackId === send.destTrackId);
    if (!original || !current) return { ...send };
    const next = { ...current };
    for (const key of ["level", "pan", "enabled", "preFader", "phaseInvert", "sourceChannel", "trimDB"] as const)
      copyChangedField(next, original, send, key);
    return next;
  });
}

async function syncSends(trackId: string, after: Sends, isCurrent: () => boolean) {
  if (!isCurrent()) return false;
  const accepted = await nativeBridge.replaceTrackSends(trackId, after);
  if (!isCurrent()) return false;
  if (!accepted) throw new Error("The audio engine rejected the send update");
  return true;
}

/** Returns true only when the current project accepted an actual change. */
export function editTrackSends(set: Setter, get: () => Store, trackId: string,
  description: string, change: (sends: Sends) => Sends): Promise<boolean> {
  const epoch = getProjectEpoch();
  const isCurrent = () => epoch === getProjectEpoch() && get().tracks.some(item => item.id === trackId);
  const report = (error: unknown) => { if (isCurrent()) get().showToast(`${description}: ${String(error)}`, "error"); };
  return enqueue(async () => {
    if (!isCurrent()) return false;
    const track = get().tracks.find(item => item.id === trackId)!;
    const before = track.sends.map(send => ({ ...send }));
    const after = change(before.map(send => ({ ...send })));
    if (sameSends(before, after)) return false;

    // Only removed destinations belong to this command's envelope history.
    // Surviving lanes stay live, including edits made while the bridge is pending.
    let removedLanes: AutomationLane[] = [];
    const apply = async (from: Sends, to: Sends, restoreLanes: AutomationLane[]) => {
      if (!isCurrent()) return false;
      const removedDestinations = new Set(from.filter(send => !to.some(item => item.destTrackId === send.destTrackId)).map(send => send.destTrackId));
      const currentTrack = () => get().tracks.find(item => item.id === trackId)!;
      const retiredParams = new Set<string>();
      const initialDesired = mergeSendChange(from, to, currentTrack().sends);
      const initialProblem = graphProblem(get().tracks.map(item => item.id === trackId ? { ...item, sends: initialDesired } : item));
      if (initialProblem) throw new Error(initialProblem);
      try {
        for (const lane of currentTrack().automationLanes.filter(lane => removedDestinations.has(sendDestination(lane) ?? ""))) {
          get().endAutomationParamTouch(trackId, lane.param);
          retiredParams.add(lane.param);
          const disabled = await nativeBridge.setAutomationMode(trackId, lane.param, "off");
          if (!isCurrent()) return false;
          if (!disabled) throw new Error("The audio engine rejected send automation suspension");
          const cleared = await nativeBridge.setAutomationPoints(trackId, lane.param, []);
          if (!isCurrent()) return false;
          if (!cleared) throw new Error("The audio engine rejected send automation suspension");
        }
        let desired: Sends;
        // Rebase continuous level/pan/trim edits that arrived during native work.
        // The final synchronous commit cannot overwrite a newer gesture.
        do {
          if (!isCurrent()) return false;
          desired = mergeSendChange(from, to, currentTrack().sends);
          const problem = graphProblem(get().tracks.map(item => item.id === trackId ? { ...item, sends: desired } : item));
          if (problem) throw new Error(problem);
          if (!await syncSends(trackId, desired, isCurrent)) return false;
        } while (!sameSends(desired, mergeSendChange(from, to, currentTrack().sends)));

        for (const lane of restoreLanes) {
          if (!isCurrent()) return false;
          const result = await syncAutomationLaneToBackend(trackId, lane);
          if (!isCurrent()) return false;
          if (result.some(accepted => accepted !== true)) throw new Error("The audio engine rejected send automation restoration");
        }
        // A restored lane needs an existing native destination. Its async sync
        // may overlap a surviving send gesture, so reconcile once more below.
        while (!sameSends(desired, mergeSendChange(from, to, currentTrack().sends))) {
          desired = mergeSendChange(from, to, currentTrack().sends);
          if (!await syncSends(trackId, desired, isCurrent)) return false;
        }
        const retired = cloneLanes(currentTrack().automationLanes.filter(lane => removedDestinations.has(sendDestination(lane) ?? "")));
        set(state => ({ tracks: state.tracks.map(item => item.id === trackId
          ? { ...item, sends: desired, automationLanes: [
            ...item.automationLanes.filter(lane => !removedDestinations.has(sendDestination(lane) ?? "")),
            ...cloneLanes(restoreLanes),
          ] } : item), isModified: true }));
        removedLanes = retired;
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        const actual = await nativeBridge.getTrackSends(trackId);
        if (!isCurrent()) return false;
        if (!sameSends(actual, currentTrack().sends)) await syncSends(trackId, currentTrack().sends, isCurrent);
        if (!isCurrent()) return false;
        for (const lane of currentTrack().automationLanes.filter(lane => retiredParams.has(lane.param))) {
          if (!isCurrent()) return false;
          await syncAutomationLaneToBackend(trackId, lane);
        }
        throw error;
      }
    };
    if (!await apply(before, after, [])) return false;
    if (!isCurrent()) return false;
    let beforeRemoved = cloneLanes(removedLanes);
    let afterRemoved: AutomationLane[] = [];
    commandManager.push({ type: "EDIT_TRACK_SENDS", description, timestamp: Date.now(),
      execute: () => { void enqueue(async () => {
        if (await apply(before, after, afterRemoved)) beforeRemoved = cloneLanes(removedLanes);
      }).catch(report); },
      undo: () => { void enqueue(async () => {
        if (await apply(after, before, beforeRemoved)) afterRemoved = cloneLanes(removedLanes);
      }).catch(report); } });
    set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    return true;
  }).catch(error => { report(error); return false; });
}
