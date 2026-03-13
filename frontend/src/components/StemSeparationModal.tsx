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
}

export default function StemSeparationModal() {
  const {
    showStemSeparation,
    stemSepTrackId,
    stemSepClipId,
    stemSepClipName,
    stemSepClipDuration,
    closeStemSeparation,
  } = useDAWStore(
    useShallow((s) => ({
      showStemSeparation: s.showStemSeparation,
      stemSepTrackId: s.stemSepTrackId,
      stemSepClipId: s.stemSepClipId,
      stemSepClipName: s.stemSepClipName,
      stemSepClipDuration: s.stemSepClipDuration,
      closeStemSeparation: s.closeStemSeparation,
    }))
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

  // Cleanup on unmount
  useEffect(() => stopPolling, [stopPolling]);

  const toggleStem = (stem: string) => {
    setSelectedStems((prev) =>
      prev.includes(stem) ? prev.filter((s) => s !== stem) : [...prev, stem]
    );
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const statusText = () => {
    switch (progress.state) {
      case "loading": return "Loading model...";
      case "analyzing": return `Separating stems... ${Math.round(progress.progress * 100)}%`;
      case "writing": return "Writing stem files...";
      case "done": return "Separation complete!";
      case "error": return `Error: ${progress.error}`;
      default: return "";
    }
  };

  const handleSeparate = async () => {
    if (!stemSepTrackId || !stemSepClipId || selectedStems.length === 0) return;
    setSeparating(true);
    setProgress({ state: "loading", progress: 0 });
    completedRef.current = false;

    try {
      // Look up the clip's file path from the store
      const state = useDAWStore.getState();
      const sourceTrack = state.tracks.find((t) => t.id === stemSepTrackId);
      const sourceClip = sourceTrack?.clips.find((c) => c.id === stemSepClipId);
      if (!sourceClip?.filePath) {
        setProgress({ state: "error", progress: 0, error: "Clip has no audio file." });
        setSeparating(false);
        return;
      }

      // Start async separation — pass filePath so backend doesn't need clip ID lookup
      const result = await nativeBridge.separateStemsAsync(stemSepTrackId, stemSepClipId, {
        stems: selectedStems,
        filePath: sourceClip.filePath,
      });

      if (!result.started) {
        setProgress({ state: "error", progress: 0, error: result.error || "Failed to start separation." });
        setSeparating(false);
        return;
      }

      // Poll for progress
      let idleCount = 0;
      pollRef.current = setInterval(async () => {
        // Guard: if already completed or stopped, skip stale in-flight callbacks
        if (completedRef.current) return;

        const p = await nativeBridge.getStemSeparationProgress();

        // Re-check after async gap — another callback may have completed
        if (completedRef.current) return;

        setProgress(p);

        // Safety: stop polling if state stays idle (separation never started)
        if (p.state === "idle") {
          idleCount++;
          if (idleCount >= 10) {
            completedRef.current = true;
            stopPolling();
            setProgress({ state: "error", progress: 0, error: "Separation did not start. Check Python installation." });
            setSeparating(false);
          }
          return;
        }
        idleCount = 0;

        if (p.state === "done" && p.stemFiles) {
          completedRef.current = true;
          stopPolling();
          const state = useDAWStore.getState();
          const sourceTrack = state.tracks.find((t) => t.id === stemSepTrackId);
          const sourceClip = sourceTrack?.clips.find((c) => c.id === stemSepClipId);

          if (sourceClip) {
            // Query actual file properties for each stem (duration & sampleRate
            // may differ from source due to audio-separator processing)
            const enrichedStems = await Promise.all(
              p.stemFiles.map(async (stem) => {
                try {
                  const info = await nativeBridge.importMediaFile(stem.filePath);
                  return {
                    name: stem.name,
                    filePath: stem.filePath,
                    duration: info?.duration || sourceClip.duration,
                    sampleRate: info?.sampleRate || sourceClip.sampleRate || 44100,
                  };
                } catch {
                  return {
                    name: stem.name,
                    filePath: stem.filePath,
                    duration: sourceClip.duration,
                    sampleRate: sourceClip.sampleRate || 44100,
                  };
                }
              })
            );

            state.completeStemSeparation(
              stemSepTrackId,
              stemSepClipId,
              stemSepClipName || "Audio",
              enrichedStems,
              sourceClip.startTime,
            );
          }

          setSeparating(false);
          setTimeout(() => closeStemSeparation(), 800);
        } else if (p.state === "error") {
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

  const handleCancel = async () => {
    if (separating) {
      stopPolling();
      await nativeBridge.cancelStemSeparation();
      setSeparating(false);
      setProgress({ state: "idle", progress: 0 });
    } else {
      closeStemSeparation();
    }
  };

  if (!showStemSeparation) return null;

  return (
    <Modal isOpen={showStemSeparation} onClose={handleCancel}>
      <ModalHeader title="Separate Stems" />
      <ModalContent>
        <div className="space-y-4">
          {/* Source info */}
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

          {/* Model info */}
          <div>
            <label className="text-sm text-daw-text-secondary block mb-1">Model</label>
            <div className="bg-daw-dark rounded p-2 text-sm">
              BS-RoFormer SW — 6 Stems (Vocals / Drums / Bass / Guitar / Piano / Other)
            </div>
          </div>

          {/* Stem selection */}
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

          {/* Progress */}
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

          {/* Error */}
          {progress.state === "error" && !separating && (
            <p className="text-xs text-daw-record text-center">{progress.error}</p>
          )}
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost" onClick={handleCancel}>
          {separating ? "Cancel" : "Close"}
        </Button>
        {!separating && progress.state !== "done" && (
          <Button
            variant="primary"
            onClick={handleSeparate}
            disabled={selectedStems.length === 0}
          >
            Separate
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
