import { useState, useEffect } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { NativeSelect } from "./ui";
import { useShallow } from "zustand/react/shallow";

interface MIDIDeviceSelectorProps {
  trackId: string;
}

export function MIDIDeviceSelector({ trackId }: MIDIDeviceSelectorProps) {
  const [availableInputDevices, setAvailableInputDevices] = useState<string[]>([]);
  const [availableOutputDevices, setAvailableOutputDevices] = useState<string[]>([]);
  const [openDevices, setOpenDevices] = useState<string[]>([]);
  const { track, setTrackMIDIOutput } = useDAWStore(
    useShallow((state) => ({
      track: state.tracks.find((t) => t.id === trackId),
      setTrackMIDIOutput: state.setTrackMIDIOutput,
    })),
  );

  // Load MIDI devices on mount
  useEffect(() => {
    loadDevices();
  }, []);

  const loadDevices = async () => {
    try {
      const devices = await nativeBridge.getMIDIInputDevices();
      const outputs = await nativeBridge.getMIDIOutputDevices();
      const open = await nativeBridge.getOpenMIDIDevices();
      setAvailableInputDevices(Array.isArray(devices) ? devices : []);
      setAvailableOutputDevices(Array.isArray(outputs) ? outputs : []);
      setOpenDevices(Array.isArray(open) ? open : []);
    } catch (error) {
      console.error("Failed to load MIDI devices:", error);
    }
  };

  const syncBackendTrackState = async () => {
    if (!track || track.type === "bus") return;

    await nativeBridge.addTrack(trackId, track.type).catch(() => false);
    await nativeBridge.setTrackType(trackId, track.type).catch(() => false);
    await nativeBridge.setTrackRecordArm(trackId, track.armed).catch(() => false);
  };

  const handleDeviceChange = async (deviceName: string) => {
    if (!track) return;

    try {
      if (deviceName && !openDevices.includes(deviceName)) {
        await nativeBridge.openMIDIDevice(deviceName);
      } else if (!deviceName) {
        for (const availableDevice of availableInputDevices) {
          if (!openDevices.includes(availableDevice)) {
            await nativeBridge.openMIDIDevice(availableDevice);
          }
        }
      }

      await syncBackendTrackState();
      await nativeBridge.setTrackMIDIInput(
        trackId,
        deviceName,
        track.midiChannel || 0,
      );

      // Update local state
      useDAWStore.setState((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId ? { ...t, midiInputDevice: deviceName } : t,
        ),
      }));

      // Refresh device list
      await loadDevices();
    } catch (error) {
      console.error("Failed to set MIDI device:", error);
    }
  };

  const handleChannelChange = async (channel: number) => {
    if (!track) return;

    try {
      await syncBackendTrackState();
      if (track.midiInputDevice && !openDevices.includes(track.midiInputDevice)) {
        await nativeBridge.openMIDIDevice(track.midiInputDevice).catch(() => false);
      } else if (!track.midiInputDevice) {
        for (const availableDevice of availableInputDevices) {
          if (!openDevices.includes(availableDevice)) {
            await nativeBridge.openMIDIDevice(availableDevice).catch(() => false);
          }
        }
      }
      await nativeBridge.setTrackMIDIInput(
        trackId,
        track.midiInputDevice || "",
        channel,
      );

      useDAWStore.setState((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId ? { ...t, midiChannel: channel } : t,
        ),
      }));
    } catch (error) {
      console.error("Failed to set MIDI channel:", error);
    }
  };

  const handleOutputChange = async (deviceName: string) => {
    if (!track) return;

    try {
      await setTrackMIDIOutput(trackId, deviceName);
    } catch (error) {
      console.error("Failed to set MIDI output:", error);
    }
  };

  if (!track || (track.type !== "midi" && track.type !== "instrument")) {
    return null;
  }

  // Empty input is DAW-style omni input. The record path opens all available
  // MIDI inputs for armed tracks in this mode.
  const deviceOptions = [
    { value: "", label: "All Inputs" },
    ...availableInputDevices.map((device) => ({ value: device, label: device })),
  ];
  const outputOptions = [
    { value: "", label: "No Out" },
    ...availableOutputDevices.map((device) => ({ value: device, label: device })),
  ];

  // Build channel options: 0 = "All", 1-16 = "Ch 1" through "Ch 16"
  const channelOptions = [
    { value: 0, label: "All" },
    ...Array.from({ length: 16 }, (_, i) => ({
      value: i + 1,
      label: `Ch ${i + 1}`,
    })),
  ];

  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-neutral-700/70 bg-neutral-900/55 px-1.5 py-0.5 text-[10px]">
      {/* Device selector - compact */}
      <NativeSelect
        variant="compact"
        size="xs"
        options={deviceOptions}
        value={track.midiInputDevice || ""}
        onChange={(val) => handleDeviceChange(String(val))}
        title={track.midiInputDevice || "All MIDI inputs"}
        className="w-[122px] max-w-[122px] truncate"
      />

      {/* Channel selector - compact */}
      <NativeSelect
        variant="compact"
        size="xs"
        options={channelOptions}
        value={track.midiChannel || 0}
        onChange={(val) => handleChannelChange(Number(val))}
        title={`Channel: ${track.midiChannel || "All"}`}
        className="w-[68px]"
      />

      <NativeSelect
        variant="compact"
        size="xs"
        options={outputOptions}
        value={track.midiOutputDevice || ""}
        onChange={(val) => handleOutputChange(String(val))}
        title={track.midiOutputDevice ? `MIDI out: ${track.midiOutputDevice}` : "No MIDI output"}
        className="w-[104px] max-w-[104px] truncate"
      />
    </div>
  );
}
