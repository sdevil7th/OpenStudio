import "./NAMRackKnob.css";
import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Power } from "lucide-react";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import {
  denormalizeParamValue,
  formatParamValue,
  normalizeParam,
  normalizeParamValue,
  offsetParamValue,
  paramValueFromRangeInput,
  quantizeParamValue,
  rangeInputMax,
  rangeInputMin,
  rangeInputStep,
  rangeInputValue,
} from "../utils/builtInParamValue";
import { knobAssetForVariant, knobAtlasFrame, knobFrameIndex } from "./NAMRackControlAssets";
import { NAMRackControlTooltip } from "./NAMRackControlTooltip";
import {
  getParameterWheelStepCount,
  resolveProfiledParameterWheel,
} from "../utils/parameterWheel";

type TooltipActivity = "hovered" | "focused" | "dragging";

function RasterKnobCap({
  pct,
  size,
}: {
  pct: number;
  size: "default" | "large";
}) {
  const asset = knobAssetForVariant(size === "large" ? "panel" : undefined);
  const frame = knobAtlasFrame(asset, knobFrameIndex(pct, asset.frameCount));
  const rows = Math.ceil(asset.frameCount / asset.columns);
  const spriteStyle = {
    backgroundImage: `url("${asset.href}")`,
    backgroundSize: `${asset.columns * 100}% ${rows * 100}%`,
    backgroundPosition: `${asset.columns > 1 ? (frame.column / (asset.columns - 1)) * 100 : 0}% ${rows > 1 ? (frame.row / (rows - 1)) * 100 : 0}%`,
  } as CSSProperties;

  return (
    <span
      className="nam-rack-knob-cap nam-rack-knob-cap-raster"
      data-control-asset={asset.id}
      data-frame={frame.index}
      data-size={size}
      aria-hidden="true"
    >
      <span style={spriteStyle} />
    </span>
  );
}

