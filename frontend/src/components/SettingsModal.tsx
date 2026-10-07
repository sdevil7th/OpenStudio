import { useState, useEffect, useSyncExternalStore, useRef } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import {
  nativeBridge,
  type AudioDebugSnapshot,
  type AudioDeviceDraft,
} from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, NativeSelect } from "./ui";
import { guardModalContextMenu, modalPointerBoundaryProps } from "../utils/modalEventGuards";
import { AudioSettingsSession, audioDeviceDraft, isWasapiType, wasapiModes } from "../utils/audioSettingsSession";
import { resolveAudioPerformanceAdvisory } from "../utils/audioPerformanceAdvisory";
import { useModalShortcutScope } from "../utils/modalShortcutScope";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [session] = useState(() => new AudioSettingsSession((draft) => nativeBridge.queryAudioDeviceSetup(draft)));
  const { setup: config, applied, loading, resolving: switching, error } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [applying, setApplying] = useState(false);
  const [openingDriverPanel, setOpeningDriverPanel] = useState(false);
  const [driverPanelMessage, setDriverPanelMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [audioDiagnostics, setAudioDiagnostics] = useState<AudioDebugSnapshot | null>(null);
  const [oversamplingFactor, setOversamplingFactor] = useState<2 | 4 | 8>(4);
  const appliedOversampling = useRef<2 | 4 | 8>(4);
  const openGeneration = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { refreshAudioDeviceSetup, stop } = useDAWStore(useShallow((s) => ({
    refreshAudioDeviceSetup: s.refreshAudioDeviceSetup,
    stop: s.stop,
  })));
  const isLoading = loading || switching || applying || openingDriverPanel;
  const controlsLocked = loading || applying || openingDriverPanel;
  const bufferSizeOptions = config?.bufferSizes?.length ? config.bufferSizes : [0];
  const selectedBufferSize = config?.current.bufferSize ?? 0;
  const performanceAdvisory = resolveAudioPerformanceAdvisory(audioDiagnostics);
  const { deadlineStatus } = performanceAdvisory;
  const devicePending = config && applied && JSON.stringify(audioDeviceDraft(config.current)) !== JSON.stringify(audioDeviceDraft(applied.current));
  const canApply = !!config && config.current.sampleRate > 0 && config.current.bufferSize > 0 && !isLoading && !error;
  const availableModes = wasapiModes.filter((mode) => config?.availableTypes?.includes(mode.value));
  const systemOptions = [...new Set((config?.availableTypes ?? []).map((type) => isWasapiType(type) ? "WASAPI" : type))];

  const refreshConfig = async () => {
    const generation = ++openGeneration.current;
    await session.load(async () => {
      const [setup, factor, diagnostics] = await Promise.all([
        nativeBridge.getAudioDeviceSetup(),
        nativeBridge.getNAMRackOversamplingFactor(),
        nativeBridge.getAudioDebugSnapshot().catch(() => null),
      ]);
      if (generation === openGeneration.current) {
        appliedOversampling.current = factor;
        setOversamplingFactor(factor);
        setAudioDiagnostics(diagnostics);
      }
      return setup;
    });
  };

  const close = () => {
    if (applying || openingDriverPanel) return;
    ++openGeneration.current;
    session.invalidate();
    onClose();
  };
  useModalShortcutScope(isOpen, close, !applying && !openingDriverPanel);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (isOpen) {
      setDriverPanelMessage(null);
      void refreshConfig();
      dialogRef.current?.focus();
    }
    return () => {
      ++openGeneration.current;
      session.invalidate();
      if (isOpen && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen, session]);

  const handleApply = async (closeAfter = false) => {
    if (!canApply || !config) return;
    if (useDAWStore.getState().transport.isRecording) {
      session.setError("Stop recording before changing audio devices.");
      return;
    }
    setApplying(true);
    session.invalidate();
    session.setError(null);
    try {
      await stop();
      await nativeBridge.panicMIDI();
      const result = await nativeBridge.applyAudioDeviceSetup(audioDeviceDraft(config.current));
      await refreshAudioDeviceSetup();
      if (!result.success) {
        // Keep the pending choices for correction; publish the actual recovery state.
        session.acceptApplied(result.setup, true);
        throw new Error(result.error || "Audio device rejected the requested configuration.");
      }
      session.acceptApplied(result.setup);
      if (oversamplingFactor !== appliedOversampling.current) {
        const accepted = await nativeBridge.setNAMRackOversamplingFactor(oversamplingFactor);
        if (!accepted) {
          setOversamplingFactor(appliedOversampling.current);
          throw new Error("Audio device settings were applied, but NAM oversampling was rejected.");
        }
        appliedOversampling.current = oversamplingFactor;
      }
      setAudioDiagnostics(await nativeBridge.getAudioDebugSnapshot().catch(() => null));
      if (closeAfter) onClose();
    } catch (cause) {
      session.setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(false);
    }
  };

  const updateConfig = <K extends keyof AudioDeviceDraft>(key: K, value: AudioDeviceDraft[K]) => {
    setDriverPanelMessage(null);
    void session.select({ [key]: value });
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

      const setup = await nativeBridge.getAudioDeviceSetup();
      session.acceptApplied(setup, !!devicePending);
      if (devicePending) await session.select({});
      await refreshAudioDeviceSetup();
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
      {...modalPointerBoundaryProps}
      onClick={close}
      onContextMenu={guardModalContextMenu}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 w-[500px] max-w-[90vw] max-h-[85vh] flex flex-col rounded-lg shadow-2xl text-neutral-200"
        role="dialog"
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-label="Audio Settings"
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)"));
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
              event.preventDefault(); last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault(); first?.focus();
            }
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={guardModalContextMenu}
      >
        <div className="flex justify-between items-center p-4 bg-neutral-800 rounded-t-lg border-b border-neutral-700">
          <h2 className="m-0 text-lg font-medium">Audio Settings</h2>
          <Button
            variant="ghost"
            size="icon-md"
            aria-label="Close Audio Settings"
            disabled={applying || openingDriverPanel}
            onClick={close}
          >
            <X size={18} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {isLoading && (
            <div className="flex items-center gap-2 p-3 bg-blue-500/15 border border-blue-500 rounded text-blue-400 text-sm animate-pulse">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              {switching
                ? "Updating device options..."
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
                onClick={() => config ? void session.select({}) : void refreshConfig()}
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
                onClick={() => config ? void session.select({}) : void refreshConfig()}
                className="ml-2"
              >
                Load
              </Button>
            </div>
          )}

          {config?.capabilityMessage && <p role="status" className="text-xs text-neutral-400">{config.capabilityMessage}</p>}
          {!!config?.adjustments?.length && <p role="status" className="text-xs text-amber-200">{config.adjustments.join(" ")}</p>}
          {devicePending && <p className="text-xs text-neutral-400">Changes are pending. Audio continues using the applied settings until you choose Apply or OK.</p>}
          {config && config.current && (
            <>
              {/* Audio System (Driver Type) */}
              <NativeSelect
                label="Audio System"
                options={systemOptions}
                value={isWasapiType(config.current.audioDeviceType) ? "WASAPI" : config.current.audioDeviceType}
                onChange={(val) => updateConfig("audioDeviceType", val === "WASAPI" ? availableModes[0].value : String(val))}
                loading={controlsLocked}
                fullWidth
              />
              {isWasapiType(config.current.audioDeviceType) && (
                <NativeSelect label="Mode" options={availableModes} value={config.current.audioDeviceType}
                  onChange={(value) => updateConfig("audioDeviceType", String(value))}
                  loading={controlsLocked} fullWidth />
              )}

              {/* ASIO Driver Selection (only show when ASIO is selected) */}
              {config.current.audioDeviceType === "ASIO" && (
                <div>
                  <NativeSelect
                    label="ASIO Driver"
                    options={config.outputs || []}
                    value={config.current.outputDevice || (config.outputs && config.outputs[0]) || ""}
                    onChange={(val) => {
                      setDriverPanelMessage(null);
                      void session.select({ inputDevice: String(val), outputDevice: String(val) });
                    }}
                    loading={controlsLocked}
                    fullWidth
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-xs leading-snug text-neutral-500">
                      {devicePending ? "Apply the pending device settings before opening the driver panel." : "Opens the active driver's native hardware settings."}
                    </span>
                    <Button
                      variant="default"
                      size="sm"
                      icon={<ExternalLink size={14} />}
                      onClick={handleOpenAudioDeviceControlPanel}
                      loading={openingDriverPanel}
                      disabled={isLoading || !!devicePending}
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

              {config.current.microphonePermissionRequired && <div role="status" className="rounded border border-amber-500/40 p-3 text-xs text-amber-200">
                {config.current.microphonePermissionStatus === "notDetermined"
                  ? "Audio input is off until you enable monitoring, record audio, or apply an input device. macOS asks when input is first needed."
                  : "Audio input is unavailable. Enable OpenStudio in System Settings > Privacy & Security > Microphone. Playback, editing, and MIDI remain available."}
              </div>}

              {/* Input Device (hide for ASIO, show for others) */}
              {config.current.audioDeviceType !== "ASIO" && (
                <NativeSelect
                  label="Input Device"
                  options={config.inputs || []}
                  value={config.current.inputDevice}
                  onChange={(val) => updateConfig("inputDevice", String(val))}
                  loading={controlsLocked}
                  fullWidth
                />
              )}

              {/* Output Device (hide for ASIO, show for others) */}
              {config.current.audioDeviceType !== "ASIO" && (
                <NativeSelect
                  label="Output Device"
                  options={config.outputs || []}
                  value={config.current.outputDevice}
                  onChange={(val) => updateConfig("outputDevice", String(val))}
                  loading={controlsLocked}
                  fullWidth
                />
              )}

              {/* Sample Rate */}
              <NativeSelect
                label="Sample Rate"
                options={config.sampleRates?.length ? config.sampleRates : [0]}
                value={config.current.sampleRate}
                onChange={(val) => {
                  console.log("[SettingsModal] Sample rate selected:", val);
                  updateConfig("sampleRate", Number(val));
                }}
                formatLabel={(val) => Number(val) === 0 ? "Automatic" : `${val} Hz`}
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
                  loading={controlsLocked}
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
                  formatLabel={(val) => Number(val) === 0 ? "Automatic" : `${val} samples`}
                  loading={isLoading}
                  fullWidth
                />
                <div className="mt-2 text-xs leading-relaxed text-neutral-500">
                  Options follow the selected device pair. Smaller buffers leave less time for audio processing. The driver confirms the actual size when applied.
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
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => void handleApply()}
            disabled={!canApply}
          >
            Apply
          </Button>
          <Button variant="primary" size="md" onClick={() => void handleApply(true)} disabled={!canApply}>
            OK
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
