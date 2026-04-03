/**
 * Metering actions — real-time level updates, peak tracking, clipping detection.
 * These update transient display state at 10-60Hz and should never trigger
 * re-renders of non-meter components.
 */

import { interpolateAtTime } from "../automationParams";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const meteringActions = (set: SetFn, get: GetFn) => ({
  setTrackMeterLevel: (trackId: string, level: number) => {
    set((state: any) => ({
      meterLevels: { ...state.meterLevels, [trackId]: level },
      peakLevels: {
        ...state.peakLevels,
        [trackId]: Math.max(state.peakLevels[trackId] ?? 0, level),
      },
    }));
  },

  batchUpdateMeterLevels: (
    levels: Record<string, number>,
    masterLevel: number,
    clippingStates: Record<string, boolean>,
    masterClipping: boolean
  ) => {
    set((state: any) => {
      let anyChanged = false;
      let newMeter = state.meterLevels;
      let newPeak = state.peakLevels;
      let newClipping = state.clippingStates;

      for (const track of state.tracks) {
        const level = levels[track.id];
        const clipping = clippingStates[track.id] ?? false;
        const levelChanged = level !== undefined && level !== newMeter[track.id];
        const clippingChanged = clipping !== (state.clippingStates[track.id] ?? false);
        if (!levelChanged && !clippingChanged) continue;
        if (!anyChanged) {
          newMeter = { ...state.meterLevels };
          newPeak = { ...state.peakLevels };
          newClipping = { ...state.clippingStates };
          anyChanged = true;
        }
        if (level !== undefined) {
          newMeter[track.id] = level;
          newPeak[track.id] = Math.max(newPeak[track.id] ?? 0, level);
        }
        newClipping[track.id] = clipping;
      }

      if (
        masterLevel !== state.meterLevels["master"] ||
        masterClipping !== (state.clippingStates["master"] ?? false)
      ) {
        if (!anyChanged) {
          newMeter = { ...state.meterLevels };
          newPeak = { ...state.peakLevels };
          newClipping = { ...state.clippingStates };
          anyChanged = true;
        }
        newMeter["master"] = masterLevel;
        newPeak["master"] = Math.max(newPeak["master"] ?? 0, masterLevel);
        newClipping["master"] = masterClipping;
      }

      if (!anyChanged && masterLevel === state.masterLevel) return state;
      if (!anyChanged) return { masterLevel };
      return {
        meterLevels: newMeter,
        peakLevels: newPeak,
        clippingStates: newClipping,
        masterLevel,
      };
    });
  },

  setMasterLevel: (level: number) => set({ masterLevel: level }),

  updateAutomatedValues: () => {
    const state = get();
    const time = state.transport.currentTime;
    const prev = state.automatedParamValues;
    const next: Record<string, Record<string, number>> = {};

    for (const track of state.tracks) {
      if (!track.automationEnabled) continue;
      for (const lane of track.automationLanes) {
        if (lane.mode === "off" || lane.points.length === 0) continue;
        const normalized = interpolateAtTime(lane.points, time);
        const rounded = Math.round(normalized * 10000) / 10000;
        if (!next[track.id]) next[track.id] = {};
        next[track.id][lane.param] = rounded;
      }
    }

    const prevTrackIds = Object.keys(prev);
    const nextTrackIds = Object.keys(next);
    let changed = prevTrackIds.length !== nextTrackIds.length;

    if (!changed) {
      for (const trackId of nextTrackIds) {
        const prevTrackValues = prev[trackId] ?? {};
        const nextTrackValues = next[trackId] ?? {};
        const prevParams = Object.keys(prevTrackValues);
        const nextParams = Object.keys(nextTrackValues);
        if (prevParams.length !== nextParams.length) {
          changed = true;
          break;
        }
        for (const param of nextParams) {
          if (prevTrackValues[param] !== nextTrackValues[param]) {
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }

    if (changed) set({ automatedParamValues: next });
  },
});
