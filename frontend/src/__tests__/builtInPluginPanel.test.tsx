import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error The app tsconfig does not include Node builtin typings, but Vitest runs this file in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BuiltInPluginPanel,
  BuiltInParamControl,
  formatParamValue,
  getPluginKind,
  groupLabel,
  groupSortWeight,
  primaryParamIdsForKind,
  stepForParam,
} from "../components/BuiltInPluginPanel";
import type { BuiltInParamDescriptor, BuiltInPluginSchema } from "../services/NativeBridge";

function param(overrides: Partial<BuiltInParamDescriptor>): BuiltInParamDescriptor {
  return {
    id: "value",
    label: "Value",
    type: "continuous",
    value: 0.5,
    min: 0,
    max: 1,
    defaultValue: 0,
    automatable: true,
    ...overrides,
  };
}

function schema(name: string, category: string): BuiltInPluginSchema {
  return {
    schemaVersion: 1,
    name,
    category,
    chain: "track",
    fxIndex: 0,
    parameters: [],
  };
}

function schemaWithParams(name: string, category: string, params: BuiltInParamDescriptor[]): BuiltInPluginSchema {
  return {
    ...schema(name, category),
    parameters: params,
    visualization: {
      frequencies: [20, 100, 1000, 10000, 20000],
      responseDb: [0, 1, -2, 0.5, 0],
      spectrumPreDb: [-70, -45, -30, -55, -78],
      spectrumPostDb: [-76, -48, -28, -58, -82],
      spectrumReady: true,
      dynamicGainDb: [0, -1, 0.5, 0, 0, 0, 0, 0],
      gainReductionDb: -6,
      inputLevelDb: -18,
      outputLevelDb: -24,
      gateOpen: true,
      historyDetectedMidi: [58, 59, 60, 61],
      historyCorrectedMidi: [60, 60, 60, 60],
      historyConfidence: [0.7, 0.8, 0.9],
    },
  };
}

function continuous(id: string, label: string, value: number, min = 0, max = 1, graphRole = "controls", unit = "") {
  return param({ id, label, value, min, max, graphRole, unit });
}

function toggle(id: string, label: string, value: number, graphRole = "controls") {
  return param({ id, label, type: "toggle", value, min: 0, max: 1, graphRole });
}

function choice(id: string, label: string, value: number, labels: string[], graphRole = "controls") {
  return param({
    id,
    label,
    type: "enum",
    value,
    min: 0,
    max: labels.length - 1,
    graphRole,
    enumOptions: labels.map((optionLabel, index) => ({ value: index, label: optionLabel })),
  });
}

function eqSchema() {
  const params: BuiltInParamDescriptor[] = [];
  for (let band = 0; band < 8; band += 1) {
    params.push(toggle(`band${band}.enabled`, `Band ${band + 1} On`, band === 0 ? 0 : 1, "eqBand"));
    params.push(continuous(`band${band}.freq`, `Band ${band + 1} Freq`, 100 * (band + 1), 20, 20000, "eqBand", "Hz"));
    params.push(continuous(`band${band}.gain`, `Band ${band + 1} Gain`, band === 2 ? 4 : 0, -30, 30, "eqBand", "dB"));
    params.push(continuous(`band${band}.q`, `Band ${band + 1} Q`, 1, 0.1, 30, "eqBand"));
  }
  params.push(continuous("outputGain", "Output", 0, -12, 12, "output", "dB"));
  params.push(toggle("autoGain", "Auto Gain", 1, "output"));
  params.push(choice("stereoMode", "Processing", 0, ["Stereo", "Mid", "Side"], "routing"));
  params.push(choice("auditionBand", "Audition", 0, ["Off", "Band 1"], "eqBand"));
  return schemaWithParams("S13 EQ", "EQ", params);
}

