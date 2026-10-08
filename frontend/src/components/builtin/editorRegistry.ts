import type { ComponentType } from "react";
import type { ApprovedEffectEditorProps } from "./ApprovedEffectEditor";
import { ChorusEditor } from "./ChorusEditor";
import { DelayEditor } from "./DelayEditor";
import { ReverbEditor } from "./ReverbEditor";
import { GainPhaseEditor } from "./GainPhaseEditor";
import { BasicSynthEditor } from "./BasicSynthEditor";
import { PianoEditor } from "./PianoEditor";
import { CleanGuitarEditor } from "./CleanGuitarEditor";
import { DrumsEditor } from "./DrumsEditor";
import { GraphicEQEditor } from "./GraphicEQEditor";
import { CompressorEditor } from "./CompressorEditor";
import { GateEditor } from "./GateEditor";
import { LimiterEditor } from "./LimiterEditor";
import { PreampEditor } from "./PreampEditor";
import { SaturatorEditor } from "./SaturatorEditor";
import { SuiteEditor } from "./SuiteEditor";

export interface BuiltInEditorRegistration {
  component: ComponentType<ApprovedEffectEditorProps>;
  preferred: { width: number; height: number };
  minimum: { width: number; height: number };
  telemetry: "none" | "levels" | "timing" | "instrument";
}
const standard = { preferred: { width: 1040, height: 680 }, minimum: { width: 640, height: 480 } };
export const builtInEditorRegistry: Record<string, BuiltInEditorRegistration> = {
  compressor: { component: CompressorEditor, ...standard, telemetry: "levels" },
  gate: { component: GateEditor, ...standard, telemetry: "levels" },
  limiter: { component: LimiterEditor, ...standard, telemetry: "levels" },
  preamp: { component: PreampEditor, ...standard, telemetry: "levels" },
  saturator: { component: SaturatorEditor, ...standard, telemetry: "levels" },
  synth: { component: BasicSynthEditor, ...standard, telemetry: "instrument" },
  piano: { component: PianoEditor, ...standard, telemetry: "instrument" },
  guitar: { component: CleanGuitarEditor, ...standard, telemetry: "instrument" },
  drums: { component: DrumsEditor, ...standard, telemetry: "instrument" },
  utility: { component: GainPhaseEditor, ...standard, telemetry: "levels" },
  reverb: { component: ReverbEditor, preferred: { width: 1040, height: 680 }, minimum: standard.minimum, telemetry: "levels" },
  chorus: { component: ChorusEditor, preferred: { width: 940, height: 520 }, minimum: standard.minimum, telemetry: "timing" },
  delay: { component: DelayEditor, preferred: { width: 1040, height: 620 }, minimum: standard.minimum, telemetry: "timing" },
  geq: { component: GraphicEQEditor, ...standard, telemetry: "levels" },
};
export function getBuiltInEditor(pluginId?: string): BuiltInEditorRegistration {
  return builtInEditorRegistry[pluginId ?? ""] ?? { component: SuiteEditor, ...standard, telemetry: "none" };
}

/** Used before the schema arrives; native IDs remain the registry authority. */
export function builtInEditorPluginId(name: string): string {
  const names: Record<string, string> = {
    "OpenStudio EQ": "eq", "OpenStudio Graphic EQ": "geq", "OpenStudio Gain Phase": "utility",
    "OpenStudio Basic Synth": "synth", "OpenStudio Clean Guitar": "guitar", "OpenStudio Pitch Correct": "pitch",
  };
  return names[name] ?? name.replace(/^OpenStudio /, "").toLowerCase();
}