export function RackKnob({
  param,
  onChange,
  size = "default",
  style: styleOverride,
  disabled = false,
  disabledReason,
}: {
  param: BuiltInParamDescriptor;
  onChange: (param: BuiltInParamDescriptor, value: number) => void;
  size?: "default" | "large";
  style?: CSSProperties;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const pct = normalizeParam(param);
  const rotation = -135 + pct * 270;
  const defaultPct = normalizeParamValue(param, param.defaultValue ?? 0);
  const bipolar = param.min < 0 && param.max > 0 && Math.abs(defaultPct - 0.5) < 0.12;
  const fillStart = (bipolar ? Math.min(defaultPct, pct) : 0) * 75;
  const fillEnd = (bipolar ? Math.max(defaultPct, pct) : pct) * 75;
  const style = {
    "--nam-knob-rotation": `${rotation}deg`,
    "--nam-knob-pct": `${pct * 75}%`,
    "--nam-knob-fill-start": `${fillStart}%`,
    "--nam-knob-fill-end": `${fillEnd}%`,
  } as CSSProperties;
  const knobStyle = styleOverride ? ({ ...style, ...styleOverride } as CSSProperties) : style;
  const controlRef = useRef<HTMLLabelElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startNormalized: number } | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);
  const pointerInitiatedFocusRef = useRef(false);
  const tooltipActivityRef = useRef<Record<TooltipActivity, boolean>>({
    hovered: false,
    focused: false,
    dragging: false,
  });
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const clearTooltipTimer = useCallback(() => {
    if (tooltipTimerRef.current === null) return;
    window.clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = null;
  }, []);
  const setTooltipActivity = useCallback(
    (activity: TooltipActivity, active: boolean) => {
      tooltipActivityRef.current[activity] = active;
      clearTooltipTimer();
      if (active) {
        if (activity === "hovered") {
          tooltipTimerRef.current = window.setTimeout(() => {
            tooltipTimerRef.current = null;
            if (tooltipActivityRef.current.hovered) setTooltipOpen(true);
          }, 220);
        } else {
          setTooltipOpen(true);
        }
        return;
      }
      if (!Object.values(tooltipActivityRef.current).some(Boolean)) setTooltipOpen(false);
    },
    [clearTooltipTimer],
  );
  const showTooltipNow = useCallback(() => {
    clearTooltipTimer();
    setTooltipOpen(true);
  }, [clearTooltipTimer]);

  useEffect(() => () => clearTooltipTimer(), [clearTooltipTimer]);

  const setValue = useCallback(
    (value: number) => {
      if (disabled) return;
      onChange(param, quantizeParamValue(param, value));
    },
    [disabled, onChange, param],
  );
  const dragToValue = useCallback(
    (event: PointerEvent<HTMLLabelElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const fine = event.shiftKey || event.ctrlKey || event.metaKey ? 0.25 : 1;
      const deltaNormalized = (drag.startY - event.clientY) / 220 * fine;
      setValue(denormalizeParamValue(param, drag.startNormalized + deltaNormalized));
    },
    [param, setValue],
  );

  if (param.type === "enum") {
    return (
      <label
        className="nam-rack-control nam-rack-control-select"
        data-param={param.id}
        data-disabled={disabled || undefined}
        title={disabled ? disabledReason ?? param.label : param.label}
      >
        <span>{param.label}</span>
        <select
          value={Math.round(param.value)}
          disabled={disabled}
          onChange={(event) => onChange(param, Number(event.currentTarget.value))}
        >
          {(param.enumOptions ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === "toggle") {
    const active = param.value >= 0.5;
    return (
      <button
        type="button"
        className="nam-rack-control nam-rack-control-switch"
        data-param={param.id}
        data-active={active}
        data-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => onChange(param, active ? 0 : 1)}
        title={disabled ? disabledReason ?? param.label : param.label}
        aria-pressed={active}
      >
        <Power size={14} />
        <span>{param.label}</span>
        <strong>{formatParamValue(param)}</strong>
      </button>
    );
  }

  return (
    <>
      <label
        ref={controlRef}
        className="nam-rack-control nam-rack-control-knob"
        data-size={size}
        data-param={param.id}
        data-bipolar={bipolar}
        data-qa={size === "large" ? "nam-faceplate-knob" : undefined}
        data-scene-anchor={size === "large" ? param.id : undefined}
        data-renderer="pbr-raster-atlas-v1"
        data-disabled={disabled || undefined}
        aria-disabled={disabled || undefined}
        style={knobStyle}
        title={disabled ? disabledReason ?? `${param.label} is unavailable` : undefined}
        onPointerEnter={() => setTooltipActivity("hovered", true)}
        onPointerLeave={() => setTooltipActivity("hovered", false)}
        onFocus={() => {
          if (!pointerInitiatedFocusRef.current) setTooltipActivity("focused", true);
        }}
        onBlur={() => {
          pointerInitiatedFocusRef.current = false;
          setTooltipActivity("focused", false);
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          pointerInitiatedFocusRef.current = true;
          setTooltipActivity("dragging", true);
          dragRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startNormalized: normalizeParam(param),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => dragToValue(event)}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragToValue(event);
            dragRef.current = null;
            setTooltipActivity("dragging", false);
          }
          pointerInitiatedFocusRef.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            setTooltipActivity("dragging", false);
          }
          pointerInitiatedFocusRef.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onWheel={(event) => {
          if (disabled) return;
          const gesture = resolveProfiledParameterWheel(event.nativeEvent, "control");
          if (gesture.preventDefault) event.preventDefault();
          if (gesture.stopPropagation) event.stopPropagation();
          if (gesture.operation !== "adjust") return;
          const stepCount = getParameterWheelStepCount(gesture);
          if (stepCount === 0) return;
          showTooltipNow();
          setValue(offsetParamValue(param, param.value, stepCount));
        }}
        onDoubleClick={(event) => {
          if (disabled) return;
          event.preventDefault();
          showTooltipNow();
          setValue(param.defaultValue ?? 0);
        }}
      >
        <RasterKnobCap pct={pct} size={size} />
        <span className="nam-rack-knob-label">{param.label}</span>
        <strong>{formatParamValue(param)}</strong>
        <input
          className="nam-rack-knob-input"
          type="range"
          min={rangeInputMin(param)}
          max={rangeInputMax(param)}
          step={rangeInputStep(param)}
          value={rangeInputValue(param)}
          disabled={disabled}
          aria-label={param.label}
          onChange={(event) => setValue(
            paramValueFromRangeInput(param, Number(event.currentTarget.value)),
          )}
        />
      </label>
      <NAMRackControlTooltip
        anchor={controlRef.current}
        open={tooltipOpen}
        label={param.label}
        value={disabled ? disabledReason ?? `${param.label} is unavailable` : formatParamValue(param)}
        kind={disabled ? "reason" : "value"}
      />
    </>
  );
}
