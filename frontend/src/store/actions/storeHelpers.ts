/**
 * Shared helper functions used by multiple extracted action files.
 * Originally module-level functions in useDAWStore.ts.
 */
import { nativeBridge } from "../../services/NativeBridge";
import { automationToBackend } from "../automationParams";
import { logBridgeError } from "../../utils/bridgeErrorHandler";

export const _linkingInProgress = new Set<string>();
export const _editSnapshots = new Map<string, number>();
export const _autoRecordTimers = new Map<string, number>();
export const _automationTouchedParams = new Set<string>();
export const _automationLatchedParams = new Set<string>();
export const _automationWriteValues = new Map<string, number>();
export const AUTO_RECORD_INTERVAL_MS = 50;

export type AutomationBackendMode = "off" | "read" | "write" | "touch" | "latch";
export type AutomationWriteBehaviorValue = "touch" | "latch" | "overwrite";

export function automationTouchKey(trackId: string, param: string): string {
  return `${trackId}::${param}`;
}

export function automationWriteBehaviorToBackendMode(
  behavior: AutomationWriteBehaviorValue,
): AutomationBackendMode {
  if (behavior === "latch") return "latch";
  if (behavior === "overwrite") return "write";
  return "touch";
}

export function automationLaneReadEnabled(lane: { readEnabled?: boolean; mode?: AutomationBackendMode }): boolean {
  return lane.readEnabled ?? lane.mode !== "off";
}

export function getLinkedTrackIds(
  trackId: string,
  trackGroups: Array<{ id: string; memberTrackIds: string[]; linkedParams: string[] }>,
  param?: string,
): string[] {
  for (const g of trackGroups) {
    if (g.memberTrackIds.includes(trackId)) {
      if (param && !g.linkedParams.includes(param)) return [trackId];
      return g.memberTrackIds;
    }
  }
  return [trackId];
}

export function syncAutomationLaneToBackend(
  trackId: string,
  lane: { param: string; points: { time: number; value: number }[]; mode?: AutomationBackendMode; readEnabled?: boolean },
) {
  const parameterId = lane.param;
  const converted = lane.points.map((p) => ({
    time: p.time,
    value: automationToBackend(lane.param, p.value),
  }));
  const mode = automationLaneReadEnabled(lane) ? (lane.mode ?? "read") : "off";
  return Promise.all([
    nativeBridge.setAutomationPoints(trackId, parameterId, converted).catch(logBridgeError("sync")),
    nativeBridge.setAutomationMode(trackId, parameterId, mode).catch(logBridgeError("sync")),
  ]);
}

export function syncTempoMarkersToBackend(markers: { time: number; tempo: number }[]) {
  if (markers.length === 0) {
    nativeBridge.clearTempoMarkers().catch(logBridgeError("sync"));
  } else {
    nativeBridge.setTempoMarkers(markers).catch(logBridgeError("sync"));
  }
}
