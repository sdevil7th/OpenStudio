// Pitch Corrector Factory Presets

export interface PitchCorrectorPreset {
  name: string;
  category: string;
  params: {
    key?: number;
    scale?: number;
    retuneSpeed: number;
    correctionStrength: number;
    humanize: number;
    formantCorrection: boolean;
    formantShift: number;
    mix: number;
    transpose?: number;
    noteEnables?: boolean[];
    /** Optional for older files and partial factory templates. */
    signalPath?: 0 | 1;
    midiOutput?: boolean;
    midiChannel?: number;
    bypass?: boolean;
    sensitivity?: number;
    minFreqParam?: number;
    maxFreqParam?: number;
    detectionSource?: 0 | 1 | 2;
    humanizeMode?: 0 | 1;
  };
}

/** Validate imported files before any native write; old files retain Legacy masks. */
export function parsePitchCorrectorPreset(document: unknown): PitchCorrectorPreset {
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error("This file is not a Pitch Correct preset.");
  const preset = document as Record<string, unknown>;
  if (typeof preset.name !== "string" || !preset.name.trim()
    || !preset.params || typeof preset.params !== "object" || Array.isArray(preset.params))
    throw new Error("This file is not a Pitch Correct preset.");
  const values = preset.params as Record<string, unknown>;
  const number = (id: string, min: number, max: number, integer = false): number => {
    const value = values[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min - 1e-6 || value > max + 1e-6
      || (integer && !Number.isInteger(value)))
      throw new Error(`Invalid Pitch Correct preset parameter: ${id}.`);
    // Native float parameters can round a few ULPs beyond a decimal bound.
    return Math.min(max, Math.max(min, value));
  };
  if (typeof values.formantCorrection !== "boolean")
    throw new Error("Invalid Pitch Correct preset parameter: formantCorrection.");
  const params: PitchCorrectorPreset["params"] = {
    retuneSpeed: number("retuneSpeed", 0, 400),
    correctionStrength: number("correctionStrength", 0, 1),
    humanize: number("humanize", 0, 100),
    formantCorrection: values.formantCorrection,
    formantShift: number("formantShift", -12, 12),
    mix: number("mix", 0, 1),
    signalPath: values.signalPath === undefined ? 0 : number("signalPath", 0, 1, true) as 0 | 1,
  };
  if (values.key !== undefined) params.key = number("key", 0, 11, true);
  if (values.scale !== undefined) params.scale = number("scale", 0, 15, true);
  if (values.transpose !== undefined) params.transpose = number("transpose", -24, 24, true);
  if (values.noteEnables !== undefined) {
    if (!Array.isArray(values.noteEnables) || values.noteEnables.length !== 12
      || !values.noteEnables.every(value => typeof value === "boolean"))
      throw new Error("A Pitch Correct preset must contain exactly 12 note switches.");
    params.noteEnables = [...values.noteEnables];
  }
  if (values.midiOutput !== undefined) {
    if (typeof values.midiOutput !== "boolean")
      throw new Error("Invalid Pitch Correct preset parameter: midiOutput.");
    params.midiOutput = values.midiOutput;
  }
  // The native continuous parameter stores a float and rounds when emitting MIDI.
  if (values.midiChannel !== undefined) params.midiChannel = number("midiChannel", 1, 16);
  if (values.bypass !== undefined) {
    if (typeof values.bypass !== "boolean")
      throw new Error("Invalid Pitch Correct preset parameter: bypass.");
    params.bypass = values.bypass;
  }
  if (values.sensitivity !== undefined) params.sensitivity = number("sensitivity", 0.02, 0.35);
  if (values.minFreqParam !== undefined) params.minFreqParam = number("minFreqParam", 40, 400);
  if (values.maxFreqParam !== undefined) params.maxFreqParam = number("maxFreqParam", 400, 4000);
  if (values.detectionSource !== undefined) params.detectionSource = number("detectionSource", 0, 2, true) as 0 | 1 | 2;
  if (values.humanizeMode !== undefined) params.humanizeMode = number("humanizeMode", 0, 1, true) as 0 | 1;
  return { name: preset.name.trim(), category: typeof preset.category === "string" ? preset.category : "User", params };
}

