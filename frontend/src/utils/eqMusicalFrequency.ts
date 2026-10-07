/** Explicit musical entry uses twelve-tone equal temperament, A4 = 440 Hz. */
export function parseEQFrequency(text: string): number | null {
  const compact = text.trim().replace(/\s+/g, "").replace(/♯/g, "#").replace(/♭/g, "b");
  const number = /^(\d+(?:\.\d*)?|\.\d+)(k(?:hz)?|hz)?$/i.exec(compact);
  if (number) {
    const hz = Number(number[1]) * (/^k/i.test(number[2] ?? "") ? 1000 : 1);
    return Number.isFinite(hz) && hz > 0 ? hz : null;
  }
  const note = /^([a-g])([#b]?)(-?\d{1,2})(?:([+-](?:\d+(?:\.\d*)?|\.\d+))(?:c|ct|cents)?)?$/i.exec(compact);
  if (!note) return null;
  const pitch = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[note[1].toUpperCase()];
  const midi = (Number(note[3]) + 1) * 12 + pitch + (note[2] === "#" ? 1 : note[2].toLowerCase() === "b" ? -1 : 0);
  const cents = Number(note[4] ?? 0);
  const hz = 440 * 2 ** ((midi - 69 + cents / 100) / 12);
  return Number.isFinite(hz) && hz > 0 && Math.abs(cents) <= 1200 ? hz : null;
}

export function eqFrequencyNote(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return "";
  const pitch = 69 + 12 * Math.log2(hz / 440), nearest = Math.round(pitch), cents = Math.round((pitch - nearest) * 100);
  const name = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][((nearest % 12) + 12) % 12];
  return `${name}${Math.floor(nearest / 12) - 1}${cents ? ` ${cents > 0 ? "+" : ""}${cents} ct` : ""}`;
}
