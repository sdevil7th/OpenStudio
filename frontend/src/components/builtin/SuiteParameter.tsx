import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import "./SuiteParameter.css";
import type { BuiltInParamDescriptor } from "../../services/NativeBridge";
import { clampNumber, formatParamValue, offsetParamValue } from "../../utils/builtInParamValue";
import { createSuiteParameterWheel, parseSuiteParameterDraft } from "../../utils/suiteParameterGesture";
import { beginEditTransaction, commitEditTransaction, createEditTransactionLifecycle } from "../ui/editTransactionLifecycle";

export type ParameterChange = (parameter: BuiltInParamDescriptor, value: number) => void;
type KnobStyle = CSSProperties & { "--suite-sweep": string; "--suite-rotation": string };

// Visual taper only. Persisted values and host automation remain in native units.
export function parameterPosition(p: BuiltInParamDescriptor, value: number) {
  const logarithmic = p.min > 0 && (p.unit === "Hz" || p.unit === "ms" || p.unit === "s" || /\.q$/.test(p.id));
  return clampNumber(logarithmic ? Math.log(Math.max(p.min, value) / p.min) / Math.log(p.max / p.min) : (value - p.min) / (p.max - p.min || 1), 0, 1);
}
export function parameterAtPosition(p: BuiltInParamDescriptor, position: number) {
  const logarithmic = p.min > 0 && (p.unit === "Hz" || p.unit === "ms" || p.unit === "s" || /\.q$/.test(p.id));
  const fraction = clampNumber(position, 0, 1);
  return logarithmic ? p.min * (p.max / p.min) ** fraction : p.min + fraction * (p.max - p.min);
}

