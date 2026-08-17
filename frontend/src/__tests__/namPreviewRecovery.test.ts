import { describe, expect, it } from "vitest";

import { provisionalNAMPreviewMatchesState } from "../components/NAMExplorer";

const baseline = {
  pedalModelPath: "",
  ampModelPath: "C:/NAM/Baseline.nam",
  cabIRPath: "C:/IR/Baseline.wav",
  pedalDeclaredCaptureType: "unknown",
  ampDeclaredCaptureType: "full_rig",
  cabEnabled: 1,
  cabRequestedEnabled: true,
  pedalMix: 0,
  ampEnabled: 1,
  ampMix: 1,
  pedalCalibrationMode: 1,
  pedalOverrideInputLevelDbu: 12,
  pedalOverrideOutputLevelDbu: 12,
  ampCalibrationMode: 1,
  ampOverrideInputLevelDbu: 12,
  ampOverrideOutputLevelDbu: 12,
};

function audition(overrides: Record<string, unknown> = {}) {
  const candidate = {
    key: "amp:preview",
    slot: "amp",
    toneId: 1,
    modelId: 2,
    title: "Preview",
    modelName: "Preview",
    creator: "QA",
    localPath: "C:/NAM/Preview.nam",
    previousPath: baseline.ampModelPath,
    source: "installed",
    previewDownload: false,
    saved: false,
    action: "live-preview",
    captureType: "amp",
    includesCab: false,
    baseline,
    ...overrides,
  } as any;
  return {
    ...candidate,
    provisionalPublication: candidate.provisionalPublication ?? {
      slot: candidate.slot,
      localPath: candidate.localPath,
      cabRequestedEnabled: candidate.slot === "cab" ? true : baseline.cabRequestedEnabled,
      effectiveCabEnabled: candidate.slot === "cab" ? 1 : undefined,
      pedalMix: candidate.slot === "pedal" ? 1 : undefined,
      ampEnabled: candidate.slot === "amp" ? 1 : undefined,
      ampMix: candidate.slot === "amp" ? 1 : undefined,
    },
  } as any;
}

describe("NAM provisional preview recovery guard", () => {
  it("requires amp-only effective Cab state to match the preserved request", () => {
    const state = {
      modelState: {
        ampModelPath: "c:\\nam\\preview.nam",
        hasAmpModel: true,
        cabRequestedEnabled: true,
      },
      values: { auditionSource: 0, cabEnabled: 1, ampEnabled: 1, ampMix: 1 },
    };
    expect(provisionalNAMPreviewMatchesState(state, audition())).toBe(true);
    expect(provisionalNAMPreviewMatchesState({
      ...state,
      values: { ...state.values, cabEnabled: 0 },
    }, audition())).toBe(false);
  });

  it("ignores retired diagnostic-source state but rejects power, mix, or Cab changes", () => {
    const state = {
      modelState: {
        ampModelPath: "C:/NAM/Preview.nam",
        hasAmpModel: true,
        cabRequestedEnabled: true,
      },
      values: { auditionSource: 1, cabEnabled: 1, ampEnabled: 1, ampMix: 1 },
    };
    expect(provisionalNAMPreviewMatchesState(state, audition())).toBe(true);
    expect(provisionalNAMPreviewMatchesState({
      ...state,
      values: { auditionSource: 0, cabEnabled: 1, ampEnabled: 0, ampMix: 1 },
    }, audition())).toBe(false);
    expect(provisionalNAMPreviewMatchesState({
      ...state,
      values: { auditionSource: 0, cabEnabled: 1, ampEnabled: 1, ampMix: 0 },
    }, audition())).toBe(false);
    expect(provisionalNAMPreviewMatchesState({
      ...state,
      modelState: { ...state.modelState, cabRequestedEnabled: false },
      values: { auditionSource: 0, cabEnabled: 0, ampEnabled: 1, ampMix: 1 },
    }, audition())).toBe(false);
  });

  it("uses authoritative embedded-Cab topology for safety instead of a provisional effective-Cab guess", () => {
    const fullRig = audition({ captureType: "full-rig", includesCab: true });
    expect(provisionalNAMPreviewMatchesState({
      modelState: {
        ampModelPath: "C:/NAM/Preview.nam",
        hasAmpModel: true,
        ampIncludesCab: true,
        cabRequestedEnabled: true,
      },
      values: { auditionSource: 0, cabEnabled: 0, ampEnabled: 1, ampMix: 1 },
    }, fullRig)).toBe(true);
    expect(provisionalNAMPreviewMatchesState({
      modelState: {
        ampModelPath: "C:/NAM/Preview.nam",
        hasAmpModel: true,
        ampIncludesCab: true,
        cabRequestedEnabled: true,
      },
      values: { auditionSource: 0, cabEnabled: 1, ampEnabled: 1, ampMix: 1 },
    }, fullRig)).toBe(false);
  });

  it("rejects an effective Cab that is on while the durable request is off", () => {
    const requestOff = audition({
      provisionalPublication: {
        slot: "amp",
        localPath: "C:/NAM/Preview.nam",
        cabRequestedEnabled: false,
        effectiveCabEnabled: 0,
        ampEnabled: 1,
        ampMix: 1,
      },
    });
    const state = {
      modelState: {
        ampModelPath: "C:/NAM/Preview.nam",
        hasAmpModel: true,
        ampIncludesCab: false,
        cabRequestedEnabled: false,
      },
      values: { auditionSource: 0, cabEnabled: 0, ampEnabled: 1, ampMix: 1 },
    };
    expect(provisionalNAMPreviewMatchesState(state, requestOff)).toBe(true);
    expect(provisionalNAMPreviewMatchesState({
      ...state,
      values: { ...state.values, cabEnabled: 1 },
    }, requestOff)).toBe(false);
  });

  it("accepts only the still-enabled matching Cab/IR preview", () => {
    const cab = audition({
      key: "cab:preview",
      slot: "cab",
      localPath: "C:/IR/Preview.wav",
      previousPath: baseline.cabIRPath,
      captureType: "unknown",
    });
    expect(provisionalNAMPreviewMatchesState({
      modelState: { cabIRPath: "C:/IR/Preview.wav", hasCabIR: true, cabRequestedEnabled: true },
      values: { auditionSource: 0, cabEnabled: 1 },
    }, cab)).toBe(true);
    expect(provisionalNAMPreviewMatchesState({
      modelState: { cabIRPath: "C:/IR/Preview.wav", hasCabIR: true, cabRequestedEnabled: true },
      values: { auditionSource: 0, cabEnabled: 0 },
    }, cab)).toBe(false);
  });

});
