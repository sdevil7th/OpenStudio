import { useState, useEffect } from "react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Button, NativeSelect } from "./ui";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false); // Track when switching audio types
  const [error, setError] = useState<string | null>(null);
  const { refreshAudioDeviceSetup } = useDAWStore();

  // Combined loading state for disabling dropdowns
  const isLoading = loading || switching;

  // Fetch initial config
  useEffect(() => {
    if (isOpen) {
      refreshConfig();
    }
  }, [isOpen]);

  const refreshConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      console.log("[SettingsModal] Fetching audio config...");
      const data = await nativeBridge.getAudioDeviceSetup();
      console.log("[SettingsModal] Audio Config received:", data);

      if (!data || !data.current) {
        throw new Error("Invalid config data received from backend");
      }

      setConfig(data);
    } catch (e) {
      console.error("[SettingsModal] Failed to get audio config:", e);
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async () => {
    if (!config || !config.current) return;

    try {
      console.log("[SettingsModal] Applying config:", config.current);
      await nativeBridge.setAudioDeviceSetup(config.current);

      // Update the store so TrackHeader immediately gets new input list
      await refreshAudioDeviceSetup();

      onClose();
    } catch (e) {
      console.error("[SettingsModal] Failed to set audio config:", e);
      alert(
        "Failed to apply settings: " +
          (e instanceof Error ? e.message : "Unknown error"),
      );
    }
  };

  const updateConfig = (key: string, value: any) => {
    if (!config) return;

    const newConfig = {
      ...config,
      current: {
        ...config.current,
        [key]: value,
      },
    };

    setConfig(newConfig);

    // If changing audio system type, we need to switch backend and refresh device lists
    if (key === "audioDeviceType") {
      console.log("[SettingsModal] Audio type changed to:", value);
      // Apply the type change immediately to get correct device lists
      handleApplyTypeChange(value);
    }
  };

  const handleApplyTypeChange = async (newType: string) => {
    setSwitching(true);
    try {
      console.log("[SettingsModal] Switching to audio type:", newType);
      // Tell backend to switch audio device type
      await nativeBridge.setAudioDeviceSetup({
        type: newType,
        inputDevice: "", // Will use default
        outputDevice: "", // Will use default
        sampleRate: 44100,
        bufferSize: 512,
      });

      // Wait a bit for backend to switch
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Refresh to get devices for new type
      await refreshConfig();
    } catch (e) {
      console.error("[SettingsModal] Failed to switch audio type:", e);
    } finally {
      setSwitching(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 w-screen h-screen bg-black/70 flex justify-center items-center z-[1000] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 w-[500px] max-w-[90vw] max-h-[85vh] flex flex-col rounded-lg shadow-2xl text-neutral-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-4 bg-neutral-800 rounded-t-lg border-b border-neutral-700">
          <h2 className="m-0 text-lg font-medium">Audio Settings</h2>
          <Button
            variant="ghost"
            size="icon-md"
            onClick={onClose}
          >
            ×
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {isLoading && (
            <div className="flex items-center gap-2 p-3 bg-blue-500/15 border border-blue-500 rounded text-blue-400 text-sm animate-pulse">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              {switching
                ? "Switching audio system..."
                : "Loading audio devices..."}
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-500/15 border border-red-500 rounded text-red-400 text-sm">
              <strong>Error:</strong> {error}
              <Button
                variant="danger"
                size="xs"
                onClick={refreshConfig}
                className="ml-2"
              >
                Retry
              </Button>
            </div>
          )}

          {!loading && !error && !config && (
            <div className="p-5 text-center text-neutral-400">
              No audio configuration available.
              <Button
                variant="primary"
                size="xs"
                onClick={refreshConfig}
                className="ml-2"
              >
                Load
              </Button>
            </div>
          )}

          {config && config.current && (
            <>
              {/* Audio System (Driver Type) */}
              <NativeSelect
                label="Audio System"
                options={config.availableTypes || []}
                value={config.current.audioDeviceType}
                onChange={(val) => updateConfig("audioDeviceType", val)}
                loading={isLoading}
                fullWidth
              />

              {/* ASIO Driver Selection (only show when ASIO is selected) */}
              {config.current.audioDeviceType === "ASIO" && (
                <NativeSelect
                  label="ASIO Driver"
                  options={config.outputs || []}
                  value={config.current.outputDevice || (config.outputs && config.outputs[0]) || ""}
                  onChange={(val) => {
                    console.log("[SettingsModal] ASIO driver selected:", val);
                    // For ASIO, input and output use the same driver
                    const newConfig = {
                      ...config,
                      current: {
                        ...config.current,
                        inputDevice: val,
                        outputDevice: val,
                      },
                    };
                    setConfig(newConfig);
                  }}
                  loading={isLoading}
                  fullWidth
                />
              )}

              {/* Input Device (hide for ASIO, show for others) */}
              {config.current.audioDeviceType !== "ASIO" && (
                <NativeSelect
                  label="Input Device"
                  options={config.inputs || []}
                  value={config.current.inputDevice}
                  onChange={(val) => updateConfig("inputDevice", val)}
                  loading={isLoading}
                  fullWidth
                />
              )}

              {/* Output Device (hide for ASIO, show for others) */}
              {config.current.audioDeviceType !== "ASIO" && (
                <NativeSelect
                  label="Output Device"
                  options={config.outputs || []}
                  value={config.current.outputDevice}
                  onChange={(val) => updateConfig("outputDevice", val)}
                  loading={isLoading}
                  fullWidth
                />
              )}

              {/* Sample Rate */}
              <NativeSelect
                label="Sample Rate"
                options={config.sampleRates?.length > 0 ? config.sampleRates : [44100]}
                value={config.current.sampleRate || (config.sampleRates && config.sampleRates[0]) || 44100}
                onChange={(val) => {
                  console.log("[SettingsModal] Sample rate selected:", val);
                  updateConfig("sampleRate", Number(val));
                }}
                formatLabel={(val) => `${val} Hz`}
                loading={isLoading}
                fullWidth
              />

              {/* Buffer Size */}
              <NativeSelect
                label="Buffer Size"
                options={config.bufferSizes?.length > 0 ? config.bufferSizes : [512]}
                value={config.current.bufferSize || (config.bufferSizes && config.bufferSizes[0]) || 512}
                onChange={(val) => {
                  console.log("[SettingsModal] Buffer size selected:", val);
                  updateConfig("bufferSize", Number(val));
                }}
                formatLabel={(val) => `${val} samples`}
                loading={isLoading}
                fullWidth
              />
            </>
          )}
        </div>

        <div className="p-4 border-t border-neutral-700 flex justify-end bg-neutral-800 rounded-b-lg gap-2">
          <Button
            variant="default"
            size="md"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleApply}
            disabled={!config || loading}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
