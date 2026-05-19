import { SlidersHorizontal } from "lucide-react";

interface PianoRollInspectorSummaryProps {
  readonly trackName: string;
  readonly clipName: string;
  readonly noteCount: number;
  readonly selectedCount: number;
}

export function PianoRollInspectorSummary({
  trackName,
  clipName,
  noteCount,
  selectedCount,
}: PianoRollInspectorSummaryProps) {
  return (
    <section className="piano-roll-inspector-section">
      <div className="piano-roll-section-title">
        <span className="piano-roll-panel-title">
          <SlidersHorizontal size={13} strokeWidth={2} />
          Inspector
        </span>
      </div>
      <div className="piano-roll-info-grid">
        <span>Track</span>
        <strong>{trackName || "MIDI Track"}</strong>
        <span>Clip</span>
        <strong>{clipName || "MIDI Clip"}</strong>
        <span>Notes</span>
        <strong>{noteCount}</strong>
        <span>Selection</span>
        <strong>{selectedCount || "None"}</strong>
      </div>
    </section>
  );
}
