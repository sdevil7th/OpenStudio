import { type TrackType, useDAWStore } from "../store/useDAWStore";

export type InsertableTrackType = Extract<TrackType, "audio" | "midi" | "instrument">;

const DEFAULT_PREFIX: Record<InsertableTrackType, string> = {
  audio: "Audio",
  midi: "MIDI",
  instrument: "Instrument",
};

function getTrackName(type: InsertableTrackType, prefix?: string) {
  const state = useDAWStore.getState();
  const basePrefix = (prefix || DEFAULT_PREFIX[type]).trim() || DEFAULT_PREFIX[type];
  const nextIndex =
    state.tracks.filter((track) => track.type === type).length + 1;
  return `${basePrefix} ${nextIndex}`;
}

export async function createTrackOfType(
  type: InsertableTrackType,
  options?: {
    prefix?: string;
    insertAfterTrackId?: string;
    openInstrumentBrowser?: boolean;
  },
) {
  const trackId = crypto.randomUUID();
  const state = useDAWStore.getState();
  const isMidiType = type === "midi" || type === "instrument";

  state.addTrack({
    id: trackId,
    name: getTrackName(type, options?.prefix),
    type,
    inputType: isMidiType ? "midi" : "stereo",
    inputChannelCount: isMidiType ? 1 : 2,
    armed: type === "instrument",
    monitorEnabled: type === "instrument",
  });

  state.selectTrack(trackId);
  if (type === "instrument" && options?.openInstrumentBrowser) {
    state.openPluginBrowser(trackId);
  }

  return trackId;
}

export async function createMultipleTracks(
  count: number,
  type: InsertableTrackType,
  prefix?: string,
) {
  const safeCount = Math.max(1, Math.min(128, Math.floor(count)));
  for (let index = 0; index < safeCount; index += 1) {
    await createTrackOfType(type, { prefix });
  }
}
