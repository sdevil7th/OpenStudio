import { useState, useEffect } from "react";
import classNames from "classnames";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";

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

  const selectClass = classNames(
    "bg-neutral-800 border border-neutral-700 text-neutral-200 p-2 rounded text-sm w-full focus:outline-none focus:border-blue-500",
    {
      "opacity-60 cursor-not-allowed bg-neutral-900": isLoading,
    },
  );

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
          <button
            className="bg-transparent border-none text-neutral-400 text-2xl cursor-pointer hover:text-white leading-none"
            onClick={onClose}
          >
            ×
          </button>
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
              <button
                onClick={refreshConfig}
                className="ml-2 bg-transparent border border-red-500 text-red-400 px-3 py-1 rounded cursor-pointer hover:bg-red-500/20"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && !config && (
            <div className="p-5 text-center text-neutral-400">
              No audio configuration available.
              <button
                onClick={refreshConfig}
                className="ml-2 bg-transparent border border-blue-500 text-blue-400 px-3 py-1 rounded cursor-pointer hover:bg-blue-500/20"
              >
                Load
              </button>
            </div>
          )}

          {config && config.current && (
            <>
              {/* Audio System (Driver Type) */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-neutral-400">
                  Audio System
                </label>
                <select
                  value={config.current.audioDeviceType}
                  onChange={(e) =>
                    updateConfig("audioDeviceType", e.target.value)
                  }
                  disabled={isLoading}
                  className={selectClass}
                >
                  {config.availableTypes?.map((type: string) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              {/* ASIO Driver Selection (only show when ASIO is selected) */}
              {config.current.audioDeviceType === "ASIO" && (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-neutral-400">
                    ASIO Driver
                  </label>
                  <select
                    value={
                      isLoading
                        ? ""
                        : config.current.outputDevice ||
                          (config.outputs && config.outputs[0]) ||
                          ""
                    }
                    onChange={(e) => {
                      const driverName = e.target.value;
                      console.log(
                        "[SettingsModal] ASIO driver selected:",
                        driverName,
                      );
                      // For ASIO, input and output use the same driver
                      const newConfig = {
                        ...config,
                        current: {
                          ...config.current,
                          inputDevice: driverName,
                          outputDevice: driverName,
                        },
                      };
                      setConfig(newConfig);
                    }}
                    disabled={isLoading}
                    className={selectClass}
                  >
                    {isLoading ? (
                      <option>--</option>
                    ) : (
                      config.outputs?.map((name: string) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}

              {/* Input Device (hide for ASIO, show for others) */}
              {config.current.audioDeviceType !== "ASIO" && (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-neutral-400">
                    Input Device
                  </label>
                  <select
                    value={isLoading ? "" : config.current.inputDevice}
                    onChange={(e) =>
                      updateConfig("inputDevice", e.target.value)
                    }
                    disabled={isLoading}
                    className={selectClass}
                  >
                    {isLoading ? (
                      <option>--</option>
                    ) : (
                      config.inputs?.map((name: string) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}

              {/* Output Device (hide for ASIO, show for others) */}
              {config.current.audioDeviceType !== "ASIO" && (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-neutral-400">
                    Output Device
                  </label>
                  <select
                    value={isLoading ? "" : config.current.outputDevice}
                    onChange={(e) =>
                      updateConfig("outputDevice", e.target.value)
                    }
                    disabled={isLoading}
                    className={selectClass}
                  >
                    {isLoading ? (
                      <option>--</option>
                    ) : (
                      config.outputs?.map((name: string) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}

              {/* Sample Rate */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-neutral-400">
                  Sample Rate
                </label>
                <select
                  value={
                    isLoading
                      ? ""
                      : config.current.sampleRate ||
                        (config.sampleRates && config.sampleRates[0]) ||
                        44100
                  }
                  onChange={(e) => {
                    const rate = parseFloat(e.target.value);
                    console.log("[SettingsModal] Sample rate selected:", rate);
                    updateConfig("sampleRate", rate);
                  }}
                  disabled={isLoading}
                  className={selectClass}
                >
                  {isLoading ? (
                    <option>--</option>
                  ) : config.sampleRates && config.sampleRates.length > 0 ? (
                    config.sampleRates.map((sr: number) => (
                      <option key={sr} value={sr}>
                        {sr} Hz
                      </option>
                    ))
                  ) : (
                    <option value={44100}>44100 Hz</option>
                  )}
                </select>
              </div>

              {/* Buffer Size */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-neutral-400">
                  Buffer Size
                </label>
                <select
                  value={
                    isLoading
                      ? ""
                      : config.current.bufferSize ||
                        (config.bufferSizes && config.bufferSizes[0]) ||
                        512
                  }
                  onChange={(e) => {
                    const size = parseInt(e.target.value);
                    console.log("[SettingsModal] Buffer size selected:", size);
                    updateConfig("bufferSize", size);
                  }}
                  disabled={isLoading}
                  className={selectClass}
                >
                  {isLoading ? (
                    <option>--</option>
                  ) : config.bufferSizes && config.bufferSizes.length > 0 ? (
                    config.bufferSizes.map((bs: number) => (
                      <option key={bs} value={bs}>
                        {bs} samples
                      </option>
                    ))
                  ) : (
                    <option value={512}>512 samples</option>
                  )}
                </select>
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-neutral-700 flex justify-end bg-neutral-800 rounded-b-lg gap-2">
          <button
            className="px-5 py-2 rounded text-sm bg-neutral-700 text-white hover:bg-neutral-600 transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-5 py-2 rounded text-sm bg-blue-600 text-white font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            onClick={handleApply}
            disabled={!config || loading}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
