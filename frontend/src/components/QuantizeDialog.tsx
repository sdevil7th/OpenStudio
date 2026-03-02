import { useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { commandManager } from "../store/commands";
import {
  Button,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
  Select,
  Slider,
} from "./ui";

interface QuantizeDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const GRID_OPTIONS = [
  { value: "1/1", label: "Whole Note" },
  { value: "1/2", label: "Half Note" },
  { value: "1/4", label: "Quarter Note" },
  { value: "1/8", label: "8th Note" },
  { value: "1/16", label: "16th Note" },
  { value: "1/32", label: "32nd Note" },
  { value: "1/4T", label: "Quarter Triplet" },
  { value: "1/8T", label: "8th Triplet" },
  { value: "1/16T", label: "16th Triplet" },
];

/**
 * QuantizeDialog (Sprint 19.3)
 * Provides grid-based quantization for selected MIDI notes
 * with configurable strength, swing, and humanize parameters.
 */
export function QuantizeDialog({ isOpen, onClose }: QuantizeDialogProps) {
  const { selectedNoteIds, pianoRollClipId } = useDAWStore(
    useShallow((s) => ({
      selectedNoteIds: s.selectedNoteIds,
      pianoRollClipId: s.pianoRollClipId,
    })),
  );

  const [gridSize, setGridSize] = useState("1/8");
  const [strength, setStrength] = useState(100);
  const [swing, setSwing] = useState(0);
  const [humanize, setHumanize] = useState(0);

  const handleApply = () => {
    const store = useDAWStore.getState();
    if (!pianoRollClipId || selectedNoteIds.length === 0) return;

    // Find the clip
    const clip = store.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === pianoRollClipId);
    if (!clip || (clip as any).type !== "midi") return;

    const tempo = store.transport.tempo;
    const beatDuration = 60 / tempo;

    // Parse grid size to beat fraction
    let gridBeats = 0.5; // default 1/8
    const triplet = gridSize.endsWith("T");
    const base = triplet ? gridSize.slice(0, -1) : gridSize;
    const parts = base.split("/");
    if (parts.length === 2) {
      gridBeats = (4 * parseInt(parts[0])) / parseInt(parts[1]);
    }
    if (triplet) gridBeats = (gridBeats * 2) / 3;

    const gridSeconds = gridBeats * beatDuration;
    const strengthFactor = strength / 100;

    // Quantize each selected note
    const midiClip = clip as any;
    if (!midiClip.notes) return;

    const oldNotes = midiClip.notes.map((n: any) => ({ ...n }));

    const updatedNotes = midiClip.notes.map((note: any) => {
      if (!selectedNoteIds.includes(note.id)) return note;

      const relativeTime = note.time - clip.startTime;
      const nearestGrid = Math.round(relativeTime / gridSeconds) * gridSeconds;

      // Apply swing (offset even grid positions)
      let target = nearestGrid;
      if (swing !== 0) {
        const gridIndex = Math.round(relativeTime / gridSeconds);
        if (gridIndex % 2 === 1) {
          target += (swing / 100) * gridSeconds * 0.5;
        }
      }

      // Apply strength (interpolate between original and quantized)
      let newTime = clip.startTime + relativeTime + (target - relativeTime) * strengthFactor;

      // Apply humanize (random offset)
      if (humanize > 0) {
        const maxOffset = (humanize / 100) * gridSeconds * 0.25;
        newTime += (Math.random() * 2 - 1) * maxOffset;
      }

      return { ...note, time: Math.max(clip.startTime, newTime) };
    });

    // Apply changes through store
    store.updateMIDINotes(pianoRollClipId, updatedNotes);

    // Push undo command
    commandManager.push({
      type: "quantize_notes",
      description: `Quantize ${selectedNoteIds.length} notes to ${gridSize}`,
      timestamp: Date.now(),
      execute: () => store.updateMIDINotes(pianoRollClipId, updatedNotes),
      undo: () => store.updateMIDINotes(pianoRollClipId, oldNotes),
    });

    onClose();
  };

  const noteCount = selectedNoteIds.length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader title="Quantize Notes" onClose={onClose} />
      <ModalContent>
        <div className="flex flex-col gap-4">
          <p className="text-xs text-daw-text-muted">
            {noteCount} note{noteCount !== 1 ? "s" : ""} selected
          </p>

          {/* Grid Size */}
          <div>
            <label className="text-xs text-daw-text-muted mb-1 block">
              Grid Size
            </label>
            <Select
              value={gridSize}
              onChange={(v) => setGridSize(v as string)}
              options={GRID_OPTIONS}
            />
          </div>

          {/* Strength */}
          <div>
            <label className="text-xs text-daw-text-muted mb-1 block">
              Strength: {strength}%
            </label>
            <Slider
              value={strength}
              min={0}
              max={100}
              onChange={(v) => setStrength(v)}
            />
          </div>

          {/* Swing */}
          <div>
            <label className="text-xs text-daw-text-muted mb-1 block">
              Swing: {swing}%
            </label>
            <Slider
              value={swing}
              min={-100}
              max={100}
              onChange={(v) => setSwing(v)}
            />
          </div>

          {/* Humanize */}
          <div>
            <label className="text-xs text-daw-text-muted mb-1 block">
              Humanize: {humanize}ms
            </label>
            <Slider
              value={humanize}
              min={0}
              max={50}
              onChange={(v) => setHumanize(v)}
            />
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="default" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleApply}
          disabled={noteCount === 0}
        >
          Apply
        </Button>
      </ModalFooter>
    </Modal>
  );
}
