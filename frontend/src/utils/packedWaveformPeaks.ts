import type { WaveformPeak } from "../services/NativeBridge";

const MAX_CHANNELS = 64;
const MAX_PEAKS = 32768;

/** Validate the older wire format as strictly as the packed fallback. */
export function decodeLegacyWaveformPeaks(payload: unknown): WaveformPeak[] {
  if (!Array.isArray(payload)) throw new Error("Invalid legacy waveform response");
  if (payload.length === 0) return [];
  const channels: unknown = payload[0];
  if (typeof channels !== "number" || !Number.isInteger(channels) || channels < 1 || channels > MAX_CHANNELS
    || (payload.length - 1) % (channels * 2) !== 0 || (payload.length - 1) / (channels * 2) > MAX_PEAKS
    || payload.slice(1).some((sample) => typeof sample !== "number" || !Number.isFinite(sample))) {
    throw new Error("Invalid legacy waveform dimensions or samples");
  }
  const peaks: WaveformPeak[] = [];
  for (let offset = 1; offset < payload.length;) {
    const channelPeaks: WaveformPeak["channels"] = [];
    for (let channel = 0; channel < channels; channel++, offset += 2) {
      channelPeaks.push({ min: payload[offset], max: payload[offset + 1] });
    }
    peaks.push({ channels: channelPeaks });
  }
  return peaks;
}

/** Decode the versioned wire format. Invalid native data must never become invented peaks. */
export function decodePackedWaveformPeaks(payload: unknown): WaveformPeak[] {
  if (payload === null || typeof payload !== "object") throw new Error("Invalid packed waveform response");
  const value = payload as Record<string, unknown>;
  if (typeof value.error === "string") throw new Error(value.error);
  if (value.format !== "openstudio.waveform.f32" || value.version !== 1 || value.byteOrder !== "little") {
    throw new Error("Unsupported packed waveform format");
  }
  const { channels, peakCount, byteLength, data } = value;
  if (typeof channels !== "number" || !Number.isInteger(channels) || channels < 0 || channels > MAX_CHANNELS
    || typeof peakCount !== "number" || !Number.isInteger(peakCount) || peakCount < 0 || peakCount > MAX_PEAKS
    || typeof byteLength !== "number" || !Number.isInteger(byteLength)
    || byteLength !== channels * peakCount * 2 * 4 || typeof data !== "string"
    || (channels === 0 && peakCount !== 0)
    || data.length !== 4 * Math.ceil(byteLength / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error("Invalid packed waveform dimensions or base64 length");
  }
  const binary = atob(data);
  if (binary.length !== byteLength) throw new Error("Truncated packed waveform data");
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index++) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const peaks: WaveformPeak[] = new Array(peakCount);
  let offset = 0;
  for (let peak = 0; peak < peakCount; peak++) {
    const channelPeaks: WaveformPeak["channels"] = new Array(channels);
    for (let channel = 0; channel < channels; channel++) {
      const min = view.getFloat32(offset, true);
      const max = view.getFloat32(offset + 4, true);
      if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("Non-finite packed waveform peak");
      channelPeaks[channel] = { min, max };
      offset += 8;
    }
    peaks[peak] = { channels: channelPeaks };
  }
  return peaks;
}
