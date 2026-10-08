import { nativeBridge } from "../services/NativeBridge";

/** Optional fields keep old projects compatible; missing clicks fall back explicitly. */
export async function restoreMetronomeProjectSounds(document: Record<string, unknown>) {
  await nativeBridge.resetMetronomeSounds();
  const result = { metronomeClickPath: "", metronomeAccentPath: "", warnings: [] as string[] };
  for (const accent of [false, true]) {
    const key = accent ? "metronomeAccentPath" : "metronomeClickPath";
    const selection = document[key];
    if (typeof selection !== "string" || !selection) continue;
    try {
      const accepted = await (accent ? nativeBridge.setMetronomeAccentSound(selection) : nativeBridge.setMetronomeClickSound(selection));
      const info = await nativeBridge.getMetronomeSoundInfo(accent);
      if (accepted) result[key] = info.selection ?? selection;
      else result.warnings.push(`${accent ? "Accent" : "Regular"} click: ${info.error || "sound unavailable"}. Using the original electronic click.`);
    } catch {
      result.warnings.push(`${accent ? "Accent" : "Regular"} click could not be restored. Using the original electronic click.`);
    }
  }
  return result;
}
