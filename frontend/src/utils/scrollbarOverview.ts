import type { WaveformPeak } from "../services/NativeBridge";
import type { AudioClip, Track } from "../store/useDAWStore";

export const SCROLLBAR_OVERVIEW_BIN_COUNT = 1024;

export interface ScrollbarOverviewBin {
  audio: number;
  midi: number;
}

export interface ScrollbarOverview {
  duration: number;
  bins: ScrollbarOverviewBin[];
}

interface CachedWaveformTile {
  cacheSpp: number;
  startSample: number;
  peaks: WaveformPeak[];
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function parseWaveformCacheKey(key: string) {
  const match = key.match(/^(.*)-(\d+)-(\d+)$/);
  if (!match) return null;
  return {
    filePath: match[1],
    cacheSpp: Number.parseInt(match[2], 10),
    startSample: Number.parseInt(match[3], 10),
  };
}

function getClipGain(clip: AudioClip) {
  if (clip.volumeDB <= -60) return 0;
  return Math.min(1, Math.pow(10, clip.volumeDB / 20));
}

function getFadeMultiplier(localTime: number, clip: AudioClip) {
  if (clip.duration <= 0) return 0;
  let multiplier = 1;

  if (clip.fadeIn > 0 && localTime < clip.fadeIn) {
    multiplier *= clamp01(localTime / clip.fadeIn);
  }
  if (clip.fadeOut > 0 && localTime > clip.duration - clip.fadeOut) {
    multiplier *= clamp01((clip.duration - localTime) / clip.fadeOut);
  }

  return multiplier;
}

function addAudioFallback(
  bins: ScrollbarOverviewBin[],
  duration: number,
  clip: AudioClip,
) {
  if (clip.duration <= 0 || duration <= 0 || clip.muted) return;

  const binDuration = duration / bins.length;
  const clipStart = Math.max(0, clip.startTime);
  const clipEnd = Math.min(duration, clip.startTime + clip.duration);
  if (clipEnd <= clipStart) return;

  const startIndex = Math.max(0, Math.floor(clipStart / binDuration));
  const endIndex = Math.min(
    bins.length - 1,
    Math.ceil(clipEnd / binDuration),
  );
  const gain = getClipGain(clip);
  const baseLevel = clip.filePath ? 0.14 + gain * 0.26 : 0.1 + gain * 0.14;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const binCenterTime = (index + 0.5) * binDuration;
    if (binCenterTime < clipStart || binCenterTime > clipEnd) continue;
    const localTime = Math.max(0, binCenterTime - clip.startTime);
    const fade = getFadeMultiplier(localTime, clip);
    bins[index].audio = Math.max(
      bins[index].audio,
      clamp01(baseLevel * Math.max(0.2, fade)),
    );
  }
}

function addAudioWaveformDetail(
  bins: ScrollbarOverviewBin[],
  duration: number,
  clip: AudioClip,
  tiles: CachedWaveformTile[],
) {
  if (tiles.length === 0 || clip.duration <= 0 || duration <= 0) return;

  const fileSampleRate = clip.sampleRate || 44100;
  const clipOffsetSamples = Math.floor((clip.offset || 0) * fileSampleRate);
  const clipEndSamples =
    clipOffsetSamples + Math.floor(clip.duration * fileSampleRate);
  const binDuration = duration / bins.length;
  const gain = getClipGain(clip);

  for (const tile of tiles) {
    const tileStart = tile.startSample;
    const tileEnd = tile.startSample + tile.peaks.length * tile.cacheSpp;
    if (tileEnd <= clipOffsetSamples || tileStart >= clipEndSamples) continue;

    const sampleStep = Math.max(1, Math.ceil(tile.peaks.length / 512));
    for (let peakIndex = 0; peakIndex < tile.peaks.length; peakIndex += sampleStep) {
      const samplePosition = tile.startSample + peakIndex * tile.cacheSpp;
      if (samplePosition < clipOffsetSamples || samplePosition >= clipEndSamples) {
        continue;
      }

      const timelineTime =
        clip.startTime + (samplePosition - clipOffsetSamples) / fileSampleRate;
      if (timelineTime < 0 || timelineTime > duration) continue;

      const localTime = timelineTime - clip.startTime;
      const fade = getFadeMultiplier(localTime, clip);
      const peak = tile.peaks[peakIndex];
      let amplitude = 0;
      for (const channel of peak.channels) {
        amplitude = Math.max(amplitude, Math.abs(channel.min), Math.abs(channel.max));
      }

      const shapedLevel = clamp01(
        Math.max(0.08, amplitude * 0.9) * Math.max(0.2, fade) * Math.max(0.2, gain),
      );
      const binIndex = Math.max(
        0,
        Math.min(bins.length - 1, Math.floor(timelineTime / binDuration)),
      );
      bins[binIndex].audio = Math.max(bins[binIndex].audio, shapedLevel);
    }
  }
}

