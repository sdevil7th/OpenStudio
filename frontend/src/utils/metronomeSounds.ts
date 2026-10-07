export const METRONOME_SOUND_OPTIONS = [
  { value: "", label: "Electronic (original)" },
  { value: "builtin:woodblock", label: "Woodblock" },
  { value: "builtin:cowbell", label: "808-style cowbell" },
  { value: "builtin:mechanical", label: "Mechanical tick" },
] as const;

export function metronomeSoundLabel(selection: string): string {
  return METRONOME_SOUND_OPTIONS.find(option => option.value === selection)?.label ?? "Custom sample";
}

export function isCustomMetronomeSound(selection: string): boolean {
  return !METRONOME_SOUND_OPTIONS.some(option => option.value === selection);
}
