import { useState, useEffect, useRef, useCallback } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { nativeBridge } from "../services/NativeBridge";
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

interface StemSepProgress {
  state: "idle" | "loading" | "analyzing" | "writing" | "done" | "error";
  progress: number;
  stemFiles?: Array<{ name: string; filePath: string }>;
  error?: string;
  backend?: "cuda" | "directml" | "coreml" | "mps" | "cpu";
  accelerationMode?: "auto" | "cpu-only";
  threadCap?: number;
}

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
  const [progress, setProgress] = useState<StemSepProgress>({ state: "idle", progress: 0 });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

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
    if (!stemSepTrackId || !stemSepClipId || selectedStems.length === 0 || !aiToolsStatus.available) return;
    setSeparating(true);
    setProgress({ state: "loading", progress: 0 });
    completedRef.current = false;

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
        accelerationMode: "auto",
      });

      if (!result.started) {
        setProgress({ state: "error", progress: 0, error: result.error || "Failed to start separation." });
        setSeparating(false);
        return;
      }

      let idleCount = 0;
      pollRef.current = setInterval(async () => {
        if (completedRef.current) return;

        const nextProgress = await nativeBridge.getStemSeparationProgress();
        if (completedRef.current) return;

        setProgress(nextProgress);

        if (nextProgress.state === "idle") {
          idleCount++;
          if (idleCount >= 10) {
            completedRef.current = true;
            stopPolling();
            setProgress({ state: "error", progress: 0, error: "Separation did not start. Install AI Tools first." });
            setSeparating(false);
          }
          return;
        }
        idleCount = 0;

        if (nextProgress.state === "done" && nextProgress.stemFiles) {
          completedRef.current = true;
          stopPolling();
          const latestState = useDAWStore.getState();
          const latestTrack = latestState.tracks.find((t) => t.id === stemSepTrackId);
          const latestClip = latestTrack?.clips.find((c) => c.id === stemSepClipId);

          if (latestClip) {
            const enrichedStems = await Promise.all(
              nextProgress.stemFiles.map(async (stem) => {
                try {
                  const info = await nativeBridge.importMediaFile(stem.filePath);
                  return {
                    name: stem.name,
                    filePath: stem.filePath,
                    duration: info?.duration || latestClip.duration,
                    sampleRate: info?.sampleRate || latestClip.sampleRate || 44100,
                  };
                } catch {
                  return {
                    name: stem.name,
                    filePath: stem.filePath,
                    duration: latestClip.duration,
                    sampleRate: latestClip.sampleRate || 44100,
                  };
                }
              }),
            );

            latestState.completeStemSeparation(
              stemSepTrackId,
              stemSepClipId,
              stemSepClipName || "Audio",
              enrichedStems,
              latestClip.startTime,
            );
          }

          setSeparating(false);
          setTimeout(() => closeStemSeparation(), 800);
        } else if (nextProgress.state === "error") {
          completedRef.current = true;
          stopPolling();
          setSeparating(false);
        }
      }, 200);
    } catch (err: any) {
      setProgress({ state: "error", progress: 0, error: err.message || "Separation failed" });
      setSeparating(false);
    }
  };

  const handleInstallAiTools = async () => {
    if (aiToolsStatus.installInProgress || aiToolsStatus.available) return;

    await installAiTools();
  };

  const handleCancel = async () => {
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

          {!aiToolsStatus.available ? (
            <div className="space-y-3 rounded border border-neutral-700 bg-daw-dark p-4">
              <div>
                <p className="text-sm font-medium text-daw-text">AI Tools Required</p>
                <p className="mt-1 text-xs text-daw-text-secondary">
                  Stem separation is optional and installs on demand so the main app stays smaller.
                </p>
              </div>

              <div className="rounded bg-neutral-900/80 p-3 text-xs text-daw-text-secondary">
                {aiToolsStatus.message || "Install AI Tools to enable stem separation."}
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
                    {aiToolsStatus.message || "Installing AI Tools..."}
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => void handleInstallAiTools()}
                    disabled={aiToolsStatus.installInProgress}
                  >
                    {aiToolsStatus.buildRuntimeMode === "downloaded-runtime"
                      ? aiToolsStatus.state === "modelMissing"
                        ? "Finish AI Tools Setup"
                        : "Download AI Tools"
                      : aiToolsStatus.requiresExternalPython
                      ? aiToolsStatus.state === "pythonMissing"
                        ? "Get Python"
                        : "Install AI Tools"
                      : "Install AI Tools"}
                  </Button>
                  {(aiToolsStatus.state === "pythonMissing"
                    || aiToolsStatus.state === "error"
                    || aiToolsStatus.state === "cancelled") && (
                    <Button variant="ghost" onClick={() => void openAiToolsSetup()}>
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

          {progress.state === "error" && !separating && (
            <p className="text-xs text-daw-record text-center">{progress.error}</p>
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
