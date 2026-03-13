import React, { useState } from "react";
import { useShallow } from "zustand/shallow";
import { usePitchEditorStore } from "../store/pitchEditorStore";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function CorrectPitchModal() {
  const {
    showCorrectPitchModal, toggleCorrectPitchModal,
    applyCorrectPitchMacro, scaleKey, scaleType,
  } = usePitchEditorStore(
    useShallow((s) => ({
      showCorrectPitchModal: s.showCorrectPitchModal,
      toggleCorrectPitchModal: s.toggleCorrectPitchModal,
      applyCorrectPitchMacro: s.applyCorrectPitchMacro,
      scaleKey: s.scaleKey,
      scaleType: s.scaleType,
    }))
  );

  const [pitchCenter, setPitchCenter] = useState(72);
  const [pitchDrift, setPitchDrift] = useState(35);
  const [useScale, setUseScale] = useState(true);

  if (!showCorrectPitchModal) return null;

  const handleApply = () => {
    applyCorrectPitchMacro(pitchCenter / 100, pitchDrift / 100, useScale);
    toggleCorrectPitchModal();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-80 p-4">
        <h3 className="text-sm font-semibold text-neutral-200 mb-3">Correct Pitch</h3>

        {/* Pitch Center slider */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-neutral-400">Pitch Center</label>
            <span className="text-[10px] font-mono text-neutral-300">{pitchCenter}%</span>
          </div>
          <input
            type="range"
            min={0} max={100} value={pitchCenter}
            onChange={(e) => setPitchCenter(Number(e.target.value))}
            className="w-full h-1 bg-neutral-700 rounded-full appearance-none cursor-pointer accent-daw-accent"
          />
          <div className="flex justify-between text-[8px] text-neutral-600 mt-0.5">
            <span>Natural</span>
            <span>Corrected</span>
          </div>
        </div>

        {/* Pitch Drift slider */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-neutral-400">Pitch Drift</label>
            <span className="text-[10px] font-mono text-neutral-300">{pitchDrift}%</span>
          </div>
          <input
            type="range"
            min={0} max={100} value={pitchDrift}
            onChange={(e) => setPitchDrift(Number(e.target.value))}
            className="w-full h-1 bg-neutral-700 rounded-full appearance-none cursor-pointer accent-daw-accent"
          />
          <div className="flex justify-between text-[8px] text-neutral-600 mt-0.5">
            <span>Original</span>
            <span>Straight</span>
          </div>
        </div>

        {/* Use scale checkbox */}
        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={useScale}
            onChange={(e) => setUseScale(e.target.checked)}
            className="accent-daw-accent"
          />
          <span className="text-[10px] text-neutral-300">
            Use scale: {NOTE_NAMES[scaleKey]} {scaleType.replace(/_/g, " ")}
          </span>
        </label>

        {/* Buttons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={toggleCorrectPitchModal}
            className="px-3 py-1.5 text-[11px] rounded bg-neutral-800 text-neutral-400 hover:bg-neutral-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            className="px-3 py-1.5 text-[11px] rounded bg-daw-accent text-white hover:bg-daw-accent/80 font-semibold transition-colors"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
