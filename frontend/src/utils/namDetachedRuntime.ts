import type {
  AudioDeviceConfig,
  AudioDeviceSetupResponse,
  BuiltInPluginAddress,
  TrackRoutingInfo,
} from "../services/NativeBridge";

export type NAMRackRuntimeDevice = Pick<
  AudioDeviceConfig,
  | "audioDeviceType"
  | "inputDevice"
  | "outputDevice"
  | "sampleRate"
  | "bufferSize"
  | "numInputChannels"
  | "numOutputChannels"
  | "numActiveInputChannels"
  | "numActiveOutputChannels"
  | "inputChannelNames"
  | "outputChannelNames"
>;

export type NAMRackRuntimeTrack = {
  type: string;
  inputStartChannel: number;
  inputChannelCount: number;
  armed?: boolean;
  monitorEnabled?: boolean;
  inputMonitoring?: boolean;
  recordArmed?: boolean;
};

export type NAMRackWindowCapabilities = {
  detached: boolean;
  canOpenAppAudio: boolean;
  canOpenTrackRouting: boolean;
};

export function resolveNAMRackWindowCapabilities(
  role: string,
  address: BuiltInPluginAddress,
): NAMRackWindowCapabilities {
  const detached = role === "pluginEditor";
  return {
    detached,
    canOpenAppAudio: !detached,
    canOpenTrackRouting: !detached && Boolean(address.trackId),
  };
}

export function normalizeNAMRuntimeDevice(
  response: AudioDeviceSetupResponse | null | undefined,
): NAMRackRuntimeDevice | null {
  const device = response?.current;
  if (!device || typeof device !== "object") return null;

  return {
    audioDeviceType: String(device.audioDeviceType ?? ""),
    inputDevice: String(device.inputDevice ?? ""),
    outputDevice: String(device.outputDevice ?? ""),
    sampleRate: Number.isFinite(Number(device.sampleRate)) ? Number(device.sampleRate) : 0,
    bufferSize: Number.isFinite(Number(device.bufferSize)) ? Number(device.bufferSize) : 0,
    numInputChannels: Number.isFinite(Number(device.numInputChannels))
      ? Math.max(0, Math.trunc(Number(device.numInputChannels)))
      : 0,
    numOutputChannels: Number.isFinite(Number(device.numOutputChannels))
      ? Math.max(0, Math.trunc(Number(device.numOutputChannels)))
      : 0,
    numActiveInputChannels: Number.isFinite(Number(device.numActiveInputChannels))
      ? Math.max(0, Math.trunc(Number(device.numActiveInputChannels)))
      : undefined,
    numActiveOutputChannels: Number.isFinite(Number(device.numActiveOutputChannels))
      ? Math.max(0, Math.trunc(Number(device.numActiveOutputChannels)))
      : undefined,
    inputChannelNames: Array.isArray(device.inputChannelNames)
      ? device.inputChannelNames.map(String)
      : [],
    outputChannelNames: Array.isArray(device.outputChannelNames)
      ? device.outputChannelNames.map(String)
      : [],
  };
}

export function normalizeNAMRuntimeTrack(
  routing: TrackRoutingInfo | null | undefined,
): NAMRackRuntimeTrack | null | undefined {
  if (routing === undefined) return undefined;
  if (!routing) return null;

  return {
    type: String(routing.trackType || "audio"),
    inputStartChannel: Math.max(0, Math.trunc(Number(routing.inputStartChannel) || 0)),
    inputChannelCount: Math.max(0, Math.trunc(Number(routing.inputChannelCount) || 0)),
    armed: Boolean(routing.recordArmed),
    monitorEnabled: Boolean(routing.inputMonitoring),
    inputMonitoring: Boolean(routing.inputMonitoring),
    recordArmed: Boolean(routing.recordArmed),
  };
}

export function formatNAMRuntimeDeviceLabel(
  device: Partial<NAMRackRuntimeDevice> & { deviceType?: string } | null | undefined,
): string | undefined {
  if (!device) return undefined;
  const input = String(device.inputDevice ?? "").trim();
  const output = String(device.outputDevice ?? "").trim();
  if (input && output && input !== output) return `${input} -> ${output}`;
  if (input || output) return input || output;
  const type = String(device.audioDeviceType ?? device.deviceType ?? "").trim();
  return type || undefined;
}

export function formatNAMRuntimeInputLabel({
  address,
  track,
  device,
}: {
  address: BuiltInPluginAddress;
  track: NAMRackRuntimeTrack | null | undefined;
  device: Pick<NAMRackRuntimeDevice, "inputChannelNames"> | null | undefined;
}): string {
  if (address.chain === "master") return "Master bus (no track input)";
  if (!address.trackId) return "No track input";
  if (track === undefined) return "Loading track input...";
  if (track === null) return "Track input unavailable";
  if (track.type === "instrument") return "Instrument output (no hardware input)";
  if (track.type === "midi") return "MIDI track (no hardware input)";
  if (track.inputChannelCount <= 0) return "No hardware input";

  const start = track.inputStartChannel;
  const count = track.inputChannelCount;
  const route = count === 1
    ? `Input ${start + 1}`
    : `Inputs ${start + 1}-${start + count}`;
  const names = (device?.inputChannelNames ?? [])
    .slice(start, start + count)
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? `${route} - ${names.join(" / ")}` : route;
}
