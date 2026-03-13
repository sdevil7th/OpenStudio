import React, { useCallback } from "react";
import { useShallow } from "zustand/shallow";
import { usePitchEditorStore } from "../store/pitchEditorStore";
import type { PitchNoteData } from "../services/NativeBridge";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function formatNoteName(midi: number): string {
  const noteClass = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  const cents = Math.round((midi - Math.round(midi)) * 100);
  return `${NOTE_NAMES[noteClass]}${octave}${cents !== 0 ? ` ${cents > 0 ? "+" : ""}${cents}c` : ""}`;
}

interface InspectorRowProps {
  label: string;
  value: string;
  suffix?: string;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

function InspectorRow({ label, value, suffix = "", onChange, min = -999, max = 999, step = 0.1, disabled }: InspectorRowProps) {
  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
  }, [onChange, min, max]);

  return (
    <div className="flex items-center justify-between gap-1 h-5">
      <span className="text-[9px] text-neutral-500 shrink-0 w-14">{label}</span>
      <div className="flex items-center gap-0.5 flex-1 justify-end">
        <input
          type="number"
          value={value}
          onChange={handleInput}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          className="w-14 text-right text-[10px] font-mono bg-neutral-800 text-neutral-200 border border-neutral-700 rounded px-1 py-0 h-4 focus:border-daw-accent focus:outline-none disabled:opacity-30"
        />
        {suffix && <span className="text-[8px] text-neutral-600 w-4">{suffix}</span>}
      </div>
    </div>
  );
}

export function NoteInspector() {
  const {
    selectedNoteIds, notes, inspectorExpanded, toggleInspector,
    setNoteFormant, setNoteGain, setNoteModulation, setNoteDrift, setNoteTransition,
    updateNote, commitNoteEdit, pushUndo,
  } = usePitchEditorStore(
    useShallow((s) => ({
      selectedNoteIds: s.selectedNoteIds,
      notes: s.notes,
      inspectorExpanded: s.inspectorExpanded,
      toggleInspector: s.toggleInspector,
      setNoteFormant: s.setNoteFormant,
      setNoteGain: s.setNoteGain,
      setNoteModulation: s.setNoteModulation,
      setNoteDrift: s.setNoteDrift,
      setNoteTransition: s.setNoteTransition,
      updateNote: s.updateNote,
      commitNoteEdit: s.commitNoteEdit,
      pushUndo: s.pushUndo,
    }))
  );

  const selectedNotes = notes.filter(n => selectedNoteIds.includes(n.id));
  const note: PitchNoteData | null = selectedNotes.length === 1 ? selectedNotes[0] : null;
  const multi = selectedNotes.length > 1;
  const hasSelection = selectedNotes.length > 0;

  if (!hasSelection) return null;

  const pitchDisplay = note ? formatNoteName(note.correctedPitch) : "\u2014";
  const centsDisplay = note ? `${Math.round((note.correctedPitch - Math.round(note.correctedPitch)) * 100)}` : "\u2014";
  const formantDisplay = note ? note.formantShift.toFixed(1) : "\u2014";
  const gainDisplay = note ? note.gain.toFixed(1) : "\u2014";
  const modulationDisplay = note ? Math.round(note.vibratoDepth * 100).toString() : "\u2014";
  const driftDisplay = note ? Math.round(note.driftCorrectionAmount * 100).toString() : "\u2014";
  const transInDisplay = note ? Math.round(note.transitionIn).toString() : "\u2014";
  const transOutDisplay = note ? Math.round(note.transitionOut).toString() : "\u2014";

  return (
    <div className="border-b border-neutral-800/60 shrink-0">
      <button
        onClick={toggleInspector}
        className="w-full flex items-center px-2 py-1 text-[9px] text-neutral-500 uppercase tracking-wider hover:text-neutral-300 transition-colors"
      >
        <span className={`mr-1 transition-transform ${inspectorExpanded ? "rotate-90" : ""}`}>&#9654;</span>
        Inspector {multi ? `(${selectedNotes.length})` : ""}
      </button>

      {inspectorExpanded && (
        <div className="px-2 pb-2 flex flex-col gap-0.5">
          {/* Pitch */}
          <div className="flex items-center justify-between h-5">
            <span className="text-[9px] text-neutral-500 shrink-0 w-14">Pitch</span>
            <div className="flex items-center gap-1 flex-1 justify-end">
              <span className="text-[10px] font-mono text-neutral-200">{pitchDisplay}</span>
              {note && Math.abs(note.correctedPitch - note.detectedPitch) > 0.05 && (
                <span className="text-[9px] font-mono text-amber-500">
                  {(note.correctedPitch - note.detectedPitch) > 0 ? "+" : ""}
                  {(note.correctedPitch - note.detectedPitch).toFixed(1)}st
                </span>
              )}
            </div>
          </div>

          {/* Cents offset */}
          <InspectorRow
            label="Cents"
            value={centsDisplay}
            suffix="c"
            disabled={!note}
            min={-50} max={50} step={1}
            onChange={(v) => {
              if (!note) return;
              pushUndo("Change pitch cents");
              updateNote(note.id, { correctedPitch: Math.round(note.correctedPitch) + v / 100 });
              commitNoteEdit();
            }}
          />

          {/* Formant */}
          <InspectorRow
            label="Formant"
            value={formantDisplay}
            suffix="st"
            disabled={!note}
            min={-12} max={12} step={0.5}
            onChange={(v) => { if (note) setNoteFormant(note.id, v); }}
          />

          {/* Volume */}
          <InspectorRow
            label="Volume"
            value={gainDisplay}
            suffix="dB"
            disabled={!note}
            min={-24} max={24} step={0.5}
            onChange={(v) => { if (note) setNoteGain(note.id, v); }}
          />

          {/* Modulation (vibrato) */}
          <InspectorRow
            label="Modulation"
            value={modulationDisplay}
            suffix="%"
            disabled={!note}
            min={0} max={200} step={5}
            onChange={(v) => { if (note) setNoteModulation(note.id, v); }}
          />

          {/* Drift */}
          <InspectorRow
            label="Drift"
            value={driftDisplay}
            suffix="%"
            disabled={!note}
            min={0} max={100} step={5}
            onChange={(v) => { if (note) setNoteDrift(note.id, v); }}
          />

          {/* Transitions */}
          <InspectorRow
            label="Trans In"
            value={transInDisplay}
            suffix="ms"
            disabled={!note}
            min={0} max={200} step={5}
            onChange={(v) => { if (note) setNoteTransition(note.id, v, note.transitionOut); }}
          />
          <InspectorRow
            label="Trans Out"
            value={transOutDisplay}
            suffix="ms"
            disabled={!note}
            min={0} max={200} step={5}
            onChange={(v) => { if (note) setNoteTransition(note.id, note.transitionIn, v); }}
          />
        </div>
      )}
    </div>
  );
}
