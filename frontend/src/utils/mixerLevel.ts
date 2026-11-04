export const MIXER_LEVEL_MIN_DB = -60;
export const MIXER_LEVEL_MAX_DB = 12;

/** Keep invalid drafts out of the audio engine. The fader's minimum is silence. */
export function parseMixerLevel(text: string): number | null {
  const value = text.trim().replace(/\s*dB$/i, "").trim();
  if (/^-(?:inf(?:inity)?|∞)$/i.test(value)) return MIXER_LEVEL_MIN_DB;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const db = Number(value);
  return Number.isFinite(db) && db >= MIXER_LEVEL_MIN_DB && db <= MIXER_LEVEL_MAX_DB ? db : null;
}

export function formatMixerLevel(db: number): string {
  return db <= MIXER_LEVEL_MIN_DB ? "-∞" : db.toFixed(1);
}
