import { useEffect, useId, useMemo, useState } from "react";
import { Slider } from "./ui";
import { type AIWorkflowParam } from "../data/aiWorkflows";

interface NumericWorkflowParamFieldProps {
  param: AIWorkflowParam;
  value: unknown;
  onChange: (value: number) => void;
  onBeginEdit?: () => void;
  onCommitEdit?: () => void;
  disabled?: boolean;
}

function getDecimalPlaces(step: number) {
  if (!Number.isFinite(step)) return 0;
  const text = String(step);
  if (!text.includes(".")) return 0;
  return text.split(".")[1]?.length ?? 0;
}

function quantizeToStep(value: number, min: number, step: number) {
  if (!Number.isFinite(step) || step <= 0) return value;
  const stepped = Math.round((value - min) / step) * step + min;
  const decimals = getDecimalPlaces(step);
  return Number(stepped.toFixed(Math.min(6, decimals + 1)));
}

function formatNumber(value: number, step: number) {
  const decimals = getDecimalPlaces(step);
  if (decimals <= 0) return String(Math.round(value));
  return value
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

export function NumericWorkflowParamField({
  param,
  value,
  onChange,
  onBeginEdit,
  onCommitEdit,
  disabled = false,
}: NumericWorkflowParamFieldProps) {
  const inputId = useId();
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  const step = param.step ?? 1;
  const numericValue = useMemo(() => {
    const parsed = typeof value === "number" ? value : Number(value ?? param.default ?? min);
    return Number.isFinite(parsed) ? parsed : Number(param.default ?? min);
  }, [min, param.default, value]);
  const [draft, setDraft] = useState(() => formatNumber(numericValue, step));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!isEditing) {
      setDraft(formatNumber(numericValue, step));
    }
  }, [isEditing, numericValue, step]);

  const commitDraft = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraft(formatNumber(numericValue, step));
      setIsEditing(false);
      return;
    }

    const nextValue = Math.max(min, Math.min(max, quantizeToStep(parsed, min, step)));
    setDraft(formatNumber(nextValue, step));
    setIsEditing(false);
    if (nextValue !== numericValue) {
      onChange(nextValue);
    }
  };

  const handleSliderChange = (nextValue: number) => {
    const normalized = Math.max(min, Math.min(max, quantizeToStep(nextValue, min, step)));
    setDraft(formatNumber(normalized, step));
    onChange(normalized);
  };

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label
          htmlFor={inputId}
          className="text-xs font-medium uppercase tracking-[0.12em] text-daw-text-muted"
        >
          {param.label}
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          value={draft}
          disabled={disabled}
          onFocus={() => setIsEditing(true)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setDraft(formatNumber(numericValue, step));
              setIsEditing(false);
              event.currentTarget.blur();
            }
          }}
          className="h-8 w-16 rounded border border-neutral-700 bg-neutral-900 px-2 text-right text-xs text-daw-text outline-none transition-colors focus:border-daw-accent disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`${param.label} value`}
        />
      </div>
      <Slider
        value={numericValue}
        min={min}
        max={max}
        step={step}
        onChange={handleSliderChange}
        onBeginEdit={onBeginEdit}
        onCommitEdit={onCommitEdit}
        disabled={disabled}
      />
      {param.description ? (
        <p className="mt-2 text-xs leading-5 text-daw-text-muted">{param.description}</p>
      ) : null}
    </div>
  );
}
