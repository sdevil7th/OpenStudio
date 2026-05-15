import { Activity, ChevronDown, Copy, SlidersHorizontal, Trash2, Wand2 } from "lucide-react";
import { CC_PRESETS, POLY_PRESSURE_LANE } from "../utils/pianoRollLanes";

interface PianoRollLaneEditorSectionProps {
  readonly selectedCC: number;
  readonly isCC14BitMode: boolean;
  readonly polyPressureNote: number;
  readonly transformsDisabled: boolean;
  readonly canPaste: boolean;
  readonly onSelectedCCChange: (cc: number) => void;
  readonly onCC14BitModeChange: (enabled: boolean) => void;
  readonly onPolyPressureNoteChange: (note: number) => void;
  readonly onOpenLine: () => void;
  readonly onOpenLFO: () => void;
  readonly onOpenTransform: () => void;
  readonly onOpenThin: () => void;
  readonly onCopy: () => void;
  readonly onPaste: () => void;
  readonly onClear: () => void;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function PianoRollLaneEditorSection({
  selectedCC,
  isCC14BitMode,
  polyPressureNote,
  transformsDisabled,
  canPaste,
  onSelectedCCChange,
  onCC14BitModeChange,
  onPolyPressureNoteChange,
  onOpenLine,
  onOpenLFO,
  onOpenTransform,
  onOpenThin,
  onCopy,
  onPaste,
  onClear,
}: PianoRollLaneEditorSectionProps) {
  const updateSelectedCC = (nextCC: number) => {
    onSelectedCCChange(nextCC);
    if (nextCC < 0 || nextCC > 31) onCC14BitModeChange(false);
  };

  return (
    <section className="piano-roll-inspector-section">
      <div className="piano-roll-section-title">
        <span className="piano-roll-panel-title">
          <SlidersHorizontal size={13} strokeWidth={2} />
          Lane Editor
        </span>
      </div>
      <div className="piano-roll-field-grid">
        <label htmlFor="pr-ins-controller">Lane</label>
        <select id="pr-ins-controller" value={selectedCC} onChange={(event) => updateSelectedCC(Number.parseInt(event.target.value, 10))}>
          {CC_PRESETS.map((preset) => (
            <option key={preset.cc} value={preset.cc}>{preset.name}</option>
          ))}
          {!CC_PRESETS.some((preset) => preset.cc === selectedCC) && (
            <option value={selectedCC}>CC#{selectedCC}</option>
          )}
        </select>
        {selectedCC >= 0 && (
          <>
            <label htmlFor="pr-ins-cc-number">CC</label>
            <input id="pr-ins-cc-number" type="number" min={0} max={127} value={selectedCC} onChange={(event) => updateSelectedCC(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 127))} />
            <label htmlFor="pr-ins-cc14">14-bit</label>
            <input id="pr-ins-cc14" type="checkbox" checked={isCC14BitMode} disabled={selectedCC < 0 || selectedCC > 31} onChange={(event) => onCC14BitModeChange(event.target.checked)} />
          </>
        )}
        {selectedCC === POLY_PRESSURE_LANE && (
          <>
            <label htmlFor="pr-ins-poly-note">Poly Note</label>
            <input id="pr-ins-poly-note" type="number" min={0} max={127} value={polyPressureNote} onChange={(event) => onPolyPressureNoteChange(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 127))} />
          </>
        )}
      </div>
      <div className="piano-roll-command-grid">
        <button type="button" onClick={onOpenLine}><Wand2 size={12} /> Line</button>
        <button type="button" onClick={onOpenLFO} disabled={transformsDisabled}><Activity size={12} /> LFO</button>
        <button type="button" onClick={onOpenTransform} disabled={transformsDisabled}><SlidersHorizontal size={12} /> Transform</button>
        <button type="button" onClick={onOpenThin} disabled={transformsDisabled}><ChevronDown size={12} /> Thin</button>
        <button type="button" onClick={onCopy}><Copy size={12} /> Copy</button>
        <button type="button" onClick={onPaste} disabled={!canPaste}><Copy size={12} /> Paste</button>
        <button type="button" onClick={onClear}><Trash2 size={12} /> Clear</button>
      </div>
    </section>
  );
}