function addMidiDensity(
  bins: ScrollbarOverviewBin[],
  duration: number,
  track: Track,
) {
  if (duration <= 0) return;

  const binDuration = duration / bins.length;

  for (const clip of track.midiClips) {
    if (clip.duration <= 0) continue;
    const clipStart = Math.max(0, clip.startTime);
    const clipEnd = Math.min(duration, clip.startTime + clip.duration);
    if (clipEnd <= clipStart) continue;

    const noteOns = clip.events.filter((event) => event.type === "noteOn");
    const noteDensity = clip.duration > 0 ? noteOns.length / clip.duration : 0;
    const baseLevel = clamp01(0.08 + Math.min(0.18, noteDensity * 0.04));

    const startIndex = Math.max(0, Math.floor(clipStart / binDuration));
    const endIndex = Math.min(
      bins.length - 1,
      Math.ceil(clipEnd / binDuration),
    );

    for (let index = startIndex; index <= endIndex; index += 1) {
      bins[index].midi = Math.max(bins[index].midi, baseLevel);
    }

    for (const event of noteOns) {
      const noteTime = clip.startTime + event.timestamp;
      if (noteTime < clipStart || noteTime > clipEnd) continue;
      const binIndex = Math.max(
        0,
        Math.min(bins.length - 1, Math.floor(noteTime / binDuration)),
      );
      bins[binIndex].midi = Math.max(
        bins[binIndex].midi,
        clamp01(baseLevel + 0.18),
      );
    }
  }
}

export function buildScrollbarOverview(
  tracks: Track[],
  duration: number,
  waveformCache: ReadonlyMap<string, WaveformPeak[]>,
): ScrollbarOverview | undefined {
  if (duration <= 0) return undefined;

  const bins = Array.from({ length: SCROLLBAR_OVERVIEW_BIN_COUNT }, () => ({
    audio: 0,
    midi: 0,
  }));
  const waveformTilesByPath = new Map<string, CachedWaveformTile[]>();
  const hasSoloedTracks = tracks.some((track) => track.soloed);
  const activeTracks = tracks.filter((track) =>
    hasSoloedTracks ? track.soloed : !track.muted,
  );

  if (activeTracks.length === 0) {
    return { duration, bins };
  }

  waveformCache.forEach((peaks, key) => {
    const parsed = parseWaveformCacheKey(key);
    if (!parsed || peaks.length === 0) return;

    const tiles = waveformTilesByPath.get(parsed.filePath) ?? [];
    tiles.push({
      cacheSpp: parsed.cacheSpp,
      startSample: parsed.startSample,
      peaks,
    });
    waveformTilesByPath.set(parsed.filePath, tiles);
  });

  waveformTilesByPath.forEach((tiles) => {
    tiles.sort((left, right) => left.startSample - right.startSample);
  });

  for (const track of activeTracks) {
    for (const clip of track.clips) {
      addAudioFallback(bins, duration, clip);
      if (clip.filePath) {
        addAudioWaveformDetail(
          bins,
          duration,
          clip,
          waveformTilesByPath.get(clip.filePath) ?? [],
        );
      }
    }

    if (track.type === "midi" || track.type === "instrument") {
      addMidiDensity(bins, duration, track);
    }
  }

  return {
    duration,
    bins: bins.map((bin) => ({
      audio: clamp01(bin.audio),
      midi: clamp01(bin.midi),
    })),
  };
}
