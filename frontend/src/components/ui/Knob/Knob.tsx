import { useState, useCallback, useEffect, useRef } from "react";
import classNames from "classnames";
import { KnobProps, knobSizeMap } from "./Knob.types";
import {
  accumulateParameterWheelGesture,
  getParameterWheelValue,
  resolveProfiledParameterWheel,
} from "../../../utils/parameterWheel";
import {
  createWheelDeltaAccumulator,
  type WheelDeltaAccumulator,
} from "../../../utils/wheelDeltaAccumulator";
import {
  beginEditTransaction,
  commitEditTransaction,
  createEditTransactionLifecycle,
} from "../editTransactionLifecycle";

// --- Arc geometry constants ---
// 270° sweep with a gap at the bottom (6-o'clock area)
const START_ANGLE = 225; // 7:30 position
const END_ANGLE = 495; // 4:30 position
const ARC_SWEEP = END_ANGLE - START_ANGLE; // 270

// Variant fill colors
const FILL_COLORS: Record<string, string> = {
  default: "#0078d4",
  volume: "#4caf50",
  pan: "#16a34a",
};

// --- Helpers ---
function valueToAngle(value: number, min: number, max: number): number {
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return START_ANGLE + ratio * ARC_SWEEP;
}

function angleToPoint(
  angleDeg: number,
  radius: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  // -90 offset so 0° = 12-o'clock
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  if (Math.abs(endAngle - startAngle) < 0.1) return "";
  const start = angleToPoint(startAngle, radius, cx, cy);
  const end = angleToPoint(endAngle, radius, cx, cy);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function Knob({
  min,
  max,
  value,
  defaultValue,
  onChange,
  onBeginEdit,
  onCommitEdit,
  formatValue,
  variant = "default",
  size = "md",
  sensitivity = 200,
  label,
  className,
  disabled = false,
  bipolarCenter,
}: KnobProps) {
  const diameter = knobSizeMap[size];
  const cx = diameter / 2;
  const cy = diameter / 2;
  const trackR = diameter / 2 - 2.5; // outer arc radius
  const indicatorInnerR = trackR * 0.5; // indicator line starts here
  const indicatorOuterR = trackR; // indicator line ends at arc

  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const dragStartY = useRef(0);
  const dragStartValue = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const wheelValueRef = useRef(value);
  const wheelEditingRef = useRef(false);
  const wheelCommitCallbackRef = useRef<(() => void) | undefined>(undefined);
  const wheelAccumulatorRef = useRef<WheelDeltaAccumulator | null>(null);
  const commitWheelEditRef = useRef<() => void>(() => undefined);
  const dragEditRef = useRef(createEditTransactionLifecycle());
  wheelValueRef.current = value;

  const fillColor = FILL_COLORS[variant] || FILL_COLORS.default;
  const currentAngle = valueToAngle(value, min, max);

  // Compute fill arc angles
  let fillStartAngle = START_ANGLE;
  let fillEndAngle = currentAngle;

  if (bipolarCenter !== undefined) {
    const centerAngle = valueToAngle(bipolarCenter, min, max);
    if (Math.abs(value - bipolarCenter) < (max - min) * 0.005) {
      // At center — no fill
      fillStartAngle = centerAngle;
      fillEndAngle = centerAngle;
    } else if (value > bipolarCenter) {
      fillStartAngle = centerAngle;
      fillEndAngle = currentAngle;
    } else {
      fillStartAngle = currentAngle;
      fillEndAngle = centerAngle;
    }
  }

  const showTooltip = isHovered || isDragging;
  const tooltipText = formatValue
    ? formatValue(value)
    : value.toFixed(1);

  // --- Drag handler ---
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      // Ctrl+Click → reset to default
      if (e.ctrlKey || e.metaKey) {
        wheelAccumulatorRef.current?.reset();
        onBeginEdit?.();
        onChange(defaultValue);
        onCommitEdit?.();
        return;
      }

      wheelAccumulatorRef.current?.reset();
      beginEditTransaction(dragEditRef.current, onBeginEdit, onCommitEdit);
      setIsDragging(true);
      dragStartY.current = e.clientY;
      dragStartValue.current = value;

      // Capture pointer for smooth dragging even outside the element
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [disabled, value, defaultValue, onChange, onBeginEdit, onCommitEdit],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragEditRef.current.active) return;
      const deltaY = dragStartY.current - e.clientY; // up = positive
      const range = max - min;
      const newValue = dragStartValue.current + (deltaY / sensitivity) * range;
      onChange(Math.max(min, Math.min(max, newValue)));
    },
    [min, max, sensitivity, onChange],
  );

  const commitDragEdit = useCallback(() => {
    commitEditTransaction(dragEditRef.current);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragEditRef.current.active) return;
      setIsDragging(false);
      commitDragEdit();
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [commitDragEdit],
  );

  const handlePointerCancel = useCallback(() => {
    setIsDragging(false);
    commitDragEdit();
  }, [commitDragEdit]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      if (defaultValue === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      wheelAccumulatorRef.current?.reset();
      onBeginEdit?.();
      onChange(defaultValue);
      onCommitEdit?.();
    },
    [defaultValue, disabled, onBeginEdit, onChange, onCommitEdit],
  );

  const commitWheelEdit = useCallback(() => {
    if (!wheelEditingRef.current) return;
    wheelEditingRef.current = false;
    const commit = wheelCommitCallbackRef.current;
    wheelCommitCallbackRef.current = undefined;
    commit?.();
  }, []);
  commitWheelEditRef.current = commitWheelEdit;

  useEffect(() => {
    const accumulator = createWheelDeltaAccumulator({
      quantum: 1,
      idleMs: 180,
      onReset: () => commitWheelEditRef.current(),
    });
    wheelAccumulatorRef.current = accumulator;
    return () => {
      accumulator.dispose();
      if (wheelAccumulatorRef.current === accumulator) wheelAccumulatorRef.current = null;
    };
  }, []);
  useEffect(() => () => commitDragEdit(), [commitDragEdit]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (disabled) return;
    const gesture = resolveProfiledParameterWheel(event.nativeEvent, "control");
    if (gesture.preventDefault) event.preventDefault();
    if (gesture.stopPropagation) event.stopPropagation();
    const accumulatedGesture = wheelAccumulatorRef.current
      ? accumulateParameterWheelGesture(wheelAccumulatorRef.current, gesture, "control")
      : null;
    if (!accumulatedGesture) return;
    const nextValue = getParameterWheelValue(accumulatedGesture, {
      min,
      max,
      value: wheelValueRef.current,
      step: (max - min) / 100,
    });
    if (nextValue === wheelValueRef.current) return;
    if (!wheelEditingRef.current) {
      wheelEditingRef.current = true;
      wheelCommitCallbackRef.current = onCommitEdit;
      onBeginEdit?.();
    }
    wheelValueRef.current = nextValue;
    onChange(nextValue);
  }, [disabled, max, min, onBeginEdit, onChange, onCommitEdit]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const normalStep = (max - min) / 100;
    const step = event.shiftKey ? normalStep * 0.1 : normalStep;
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = value + step;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = value - step;
    else if (event.key === "PageUp") next = value + (max - min) / 10;
    else if (event.key === "PageDown") next = value - (max - min) / 10;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    wheelAccumulatorRef.current?.reset();
    onBeginEdit?.();
    onChange(Math.max(min, Math.min(max, next)));
    onCommitEdit?.();
  }, [disabled, max, min, onBeginEdit, onChange, onCommitEdit, value]);

  // Indicator endpoints
  const indicatorInner = angleToPoint(currentAngle, indicatorInnerR, cx, cy);
  const indicatorOuter = angleToPoint(currentAngle, indicatorOuterR, cx, cy);

  // Tick marks at key positions for visual richness
  const tickAngles = [START_ANGLE, START_ANGLE + ARC_SWEEP / 2, END_ANGLE];
  if (bipolarCenter !== undefined) {
    tickAngles.push(valueToAngle(bipolarCenter, min, max));
  }

  return (
    <div
      ref={wrapperRef}
      className={classNames(
        "relative inline-flex items-center justify-center select-none",
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-ns-resize",
        className,
      )}
      style={{ width: diameter, height: diameter }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => {
        if (!isDragging) setIsHovered(false);
      }}
      title={label ? `${label}: ${tooltipText}` : tooltipText}
      data-no-drag
      data-no-select
      role="slider"
      aria-label={label ?? "Parameter"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
    >
      <svg
        width={diameter}
        height={diameter}
        viewBox={`0 0 ${diameter} ${diameter}`}
        className="block"
      >
        {/* Outer ring shadow / glow when dragging */}
        {isDragging && (
          <circle
            cx={cx}
            cy={cy}
            r={trackR + 1}
            fill="none"
            stroke={fillColor}
            strokeWidth={0.8}
            opacity={0.3}
          />
        )}

        {/* Background track arc */}
        <path
          d={describeArc(cx, cy, trackR, START_ANGLE, END_ANGLE)}
          fill="none"
          stroke="#2a2a2a"
          strokeWidth={2.5}
          strokeLinecap="round"
        />

        {/* Subtle outer edge highlight */}
        <path
          d={describeArc(cx, cy, trackR, START_ANGLE, END_ANGLE)}
          fill="none"
          stroke="#3a3a3a"
          strokeWidth={1.5}
          strokeLinecap="round"
        />

        {/* Tick marks */}
        {tickAngles.map((angle, i) => {
          const outer = angleToPoint(angle, trackR + 1.5, cx, cy);
          const inner = angleToPoint(angle, trackR - 0.5, cx, cy);
          return (
            <line
              key={i}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="#555"
              strokeWidth={0.6}
              strokeLinecap="round"
            />
          );
        })}

        {/* Value fill arc */}
        {Math.abs(fillEndAngle - fillStartAngle) > 0.1 && (
          <>
            {/* Glow layer */}
            <path
              d={describeArc(cx, cy, trackR, fillStartAngle, fillEndAngle)}
              fill="none"
              stroke={fillColor}
              strokeWidth={3.5}
              strokeLinecap="round"
              opacity={0.25}
            />
            {/* Main fill */}
            <path
              d={describeArc(cx, cy, trackR, fillStartAngle, fillEndAngle)}
              fill="none"
              stroke={fillColor}
              strokeWidth={2}
              strokeLinecap="round"
            />
          </>
        )}

        {/* Center dot + label */}
        <circle
          cx={cx}
          cy={cy}
          r={diameter * 0.18}
          fill="#1a1a1a"
          stroke="#444"
          strokeWidth={0.5}
        />
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#666"
          fontSize={diameter * 0.28}
          fontWeight="bold"
          fontFamily="sans-serif"
          style={{ pointerEvents: "none" }}
        >
          {variant === "volume" ? "V" : variant === "pan" ? "P" : ""}
        </text>

        {/* Indicator line */}
        <line
          x1={indicatorInner.x}
          y1={indicatorInner.y}
          x2={indicatorOuter.x}
          y2={indicatorOuter.y}
          stroke={isDragging ? "#fff" : "#ccc"}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      </svg>

      {/* Floating tooltip */}
      {showTooltip && (
        <div className="absolute -top-5 left-1/2 -translate-x-1/2 bg-neutral-900 border border-neutral-600 text-neutral-200 text-[8px] font-mono px-1 py-px rounded whitespace-nowrap z-50 pointer-events-none shadow-lg">
          {tooltipText}
        </div>
      )}
    </div>
  );
}
