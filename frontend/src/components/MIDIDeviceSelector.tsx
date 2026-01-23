import { useState, useEffect } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";

interface MIDIDeviceSelectorProps {
  trackId: string;
}

export function MIDIDeviceSelector({ trackId }: MIDIDeviceSelectorProps) {
  const [availableDevices, setAvailableDevices] = useState<string[]>([]);
  const [openDevices, setOpenDevices] = useState<string[]>([]);
  const track = useDAWStore((state) =>
    state.tracks.find((t) => t.id === trackId),
  );

  // Load MIDI devices on mount
  useEffect(() => {
    loadDevices();
  }, []);

  const loadDevices = async () => {
    try {
      const devices = await nativeBridge.getMIDIInputDevices();
      const open = await nativeBridge.getOpenMIDIDevices();
      setAvailableDevices(devices);
      setOpenDevices(open);
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

  if (!track || (track.type !== "midi" && track.type !== "instrument")) {
    return null;
  }

  const selectClasses = `
    flex-1 px-2 py-1 
    bg-black/30 
    border border-white/10 rounded 
    text-white text-[11px] 
    cursor-pointer 
    transition-all duration-200
    hover:bg-black/40 hover:border-white/20
    focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20
  `;

  return (
    <div className="flex flex-col gap-2 p-2 bg-white/5 rounded mt-2">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-neutral-400 min-w-[80px]">
          MIDI Device:
        </label>
        <select
          value={track.midiInputDevice || ""}
          onChange={(e) => handleDeviceChange(e.target.value)}
          className={selectClasses}
        >
          <option value="" className="bg-neutral-900 text-white">
            No Device
          </option>
          {availableDevices.map((device) => (
            <option
              key={device}
              value={device}
              className="bg-neutral-900 text-white"
            >
              {device} {openDevices.includes(device) ? "●" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-[11px] text-neutral-400 min-w-[80px]">
          MIDI Channel:
        </label>
        <select
          value={track.midiChannel || 0}
          onChange={(e) => handleChannelChange(parseInt(e.target.value))}
          className={selectClasses}
        >
          <option value={0} className="bg-neutral-900 text-white">
            All Channels
          </option>
          {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
            <option key={ch} value={ch} className="bg-neutral-900 text-white">
              Channel {ch}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
