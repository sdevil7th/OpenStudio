import { useId, useRef, useState } from "react";
import { formatMixerLevel, parseMixerLevel } from "../utils/mixerLevel";

interface MixerLevelInputProps {
  value: number;
  name: string;
  onBeginEdit: () => void;
  onChange: (value: number) => void;
  onCommitEdit: () => void;
}

/** Typing is a local draft; applying it produces one volume undo transaction. */
export function MixerLevelInput({ value, name, onBeginEdit, onChange, onCommitEdit }: MixerLevelInputProps) {
  const helpId = useId();
  const editing = useRef(false);
  const dirty = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const finish = (apply: boolean) => {
    if (!editing.current) return;
    const next = draft === null ? null : parseMixerLevel(draft);
    const wasEdited = dirty.current;
    editing.current = false;
    dirty.current = false;
    setDraft(null);
    setInvalid(false);
    if (apply && wasEdited && next !== null && Math.abs(next - value) > 0.000001) {
      onBeginEdit();
      onChange(next);
      onCommitEdit();
    }
  };

  return (
    <div className="flex min-h-6 items-center justify-center gap-0.5 px-0.5">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Volume in decibels for ${name}`}
        aria-describedby={helpId}
        aria-invalid={invalid || undefined}
        className="min-w-0 w-full max-w-16 rounded border border-transparent bg-transparent px-0.5 py-0.5 text-center font-mono text-[10px] text-inherit outline-none hover:border-neutral-600 focus:border-daw-accent focus:bg-neutral-950 focus-visible:ring-1 focus-visible:ring-daw-accent aria-invalid:border-red-400"
        value={draft ?? formatMixerLevel(value)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onFocus={(event) => {
          editing.current = true;
          dirty.current = false;
          setDraft(formatMixerLevel(value));
          event.currentTarget.select();
        }}
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
            event.currentTarget.blur();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (parseMixerLevel(draft ?? "") === null) {
              setInvalid(true);
              return;
            }
            finish(true);
            event.currentTarget.blur();
          }
        }}
      />
      <span aria-hidden="true" className="text-[9px]">dB</span>
      <span id={helpId} className="sr-only">
        Enter a level from -60 to +12 dB, or -inf for silence. Enter applies; Escape cancels.
      </span>
    </div>
  );
}
