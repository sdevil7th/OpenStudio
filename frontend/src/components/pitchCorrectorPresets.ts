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
  };
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
