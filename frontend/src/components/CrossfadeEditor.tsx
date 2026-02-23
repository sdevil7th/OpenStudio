import { useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { Modal, Button, Select } from "./ui";
import { Slider } from "./ui";

const FADE_SHAPES = [
  { value: 0, label: "Linear" },
  { value: 1, label: "Equal Power" },
  { value: 2, label: "S-Curve" },
  { value: 3, label: "Logarithmic" },
  { value: 4, label: "Exponential" },
];

// Generate curve preview points
function getCurvePoints(shapeType: number, numPoints: number = 50): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    let y: number;
    switch (shapeType) {
      case 1: y = Math.sqrt(t); break;
      case 2: y = 3 * t * t - 2 * t * t * t; break;
      case 3: y = Math.log10(1 + 9 * t); break;
      case 4: y = (Math.exp(3 * t) - 1) / (Math.exp(3) - 1); break;
      default: y = t; break;
    }
    points.push({ x: t, y });
  }
  return points;
}

interface CrossfadeEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CrossfadeEditor({ isOpen, onClose }: CrossfadeEditorProps) {
  const crossfadeEditorClipIds = useDAWStore((s) => s.crossfadeEditorClipIds);

  // Find the two clips
  const clip1 = crossfadeEditorClipIds
    ? useDAWStore.getState().tracks.flatMap((t) => t.clips).find((c) => c.id === crossfadeEditorClipIds[0])
    : null;
  const clip2 = crossfadeEditorClipIds
    ? useDAWStore.getState().tracks.flatMap((t) => t.clips).find((c) => c.id === crossfadeEditorClipIds[1])
    : null;

  const [fadeInShape, setFadeInShape] = useState(clip2?.fadeInShape ?? 0);
  const [fadeOutShape, setFadeOutShape] = useState(clip1?.fadeOutShape ?? 0);
  const [fadeLength, setFadeLength] = useState(() => {
    if (clip1 && clip2) {
      // Calculate overlap region
      const overlapStart = Math.max(clip1.startTime, clip2.startTime);
      const overlapEnd = Math.min(clip1.startTime + clip1.duration, clip2.startTime + clip2.duration);
      return Math.max(0, overlapEnd - overlapStart);
    }
    return 0.5;
  });

  const handleApply = () => {
    if (!crossfadeEditorClipIds) return;
    const store = useDAWStore.getState();
    const [id1, id2] = crossfadeEditorClipIds;

    // Set fade out shape on clip1, fade in shape on clip2
    store.setClipFadeOutShape(id1, fadeOutShape);
    store.setClipFadeInShape(id2, fadeInShape);

    // Set fade lengths
    store.setClipFades(id1, clip1?.fadeIn ?? 0, fadeLength);
    store.setClipFades(id2, fadeLength, clip2?.fadeOut ?? 0);

    onClose();
  };

  const fadeInPoints = getCurvePoints(fadeInShape);
  const fadeOutPoints = getCurvePoints(fadeOutShape);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Crossfade Editor">
      <div className="w-[450px] flex flex-col gap-4">
        {/* Crossfade visualization */}
        <div className="relative h-[120px] bg-neutral-900 rounded border border-neutral-700 overflow-hidden">
          {/* Fade Out curve (clip 1) */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <path
              d={`M 0 0 ${fadeOutPoints.map((p) => `L ${p.x * 100} ${(1 - p.y) * 100}`).join(" ")} L 100 100 L 0 100 Z`}
              fill="rgba(239, 68, 68, 0.3)"
              stroke="rgb(239, 68, 68)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Fade In curve (clip 2) */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <path
              d={`M 0 100 ${fadeInPoints.map((p) => `L ${p.x * 100} ${(1 - p.y) * 100}`).join(" ")} L 100 0 L 100 100 Z`}
              fill="rgba(59, 130, 246, 0.3)"
              stroke="rgb(59, 130, 246)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Labels */}
          <span className="absolute top-1 left-2 text-[8px] text-red-400">
            {clip1?.name || "Clip 1"} (fade out)
          </span>
          <span className="absolute top-1 right-2 text-[8px] text-blue-400">
            {clip2?.name || "Clip 2"} (fade in)
          </span>
        </div>

        {/* Shape selectors */}
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Fade Out Shape"
            size="sm"
            fullWidth
            value={fadeOutShape}
            onChange={(val) => setFadeOutShape(Number(val))}
            options={FADE_SHAPES}
          />
          <Select
            label="Fade In Shape"
            size="sm"
            fullWidth
            value={fadeInShape}
            onChange={(val) => setFadeInShape(Number(val))}
            options={FADE_SHAPES}
          />
        </div>

        {/* Crossfade length */}
        <div>
          <label className="text-[9px] text-neutral-400 block mb-1">
            Crossfade Length: {fadeLength.toFixed(3)}s
          </label>
          <Slider
            orientation="horizontal"
            min={0}
            max={5}
            step={0.01}
            value={fadeLength}
            onChange={(val) => setFadeLength(val)}
            defaultValue={0.5}
            className="w-full"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-neutral-700">
          <Button variant="default" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleApply}>
            Apply
          </Button>
        </div>
      </div>
    </Modal>
  );
}
