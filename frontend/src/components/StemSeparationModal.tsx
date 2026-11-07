import { useState, useEffect, useRef, useCallback } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { isMac } from "../utils/platform";
import { nativeBridge, type StemSepProgress } from "../services/NativeBridge";
import {
  Button,
  Checkbox,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

const STEM_COLORS: Record<string, string> = {
  Vocals: "#ec4899",
  Drums: "#f97316",
  Bass: "#3b82f6",
  Guitar: "#a855f7",
  Piano: "#06b6d4",
  Other: "#22c55e",
};

const ALL_STEMS = ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"];

export default function StemSeparationModal() {
  const {
    showStemSeparation,
    stemSepTrackId,
    stemSepClipId,
    stemSepClipName,
    stemSepClipDuration,
    closeStemSeparation,
    aiToolsStatus,
    installAiTools,
    cancelAiToolsInstall,
    openAiToolsSetup,
  } = useDAWStore(
    useShallow((s) => ({
      showStemSeparation: s.showStemSeparation,
      stemSepTrackId: s.stemSepTrackId,
      stemSepClipId: s.stemSepClipId,
      stemSepClipName: s.stemSepClipName,
      stemSepClipDuration: s.stemSepClipDuration,
      closeStemSeparation: s.closeStemSeparation,
      aiToolsStatus: s.aiToolsStatus,
      installAiTools: s.installAiTools,
      cancelAiToolsInstall: s.cancelAiToolsInstall,
      openAiToolsSetup: s.openAiToolsSetup,
    })),
  );

  const [selectedStems, setSelectedStems] = useState<string[]>([...ALL_STEMS]);
  const [separating, setSeparating] = useState(false);
  const [accelerationMode, setAccelerationMode] = useState<"auto" | "cpu-only">("auto");
  const [chunkDuration, setChunkDuration] = useState<0 | 30>(0);
  const [memoryMode, setMemoryMode] = useState<"automatic" | "streaming-preview">("automatic");
  const [performanceMode, setPerformanceMode] = useState<"standard" | "qualified-fast">("standard");
  const [progress, setProgress] = useState<StemSepProgress>({ state: "idle", progress: 0 });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedRef = useRef(false);
  const requestSerialRef = useRef(0);
  const stemFeature = aiToolsStatus.features?.stemSeparation;
  const isStemSeparationReady = Boolean(stemFeature?.ready ?? aiToolsStatus.available);
  const rollingSupported = aiToolsStatus.hardware?.platform
    ? ["windows", "linux"].includes(aiToolsStatus.hardware.platform.toLowerCase()) : !isMac;
  const isStemSeparationCompatible = stemFeature?.compatible ?? true;
  const stemSeparationBlockMessage =
    stemFeature?.message
    || (stemFeature?.blockReason
      ? `This machine does not meet Stem Separation requirements: ${stemFeature.blockReason}.`
      : "This machine does not meet Stem Separation requirements.");

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    ++requestSerialRef.current;
    completedRef.current = true;
    stopPolling();
  }, [stopPolling]);

  const toggleStem = (stem: string) => {
    setSelectedStems((prev) =>
      prev.includes(stem) ? prev.filter((s) => s !== stem) : [...prev, stem],
    );
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const statusText = () => {
    const backendLabel = progress.backend ? ` (${progress.backend.toUpperCase()})` : "";
    switch (progress.state) {
      case "loading": return `Loading model...${backendLabel}`;
      case "analyzing": return `Separating stems... ${Math.round(progress.progress * 100)}%${backendLabel}`;
      case "writing": return `Writing stem files...${backendLabel}`;
      case "done": return "Separation complete!";
      case "error": return `Error: ${progress.error}`;
      default: return "";
    }
  };

  const handleSeparate = async () => {
    if (!stemSepTrackId || !stemSepClipId || selectedStems.length === 0 || !isStemSeparationReady) return;
    setSeparating(true);
    setProgress({ state: "loading", progress: 0 });
    completedRef.current = false;
    const requestSerial = ++requestSerialRef.current;
    const isCurrent = () => requestSerialRef.current === requestSerial;

    try {
      const state = useDAWStore.getState();
      const sourceTrack = state.tracks.find((t) => t.id === stemSepTrackId);
      const sourceClip = sourceTrack?.clips.find((c) => c.id === stemSepClipId);
      if (!sourceClip?.filePath) {
        setProgress({ state: "error", progress: 0, error: "Clip has no audio file." });
        setSeparating(false);
        return;
      }

      const result = await nativeBridge.separateStemsAsync(stemSepTrackId, stemSepClipId, {
        stems: selectedStems,
        filePath: sourceClip.filePath,
        accelerationMode,
        chunkDuration,
        memoryMode,
        performanceMode,
      });
      if (!isCurrent()) return;

      if (!result.started) {
        setProgress({ state: "error", progress: 0, error: result.error || "Failed to start separation." });
        setSeparating(false);
        return;
      }

      let idleCount = 0;
      let pollInFlight = false;
      pollRef.current = setInterval(async () => {
        if (!isCurrent() || completedRef.current || pollInFlight) return;
        pollInFlight = true;

        let nextProgress: StemSepProgress;
        try {
          nextProgress = await nativeBridge.getStemSeparationProgress();
        } catch (error) {
          if (!isCurrent() || completedRef.current) return;
          completedRef.current = true;
          stopPolling();
          setProgress({ state: "error", progress: 0, error: error instanceof Error ? error.message : "Could not read separation progress." });
          setSeparating(false);
          return;
        } finally {
          pollInFlight = false;
        }
        if (!isCurrent() || completedRef.current) return;

        setProgress(nextProgress);

        if (nextProgress.state === "idle") {
          idleCount++;
          if (idleCount >= 10) {
            completedRef.current = true;
            stopPolling();
            setProgress({ state: "error", progress: 0, error: "Separation did not start. Install Stem Separation first." });
            setSeparating(false);
          }
          return;
        }
        idleCount = 0;

        if (nextProgress.state === "done") {
          completedRef.current = true;
          stopPolling();
          if (!nextProgress.stemFiles || selectedStems.some(name =>
            nextProgress.stemFiles!.filter(stem => stem.name === name && stem.filePath).length !== 1)) {
            setProgress({ state: "error", progress: 0, error: "The separator did not return every requested stem. No tracks were added." });
            setSeparating(false);
            return;
          }
          const latestState = useDAWStore.getState();
          const latestTrack = latestState.tracks.find((t) => t.id === stemSepTrackId);
          const latestClip = latestTrack?.clips.find((c) => c.id === stemSepClipId);

          if (latestClip) {
            const enrichedStems = await Promise.all(
              nextProgress.stemFiles.map(async (stem) => {
                const info = await nativeBridge.importMediaFile(stem.filePath);
                if (!info || !Number.isFinite(info.duration) || info.duration <= 0
                  || !Number.isFinite(info.sampleRate) || info.sampleRate <= 0) {
                  throw new Error(`Cannot read the ${stem.name} stem. No tracks were added.`);
                }
                return {
                  name: stem.name,
                  filePath: stem.filePath,
                  duration: info.duration,
                  sampleRate: info.sampleRate,
                };
              }),
            ).catch((error: unknown) => {
              if (isCurrent()) {
                setProgress({ state: "error", progress: 0, error: error instanceof Error ? error.message : "Could not read stem files. No tracks were added." });
                setSeparating(false);
              }
              return null;
            });
            if (!isCurrent()) return;
            if (!enrichedStems) return;
            const currentTrack = useDAWStore.getState().tracks.find((track) => track.id === stemSepTrackId);
            const currentClip = currentTrack?.clips.find((clip) => clip.id === stemSepClipId);
            if (!currentClip || currentClip.filePath !== sourceClip.filePath) {
              setProgress({ state: "error", progress: 0, error: "The source clip changed during separation. No tracks were added." });
              setSeparating(false);
              return;
            }

            latestState.completeStemSeparation(
              stemSepTrackId,
              stemSepClipId,
              stemSepClipName || "Audio",
              enrichedStems,
              latestClip.startTime,
            );
          }

          setSeparating(false);
          setTimeout(() => { if (isCurrent()) closeStemSeparation(); }, 800);
        } else if (nextProgress.state === "error") {
          completedRef.current = true;
          stopPolling();
          setSeparating(false);
        }
      }, 200);
    } catch (err: any) {
      if (!isCurrent()) return;
      setProgress({ state: "error", progress: 0, error: err.message || "Separation failed" });
      setSeparating(false);
    }
  };

  const handleInstallAiTools = async () => {
    if (aiToolsStatus.installInProgress || isStemSeparationReady || !isStemSeparationCompatible) return;

    await installAiTools({ requestedFeature: "stemSeparation", selectedFeatures: ["stemSeparation"] });
  };

  const handleCancel = async () => {
    ++requestSerialRef.current;
    completedRef.current = true;
    if (separating) {
      stopPolling();
      await nativeBridge.cancelStemSeparation();
      setSeparating(false);
      setProgress({ state: "idle", progress: 0 });
      return;
    }
    closeStemSeparation();
  };

  const handleCancelInstall = async () => {
    if (!aiToolsStatus.installInProgress) {
      return;
    }

    await cancelAiToolsInstall();
  };

  if (!showStemSeparation) return null;

  return (
    <Modal isOpen={showStemSeparation} onClose={() => void handleCancel()}>
      <ModalHeader title="Separate Stems" />
      <ModalContent>
        <div className="space-y-4">
          <div className="bg-daw-dark rounded p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-daw-text-secondary">Source:</span>
              <span>{stemSepClipName || "Audio"}</span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-daw-text-secondary">Duration:</span>
              <span>{formatDuration(stemSepClipDuration)}</span>
            </div>
          </div>

          {!isStemSeparationReady ? (
            <div className="space-y-3 rounded border border-neutral-700 bg-daw-dark p-4">
              <div>
                <p className="text-sm font-medium text-daw-text">Stem Separation Required</p>
                <p className="mt-1 text-xs text-daw-text-secondary">
                  Stem separation is optional and installs on demand so the main app stays smaller.
                </p>
              </div>

              <div className="rounded bg-neutral-900/80 p-3 text-xs text-daw-text-secondary">
                {isStemSeparationCompatible
                  ? aiToolsStatus.message || "Install Stem Separation to enable this workflow."
                  : stemSeparationBlockMessage}
                {aiToolsStatus.error ? (
                  <p className="mt-2 text-daw-record">{aiToolsStatus.error}</p>
                ) : null}
                {aiToolsStatus.lastPhase ? (
                  <p className="mt-2">Last phase: <span className="text-daw-text">{aiToolsStatus.lastPhase}</span></p>
                ) : null}
                {aiToolsStatus.installSessionId ? (
                  <p className="mt-1 break-all">
                    Session: <span className="text-daw-text">{aiToolsStatus.installSessionId}</span>
                  </p>
                ) : null}
                {aiToolsStatus.detailLogPath ? (
                  <p className="mt-1 break-all">
                    Install log: <span className="text-daw-text">{aiToolsStatus.detailLogPath}</span>
                  </p>
                ) : null}
              </div>

              {aiToolsStatus.installInProgress && (
                <div className="space-y-2">
                  <div className="w-full bg-neutral-900 rounded-full h-2">
                    <div
                      className="bg-daw-accent h-2 rounded-full transition-all duration-200"
                      style={{ width: `${Math.round(aiToolsStatus.progress * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-daw-text-secondary text-center">
                    {aiToolsStatus.message || "Installing Stem Separation..."}
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => void handleInstallAiTools()}
                    disabled={aiToolsStatus.installInProgress || !isStemSeparationCompatible}
                  >
                    {aiToolsStatus.buildRuntimeMode === "downloaded-runtime"
                      ? aiToolsStatus.state === "modelMissing"
                        ? "Finish Stem Separation Setup"
                        : "Download Stem Separation"
                      : aiToolsStatus.requiresExternalPython
                      ? aiToolsStatus.state === "pythonMissing"
                        ? "Get Python"
                        : "Install Stem Separation"
                      : "Install Stem Separation"}
                  </Button>
                  {(aiToolsStatus.state === "pythonMissing"
                    || aiToolsStatus.state === "error"
                    || aiToolsStatus.state === "cancelled"
                    || !isStemSeparationCompatible) && (
                    <Button variant="ghost" onClick={() => void openAiToolsSetup("stemSeparation")}>
                      Open Setup Guide
                    </Button>
                  )}
                </div>
            </div>
          ) : (
            <>
              <div>
                <label className="text-sm text-daw-text-secondary block mb-1">Model</label>
                <div className="bg-daw-dark rounded p-2 text-sm">
                  BS-RoFormer SW - 6 Stems (Vocals / Drums / Bass / Guitar / Piano / Other)
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm text-daw-text-secondary">
                  Processing device
                  <select className="mt-1 block w-full rounded border border-neutral-700 bg-daw-dark p-2 text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent"
                    value={accelerationMode} disabled={separating}
                    onChange={(event) => setAccelerationMode(event.target.value as "auto" | "cpu-only")}>
                    <option value="auto">Automatic (use GPU when available)</option>
                    <option value="cpu-only">CPU only</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={chunkDuration === 30} disabled={separating || memoryMode === "streaming-preview"}
                    onChange={() => setChunkDuration((value) => value === 0 ? 30 : 0)} />
                  Process in 30-second sections to reduce memory use
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={memoryMode === "streaming-preview"} disabled={separating || !rollingSupported}
                    onChange={() => { setMemoryMode((mode) => mode === "automatic" ? "streaming-preview" : "automatic"); setChunkDuration(0); }} />
                  Use rolling output buffers
                </label>
                {!rollingSupported && <p className="text-xs text-daw-text-secondary">Rolling buffers are currently qualified on Windows and Linux. Use Automatic or 30-second sections on this platform.</p>}
                <p className="text-xs text-daw-text-secondary">Automatic mode uses rolling buffers when RAM is limited and the runtime is supported. Rolling buffers need temporary disk space and preserve the model’s window boundaries. Explicit 30-second sections can change results at section boundaries.</p>
                {aiToolsStatus.hardware?.gpuBackend === "rocm" && (
                  <label className="block text-sm text-daw-text-secondary">
                    AMD performance
                    <select className="mt-1 block w-full rounded border border-neutral-700 bg-daw-dark p-2 text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent"
                      value={performanceMode} disabled={separating || accelerationMode === "cpu-only"}
                      onChange={(event) => setPerformanceMode(event.target.value as "standard" | "qualified-fast")}>
                      <option value="standard">Standard precision</option>
                      <option value="qualified-fast">Faster when qualified (FP16)</option>
                    </select>
                    <span className="mt-1 block text-xs">Qualified on Linux gfx1151 with the reviewed ROCm 7.2 runtime. Other configurations keep standard precision.</span>
                  </label>
                )}
              </div>

              <div>
                <label className="text-sm text-daw-text-secondary block mb-2">Stems to extract</label>
                <div className="grid grid-cols-3 gap-2">
                  {ALL_STEMS.map((stem) => (
                    <label
                      key={stem}
                      className="flex items-center gap-2 p-2 rounded bg-daw-dark hover:bg-daw-surface cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedStems.includes(stem)}
                        onChange={() => toggleStem(stem)}
                        disabled={separating}
                      />
                      <span
                        className="w-3 h-3 rounded-full inline-block"
                        style={{ backgroundColor: STEM_COLORS[stem] }}
                      />
                      <span className="text-sm">{stem}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {separating && (
            <div className="space-y-2">
              <div className="w-full bg-daw-dark rounded-full h-2">
                <div
                  className="bg-daw-accent h-2 rounded-full transition-all duration-200"
                  style={{ width: `${Math.round(progress.progress * 100)}%` }}
                />
              </div>
              <p className="text-xs text-daw-text-secondary text-center">
                {statusText()}
              </p>
            </div>
          )}

          {progress.fallbackReason && (
            <p role="status" className="break-words text-xs text-daw-text-secondary">{progress.fallbackReason}</p>
          )}
          {progress.diagnostics?.memoryPlan && (
            <details className="rounded border border-daw-border p-2 text-xs text-daw-text-secondary">
              <summary className="cursor-pointer focus-visible:outline focus-visible:outline-daw-accent">Processing details</summary>
              <div className="mt-2 space-y-1 break-words">
                <p>{progress.diagnostics.executionDetails?.deviceReceipt?.cudaDeviceName ?? progress.backend?.toUpperCase()}</p>
                <p>{progress.diagnostics.memoryPlan.reason}</p>
                <p>{progress.diagnostics.memoryPlan.memory_mode === "streaming" ? "Rolling output buffers with temporary disk storage" : progress.diagnostics.memoryPlan.chunk_duration > 0 ? `${progress.diagnostics.memoryPlan.chunk_duration}-second output sections` : "Whole-recording output buffers"}</p>
              </div>
            </details>
          )}
          {progress.diagnostics?.performancePolicy && (
            <p className="text-xs text-daw-text-secondary">{progress.diagnostics.performancePolicy.reason}</p>
          )}

          {progress.state === "error" && !separating && (
            <p className="break-words text-xs text-daw-record text-center">{progress.error}</p>
          )}
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost" onClick={() => void handleCancel()}>
          {separating ? "Cancel" : "Close"}
        </Button>
        {!separating && aiToolsStatus.installInProgress && (
          <Button variant="secondary" onClick={() => void handleCancelInstall()}>
            Cancel Install
          </Button>
        )}
        {!separating && progress.state !== "done" && aiToolsStatus.available && (
          <Button
            variant="primary"
            onClick={() => void handleSeparate()}
            disabled={selectedStems.length === 0}
          >
            Separate
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