export const SuiteParameter = memo(function SuiteParameter({ parameter: p, onChange, label, large = false, layout = "vertical", onGestureStart, onGestureEnd }: {
  parameter: BuiltInParamDescriptor; onChange: ParameterChange; label?: string; large?: boolean; layout?: "vertical" | "horizontal";
  onGestureStart?: (id: string) => void; onGestureEnd?: () => void;
}) {
  const name = label ?? p.label;
  const percent = p.type === "continuous" && p.min === 0 && p.max > 0 && p.max <= 1 && !p.unit;
  const factor = percent ? 100 : 1;
  const displayValue = Number((p.value * factor).toFixed(3));
  const unit = percent ? "%" : p.unit;
  const [draft, setDraft] = useState(String(displayValue));
  const editing = useRef(false);
  const cancelledDraft = useRef(false);
  const drag = useRef<{ y: number; position: number; before: number } | null>(null);
  const pointerEdit = useRef(createEditTransactionLifecycle());
  const current = useRef({ p, onChange, onGestureStart, onGestureEnd });
  current.current = { p, onChange, onGestureStart, onGestureEnd };
  const wheel = useRef<ReturnType<typeof createSuiteParameterWheel> | null>(null);
  useEffect(() => {
    const controller = createSuiteParameterWheel({
      parameter: () => current.current.p,
      change: next => { const state = current.current; current.current = { ...state, p: { ...state.p, value: next } }; state.onChange(state.p, next); },
      begin: () => current.current.onGestureStart?.(current.current.p.id),
      commit: () => current.current.onGestureEnd?.(),
    });
    wheel.current = controller;
    return () => { drag.current = null; commitEditTransaction(pointerEdit.current); controller.dispose(); if (wheel.current === controller) wheel.current = null; };
  }, [p.id]);
  useEffect(() => { if (!editing.current) setDraft(String(displayValue)); }, [displayValue]);
  const finishPointer = () => { drag.current = null; commitEditTransaction(pointerEdit.current); };
  const discreteChange = (next: number) => {
    wheel.current?.reset(); finishPointer();
    if (next === p.value) return;
    onGestureStart?.(p.id); onChange(p, next); onGestureEnd?.();
  };
  const commit = () => {
    editing.current = false;
    const next = cancelledDraft.current ? null : parseSuiteParameterDraft(draft, factor, p);
    cancelledDraft.current = false;
    if (next !== null) { setDraft(String(Number((next * factor).toFixed(3)))); discreteChange(next); }
    else setDraft(String(displayValue));
  };
  if (p.type === "enum") return <label data-param={p.id} className={`flex min-w-0 gap-2 text-xs text-daw-text ${layout === "horizontal" ? "flex-row items-center" : "flex-col"}`}>
    <span>{name}</span><select aria-label={name} className="suite-select" value={Math.round(p.value)} onChange={e => onChange(p, Number(e.currentTarget.value))}>
      {p.enumOptions?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>;
  if (p.type === "toggle") return <button data-param={p.id} type="button" className="suite-button" aria-pressed={p.value >= .5} onClick={() => onChange(p, p.value >= .5 ? 0 : 1)}>{name}<span className="text-xs opacity-75">{p.value >= .5 ? "On" : "Off"}</span></button>;
  if (p.type !== "continuous") return null;
  const style: KnobStyle = { "--suite-sweep": `${parameterPosition(p, p.value) * 270}deg`, "--suite-rotation": `${-135 + parameterPosition(p, p.value) * 270}deg` };
  return <div data-param={p.id} className="suite-parameter flex min-w-0 flex-col items-center gap-2" data-large={large}>
    <span className="max-w-32 text-center text-[13px] leading-tight text-daw-text">{name}</span>
    <div className="suite-knob" style={style} role="slider" tabIndex={0} aria-label={name} aria-valuemin={p.min} aria-valuemax={p.max} aria-valuenow={p.value} aria-valuetext={formatParamValue(p)} aria-orientation="vertical"
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); wheel.current?.reset(); e.currentTarget.focus(); beginEditTransaction(pointerEdit.current, () => onGestureStart?.(p.id), onGestureEnd); drag.current = { y: e.clientY, position: parameterPosition(p, p.value), before: p.value }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (drag.current) { const position = clampNumber(drag.current.position + (drag.current.y - e.clientY) / (e.shiftKey ? 1600 : 240), 0, 1); drag.current = { ...drag.current, y: e.clientY, position }; onChange(p, parameterAtPosition(p, position)); } }}
      onPointerUp={e => { finishPointer(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={finishPointer} onLostPointerCapture={finishPointer}
      onBlur={() => { finishPointer(); wheel.current?.reset(); }}
      onWheel={e => { const gesture = wheel.current?.wheel(e.nativeEvent); if (gesture?.preventDefault) e.preventDefault(); if (gesture?.stopPropagation) e.stopPropagation(); }}
      onDoubleClick={() => discreteChange(p.defaultValue)}
      onKeyDown={e => { if (e.key === "Escape" && drag.current) { e.preventDefault(); e.stopPropagation(); onChange(p, drag.current.before); finishPointer(); return; } const direction = ["ArrowUp", "ArrowRight", "PageUp"].includes(e.key) ? 1 : ["ArrowDown", "ArrowLeft", "PageDown"].includes(e.key) ? -1 : 0; if (!direction && !["Home", "End"].includes(e.key)) return; e.preventDefault(); discreteChange(clampNumber(e.key === "Home" ? p.min : e.key === "End" ? p.max : offsetParamValue(p, p.value, direction * (e.key.startsWith("Page") ? 20 : e.shiftKey ? 1 : 5)), p.min, p.max)); }} />
    <span className="flex items-baseline justify-center gap-1"><input className="suite-value" aria-label={`${name} value`} type="number" min={p.min * factor} max={p.max * factor} step="any" value={draft}
      onFocus={e => { editing.current = true; cancelledDraft.current = false; e.currentTarget.select(); }} onChange={e => setDraft(e.currentTarget.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } if (e.key === "Escape") { cancelledDraft.current = true; setDraft(String(displayValue)); editing.current = false; e.stopPropagation(); e.currentTarget.blur(); } }} /><span className="text-xs text-daw-text-muted">{unit}</span></span>
  </div>;
});
