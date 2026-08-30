import { describe, expect, it } from "vitest";

import {
  expectedNAMEffectiveCabEnabled,
  inspectNAMCaptureActivation,
  inspectNAMCaptureSchemaActivation,
  namCaptureUsePhaseLabel,
  namCaptureStateFromSchema,
} from "../utils/namCaptureActivation";

describe("NAM capture activation readback", () => {
  it("derives the effective Cab invariant from request and embedded topology", () => {
    expect(expectedNAMEffectiveCabEnabled(true, false)).toBe(true);
    expect(expectedNAMEffectiveCabEnabled(false, false)).toBe(false);
    expect(expectedNAMEffectiveCabEnabled(true, true)).toBe(false);
    expect(expectedNAMEffectiveCabEnabled(false, true)).toBe(false);
  });

  it("exposes the complete professional Use lifecycle for browser QA", () => {
    expect(["downloading", "preparing", "activating", "success", "error"].map((phase) =>
      namCaptureUsePhaseLabel(phase as Parameters<typeof namCaptureUsePhaseLabel>[0]),
    )).toEqual([
      "Downloading...",
      "Installing / Preparing...",
      "Activating...",
      "Activated",
      "Retry Use Capture",
    ]);
  });

  it("does not accept a matching path when the amp graph failed to load", () => {
    const result = inspectNAMCaptureActivation({
      modelState: {
        ampModelPath: "C:/OpenStudio/NAM/library/tone-42/Crunch.nam",
        hasAmpModel: false,
        lastLoadError: "Unsupported NAM architecture",
      },
      values: { auditionSource: 0 },
      uiState: { namActivePreview: null },
    }, "amp", "c:\\openstudio\\nam\\library\\tone-42\\crunch.nam", {
      requirePreviewCleared: true,
    });

    expect(result.verified).toBe(false);
    expect(result.pathMatches).toBe(true);
    expect(result.resourceLoaded).toBe(false);
    expect(result.reason).toBe("Unsupported NAM architecture");
  });

  it("requires the chosen capture, loaded graph, live input, and cleared preview marker", () => {
    expect(inspectNAMCaptureActivation({
      modelState: {
        ampModelPath: "C:/NAM/Chosen.nam",
        hasAmpModel: true,
        cabRequestedEnabled: true,
        lastLoadError: "",
      },
      values: { auditionSource: 0, ampEnabled: 1, ampMix: 1, cabEnabled: 1 },
      uiState: { namActivePreview: null },
    }, "amp", "C:/NAM/Chosen.nam", {
      requirePreviewCleared: true,
      expectedCabRequestedEnabled: true,
    }).verified).toBe(true);

    expect(inspectNAMCaptureActivation({
      modelState: {
        ampModelPath: "C:/NAM/Chosen.nam",
        hasAmpModel: true,
        cabRequestedEnabled: true,
      },
      values: { auditionSource: 1, ampEnabled: 1, ampMix: 1, cabEnabled: 1 },
      uiState: { namActivePreview: { slot: "amp" } },
    }, "amp", "C:/NAM/Chosen.nam", {
      requirePreviewCleared: true,
    })).toMatchObject({
      verified: false,
      liveSource: false,
      previewCleared: false,
    });
  });

  it("validates the exact schema accepted by the rack view before leaving the library", () => {
    const emptySchema = {
      parameters: [
        { id: "auditionSource", value: 0 },
        { id: "ampEnabled", value: 1 },
        { id: "ampMix", value: 1 },
        { id: "cabEnabled", value: 0 },
      ],
      modelState: {
        ampModelPath: "",
        hasAmpModel: false,
        cabRequestedEnabled: false,
      },
      uiState: { namActivePreview: null },
    };
    const acceptedSchema = {
      ...emptySchema,
      parameters: emptySchema.parameters.map((parameter) =>
        parameter.id === "cabEnabled" ? { ...parameter, value: 1 } : parameter,
      ),
      modelState: {
        ampModelPath: "C:/NAM/Installed/Chosen.nam",
        hasAmpModel: true,
        ampIncludesCab: false,
        cabRequestedEnabled: true,
        lastLoadError: "",
      },
    };

    expect(namCaptureStateFromSchema(acceptedSchema)?.values).toMatchObject({
      auditionSource: 0,
      ampEnabled: 1,
      ampMix: 1,
      cabEnabled: 1,
    });
    expect(inspectNAMCaptureSchemaActivation(
      emptySchema,
      "amp",
      "C:/NAM/Installed/Chosen.nam",
      {
        requireLiveSource: true,
        requirePreviewCleared: true,
        expectedCabRequestedEnabled: true,
      },
    ).verified).toBe(false);
    expect(inspectNAMCaptureSchemaActivation(
      acceptedSchema,
      "amp",
      "c:\\nam\\installed\\chosen.nam",
      {
        requireLiveSource: true,
        requirePreviewCleared: true,
        expectedCabRequestedEnabled: true,
      },
    )).toMatchObject({
      verified: true,
      pathMatches: true,
      resourceLoaded: true,
      liveSource: true,
      previewCleared: true,
    });
  });

  it("requires an activated amp capture to have power, wet mix, and preserved Cab intent", () => {
    const baseState = {
      modelState: {
        ampModelPath: "C:/NAM/Chosen.nam",
        hasAmpModel: true,
        cabRequestedEnabled: true,
      },
      values: {
        auditionSource: 0,
        cabEnabled: 1,
        ampEnabled: 1,
        ampMix: 1,
      },
    };

    expect(inspectNAMCaptureActivation({
      ...baseState,
      values: { ...baseState.values, ampEnabled: 0 },
    }, "amp", "C:/NAM/Chosen.nam", {
      expectedCabRequestedEnabled: true,
    }).reason).toBe("The amp capture loaded but Amp Power remained off.");

    expect(inspectNAMCaptureActivation({
      ...baseState,
      values: { ...baseState.values, ampMix: 0 },
    }, "amp", "C:/NAM/Chosen.nam", {
      expectedCabRequestedEnabled: true,
    }).reason).toBe("The amp capture loaded but Capture Mix remained fully dry.");

    expect(inspectNAMCaptureActivation({
      ...baseState,
      modelState: { ...baseState.modelState, cabRequestedEnabled: false },
    }, "amp", "C:/NAM/Chosen.nam", {
      expectedCabRequestedEnabled: true,
    }).reason).toBe("The rack did not preserve the requested external-cabinet preference.");

    expect(inspectNAMCaptureActivation({
      ...baseState,
      modelState: { ...baseState.modelState, ampIncludesCab: true },
      values: { ...baseState.values, cabEnabled: 1 },
    }, "amp", "C:/NAM/Chosen.nam", {
      expectedCabRequestedEnabled: true,
    }).reason).toBe("The effective Cab/IR state did not match the requested preference and amp topology.");

    expect(inspectNAMCaptureActivation({
      ...baseState,
      values: { ...baseState.values, cabEnabled: 0 },
    }, "amp", "C:/NAM/Chosen.nam", {
      expectedCabRequestedEnabled: true,
    }).reason).toBe("The effective Cab/IR state did not match the requested preference and amp topology.");

    expect(inspectNAMCaptureActivation({
      ...baseState,
      modelState: { ...baseState.modelState, cabRequestedEnabled: false },
      values: { ...baseState.values, cabEnabled: 1 },
    }, "amp", "C:/NAM/Chosen.nam", {
      expectedCabRequestedEnabled: false,
    }).reason).toBe("The effective Cab/IR state did not match the requested preference and amp topology.");

    expect(inspectNAMCaptureActivation({
      ...baseState,
      modelState: { ...baseState.modelState, ampIncludesCab: true },
      values: { ...baseState.values, cabEnabled: 0 },
    }, "amp", "C:/NAM/Chosen.nam", {
      expectedCabRequestedEnabled: true,
    })).toMatchObject({
      verified: true,
      expectedEffectiveCabEnabled: false,
      cabTopologySafe: true,
    });
  });

});
