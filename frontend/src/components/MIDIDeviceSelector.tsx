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

  const handleDeviceChange = async (deviceName: string) => {
    if (!track) return;

    try {
      // Open the new device if not already open
      if (deviceName && !openDevices.includes(deviceName)) {
        await nativeBridge.openMIDIDevice(deviceName);
      }

      // Set the device for this track
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
    <div className="flex items-center gap-1 px-1 py-0.5 bg-white/5 rounded text-[10px]">
      {/* Device selector - compact */}
      <NativeSelect
        variant="compact"
        size="xs"
        options={deviceOptions}
        value={track.midiInputDevice || ""}
        onChange={(val) => handleDeviceChange(String(val))}
        title={track.midiInputDevice || "All MIDI inputs"}
        className="max-w-[80px] truncate"
      />

      {/* Channel selector - compact */}
      <NativeSelect
        variant="compact"
        size="xs"
        options={channelOptions}
        value={track.midiChannel || 0}
        onChange={(val) => handleChannelChange(Number(val))}
        title={`Channel: ${track.midiChannel || "All"}`}
        className="max-w-[55px]"
      />

      <NativeSelect
        variant="compact"
        size="xs"
        options={outputOptions}
        value={track.midiOutputDevice || ""}
        onChange={(val) => handleOutputChange(String(val))}
        title={track.midiOutputDevice ? `MIDI out: ${track.midiOutputDevice}` : "No MIDI output"}
        className="max-w-[80px] truncate"
      />
    </div>
  );
}
