// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveNAMRackCabinetSpaceActivity } from "../services/NativeBridge";
import {
  NAM_RACK_ADVANCED_CONTROL_IDS,
  NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS,
  NAM_RACK_CABINET_SPACE_PARAM_IDS,
  isNAMRackCabinetSpaceParamId,
  namRackAdvancedStageForCompactModule,
} from "../components/NAMRackMixer";
import { migrateLegacyNAMRackPresetDspState } from "../utils/namRackPresetTransactions";

describe("NAM Rack Cabinet Space controls", () => {
  it("keeps the room and doubler in their own stable advanced-control group", () => {
    expect(NAM_RACK_CABINET_SPACE_PARAM_IDS).toEqual([
      "cabRoomEnabled",
      "cabRoomAmount",
      "cabRoomWidth",
      "cabDoublerEnabled",
      "cabDoublerMix",
      "cabDoublerDelayMs",
      "cabDoublerSpread",
    ]);
    expect(NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[1]).toEqual({
      id: "room",
      label: "Room",
      paramIds: ["cabRoomEnabled", "cabRoomAmount", "cabRoomWidth"],
    });
    expect(NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[2]).toEqual({
      id: "doubler",
      label: "Doubler",
      paramIds: ["cabDoublerEnabled", "cabDoublerMix", "cabDoublerDelayMs", "cabDoublerSpread"],
    });
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.cab).toEqual([...NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[0].paramIds]);
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.room).toEqual([...NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[1].paramIds]);
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.doubler).toEqual([...NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[2].paramIds]);
    expect(isNAMRackCabinetSpaceParamId("cabRoomAmount")).toBe(true);
    expect(isNAMRackCabinetSpaceParamId("cabRoomSend")).toBe(false);
  });

  it("uses the locked defaults in both mock schema and portable preset defaults", () => {
    const bridgeSource = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");

    for (const expected of [
      'param("cabRoomEnabled", "Room", 0, 0, 1, "", "cabinetSpace", "toggle")',
      'param("cabRoomAmount", "Room Amount", 0.22, 0, 1',
      'param("cabRoomWidth", "Room Width", 0.65, 0, 1',
      'param("cabDoublerEnabled", "Doubler", 0, 0, 1, "", "cabinetSpace", "toggle")',
      'param("cabDoublerMix", "Doubler Mix", 0.12, 0, 1',
      'param("cabDoublerDelayMs", "Doubler Delay", 4.5, 3, 20, "ms", "cabinetSpace")',
      'param("cabDoublerSpread", "Doubler Spread", 0.65, 0, 1',
    ]) {
      expect(bridgeSource).toContain(expected);
    }
    expect(panelSource).toContain("cabRoomEnabled: 0");
    expect(panelSource).toContain("cabRoomAmount: 0.22");
    expect(panelSource).toContain("cabRoomWidth: 0.65");
    expect(panelSource).toContain("cabDoublerEnabled: 0");
    expect(panelSource).toContain("cabDoublerMix: 0.12");
    expect(panelSource).toContain("cabDoublerDelayMs: 4.5");
    expect(panelSource).toContain("cabDoublerSpread: 0.65");
    expect(panelSource).toContain("paramGroups: [NAM_RACK_CAB_ADVANCED_CONTROL_GROUPS[0]]");
    expect(panelSource).toContain("Room has its own power switch");
    expect(panelSource).toContain("Doubler has its own power switch");
    expect(panelSource).toContain("before EQ, Modulation, Delay, and Reverb");
  });

  it("fills deterministic cabinet-space values without persisting routing topology", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {},
      dspState: { namEffectsDspVersion: 5, reverbEngineVersion: 3 },
    }, { completePreset: true }) as { values: Record<string, number> };

    expect(migrated.values).toMatchObject({
      cabRoomEnabled: 0,
      cabRoomAmount: 0.22,
      cabRoomWidth: 0.65,
      cabDoublerEnabled: 0,
      cabDoublerMix: 0.12,
      cabDoublerDelayMs: 4.5,
      cabDoublerSpread: 0.65,
    });
    expect(migrated.values).not.toHaveProperty("inputMode");
  });

  it("reports Room and Doubler activity independently from the external Cab/IR power", () => {
    expect(resolveNAMRackCabinetSpaceActivity(0, 0)).toEqual({
      active: false,
      roomActive: false,
      doublerActive: false,
      label: "",
    });
    expect(resolveNAMRackCabinetSpaceActivity(1, 0)).toEqual({
      active: true,
      roomActive: true,
      doublerActive: false,
      label: "Room",
    });
    expect(resolveNAMRackCabinetSpaceActivity(0, 1)).toEqual({
      active: true,
      roomActive: false,
      doublerActive: true,
      label: "Doubler",
    });
    expect(resolveNAMRackCabinetSpaceActivity(1, 1)).toEqual({
      active: true,
      roomActive: true,
      doublerActive: true,
      label: "Room + Doubler",
    });
    expect(resolveNAMRackCabinetSpaceActivity(Number.NaN, undefined)).toEqual({
      active: false,
      roomActive: false,
      doublerActive: false,
      label: "",
    });
    expect(resolveNAMRackCabinetSpaceActivity(0.49, 0.49)).toEqual({
      active: false,
      roomActive: false,
      doublerActive: false,
      label: "",
    });
  });

  it("keeps compact Cab/IR, Room, and Doubler independently powered without duplicate advanced editors", () => {
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");

    expect(panelSource).toContain("const cabinetStageActive = embeddedCabCapture || cabActive || cabinetSpaceAudible");
    expect(panelSource).toContain('id: "room"');
    expect(panelSource).toContain('label: "Room"');
    expect(panelSource).toContain('id: "doubler"');
    expect(panelSource).toContain('label: "Doubler"');
    expect(panelSource).toContain("const toggleRoom = () => toggleEffectPower(cabRoomEnabledParam, roomActive)");
    expect(panelSource).toContain("const toggleDoubler = () => toggleEffectPower(cabDoublerEnabledParam, doublerActive)");
    expect(panelSource).not.toContain("toggleCabinetSpacePower");
    expect(panelSource).not.toContain("cabinetSpaceBusy");
    expect(panelSource).toContain('onToggle: !cabEnabledParam || !cabPresentation.canToggleExternalCab ? undefined : toggleCabPower');
    expect(namRackAdvancedStageForCompactModule("cab-ir")).toBeNull();
    expect(namRackAdvancedStageForCompactModule("room")).toBeNull();
    expect(namRackAdvancedStageForCompactModule("doubler")).toBeNull();
  });

  it("preserves an enabled Room while reporting that no speaker-voiced cab source is available", () => {
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");

    expect(panelSource).toContain('booleanFromRecord(rackDiagnostics, "cabRoomInputSourceAvailable")');
    expect(panelSource).toContain("?? (cabActive || (ampActive && embeddedCabCapture))");
    expect(panelSource).toContain("const roomWaitingForCabSource = roomActive && !cabRoomInputSourceAvailable");
    expect(panelSource).toContain('roomWaitingForCabSource ? "No cab source"');
    expect(panelSource).toContain("enabled: roomActive");
    expect(panelSource).not.toContain("onParamChange(cabRoomEnabledParam, 0)");
  });

  it("keeps Doubler visible globally and pauses it in Stereo without rewriting its saved settings", () => {
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");

    expect(panelSource).toContain("const doublerAudible = doublerActive && !stereoInputActive");
    expect(panelSource).toContain('className="nam-neural-global-knob nam-neural-global-doubler"');
    expect(panelSource).toContain("the DAW route is stereo");
    expect(panelSource).toContain("disabled={stereoInputActive}");
    expect(panelSource).toContain('paramById(params, "cabDoublerDelayMs")');
    expect(panelSource).toContain("Mix, Delay, and Spread are preserved");
    expect(panelSource).not.toContain("onParamChange(cabDoublerEnabledParam, 0)");
  });

  it("binds an uncluttered 3-20 ms Delay control and explicit readout on the current Doubler asset", () => {
    const designSource = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    const utilityStart = designSource.indexOf("function PremiumHeaderUtility(");
    const utilityEnd = designSource.indexOf("function BoundDistortionModeDisplay", utilityStart);
    const doublerUtility = designSource.slice(utilityStart, utilityEnd);

    expect(doublerUtility).toContain('useBoundDesignParam("cabDoublerDelayMs")');
    expect(doublerUtility).toContain('data-utility-rotary="delay"');
    expect(doublerUtility).toContain('paramId="cabDoublerDelayMs"');
    expect(doublerUtility).toContain("<span>Delay</span>");
    expect(doublerUtility).toContain("<strong>{doublerDelayLabel}</strong>");
    expect(doublerUtility).toContain('"4.5 ms"');
  });

  it("keeps legacy cabRoomSend named Bloom rather than misrepresenting it as the new room", () => {
    const design = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    const paramIndex = design.indexOf('paramId="cabRoomSend"');
    const controlStart = design.lastIndexOf("<Knob", paramIndex);
    const controlEnd = design.indexOf("/>", paramIndex);
    const control = design.slice(controlStart, controlEnd + 2);

    expect(paramIndex).toBeGreaterThan(-1);
    expect(controlStart).toBeGreaterThan(-1);
    expect(control).toContain('paramId="cabRoomSend"');
    expect(control).toContain('labelText="LOW BLOOM"');
    expect(control).not.toContain('labelText="ROOM"');
  });
});
