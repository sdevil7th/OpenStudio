export const NOTES_PER_OCTAVE = 12;

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export const SCALE_DEFINITIONS: Record<string, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

export const SCALE_DISPLAY_NAMES: Record<string, string> = {
  chromatic: "Chromatic",
  major: "Major",
  minor: "Minor",
  dorian: "Dorian",
  mixolydian: "Mixolydian",
  pentatonic_major: "Pentatonic Major",
  pentatonic_minor: "Pentatonic Minor",
  blues: "Blues",
};

export function getNoteNameFromPitch(pitch: number): string {
  const noteName = NOTE_NAMES[((pitch % NOTES_PER_OCTAVE) + NOTES_PER_OCTAVE) % NOTES_PER_OCTAVE];
  const octave = Math.floor(pitch / NOTES_PER_OCTAVE) - 2;
  return `${noteName}${octave}`;
}

export function isNoteInScale(noteNumber: number, scaleRoot: number, scaleType: string): boolean {
  if (scaleType === "chromatic") return true;
  const intervals = SCALE_DEFINITIONS[scaleType];
  if (!intervals) return true;
  const degree = ((noteNumber % NOTES_PER_OCTAVE) - scaleRoot + NOTES_PER_OCTAVE) % NOTES_PER_OCTAVE;
  return intervals.includes(degree);
}
