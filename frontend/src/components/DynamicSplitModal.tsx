import { useState, useCallback } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { Button, Slider } from "./ui";
import { Modal } from "./ui/Modal/Modal";

interface DynamicSplitModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DynamicSplitModal({ isOpen, onClose }: DynamicSplitModalProps) {
  const clipId = useDAWStore((s) => s.dynamicSplitClipId);
  const tracks = useDAWStore((s) => s.tracks);
  const executeDynamicSplit = useDAWStore((s) => s.executeDynamicSplit);

  const [sensitivity, setSensitivity] = useState(0.5);
  const [minGapMs, setMinGapMs] = useState(100);
  const [transients, setTransients] = useState<number[]>([]);
  const [analyzing, setAnalyzing] = useState(false);

  // Find the clip
  let clipName = "";
  let clipFilePath = "";
  if (clipId) {
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) {
        clipName = clip.name;
        clipFilePath = clip.filePath;
        break;
      }
    }
  }

  const handleDetect = useCallback(async () => {
    if (!clipFilePath) return;
    setAnalyzing(true);
    try {
      const result = await nativeBridge.detectTransients(clipFilePath, sensitivity, minGapMs);
      setTransients(result);
    } catch {
      setTransients([]);
    }
    setAnalyzing(false);
  }, [clipFilePath, sensitivity, minGapMs]);

  const handleSplit = () => {
    if (clipId && transients.length > 0) {
      executeDynamicSplit(clipId, transients);
    }
  };

  if (!isOpen || !clipId) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Dynamic Split (Transient Detection)">
      <div className="space-y-4 min-w-[400px]">
        <div className="text-sm text-daw-text-muted">
          Clip: <span className="text-daw-text">{clipName || "Unknown"}</span>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-daw-text-muted">
            Sensitivity: {sensitivity.toFixed(2)}
          </label>
          <Slider
            min={0.1}
            max={1.0}
            step={0.05}
            value={sensitivity}
            onChange={(v) => setSensitivity(v as number)}
          />
          <div className="flex justify-between text-[10px] text-daw-text-muted">
            <span>More splits</span>
            <span>Fewer splits</span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-daw-text-muted">
            Min Gap: {minGapMs}ms
          </label>
          <Slider
            min={10}
            max={500}
            step={10}
            value={minGapMs}
            onChange={(v) => setMinGapMs(v as number)}
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={handleDetect}
            disabled={analyzing || !clipFilePath}
          >
            {analyzing ? "Analyzing..." : "Detect Transients"}
          </Button>
          {transients.length > 0 && (
            <span className="text-xs text-daw-text-muted self-center">
              {transients.length} transient{transients.length !== 1 ? "s" : ""} found
            </span>
          )}
        </div>

        {transients.length > 0 && (
          <div className="max-h-32 overflow-y-auto bg-daw-darker rounded p-2 text-xs text-daw-text-muted">
            {transients.map((t, i) => (
              <span key={i} className="inline-block mr-2 mb-1 bg-daw-panel px-1.5 py-0.5 rounded">
                {t.toFixed(3)}s
              </span>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-daw-border">
          <Button variant="default" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSplit}
            disabled={transients.length === 0}
          >
            Split at {transients.length} Point{transients.length !== 1 ? "s" : ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
