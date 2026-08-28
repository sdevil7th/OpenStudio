import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { getParameterWheelValue, resolveProfiledParameterWheel } from "../../../utils/parameterWheel";
import { createWheelDeltaAccumulator, type WheelDeltaAccumulator } from "../../../utils/wheelDeltaAccumulator";
import {
  beginEditTransaction,
  commitEditTransaction,
  createEditTransactionLifecycle,
} from "../editTransactionLifecycle";
import type { ProfiledRangeInputProps } from "./ProfiledRangeInput.types";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * A visually bare native range input with DAW-profile wheel routing.
 *
 * It deliberately adds no wrapper or classes, so callers retain their exact
 * layout and styling while pointer, keyboard and wheel edits share one safe
 * begin/live/commit lifecycle.
 */
export const ProfiledRangeInput = forwardRef<HTMLInputElement, ProfiledRangeInputProps>(
  (
    {
      min,
      max,
      step = 1,
      value,
      onValueChange,
      onBeginEdit,
      onCommitEdit,
      wheelSubtarget = "control",
      disabled,
      onWheel,
      onKeyDown,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onBlur,
      ...rest
    },
    ref,
  ) => {
    const valueRef = useRef(value);
    const pointerEditRef = useRef(createEditTransactionLifecycle());
    const wheelEditRef = useRef(createEditTransactionLifecycle());
    const wheelAccumulatorRef = useRef<WheelDeltaAccumulator | null>(null);
    const commitWheelEditRef = useRef<() => void>(() => undefined);
    valueRef.current = value;

    const commitPointerEdit = useCallback(() => {
      commitEditTransaction(pointerEditRef.current);
    }, []);

    const commitWheelEdit = useCallback(() => {
      commitEditTransaction(wheelEditRef.current);
    }, []);
    commitWheelEditRef.current = commitWheelEdit;

    const commitAllEdits = useCallback(() => {
      commitPointerEdit();
      if (wheelAccumulatorRef.current) wheelAccumulatorRef.current.reset();
      else commitWheelEdit();
    }, [commitPointerEdit, commitWheelEdit]);

    useEffect(() => {
      const accumulator = createWheelDeltaAccumulator({
        quantum: 1,
        idleMs: 180,
        onReset: () => commitWheelEditRef.current(),
      });
      wheelAccumulatorRef.current = accumulator;
      return () => {
        commitPointerEdit();
        accumulator.dispose();
        if (wheelAccumulatorRef.current === accumulator) wheelAccumulatorRef.current = null;
      };
    }, [commitPointerEdit]);

    const handleWheel = useCallback((event: WheelEvent<HTMLInputElement>) => {
      onWheel?.(event);
      // The app's capture-phase WebView zoom guard may already have prevented
      // primary-modified wheel input. Parameter controls still resolve and own
      // that gesture locally.
      if (disabled) return;

      const gesture = resolveProfiledParameterWheel(event.nativeEvent, wheelSubtarget);
      if (gesture.preventDefault) event.preventDefault();
      if (gesture.stopPropagation) event.stopPropagation();
      if (gesture.operation !== "adjust") {
        wheelAccumulatorRef.current?.reset();
        return;
      }

      const targetKey = `${wheelSubtarget}:${gesture.profileId}:${gesture.ruleId}:${gesture.precision}`;
      const emittedAmount = wheelAccumulatorRef.current?.consume(targetKey, gesture.amount) ?? 0;
      if (emittedAmount === 0) return;

      const currentValue = valueRef.current;
      const nextValue = getParameterWheelValue({ ...gesture, amount: emittedAmount }, {
        min,
        max,
        value: currentValue,
        step,
      });
      if (nextValue === currentValue) return;

      commitPointerEdit();
      beginEditTransaction(wheelEditRef.current, onBeginEdit, onCommitEdit);
      valueRef.current = nextValue;
      onValueChange(nextValue);
    }, [
      commitPointerEdit,
      disabled,
      max,
      min,
      onBeginEdit,
      onCommitEdit,
      onValueChange,
      onWheel,
      step,
      wheelSubtarget,
    ]);

    const handlePointerDown = useCallback((event: PointerEvent<HTMLInputElement>) => {
      onPointerDown?.(event);
      if (event.defaultPrevented || disabled) return;
      commitAllEdits();
      beginEditTransaction(pointerEditRef.current, onBeginEdit, onCommitEdit);
    }, [commitAllEdits, disabled, onBeginEdit, onCommitEdit, onPointerDown]);

    const handlePointerUp = useCallback((event: PointerEvent<HTMLInputElement>) => {
      onPointerUp?.(event);
      commitPointerEdit();
    }, [commitPointerEdit, onPointerUp]);

    const handlePointerCancel = useCallback((event: PointerEvent<HTMLInputElement>) => {
      onPointerCancel?.(event);
      commitPointerEdit();
    }, [commitPointerEdit, onPointerCancel]);

    const handleLostPointerCapture = useCallback((event: PointerEvent<HTMLInputElement>) => {
      onLostPointerCapture?.(event);
      commitPointerEdit();
    }, [commitPointerEdit, onLostPointerCapture]);

    const handleBlur = useCallback((event: FocusEvent<HTMLInputElement>) => {
      onBlur?.(event);
      commitAllEdits();
    }, [commitAllEdits, onBlur]);

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || disabled) return;

      const smallStep = event.shiftKey ? step * 0.1 : step;
      const largeStep = Math.max(step, (max - min) / 10);
      let nextValue: number | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        nextValue = valueRef.current + smallStep;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        nextValue = valueRef.current - smallStep;
      } else if (event.key === "PageUp") {
        nextValue = valueRef.current + largeStep;
      } else if (event.key === "PageDown") {
        nextValue = valueRef.current - largeStep;
      } else if (event.key === "Home") {
        nextValue = min;
      } else if (event.key === "End") {
        nextValue = max;
      } else {
        return;
      }

      event.preventDefault();
      commitAllEdits();
      const clampedValue = Number(clamp(nextValue, min, max).toPrecision(12));
      if (clampedValue === valueRef.current) return;
      const keyEdit = createEditTransactionLifecycle();
      beginEditTransaction(keyEdit, onBeginEdit, onCommitEdit);
      valueRef.current = clampedValue;
      onValueChange(clampedValue);
      commitEditTransaction(keyEdit);
    }, [
      commitAllEdits,
      disabled,
      max,
      min,
      onBeginEdit,
      onCommitEdit,
      onKeyDown,
      onValueChange,
      step,
    ]);

    const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = Number(event.currentTarget.value);
      if (!Number.isFinite(nextValue)) return;
      valueRef.current = nextValue;
      if (pointerEditRef.current.active || wheelEditRef.current.active) {
        onValueChange(nextValue);
        return;
      }

      // Assistive technologies can emit a range change without a pointer or
      // keyboard event. Treat that as one complete discrete edit.
      const discreteEdit = createEditTransactionLifecycle();
      beginEditTransaction(discreteEdit, onBeginEdit, onCommitEdit);
      onValueChange(nextValue);
      commitEditTransaction(discreteEdit);
    }, [onBeginEdit, onCommitEdit, onValueChange]);

    return (
      <input
        {...rest}
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={handleChange}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onBlur={handleBlur}
      />
    );
  },
);

ProfiledRangeInput.displayName = "ProfiledRangeInput";
