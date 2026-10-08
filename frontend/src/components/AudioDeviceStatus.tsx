import { useEffect, useState } from "react";
import { nativeBridge, type AudioDeviceDraft } from "../services/NativeBridge";

export function AudioDeviceStatus({ onOpen }: { onOpen: () => void }) {
  const [device, setDevice] = useState<(AudioDeviceDraft & { audioDeviceRunning?: boolean }) | null>(null);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        // Reads the cached native snapshot, never a streaming driver.
        const response = await nativeBridge.getAudioDeviceSetup();
        if (!disposed) setDevice(response.current);
      } catch { if (!disposed) setDevice(null); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    window.addEventListener("focus", refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const active = device && device.audioDeviceRunning !== false && (device.inputDevice || device.outputDevice) && device.sampleRate > 0 && device.bufferSize > 0;
  const label = active ? `${device.sampleRate / 1000} kHz · ${device.bufferSize} spl` : "Audio unavailable";
  return <button type="button" onClick={onOpen}
    className="shrink-0 rounded px-1 py-1 text-xs tabular-nums text-daw-text-muted hover:text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent"
    aria-label={`Audio Settings: ${label}`}
    title={active ? `${device.audioDeviceType}\nInput: ${device.inputDevice || "None"}\nOutput: ${device.outputDevice || "None"}\n${label}` : label}>
    {label}
  </button>;
}
