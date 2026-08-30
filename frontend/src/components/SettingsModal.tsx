import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import {
  nativeBridge,
  type AudioDebugSnapshot,
} from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, NativeSelect } from "./ui";
import { guardModalContextMenu } from "../utils/modalEventGuards";
import {
  resolveAudioBufferSizeOptions,
  resolveAudioBufferSizeRequest,
} from "../utils/audioBufferOptions";
import { resolveAudioPerformanceAdvisory } from "../utils/audioPerformanceAdvisory";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false); // Track when switching audio types
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingDriverPanel, setOpeningDriverPanel] = useState(false);
  const [driverPanelMessage, setDriverPanelMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [audioDiagnostics, setAudioDiagnostics] =
    useState<AudioDebugSnapshot | null>(null);
  const [oversamplingFactor, setOversamplingFactor] =
    useState<2 | 4 | 8>(4);
  const { refreshAudioDeviceSetup, stop } = useDAWStore(useShallow((s) => ({
    refreshAudioDeviceSetup: s.refreshAudioDeviceSetup,
    stop: s.stop,
  })));

  // Combined loading state for disabling dropdowns
  const isLoading = loading || switching || applying;
  const bufferSizeOptions = resolveAudioBufferSizeOptions(
    config?.bufferSizes,
    config?.current?.bufferSize,
  );
  const selectedBufferSize = resolveAudioBufferSizeRequest(
    config?.current?.bufferSize,
    config?.bufferSizes,
  );
  const performanceAdvisory =
    resolveAudioPerformanceAdvisory(audioDiagnostics);
  const { deadlineStatus } = performanceAdvisory;

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
      setOversamplingFactor(
        await nativeBridge
          .getNAMRackOversamplingFactor()
          .catch((): 2 | 4 | 8 => 4),
      );
      const diagnostics = await nativeBridge.getAudioDebugSnapshot()
        .catch((diagnosticError) => {
          console.warn(
            "[SettingsModal] Audio diagnostics are unavailable:",
            diagnosticError,
          );
          return null;
        });
      setAudioDiagnostics(diagnostics);
    } catch (e) {
      console.error("[SettingsModal] Failed to get audio config:", e);
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const buildBackendAudioDeviceConfig = (current: any) => ({
    type: current.type || current.audioDeviceType || "",
    inputDevice: current.inputDevice || "",
    outputDevice: current.outputDevice || "",
    sampleRate: Number(current.sampleRate) || 44100,
    bufferSize: resolveAudioBufferSizeRequest(
      current.bufferSize,
      config?.bufferSizes,
    ),
  });

  const handleApply = async () => {
    if (!config || !config.current) return;

    setApplying(true);
    setError(null);
    try {
      const backendConfig = buildBackendAudioDeviceConfig(config.current);
      console.log("[SettingsModal] Applying config:", backendConfig);
      await stop();
      await nativeBridge.panicMIDI().catch(() => false);
      const oversamplingApplied =
        await nativeBridge.setNAMRackOversamplingFactor(oversamplingFactor);
      if (!oversamplingApplied) {
        throw new Error("NAM Rack rejected the requested oversampling factor");
      }
      const applied = await nativeBridge.setAudioDeviceSetup(backendConfig);
      if (!applied) {
        throw new Error("Audio device rejected the requested configuration");
      }

      // Update the store so TrackHeader immediately gets new input list
      await refreshAudioDeviceSetup();
      await nativeBridge.panicMIDI().catch(() => false);

      onClose();
    } catch (e) {
      console.error("[SettingsModal] Failed to set audio config:", e);
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setApplying(false);
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
      await stop();
      await nativeBridge.panicMIDI().catch(() => false);
      // Tell backend to switch audio device type
      const switchBufferSize = resolveAudioBufferSizeRequest(
        config?.current?.bufferSize,
        config?.bufferSizes,
      );
      const applied = await nativeBridge.setAudioDeviceSetup({
        type: newType,
        inputDevice: "", // Will use default
        outputDevice: "", // Will use default
        sampleRate: 44100,
        bufferSize: switchBufferSize,
      });
      if (!applied) {
        throw new Error("Audio device rejected the selected audio system");
      }

      // Wait a bit for backend to switch
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Refresh to get devices for new type
      await refreshConfig();
      await nativeBridge.panicMIDI().catch(() => false);
    } catch (e) {
      console.error("[SettingsModal] Failed to switch audio type:", e);
      setError(e instanceof Error ? e.message : "Failed to switch audio system");
    } finally {
      setSwitching(false);
    }
  };

  const handleOpenAudioDeviceControlPanel = async () => {
    setOpeningDriverPanel(true);
    setDriverPanelMessage(null);

    try {
      const result = await nativeBridge.openAudioDeviceControlPanel();
      if (!result.success || !result.opened) {
        throw new Error(
          result.error || "The active ASIO driver did not open its control panel.",
        );
      }

      await refreshConfig();
      const deviceLabel = result.deviceName?.trim() || "ASIO driver";
      setDriverPanelMessage({
        tone: "success",
        text: result.restartRequested
          ? `${deviceLabel} restarted and its settings were refreshed.`
          : `${deviceLabel} settings were refreshed after the control panel closed.`,
      });
    } catch (controlPanelError) {
      setDriverPanelMessage({
        tone: "error",
        text: controlPanelError instanceof Error
          ? controlPanelError.message
          : "Could not open the ASIO control panel.",
      });
    } finally {
      setOpeningDriverPanel(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 w-screen h-screen bg-black/70 flex justify-center items-center z-[10000] backdrop-blur-[2px]"
      data-modal-root="true"
      onClick={onClose}
      onContextMenu={guardModalContextMenu}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 w-[500px] max-w-[90vw] max-h-[85vh] flex flex-col rounded-lg shadow-2xl text-neutral-200"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={guardModalContextMenu}
      >
        <div className="flex justify-between items-center p-4 bg-neutral-800 rounded-t-lg border-b border-neutral-700">
          <h2 className="m-0 text-lg font-medium">Audio Settings</h2>
          <Button
            variant="ghost"
            size="icon-md"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {isLoading && (
            <div className="flex items-center gap-2 p-3 bg-blue-500/15 border border-blue-500 rounded text-blue-400 text-sm animate-pulse">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              {switching
                ? "Switching audio system..."
                : applying
                  ? "Applying audio settings..."
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
                <div>
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
                      setDriverPanelMessage(null);
                    }}
                    loading={isLoading}
                    fullWidth
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-xs leading-snug text-neutral-500">
                      Opens the active driver&apos;s native hardware settings.
                    </span>
                    <Button
                      variant="default"
                      size="sm"
                      icon={<ExternalLink size={14} />}
                      onClick={handleOpenAudioDeviceControlPanel}
                      loading={openingDriverPanel}
                      disabled={isLoading || openingDriverPanel}
                      className="shrink-0"
                    >
                      Open ASIO Control Panel
                    </Button>
                  </div>
                  {driverPanelMessage && (
                    <div
                      className={`mt-2 text-xs leading-relaxed ${
                        driverPanelMessage.tone === "error"
                          ? "text-red-400"
                          : "text-emerald-400"
                      }`}
                    >
                      {driverPanelMessage.text}
                    </div>
                  )}
                </div>
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

              <div>
                <NativeSelect
                  label="Oversampling"
                  options={[2, 4, 8]}
                  value={oversamplingFactor}
                  onChange={(val) => {
                    const factor = Number(val);
                    if (factor === 2 || factor === 4 || factor === 8) {
                      setOversamplingFactor(factor);
                    }
                  }}
                  formatLabel={(val) => `${val}x`}
                  loading={isLoading}
                  fullWidth
                />
                <div className="mt-2 text-xs leading-relaxed text-neutral-500">
                  Controls internal oversampling for NAM Rack Precision Drive and
                  Distortion. Higher values reduce aliasing and increase CPU use.
                </div>
                {deadlineStatus.shouldWarn && oversamplingFactor > 2 && (
                  <div className="mt-2 text-xs leading-relaxed text-amber-300">
                    The current audio callback has recently missed its deadline.
                    Lower Oversampling if this continues; OpenStudio will not
                    reduce it automatically.
                  </div>
                )}
              </div>

              {/* Buffer Size */}
              <div>
                <NativeSelect
                  label="Buffer Size"
                  options={bufferSizeOptions}
                  value={selectedBufferSize}
                  onChange={(val) => {
                    console.log("[SettingsModal] Buffer size selected:", val);
                    updateConfig("bufferSize", Number(val));
                  }}
                  formatLabel={(val) => `${val} samples`}
                  loading={isLoading}
                  fullWidth
                />
                <div className="mt-2 text-xs leading-relaxed text-neutral-500">
                  Every size reported by the active driver is available. Smaller
                  buffers reduce latency but leave less time for audio processing.
                </div>
                {performanceAdvisory.shouldWarn && (
                  <div className="mt-2 rounded border border-amber-500/45 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                    {performanceAdvisory.deviceXRunCount > 0 && (
                      <div>
                        The audio device path recorded{" "}
                        {performanceAdvisory.deviceXRunCount}{" "}
                        {performanceAdvisory.deviceXRunCount === 1
                          ? "x-run"
                          : "x-runs"}{" "}
                        this session. This includes device or host delivery
                        interruptions.
                      </div>
                    )}
                    {deadlineStatus.shouldWarn && (
                      <div
                        className={
                          performanceAdvisory.deviceXRunCount > 0 ? "mt-1" : ""
                        }
                      >
                        OpenStudio separately observed{" "}
                        {Math.max(1, deadlineStatus.burstMissCount)} recent{" "}
                        {deadlineStatus.burstMissCount === 1
                          ? "callback"
                          : "callbacks"}{" "}
                        missing its processing deadline
                        {audioDiagnostics?.blockSize
                          ? ` at ${audioDiagnostics.blockSize} samples`
                          : ""}
                        .
                      </div>
                    )}
                    <div className="mt-1 text-amber-200/80">
                      Either condition can sound like crackling or dropouts. If
                      it continues, try the next larger size supported by your
                      driver.
                    </div>
                  </div>
                )}
              </div>
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
            disabled={!config || isLoading}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