const panelSchemas = [
  eqSchema(),
  schemaWithParams("S13 Compressor", "Dynamics", [
    continuous("threshold", "Threshold", -18, -60, 0, "dynamics", "dB"),
    continuous("ratio", "Ratio", 4, 1, 20, "dynamics"),
    continuous("attack", "Attack", 12, 0.1, 100, "dynamics", "ms"),
    continuous("release", "Release", 160, 10, 2000, "dynamics", "ms"),
    toggle("autoMakeup", "Auto Makeup", 1, "output"),
  ]),
  schemaWithParams("S13 Delay", "Delay", [
    continuous("delayTimeL", "Delay L", 250, 1, 2000, "time", "ms"),
    continuous("delayTimeR", "Delay R", 375, 1, 2000, "time", "ms"),
    continuous("feedback", "Feedback", 0.42, 0, 0.95, "feedback"),
    continuous("mix", "Mix", 0.5, 0, 1, "mix"),
    continuous("ducking", "Ducking", 0.2, 0, 1, "dynamics"),
  ]),
  schemaWithParams("S13 Reverb", "Reverb", [
    choice("algorithm", "Algorithm", 1, ["Room", "Hall", "Plate"], "space"),
    continuous("roomSize", "Size", 0.6, 0, 1, "space"),
    continuous("decayTime", "Decay", 2.2, 0.1, 20, "space", "s"),
    continuous("wetLevel", "Wet", 0.33, 0, 1, "mix"),
    continuous("dryLevel", "Dry", 0.7, 0, 1, "mix"),
  ]),
  schemaWithParams("S13 Chorus", "Modulation", [
    choice("mode", "Mode", 0, ["Chorus", "Flanger", "Phaser"], "modulation"),
    continuous("rate", "Rate", 1, 0.01, 20, "modulation", "Hz"),
    continuous("depth", "Depth", 0.5, 0, 1, "modulation"),
    continuous("mix", "Mix", 0.5, 0, 1, "mix"),
    choice("characterMode", "Character", 1, ["Clean", "Ensemble", "BBD"], "character"),
  ]),
  schemaWithParams("S13 Saturator", "Saturation", [
    choice("satType", "Type", 1, ["Tape", "Tube", "Console"], "character"),
    continuous("drive", "Drive", 6, 0, 30, "drive", "dB"),
    continuous("mix", "Mix", 1, 0, 1, "mix"),
    continuous("outputGain", "Output", -3, -12, 0, "output", "dB"),
    choice("oversampleMode", "Oversampling", 2, ["Off", "2x", "4x"], "quality"),
  ]),
  schemaWithParams("S13 Pitch Correct", "Pitch", [
    choice("key", "Key", 0, ["C", "C#"], "scale"),
    choice("scale", "Scale", 1, ["Chromatic", "Major"], "scale"),
    continuous("retuneSpeed", "Retune", 50, 0, 400, "correction", "ms"),
    continuous("correctionStrength", "Strength", 0.8, 0, 1, "correction"),
    continuous("mix", "Mix", 1, 0, 1, "mix"),
  ]),
  schemaWithParams("OpenStudio Basic Synth", "Instrument", [
    continuous("brightness", "Brightness", 0.62, 0, 1, "tone"),
    continuous("detuneCents", "Detune", 7, 0, 35, "oscillator", "ct"),
    continuous("subLevel", "Sub", 0.18, 0, 0.8, "oscillator"),
    continuous("noiseLevel", "Air", 0.015, 0, 0.25, "oscillator"),
    continuous("outputGain", "Output", -15, -36, 0, "output", "dB"),
  ]),
  schemaWithParams("OpenStudio Piano", "Instrument", [
    choice("model", "Model", 0, ["Studio Grand", "Felt"], "character"),
    continuous("tone", "Tone", 0.58, 0, 1, "tone"),
    continuous("body", "Body", 0.72, 0, 1, "body"),
    continuous("resonance", "Resonance", 0.38, 0, 1, "body"),
    continuous("outputGain", "Output", -15, -36, 0, "output", "dB"),
  ]),
  schemaWithParams("OpenStudio Drums", "Instrument", [
    choice("kit", "Kit", 0, ["Studio", "Rock"], "drums"),
    choice("mapPreset", "MIDI Map", 1, ["GM", "Roland TD"], "drums"),
    continuous("punch", "Punch", 0.55, 0, 1, "character"),
    continuous("ambience", "Room", 0.18, 0, 1, "space"),
    continuous("outputGain", "Output", -10, -36, 0, "output", "dB"),
  ]),
];

