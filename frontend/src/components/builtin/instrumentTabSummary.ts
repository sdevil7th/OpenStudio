import type { BuiltInPluginSchema } from "../../services/NativeBridge";
import { findBuiltInParameter } from "../../utils/builtInExpandedSelectors";
import { changedEffectSettings } from "./EffectDetailIndicator";

const slots = (count: number, fields: string[], start = 1) => Array.from({ length: count }, (_, index) => fields.map(field => field.replace("#", String(index + start)))).flat();
const pages: Record<string, Record<string, string[]>> = {
  synth: {
    Voice: ["oscillatorAShape", "oscillatorBShape", "oscillatorBlend", "detuneCents", "subLevel", "noiseLevel", "filterMode", "filterCutoff", "filterQ", "filterEnvelope", "attackMs", "decayMs", "sustain", "releaseMs", "brightness", ...slots(4, ["macro#"])],
    Modulation: [...slots(8, ["matrix#Source", "matrix#Target", "matrix#Amount"]), "lfoMode", "lfoShape", "lfoRate", "lfoDepth", "lfoDestination", ...slots(4, ["macro#"])],
    "Filter envelope": ["filterEnvelopeSource", "filterAttackMs", "filterDecayMs", "filterSustain", "filterReleaseMs", "filterEnvelope", "filterVelocity", "filterKeyTrack"],
    Expression: ["mpeEnabled", "mpeLowerMembers", "mpeLowerBend", "mpeLowerMasterBend", "mpeUpperMembers", "mpeUpperBend", "mpeUpperMasterBend", "wheelMode", ...slots(4, ["macro#CC", "macro#Channel"])],
  },
  piano: {
    Instrument: ["model", "tone", "body", "hammer", "resonance", "releaseMs", "stereoWidth", "performanceMode", "velocityCurve", "strikeColour"],
    Performance: ["performanceMode", "velocityCurve", "strikeColour", "releaseVelocity", "damperCurve", "softPedalDepth"],
    Resonance: ["coupledBody", "bodyCoupling", "bodyDecay", "resonance", "releaseMs"],
  },
  guitar: {
    Play: ["model", "stringEngine", "articulation", "articulationKeys", "stringMode", "tone", "stringDecay", "stringDamping", "palmMute", "body", "releaseMs", "harmonicNode", "slideTime", "bendRangeSemitones"],
    "Pick & body": ["pickPosition", "pickHardness", "pickupPosition", "pickNoise", "body", "coupledBody", "bodyCoupling", "bodyDecay"],
    "Chorus & MIDI": ["chorusMix", "chorusRate", "chorusDepth", "chorus", "stringMode", "articulationKeys", "bendRangeSemitones", "releaseMs"],
  },
  drums: {
    Kit: ["kit", "articulationEngine", "tuning", "punch", "ambience", "hihatTightness", "velocityCurve", ...slots(8, ["pieceGain#", "pieceTuning#", "piecePan#", "pieceDecay#", "pieceOutput#"], 0)],
    Mapping: ["mapPreset", "customMapEnabled", "velocityCurve", "hihatTightness"],
    Outputs: slots(8, ["pieceGain#", "piecePan#", "pieceOutput#"], 0),
  },
};

/** Saved settings and effective configuration, never inferred live activity. */
export function instrumentTabSummary(schema: BuiltInPluginSchema, kind: string, tab: string): string {
  const value = (id: string) => findBuiltInParameter(schema, id)?.value ?? 0;
  const changed = changedEffectSettings(schema, pages[kind]?.[tab] ?? []);
  const status: string[] = [];
  if (kind === "synth" && tab === "Modulation") {
    const configured = Array.from({ length: 8 }, (_, index) => index + 1).filter(slot => value(`matrix${slot}Source`) > 0 && value(`matrix${slot}Target`) > 0 && value(`matrix${slot}Amount`) !== 0).length;
    if (configured) status.push(`${configured} configured matrix route${configured === 1 ? "" : "s"}`);
  }
  if (kind === "synth" && tab === "Filter envelope" && changed && value("filterMode") === 0) status.push("Envelope settings retained; Legacy filter selected");
  if (kind === "synth" && tab === "Expression" && value("mpeEnabled") >= .5) status.push("MPE enabled");
  if (kind === "piano" && tab === "Performance") {
    if (value("performanceMode") >= .5) status.push("Expressive response enabled");
    else if (changed) status.push("Performance settings retained; Legacy response selected");
  }
  if ((kind === "piano" && tab === "Resonance" || kind === "guitar" && tab === "Pick & body") && value("coupledBody") > 0) status.push("Coupled body enabled");
  if (kind === "guitar" && tab === "Chorus & MIDI") {
    if (value("chorusMix") > 0) status.push("Delay chorus enabled");
    if (value("articulationKeys") >= .5) status.push("MIDI keyswitches enabled");
  }
  if (kind === "drums" && tab === "Mapping") {
    const custom = schema.parameters.filter(parameter => /^noteMap\d+$/.test(parameter.id) && Math.abs(parameter.value - parameter.defaultValue) > 1e-5).length;
    if (custom) status.push(`${custom} custom note assignment${custom === 1 ? "" : "s"}${value("customMapEnabled") >= .5 ? " enabled" : " retained; custom map off"}`);
  }
  if (kind === "drums" && tab === "Outputs") {
    const auxiliary = Array.from({ length: 8 }, (_, piece) => value(`pieceOutput${piece}`)).filter(destination => destination > 0).length;
    if (auxiliary) status.push(`${auxiliary} piece${auxiliary === 1 ? "" : "s"} routed to auxiliary outputs`);
  }
  return [...status, changed].filter(Boolean).join("; ");
}
