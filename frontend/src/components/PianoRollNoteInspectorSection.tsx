import { Music } from "lucide-react";
import type { MIDINotePair } from "../utils/midiNotes";

type NoteEditField = "note" | "start" | "duration";
type NoteMetadataField = "channel" | "releaseVelocity" | "chance" | "playCount" | "velocityVariance" | "centOffset";
type InspectorValue = string | number;

interface PianoRollNoteInspectorSectionProps {
  readonly selectedCount: number;
  readonly inspectedNotePair: MIDINotePair | null;
  readonly snapDuration: number;
  readonly selectedVelocityValue: InspectorValue;
  readonly selectedReleaseVelocityValue: InspectorValue;
  readonly selectedChannelValue: InspectorValue;
  readonly selectedChanceValue: InspectorValue;
  readonly selectedVarianceValue: InspectorValue;
  readonly selectedPlayCountValue: InspectorValue;
  readonly selectedCentOffsetValue: InspectorValue;
  readonly onEditInspectedNote: (field: NoteEditField, value: number) => void;
  readonly onSelectedVelocityChange: (value: number) => void;
  readonly onEditInspectedNoteMetadata: (field: NoteMetadataField, value: number) => void;
}

export function PianoRollNoteInspectorSection({
  selectedCount,
  inspectedNotePair,
  snapDuration,
  selectedVelocityValue,
  selectedReleaseVelocityValue,
  selectedChannelValue,
  selectedChanceValue,
  selectedVarianceValue,
  selectedPlayCountValue,
  selectedCentOffsetValue,
  onEditInspectedNote,
  onSelectedVelocityChange,
  onEditInspectedNoteMetadata,
}: PianoRollNoteInspectorSectionProps) {
  return (
    <section className="piano-roll-inspector-section">
      <div className="piano-roll-section-title">
        <span className="piano-roll-panel-title">
          <Music size={13} strokeWidth={2} />
          Note Selection
        </span>
      </div>
      {selectedCount === 0 ? (
        <div className="piano-roll-inspector-empty">Select notes to edit pitch, timing, velocity, channel, chance, and note metadata.</div>
      ) : (
        <div className="piano-roll-field-grid">
          {inspectedNotePair && (
            <>
              <label htmlFor="pr-ins-note-pitch">Pitch</label>
              <input id="pr-ins-note-pitch" type="number" min={0} max={127} value={inspectedNotePair.noteNumber} onChange={(event) => onEditInspectedNote("note", Number(event.target.value))} />
              <label htmlFor="pr-ins-note-start">Start</label>
              <input id="pr-ins-note-start" type="number" min={0} step={snapDuration} value={Number(inspectedNotePair.startTime.toFixed(3))} onChange={(event) => onEditInspectedNote("start", Number(event.target.value))} />
              <label htmlFor="pr-ins-note-length">Length</label>
              <input id="pr-ins-note-length" type="number" min={0.01} step={snapDuration} value={Number(inspectedNotePair.duration.toFixed(3))} onChange={(event) => onEditInspectedNote("duration", Number(event.target.value))} />
            </>
          )}
          <label htmlFor="pr-ins-note-velocity">Velocity</label>
          <input id="pr-ins-note-velocity" type="number" min={1} max={127} placeholder="mixed" value={selectedVelocityValue} onChange={(event) => onSelectedVelocityChange(Number(event.target.value))} />
          <label htmlFor="pr-ins-note-off">Note Off</label>
          <input id="pr-ins-note-off" type="number" min={0} max={127} placeholder="mixed" value={selectedReleaseVelocityValue} onChange={(event) => onEditInspectedNoteMetadata("releaseVelocity", Number(event.target.value))} />
          <label htmlFor="pr-ins-note-channel">Channel</label>
          <input id="pr-ins-note-channel" type="number" min={1} max={16} placeholder="mixed" value={selectedChannelValue} onChange={(event) => onEditInspectedNoteMetadata("channel", Number(event.target.value))} />
          <label htmlFor="pr-ins-note-chance">Chance</label>
          <input id="pr-ins-note-chance" type="number" min={0} max={100} placeholder="mixed" value={selectedChanceValue} onChange={(event) => onEditInspectedNoteMetadata("chance", Number(event.target.value))} />
          <label htmlFor="pr-ins-note-var">Variance</label>
          <input id="pr-ins-note-var" type="number" min={0} max={127} placeholder="mixed" value={selectedVarianceValue} onChange={(event) => onEditInspectedNoteMetadata("velocityVariance", Number(event.target.value))} />
          <label htmlFor="pr-ins-note-plays">Play Count</label>
          <input id="pr-ins-note-plays" type="number" min={0} max={64} placeholder="mixed" value={selectedPlayCountValue} onChange={(event) => onEditInspectedNoteMetadata("playCount", Number(event.target.value))} />
          <label htmlFor="pr-ins-note-cent">Cent</label>
          <input id="pr-ins-note-cent" type="number" min={-100} max={100} placeholder="mixed" value={selectedCentOffsetValue} onChange={(event) => onEditInspectedNoteMetadata("centOffset", Number(event.target.value))} />
        </div>
      )}
    </section>
  );
}
