import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { MetronomeControls } from "./MetronomeControls";
import { Button, Modal, TimeSignatureInput, Slider } from "./ui";

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
    practiceEnabled,
    practiceError,
    isPlaying,
    isRecording,
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
    practiceEnabled: s.metronomePracticeEnabled,
    practiceError: s.metronomePracticeError,
    isPlaying: s.transport.isPlaying,
    isRecording: s.transport.isRecording,
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

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Metronome Settings" size="sm" className="max-w-full">
        {/* Enable/Disable */}
        <div className="mb-4 space-y-2 border-b border-neutral-700 pb-3">
          <MetronomeControls />
          <p className="text-xs leading-relaxed text-neutral-400">
            Enable lights up whenever either metronome mode is on; switch it off to stop both.
            Click only keeps live monitoring on without playing clips or moving the playhead.
            It follows Play/Record, then continues when transport stops.
          </p>
          {practiceEnabled && (
            <p role="status" className="text-xs font-medium text-amber-300">
              {isRecording ? "Click following recording" : isPlaying ? "Click following playback" : "Click only · transport stopped"}
            </p>
          )}
          {practiceError && <p role="alert" className="text-xs text-red-300">{practiceError}</p>}
        </div>

        {/* Volume Control */}
        <div className="mb-4 pb-3 border-b border-neutral-700">
          <div className="text-xs text-neutral-400 mb-2">Volume</div>
          <div className="flex items-center gap-3">
            <Slider
              aria-label="Metronome volume"
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
                variant={i === 0 || metronomeAccentBeats[i] ? "warning" : "default"}
                size="md"
                onClick={() => handleBeatClick(i)}
                disabled={i === 0}
                active={i === 0 || metronomeAccentBeats[i]}
                className="h-10 w-10 rounded-lg"
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
              Track auto-regenerates when metronome settings change. This is a separate
              audio track: mute it during practice playback to avoid doubling the live click.
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
    </Modal>
  );
}