describe("BuiltInPluginPanel schema model", () => {
  it("classifies built-in plugin schemas and selects primary controls", () => {
    const drums = schema("OpenStudio Drums", "Instrument");
    const reverb = schema("S13 Reverb", "Reverb");
    const limiter = schema("S13 Limiter", "Dynamics");

    expect(getPluginKind(drums)).toBe("drums");
    expect(getPluginKind(reverb)).toBe("reverb");
    expect(getPluginKind(limiter)).toBe("dynamics");
    expect(primaryParamIdsForKind("drums", drums)).toEqual(["kit", "mapPreset", "punch", "ambience", "outputGain"]);
    expect(primaryParamIdsForKind("reverb", reverb)).toContain("decayTime");
    expect(primaryParamIdsForKind("dynamics", limiter)).toEqual(["threshold", "ceiling", "lookaheadMs", "releaseMs"]);
  });

  it("keeps grouped controls in plugin-specific order", () => {
    expect(groupLabel("eqBand")).toBe("Bands");
    expect(groupSortWeight("eq", "eqBand")).toBeLessThan(groupSortWeight("eq", "output"));
    expect(groupSortWeight("saturation", "drive")).toBeLessThan(groupSortWeight("saturation", "quality"));
  });

  it("formats and renders continuous, enum, and toggle controls", () => {
    const continuous = param({ label: "Drive", value: 6, min: 0, max: 30, unit: "dB" });
    const enumParam = param({
      id: "satType",
      label: "Type",
      type: "enum",
      value: 1,
      min: 0,
      max: 2,
      enumOptions: [
        { value: 0, label: "Tape" },
        { value: 1, label: "Tube" },
      ],
    });
    const toggle = param({ id: "autoGain", label: "Auto Gain", type: "toggle", value: 1 });

    expect(formatParamValue(continuous)).toBe("6.0 dB");
    expect(formatParamValue(enumParam)).toBe("Tube");
    expect(formatParamValue(toggle)).toBe("On");
    expect(stepForParam(continuous)).toBeGreaterThan(0);

    expect(renderToStaticMarkup(<BuiltInParamControl param={continuous} onChange={() => undefined} />)).toContain('type="range"');
    expect(renderToStaticMarkup(<BuiltInParamControl param={enumParam} onChange={() => undefined} />)).toContain("<select");
    expect(renderToStaticMarkup(<BuiltInParamControl param={toggle} onChange={() => undefined} />)).toContain('aria-pressed="true"');
  });

  it("renders every built-in panel kind with visual, macro, and grouped responsive containers", () => {
    for (const panelSchema of panelSchemas) {
      const html = renderToStaticMarkup(
        <BuiltInPluginPanel
          address={{ chain: "track", trackId: "track-1", fxIndex: 0 }}
          fallbackName={panelSchema.name}
          initialSchema={panelSchema}
        />,
      );

      expect(html).toContain(`data-kind="${getPluginKind(panelSchema)}"`);
      expect(html).toContain("builtin-visual");
      expect(html).toContain("builtin-macro-strip");
      expect(html).toContain("builtin-param-groups");
      expect(html).toContain("builtin-control");
      expect(html).not.toContain("builtin-param-row");
    }
  });

  it("keeps responsive CSS contracts for desktop, tablet, and narrow plugin panels", () => {
    const css = readFileSync(new URL("../components/FXChainPanel.css", import.meta.url), "utf8");

    expect(css).toContain("grid-template-columns: 400px 1fr");
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(164px, 1fr))");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("grid-template-rows: minmax(260px, 44vh) minmax(0, 1fr)");
    expect(css).toContain("@media (max-width: 520px)");
    expect(css).toContain("height: 112px");
  });
});