export const FACTORY_PRESETS: PitchCorrectorPreset[] = [
  // Vocal Correction
  {
    name: "Gentle Vocal",
    category: "Vocal",
    params: { retuneSpeed: 200, correctionStrength: 0.5, humanize: 40, formantCorrection: false, formantShift: 0, mix: 0.7 },
  },
  {
    name: "Natural Vocal",
    category: "Vocal",
    params: { retuneSpeed: 100, correctionStrength: 0.75, humanize: 25, formantCorrection: true, formantShift: 0, mix: 0.85 },
  },
  {
    name: "Tight Vocal",
    category: "Vocal",
    params: { retuneSpeed: 30, correctionStrength: 0.95, humanize: 5, formantCorrection: true, formantShift: 0, mix: 1.0 },
  },
  {
    name: "Hard Tune",
    category: "Vocal",
    params: { retuneSpeed: 0, correctionStrength: 1.0, humanize: 0, formantCorrection: true, formantShift: 0, mix: 1.0 },
  },
  {
    name: "Whisper Fix",
    category: "Vocal",
    params: { retuneSpeed: 150, correctionStrength: 0.6, humanize: 15, formantCorrection: true, formantShift: 0, mix: 0.8 },
  },

  // Instrument
  {
    name: "Guitar Intonation",
    category: "Instrument",
    params: { retuneSpeed: 80, correctionStrength: 0.7, humanize: 10, formantCorrection: false, formantShift: 0, mix: 0.9 },
  },
  {
    name: "Bass Correction",
    category: "Instrument",
    params: { retuneSpeed: 60, correctionStrength: 0.8, humanize: 5, formantCorrection: false, formantShift: 0, mix: 1.0 },
  },
  {
    name: "Strings",
    category: "Instrument",
    params: { retuneSpeed: 120, correctionStrength: 0.6, humanize: 30, formantCorrection: false, formantShift: 0, mix: 0.75 },
  },

  // Creative
  {
    name: "Robot Voice",
    category: "Creative",
    params: { retuneSpeed: 0, correctionStrength: 1.0, humanize: 0, formantCorrection: true, formantShift: 0, mix: 1.0, scale: 0 },
  },
  {
    name: "Gender Shift (Up)",
    category: "Creative",
    params: { retuneSpeed: 50, correctionStrength: 0.5, humanize: 20, formantCorrection: true, formantShift: 4.0, mix: 1.0 },
  },
  {
    name: "Gender Shift (Down)",
    category: "Creative",
    params: { retuneSpeed: 50, correctionStrength: 0.5, humanize: 20, formantCorrection: true, formantShift: -4.0, mix: 1.0 },
  },
  {
    name: "Octave Down",
    category: "Creative",
    params: { retuneSpeed: 50, correctionStrength: 0.5, humanize: 0, formantCorrection: true, formantShift: 0, mix: 1.0, transpose: -12 },
  },

  // Genre
  {
    name: "Pop Vocal",
    category: "Genre",
    params: { retuneSpeed: 50, correctionStrength: 0.9, humanize: 10, formantCorrection: true, formantShift: 0, mix: 1.0 },
  },
  {
    name: "R&B Smooth",
    category: "Genre",
    params: { retuneSpeed: 80, correctionStrength: 0.7, humanize: 35, formantCorrection: true, formantShift: 0, mix: 0.9 },
  },
  {
    name: "Country Twang",
    category: "Genre",
    params: { retuneSpeed: 150, correctionStrength: 0.5, humanize: 50, formantCorrection: false, formantShift: 0, mix: 0.7 },
  },
  {
    name: "Classical Precision",
    category: "Genre",
    params: { retuneSpeed: 40, correctionStrength: 0.85, humanize: 15, formantCorrection: true, formantShift: 0, mix: 0.95 },
  },
];

export const PRESET_CATEGORIES = [...new Set(FACTORY_PRESETS.map(p => p.category))];
