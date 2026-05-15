import { Activity } from "lucide-react";

interface PianoRollPitchBendSectionProps {
  readonly pitchBendRangeUp: number;
  readonly pitchBendRangeDown: number;
  readonly pitchBendRangeLinked: boolean;
  readonly snapPitchBendSemitones: boolean;
  readonly fallbackRangeSemitones: number;
  readonly onPitchBendRangeChange: (up: number, down: number, linked: boolean) => void;
  readonly onSnapPitchBendSemitonesChange: (enabled: boolean) => void;
}

function clampRange(value: number, fallback: number): number {
  return Math.max(1, Math.min(24, Number.isFinite(value) && value > 0 ? value : fallback));
}

export function PianoRollPitchBendSection({
  pitchBendRangeUp,
  pitchBendRangeDown,
  pitchBendRangeLinked,
  snapPitchBendSemitones,
  fallbackRangeSemitones,
  onPitchBendRangeChange,
  onSnapPitchBendSemitonesChange,
}: PianoRollPitchBendSectionProps) {
  return (
    <section className="piano-roll-inspector-section">
      <div className="piano-roll-section-title">
        <span className="piano-roll-panel-title">
          <Activity size={13} strokeWidth={2} />
          Pitch Bend
        </span>
      </div>
      <div className="piano-roll-field-grid">
        <label htmlFor="pr-ins-pb-up">Up</label>
        <input id="pr-ins-pb-up" type="number" min={1} max={24} value={pitchBendRangeUp} onChange={(event) => {
          const nextUp = clampRange(Number.parseInt(event.target.value, 10), fallbackRangeSemitones);
          onPitchBendRangeChange(nextUp, pitchBendRangeLinked ? nextUp : pitchBendRangeDown, pitchBendRangeLinked);
        }} />
        <label htmlFor="pr-ins-pb-down">Down</label>
        <input id="pr-ins-pb-down" type="number" min={1} max={24} disabled={pitchBendRangeLinked} value={pitchBendRangeDown} onChange={(event) => {
          const nextDown = clampRange(Number.parseInt(event.target.value, 10), fallbackRangeSemitones);
          onPitchBendRangeChange(pitchBendRangeUp, nextDown, false);
        }} />
        <label htmlFor="pr-ins-pb-link">Linked</label>
        <input id="pr-ins-pb-link" type="checkbox" checked={pitchBendRangeLinked} onChange={(event) => onPitchBendRangeChange(
          pitchBendRangeUp,
          event.target.checked ? pitchBendRangeUp : pitchBendRangeDown,
          event.target.checked,
        )} />
        <label htmlFor="pr-ins-pb-snap">Snap</label>
        <input id="pr-ins-pb-snap" type="checkbox" checked={snapPitchBendSemitones} onChange={(event) => onSnapPitchBendSemitonesChange(event.target.checked)} />
      </div>
    </section>
  );
}
