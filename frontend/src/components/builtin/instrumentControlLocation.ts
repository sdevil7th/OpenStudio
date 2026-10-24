export type InstrumentKind = "synth" | "piano" | "guitar" | "drums";
export type InstrumentControlLocation = { page: string; section?: string; piece?: number; route?: number; macro?: number; mapInput?: number };

/** Reveals the existing native control; it never changes a processor parameter. */
export function instrumentControlLocation(kind: InstrumentKind, id: string): InstrumentControlLocation | null {
  if (id === "outputGain" || (kind === "drums" && id === "stereoWidth")) return null; // Fixed footer.
  if (kind === "synth") {
    const route = /^matrix([1-8])/.exec(id);
    if (route) return { page: "Modulation", section: "Matrix", route: Number(route[1]) };
    const macro = /^macro([1-4])(CC|Channel)$/.exec(id);
    if (macro) return { page: "Expression", macro: Number(macro[1]) };
    if (/^(mpe|wheelMode)/.test(id)) return { page: "Expression" };
    if (/^lfo/.test(id)) return { page: "Modulation", section: "LFO" };
    if (/^macro[1-4]$/.test(id)) return { page: "Modulation", section: "Macros" };
    if (/^filter(EnvelopeSource|AttackMs|DecayMs|Sustain|ReleaseMs|Velocity|KeyTrack)$/.test(id)) return { page: "Filter envelope" };
    if (/^filter/.test(id)) return { page: "Voice", section: "Filter" };
    if (["attackMs", "decayMs", "sustain", "releaseMs", "brightness"].includes(id)) return { page: "Voice", section: "Amplifier" };
    return { page: "Voice", section: "Oscillators" };
  }
  if (kind === "piano") {
    if (["coupledBody", "bodyCoupling", "bodyDecay"].includes(id)) return { page: "Resonance" };
    if (["performanceMode", "velocityCurve", "strikeColour", "releaseVelocity", "damperCurve", "softPedalDepth"].includes(id)) return { page: "Performance" };
    return { page: "Instrument" };
  }
  if (kind === "guitar") {
    if (/^(pick|body|coupledBody)/.test(id)) return { page: "Pick & body" };
    if (/^chorus/.test(id) || id === "bendRangeSemitones") return { page: "Chorus & MIDI" };
    if (["articulation", "articulationKeys", "harmonicNode", "slideTime"].includes(id)) return { page: "Play", section: "Articulation" };
    if (id === "stringMode") return { page: "Play", section: "Performance" };
    return { page: "Play", section: "Sound" };
  }
  const mapping = /^noteMap(\d+)$/.exec(id);
  if (mapping && Number(mapping[1]) < 128) return { page: "Mapping", mapInput: Number(mapping[1]) };
  if (id === "customMapEnabled") return { page: "Mapping" };
  const piece = /^piece(?:Gain|Tuning|Pan|Decay|Output)([0-7])$/.exec(id);
  if (piece) return { page: "Kit", section: "Selected piece", piece: Number(piece[1]) };
  return { page: "Kit", section: ["kit", "articulationEngine", "mapPreset"].includes(id) ? "Pads" : "Character" };
}
