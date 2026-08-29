// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computePremiumStagePlacement,
  NAM_COMPRESSOR_FACEPLATE_LAYOUT,
  NAM_PRE_SIGNAL_LAYOUT,
  NAM_THREE_POSITION_SELECTOR_PX,
  compressorHpfDisplayLabel,
  compressorIntensityDisplayLabel,
} from "../components/NAMRackDesignPort";
import { projectNAMRackSchemaForUI, type BuiltInPluginSchema } from "../services/NativeBridge";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";

const currentCompressorIds = [
  "compressorEnabled",
  "compressorComp",
  "compressorAttackMs",
  "compressorReleaseMs",
  "compressorToneDb",
  "compressorIntensity",
  "compressorSidechainHPF",
  "compressorMix",
  "compressorVolumeDb",
] as const;

describe("NAM Rack Compressor V7 frontend contract", () => {
  it("keeps one current compressor identity and retires Detail everywhere", () => {
    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(19);
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { compressorDetail: 0.55 },
      dspState: { namEffectsDspVersion: 6, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number>; dspState: Record<string, number> };

    expect(migrated.dspState.namEffectsDspVersion).toBe(19);
    expect(migrated.values.compressorAttackMs).toBeCloseTo(21.9, 6);
    expect(migrated.values.compressorReleaseMs).toBeCloseTo(149.1, 6);
    expect(migrated.values.compressorToneDb).toBe(0);
    expect(migrated.values.compressorIntensity).toBe(0);
    expect(migrated.values.compressorSidechainHPF).toBe(1);
    expect(migrated.values).not.toHaveProperty("compressorDetail");
    expect(isCurrentNAMRackPresetState(migrated)).toBe(true);
  });

  it("preserves real units and the detector HPF enum in schema projection", () => {
    const parameters: BuiltInPluginSchema["parameters"] = [
      { id: "compressorAttackMs", label: "Attack", type: "continuous", value: 21.9, min: 0.1, max: 50, defaultValue: 21.9, unit: "ms" },
      { id: "compressorReleaseMs", label: "Release", type: "continuous", value: 149.1, min: 50, max: 1000, defaultValue: 149.1, unit: "ms" },
      { id: "compressorToneDb", label: "Tone", type: "continuous", value: 0, min: -6, max: 6, defaultValue: 0, unit: "dB" },
      { id: "compressorIntensity", label: "Intensity", type: "toggle", value: 0, min: 0, max: 1, defaultValue: 0 },
      { id: "compressorSidechainHPF", label: "HPF", type: "enum", value: 1, min: 0, max: 2, defaultValue: 1, enumOptions: [{ value: 0, label: "Off" }, { value: 1, label: "80 Hz" }, { value: 2, label: "240 Hz" }] },
      { id: "compressorVolumeDb", label: "Level", type: "continuous", value: 0, min: -18, max: 18, defaultValue: 0, unit: "dB" },
    ];
    const projected = projectNAMRackSchemaForUI({
      schemaVersion: 1,
      name: "OpenStudio NAM Rack",
      category: "NAM",
      chain: "track",
      fxIndex: 0,
      parameters,
      modelState: { namEffectsDspVersion: 8 },
    });

    expect(projected.parameters).toEqual(parameters);
    expect(projected.parameters.find(({ id }) => id === "compressorSidechainHPF")?.enumOptions)
      .toEqual([{ value: 0, label: "Off" }, { value: 1, label: "80 Hz" }, { value: 2, label: "240 Hz" }]);
  });

  it("keeps the 3x2 faceplate and footer zones separated in real design pixels", () => {
    const layout = NAM_COMPRESSOR_FACEPLATE_LAYOUT;
    const box = NAM_PRE_SIGNAL_LAYOUT.compressor;
    const knobRadius = layout.knobSize * box.w / 200;
    const atY = (percent: number) => percent * box.h / 100;
    const squareRadius = (size: number) => size * box.w / 200;

    expect(layout.columns).toEqual([22, 50, 78]);
    expect(layout.columns[1] - layout.columns[0]).toBe(layout.columns[2] - layout.columns[1]);
    expect(atY(layout.lowerY) - knobRadius - (atY(layout.topY) + knobRadius)).toBeGreaterThanOrEqual(18);

    const lowerKnobBottom = atY(layout.lowerY) + knobRadius;
    const lowerLabelTop = atY(layout.lowerY + layout.lowerLabelOffset) - 4;
    const lowerLabelBottom = atY(layout.lowerY + layout.lowerLabelOffset) + 4;
    const titleTop = atY(layout.titleY) - 6;
    const titleBottom = atY(layout.titleY) + 6;
    const ledTop = atY(layout.led.y) - squareRadius(layout.led.size);
    const ledBottom = atY(layout.led.y) + squareRadius(layout.led.size);
    // The standard ON/OFF capsule is 6 design pixels high (its hit target is
    // intentionally much larger), so use the photographed label edge here.
    const stateTop = atY(layout.stateLabelY) - 3;
    const stateBottom = atY(layout.stateLabelY) + 3;
    const footTop = atY(layout.foot.y) - squareRadius(layout.foot.size);
    const footBottom = atY(layout.foot.y) + squareRadius(layout.foot.size);

    expect(lowerLabelTop - lowerKnobBottom).toBeGreaterThanOrEqual(3);
    expect(titleTop - lowerLabelBottom).toBeGreaterThanOrEqual(3);
    expect(ledTop - titleBottom).toBeGreaterThanOrEqual(3);
    expect(stateTop - ledBottom).toBeGreaterThanOrEqual(3);
    expect(footTop - stateBottom).toBeGreaterThanOrEqual(2);
    expect(box.h - footBottom).toBeGreaterThanOrEqual(8);

    const meterRight = (layout.meter.x + layout.meter.w) * box.w / 100;
    const selectorLeft = (layout.hpfSelector.x - layout.hpfSelector.size / 2) * box.w / 100;
    const selectorRight = (layout.hpfSelector.x + layout.hpfSelector.size / 2) * box.w / 100;
    const meterBottom = (layout.meter.y + layout.meter.h) * box.h / 100;
    const selectorBottom = layout.hpfSelector.y * box.h / 100 + squareRadius(layout.hpfSelector.size);
    const readoutLeft = layout.hpfReadout.x * box.w / 100;
    const readoutRight = (layout.hpfReadout.x + layout.hpfReadout.w) * box.w / 100;
    expect(layout.meter.x).toBe(7);
    expect(selectorLeft - meterRight).toBeGreaterThanOrEqual(5.5);
    expect(selectorBottom).toBeCloseTo(meterBottom, 4);
    expect(readoutLeft - selectorRight).toBeGreaterThanOrEqual(5.5);
    expect(box.w - readoutRight).toBeGreaterThanOrEqual(10);
    expect(layout.hpfReadout.x + layout.hpfReadout.w).toBeLessThanOrEqual(93);
    expect(layout.hpfReadout.y).toBeGreaterThan(layout.meter.y - 2);
    expect(layout.hpfReadout.y + layout.hpfReadout.h).toBeLessThanOrEqual(layout.meter.y + layout.meter.h);
    expect((layout.meter.x + layout.meter.w) * box.w / 100).toBeLessThanOrEqual(box.w);
    expect(layout.hpfSelector.size * box.w / 100).toBeCloseTo(NAM_THREE_POSITION_SELECTOR_PX, 8);
    expect(layout.hpfSelector.size).toBeLessThan(layout.knobSize);

    const intensityToggleRight = (
      layout.intensityToggle.x + layout.intensityToggle.size / 2
    ) * box.w / 100;
    const footLeft = (
      layout.foot.x - layout.foot.size / 2
    ) * box.w / 100;
    const intensityReadoutRight = (
      layout.intensityReadout.x + layout.intensityReadout.w
    ) * box.w / 100;
    const intensityToggleBottom = layout.intensityToggle.y * box.h / 100
      + layout.intensityToggle.size * box.w / 200;
    expect(footLeft - intensityToggleRight).toBeGreaterThanOrEqual(18);
    expect(footLeft - intensityReadoutRight).toBeGreaterThanOrEqual(7);
    expect(box.h - intensityToggleBottom).toBeGreaterThanOrEqual(8);
    expect(layout.intensityReadout.x + layout.intensityReadout.w / 2).toBe(
      layout.intensityToggle.x,
    );
    const footRight = (layout.foot.x + layout.foot.size / 2) * box.w / 100;
    expect(box.w - footRight).toBeGreaterThanOrEqual(20);
    expect(layout.powerX).toBe(78);
    expect(layout.led.x).toBe(layout.powerX);
    expect(layout.foot.x).toBe(layout.powerX);
  });

  it("keeps every compressor HPF state visible in a compact pedal readout", () => {
    expect(compressorHpfDisplayLabel(0)).toBe("OFF");
    expect(compressorHpfDisplayLabel(1)).toBe("80");
    expect(compressorHpfDisplayLabel(2)).toBe("240");
    expect(compressorHpfDisplayLabel(Number.NaN)).toBe("OFF");
    expect(compressorIntensityDisplayLabel(0)).toBe("8:1");
    expect(compressorIntensityDisplayLabel(1)).toBe("16:1");
    expect(compressorIntensityDisplayLabel(Number.NaN)).toBe("8:1");
  });

  it("contains the compressor at compact, medium, wide, and every rack scale", () => {
    const group = { x: 5, y: 3, w: 898, h: 271 };
    const viewports = [
      { width: 720, height: 410 },
      { width: 1010, height: 520 },
      { width: 1366, height: 768 },
      { width: 3530, height: 1946 },
    ];

    for (const viewport of viewports) {
      for (const rackSize of [80, 100, 140, 180, 220]) {
        const placement = computePremiumStagePlacement(viewport, group, rackSize);
        const box = NAM_PRE_SIGNAL_LAYOUT.compressor;
        const left = placement.left + box.x * placement.scale;
        const right = left + box.w * placement.scale;
        const top = placement.top + box.y * placement.scale;
        const bottom = top + box.h * placement.scale;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(viewport.width);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeLessThanOrEqual(viewport.height);
      }
    }
  });

  it("uses matching wide six-control enclosures and a centred five-pedal row", () => {
    const compressor = NAM_PRE_SIGNAL_LAYOUT.compressor;
    const distortion = NAM_PRE_SIGNAL_LAYOUT.distortion;
    const row = Object.values(NAM_PRE_SIGNAL_LAYOUT);

    expect(compressor.w).toBe(156);
    expect(compressor.w).toBe(distortion.w);
    expect(compressor.h).toBe(distortion.h);
    expect(compressor.x).toBe(85);
    expect(distortion.x + distortion.w).toBe(833);
    for (let index = 1; index < row.length; index += 1) {
      expect(row[index].x - (row[index - 1].x + row[index - 1].w)).toBe(10);
    }
  });

  it("wires all controls, the fixed HPF selector, and live GR telemetry to every rack surface", () => {
    const sources = {
      panel: readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8"),
      mixer: readFileSync(new URL("../components/NAMRackMixer.tsx", import.meta.url), "utf8"),
      design: readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8"),
      bridge: readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8"),
      project: readFileSync(new URL("../store/actions/project.ts", import.meta.url), "utf8"),
    };

    for (const id of currentCompressorIds) {
      expect(sources.panel).toContain(id);
      expect(sources.mixer).toContain(id);
      expect(sources.bridge).toContain(id);
      expect(id === "compressorEnabled" || sources.design.includes(id)).toBe(true);
    }
    expect(sources.design).toContain("NAM_COMPRESSOR_FACEPLATE_LAYOUT");
    expect(sources.design).toContain('body={BODIES.blueWide}');
    expect(sources.design).toContain("<ThreePositionRotarySelector");
    expect(sources.design).toContain("NAM_COMPRESSOR_FACEPLATE_LAYOUT.hpfSelector");
    expect(sources.design).toContain("CompressorGainReductionMeter");
    expect(sources.design).toContain("<CompressorHPFReadout");
    expect(sources.design).toContain("NAM_COMPRESSOR_FACEPLATE_LAYOUT.hpfReadout");
    expect(sources.design).toContain("<CompressorIntensityReadout");
    expect(sources.design).toContain("NAM_COMPRESSOR_FACEPLATE_LAYOUT.intensityToggle");
    const ratioReadout = sources.design.slice(
      sources.design.indexOf("function CompressorIntensityReadout"),
      sources.design.indexOf("function Washer"),
    );
    expect(ratioReadout).toContain("Compressor ratio");
    expect(ratioReadout).not.toContain(">INTENSITY<");
    expect(sources.panel).toContain('numberFromRecord(rackDiagnostics, "compressorGainReductionDb")');
    expect(sources.panel).toContain("compressorGainReductionDb={compressorGainReductionDb}");
    expect(sources.project).toContain("return isRetiredNAMRackAutomationParamId(lane?.param)");
    expect(sources.project).toContain("if (isRetiredNAMRackAutomationLane(lane)) return false");
    expect(Object.values(sources).join("\n")).not.toContain('paramId="compressorDetail"');
    expect(`${sources.panel}\n${sources.design}`).not.toMatch(/\b(?:FET|OTA)\b/i);
  });
});
