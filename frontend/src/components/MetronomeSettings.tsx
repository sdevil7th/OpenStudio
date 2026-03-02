import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import classNames from "classnames";
import { Button, TimeSignatureInput, Slider } from "./ui";

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
    metronomeVolume,
    setMetronomeVolume,
    metronomeTrackId,
    generateMetronomeTrack,
    removeMetronomeTrack,
    metronomeClickPath,
    metronomeAccentPath,
  } = useDAWStore(useShallow((s) => ({
    timeSignature: s.timeSignature,
    setTimeSignature: s.setTimeSignature,
    metronomeAccentBeats: s.metronomeAccentBeats,
    setMetronomeAccentBeats: s.setMetronomeAccentBeats,
    metronomeEnabled: s.metronomeEnabled,
    toggleMetronome: s.toggleMetronome,
    metronomeVolume: s.metronomeVolume,
    setMetronomeVolume: s.setMetronomeVolume,
    metronomeTrackId: s.metronomeTrackId,
    generateMetronomeTrack: s.generateMetronomeTrack,
    removeMetronomeTrack: s.removeMetronomeTrack,
    metronomeClickPath: s.metronomeClickPath,
    metronomeAccentPath: s.metronomeAccentPath,
  })));

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

  return createPortal(
    <div className="fixed inset-0 z-2000 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-4 min-w-[320px]">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">
            Metronome Settings
          </h3>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
          >
            <X size={16} />
          </Button>
        </div>

        {/* Enable/Disable */}
        <div className="flex items-center gap-3 mb-4 pb-3 border-b border-neutral-700">
          <Button
            variant="warning"
            size="sm"
            active={metronomeEnabled}
            onClick={() => toggleMetronome()}
          >
            {metronomeEnabled ? "Enabled" : "Disabled"}
          </Button>
        </div>

        {/* Volume Control */}
        <div className="mb-4 pb-3 border-b border-neutral-700">
          <div className="text-xs text-neutral-400 mb-2">Volume</div>
          <div className="flex items-center gap-3">
            <Slider
              orientation="horizontal"
              variant="default"
              min={0}
              max={100}
              step={1}
              value={Math.round(metronomeVolume * 100)}
              onChange={(val) => setMetronomeVolume(val / 100)}
              width="180px"
            />
            <span className="text-neutral-300 text-xs w-8 text-right">
              {Math.round(metronomeVolume * 100)}%
            </span>
          </div>
        </div>

        {/* Time Signature Section */}
        <div className="mb-4 pb-3 border-b border-neutral-700">
          <div className="text-xs text-neutral-400 mb-2">Time Signature</div>
          <div className="flex items-center gap-3">
            <TimeSignatureInput
              numerator={timeSignature.numerator}
              denominator={timeSignature.denominator}
              onChange={setTimeSignature}
              size="md"
            />
            <span className="text-neutral-500 text-xs">
              (Beats per bar / Note value)
            </span>
          </div>
        </div>

        {/* Accent Beats */}
        <div className="mb-4 pb-3 border-b border-neutral-700">
          <div className="text-xs text-neutral-400 mb-2">
            Click beats to toggle accent (beat 1 is always accented)
          </div>
          <div className="flex gap-2 flex-wrap">
            {Array.from({ length: timeSignature.numerator }).map((_, i) => (
              <Button
                key={i}
                variant="warning"
                size="md"
                onClick={() => handleBeatClick(i)}
                disabled={i === 0}
                active={i === 0 || metronomeAccentBeats[i]}
                className={classNames("w-10 h-10 rounded-lg", {
                  "cursor-default": i === 0,
                  "!bg-yellow-500/70": i !== 0 && metronomeAccentBeats[i],
                  "!bg-neutral-700 !text-neutral-300 hover:!bg-neutral-600 !border-neutral-600":
                    i !== 0 && !metronomeAccentBeats[i],
                })}
              >
                {i + 1}
              </Button>
            ))}
          </div>
        </div>

        {/* Metronome Track */}
        <div className="mb-4 pb-3 border-b border-neutral-700">
          <div className="text-xs text-neutral-400 mb-2">
            Render as Track (for export)
          </div>
          <div className="flex gap-2">
            {metronomeTrackId ? (
              <>
                <Button
                  variant="warning"
                  size="sm"
                  onClick={() => generateMetronomeTrack()}
                  fullWidth
                >
                  Regenerate Track
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => removeMetronomeTrack()}
                  fullWidth
                >
                  Remove Track
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => generateMetronomeTrack()}
                fullWidth
              >
                Add as Track
              </Button>
            )}
          </div>
          {metronomeTrackId && (
            <p className="text-[10px] text-neutral-500 mt-1">
              Track auto-regenerates when metronome settings change.
            </p>
          )}
        </div>

        {/* Custom Click Sounds (Phase 9C) */}
        <div className="mb-4 pb-3 border-b border-neutral-700">
          <div className="text-xs text-neutral-400 mb-2">Click Sounds</div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-14">Click:</span>
              <span className="text-xs text-neutral-300 flex-1 truncate">
                {metronomeClickPath ? metronomeClickPath.split(/[/\\]/).pop() : "Default (Synth)"}
              </span>
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  void useDAWStore.getState().setMetronomeClickSound("");
                }}
              >
                {metronomeClickPath ? "Reset" : "Custom..."}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400 w-14">Accent:</span>
              <span className="text-xs text-neutral-300 flex-1 truncate">
                {metronomeAccentPath ? metronomeAccentPath.split(/[/\\]/).pop() : "Default (Synth)"}
              </span>
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  void useDAWStore.getState().setMetronomeAccentSound("");
                }}
              >
                {metronomeAccentPath ? "Reset" : "Custom..."}
              </Button>
            </div>
            {(metronomeClickPath || metronomeAccentPath) && (
              <Button
                variant="default"
                size="sm"
                onClick={() => { void useDAWStore.getState().resetMetronomeSounds(); }}
                fullWidth
              >
                Reset All to Default
              </Button>
            )}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={handleReset}
            fullWidth
          >
            Reset
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleAccentAll}
            fullWidth
          >
            Accent All
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
