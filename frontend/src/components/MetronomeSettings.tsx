import { useState, useEffect } from "react";
import { useDAWStore } from "../store/useDAWStore";
import classNames from "classnames";

interface MetronomeSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MetronomeSettings({ isOpen, onClose }: MetronomeSettingsProps) {
  const {
    timeSignature,
    setTimeSignature,
    metronomeAccentBeats,
    setMetronomeAccentBeats,
    metronomeEnabled,
    toggleMetronome,
  } = useDAWStore();

  // Local state for time signature inputs
  const [tempNumerator, setTempNumerator] = useState(
    timeSignature.numerator.toString(),
  );
  const [tempDenominator, setTempDenominator] = useState(
    timeSignature.denominator.toString(),
  );

  // Sync local state when store changes
  useEffect(() => {
    setTempNumerator(timeSignature.numerator.toString());
    setTempDenominator(timeSignature.denominator.toString());
  }, [timeSignature.numerator, timeSignature.denominator]);

  if (!isOpen) return null;

  const handleBeatClick = (index: number) => {
    const newAccents = [...metronomeAccentBeats];
    // Beat 1 (index 0) is always accented
    if (index === 0) return;
    newAccents[index] = !newAccents[index];
    setMetronomeAccentBeats(newAccents);
  };

  // Reset to default (only beat 1 accented)
  const handleReset = () => {
    const defaultAccents = Array(timeSignature.numerator).fill(false);
    defaultAccents[0] = true;
    setMetronomeAccentBeats(defaultAccents);
  };

  // Accent all beats
  const handleAccentAll = () => {
    setMetronomeAccentBeats(Array(timeSignature.numerator).fill(true));
  };

  // Time signature handlers
  const handleNumeratorBlur = () => {
    const val = parseInt(tempNumerator);
    if (isNaN(val) || val < 1 || val > 32) {
      setTempNumerator(timeSignature.numerator.toString());
    } else {
      setTimeSignature(val, timeSignature.denominator);
    }
  };

  const handleDenominatorBlur = () => {
    const val = parseInt(tempDenominator);
    const validDenominators = [1, 2, 4, 8, 16, 32];
    if (isNaN(val) || val < 1 || val > 32 || !validDenominators.includes(val)) {
      setTempDenominator(timeSignature.denominator.toString());
    } else {
      setTimeSignature(timeSignature.numerator, val);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-4 min-w-[320px]">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">
            Metronome Settings
          </h3>
          <button
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-neutral-400 hover:text-white hover:bg-red-700 rounded text-xs"
          >
            ×
          </button>
        </div>

        {/* Enable/Disable */}
        <div className="flex items-center gap-3 mb-4 pb-3 border-b border-neutral-700">
          <button
            onClick={() => toggleMetronome()}
            className={classNames(
              "px-3 py-1.5 rounded text-xs font-medium transition-colors",
              {
                "bg-yellow-600 text-white": metronomeEnabled,
                "bg-neutral-700 text-neutral-400 hover:bg-neutral-600":
                  !metronomeEnabled,
              },
            )}
          >
            {metronomeEnabled ? "Enabled" : "Disabled"}
          </button>
        </div>

        {/* Time Signature Section */}
        <div className="mb-4 pb-3 border-b border-neutral-700">
          <div className="text-xs text-neutral-400 mb-2">Time Signature</div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 bg-neutral-900 border border-neutral-600 rounded px-2 py-1">
              <input
                type="text"
                className="w-8 bg-transparent text-center text-white text-sm focus:outline-none"
                value={tempNumerator}
                onChange={(e) => setTempNumerator(e.target.value)}
                onBlur={handleNumeratorBlur}
                onKeyDown={handleKeyDown}
              />
              <span className="text-neutral-500 text-lg">/</span>
              <input
                type="text"
                className="w-8 bg-transparent text-center text-white text-sm focus:outline-none"
                value={tempDenominator}
                onChange={(e) => setTempDenominator(e.target.value)}
                onBlur={handleDenominatorBlur}
                onKeyDown={handleKeyDown}
              />
            </div>
            <span className="text-neutral-500 text-xs">
              (Beats per bar / Note value)
            </span>
          </div>
        </div>

        {/* Accent Beats */}
        <div className="mb-4">
          <div className="text-xs text-neutral-400 mb-2">
            Click beats to toggle accent (beat 1 is always accented)
          </div>
          <div className="flex gap-2 flex-wrap">
            {Array.from({ length: timeSignature.numerator }).map((_, i) => (
              <button
                key={i}
                onClick={() => handleBeatClick(i)}
                disabled={i === 0}
                className={classNames(
                  "w-10 h-10 rounded-lg text-sm font-bold transition-all",
                  "flex items-center justify-center",
                  {
                    // Beat 1 is always accented and highlighted
                    "bg-yellow-600 text-white cursor-default": i === 0,
                    // Other accented beats
                    "bg-yellow-500/70 text-white hover:bg-yellow-500":
                      i !== 0 && metronomeAccentBeats[i],
                    // Non-accented beats
                    "bg-neutral-700 text-neutral-300 hover:bg-neutral-600":
                      i !== 0 && !metronomeAccentBeats[i],
                  },
                )}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            className="flex-1 px-3 py-1.5 bg-neutral-700 text-neutral-300 rounded text-xs hover:bg-neutral-600 transition-colors"
          >
            Reset
          </button>
          <button
            onClick={handleAccentAll}
            className="flex-1 px-3 py-1.5 bg-neutral-700 text-neutral-300 rounded text-xs hover:bg-neutral-600 transition-colors"
          >
            Accent All
          </button>
        </div>
      </div>
    </div>
  );
}
