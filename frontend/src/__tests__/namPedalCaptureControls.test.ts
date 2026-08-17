// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NAM_RACK_ADVANCED_CONTROL_IDS,
  namRackAdvancedStageForCompactModule,
  orderNAMRackMixerStages,
  type RackMixerStripSpec,
} from "../components/NAMRackMixer";

const stage = (id: string): RackMixerStripSpec => ({
  id,
  label: id,
  caption: id,
  active: false,
  params: [],
});

describe("NAM Pedal Capture controls", () => {
  it("exposes the real wet/dry control as its own Device Controls stage", () => {
    expect(NAM_RACK_ADVANCED_CONTROL_IDS["pedal-capture"]).toEqual(["pedalMix"]);
    expect(namRackAdvancedStageForCompactModule("pedal-capture")).toBe("pedal-capture");

    const ordered = orderNAMRackMixerStages([
      stage("amp"),
      stage("pedal-capture"),
      stage("chaos"),
    ], []);
    expect(ordered.map((entry) => entry.id)).toEqual(["chaos", "pedal-capture", "amp"]);
  });

  it("shows loaded identity, Mix, and truthful bypass semantics in the compact chain", () => {
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const captureCoreStart = panelSource.indexOf("const signalChainCaptureCore");
    const captureCoreEnd = panelSource.indexOf("const signalChainPost", captureCoreStart);
    const captureCore = panelSource.slice(captureCoreStart, captureCoreEnd);

    expect(panelSource).toContain('const togglePedalCapture = () => toggleParamPower("pedal", pedalMix, pedalActive, 0, 1)');
    expect(panelSource).toContain('label: "Pedal Capture"');
    expect(panelSource).toContain('params: stageParams(NAM_RACK_ADVANCED_CONTROL_IDS["pedal-capture"], { pedalMix: "Mix" })');
    expect(panelSource).toContain("Mix is also this capture's power control: 0% is a true bypass.");
    expect(captureCore).toContain('id: "pedal-capture"');
    expect(captureCore).toContain('caption: pedalName || "No capture loaded"');
    expect(captureCore).toContain('? formatPercentParam(pedalMix, "Mix", "Engaged")');
    expect(captureCore).toContain(': "Bypassed · Mix 0%"');
    expect(captureCore).toContain('onToggle: hasPedalModel && pedalMix ? togglePedalCapture : undefined');
    expect(captureCore.indexOf('id: "pedal-capture"')).toBeLessThan(captureCore.indexOf('id: "amp-nam"'));
  });
});
