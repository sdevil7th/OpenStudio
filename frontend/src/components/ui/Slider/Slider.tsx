import classNames from 'classnames';
import { forwardRef, useRef, useCallback, useEffect } from 'react';
import { SliderProps } from './Slider.types';
import {
  accumulateParameterWheelGesture,
  getParameterWheelValue,
  resolveProfiledParameterWheel,
} from '../../../utils/parameterWheel';
import {
  createWheelDeltaAccumulator,
  type WheelDeltaAccumulator,
} from '../../../utils/wheelDeltaAccumulator';
import type { WheelSubtarget } from '../../../utils/wheelGestureResolver';
import {
  beginEditTransaction,
  commitEditTransaction,
  createEditTransactionLifecycle,
} from '../editTransactionLifecycle';

export function getSliderWheelSubtarget(
  orientation: SliderProps['orientation'],
  variant: SliderProps['variant'],
): WheelSubtarget {
  return orientation === 'vertical' && variant === 'fader'
    ? 'console_fader'
    : 'control';
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    {
      min = 0,
      max = 100,
      step = 1,
      value,
      onChange,
      onBeginEdit,
      onCommitEdit,
      orientation = 'horizontal',
      variant = 'default',
      height,
      width,
      showValue = false,
      formatValue,
      defaultValue,
      className,
      onWheel,
      onKeyDown,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onBlur,
      ...rest
    },
    ref
  ) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);
    const wheelValueRef = useRef(value);
    const wheelEditingRef = useRef(false);
    const wheelCommitCallbackRef = useRef<(() => void) | undefined>(undefined);
    const wheelAccumulatorRef = useRef<WheelDeltaAccumulator | null>(null);
    const commitWheelEditRef = useRef<() => void>(() => undefined);
    const pointerEditRef = useRef(createEditTransactionLifecycle());
    const resetHandledOnPointerDownRef = useRef(false);
    wheelValueRef.current = value;

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

    const handleWheel = useCallback((e: React.WheelEvent<HTMLElement>) => {
      onWheel?.(e as unknown as React.WheelEvent<HTMLInputElement>);
      if (rest.disabled || value === undefined || !onChange) return;
      const gesture = resolveProfiledParameterWheel(
        e.nativeEvent,
        getSliderWheelSubtarget(orientation, variant),
      );
      if (gesture.preventDefault) e.preventDefault();
      if (gesture.stopPropagation) e.stopPropagation();
      const accumulatedGesture = wheelAccumulatorRef.current
        ? accumulateParameterWheelGesture(
          wheelAccumulatorRef.current,
          gesture,
          getSliderWheelSubtarget(orientation, variant),
        )
        : null;
      if (!accumulatedGesture) return;

      const currentValue = wheelValueRef.current ?? value;
      const nextValue = getParameterWheelValue(accumulatedGesture, {
        min,
        max,
        value: currentValue,
        step,
      });
      if (nextValue === currentValue) return;
      if (!wheelEditingRef.current) {
        wheelEditingRef.current = true;
        wheelCommitCallbackRef.current = onCommitEdit;
        onBeginEdit?.();
      }
      wheelValueRef.current = nextValue;
      onChange(nextValue);
    }, [max, min, onBeginEdit, onChange, onCommitEdit, onWheel, orientation, rest.disabled, step, value, variant]);

    const handleTransactionalKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
      if (e.defaultPrevented || rest.disabled || value === undefined || !onChange) return;
      const largeStep = Math.max(step, (max - min) / 10);
      let next: number | undefined;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + (e.shiftKey ? step * 0.1 : step);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - (e.shiftKey ? step * 0.1 : step);
      else if (e.key === 'PageUp') next = value + largeStep;
      else if (e.key === 'PageDown') next = value - largeStep;
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      else return;
      e.preventDefault();
      wheelAccumulatorRef.current?.reset();
      onBeginEdit?.();
      onChange(Math.max(min, Math.min(max, next)));
      onCommitEdit?.();
    }, [max, min, onBeginEdit, onChange, onCommitEdit, onKeyDown, rest.disabled, step, value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value);
      if (onChange) {
        onChange(newValue);
      }
    };

    const applyDiscreteValue = useCallback((nextValue: number) => {
      if (!onChange) return;
      wheelAccumulatorRef.current?.reset();
      onBeginEdit?.();
      onChange(nextValue);
      onCommitEdit?.();
    }, [onBeginEdit, onChange, onCommitEdit]);

    // Primary-modifier+Click resets to the default value on Windows and macOS.
    const handleClick = (e: React.MouseEvent) => {
      if ((e.ctrlKey || e.metaKey) && defaultValue !== undefined && onChange) {
        e.preventDefault();
        if (resetHandledOnPointerDownRef.current) {
          resetHandledOnPointerDownRef.current = false;
          return;
        }
        applyDiscreteValue(defaultValue);
      }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
      if (defaultValue === undefined || !onChange) return;
      e.preventDefault();
      e.stopPropagation();
      applyDiscreteValue(defaultValue);
    };

    // --- Custom pan slider logic (center-fill) ---
    const getValueFromPointerEvent = useCallback((e: PointerEvent | React.PointerEvent) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const rawValue = min + ratio * (max - min);
      // Snap to step
      const stepped = Math.round(rawValue / step) * step;
      return Math.max(min, Math.min(max, stepped));
    }, [min, max, step]);

    const commitPointerEdit = useCallback(() => {
      draggingRef.current = false;
      commitEditTransaction(pointerEditRef.current);
    }, []);

    const handlePanPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && defaultValue !== undefined && onChange) {
        e.preventDefault();
        e.stopPropagation();
        applyDiscreteValue(defaultValue);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      wheelAccumulatorRef.current?.reset();
      beginEditTransaction(pointerEditRef.current, onBeginEdit, onCommitEdit);
      e.currentTarget.setPointerCapture(e.pointerId);
      const val = getValueFromPointerEvent(e);
      if (val !== undefined && onChange) onChange(val);
    }, [applyDiscreteValue, defaultValue, getValueFromPointerEvent, onBeginEdit, onChange, onCommitEdit]);

    const handlePanPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || !pointerEditRef.current.active) return;
      const nextValue = getValueFromPointerEvent(event);
      if (nextValue !== undefined && onChange) onChange(nextValue);
    }, [getValueFromPointerEvent, onChange]);

    const handlePanPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      commitPointerEdit();
    }, [commitPointerEdit]);

    const handleNativePointerDown = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
      onPointerDown?.(event);
      if (event.defaultPrevented || rest.disabled) return;
      if ((event.ctrlKey || event.metaKey) && defaultValue !== undefined && onChange) {
        event.preventDefault();
        resetHandledOnPointerDownRef.current = true;
        applyDiscreteValue(defaultValue);
        return;
      }
      wheelAccumulatorRef.current?.reset();
      beginEditTransaction(pointerEditRef.current, onBeginEdit, onCommitEdit);
    }, [applyDiscreteValue, defaultValue, onBeginEdit, onChange, onCommitEdit, onPointerDown, rest.disabled]);

    const handleNativePointerUp = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
      onPointerUp?.(event);
      commitPointerEdit();
    }, [commitPointerEdit, onPointerUp]);

    const handleNativePointerCancel = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
      onPointerCancel?.(event);
      commitPointerEdit();
    }, [commitPointerEdit, onPointerCancel]);

    const handleNativeBlur = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
      onBlur?.(event);
      commitPointerEdit();
    }, [commitPointerEdit, onBlur]);

    useEffect(() => () => commitPointerEdit(), [commitPointerEdit]);

    // Pan variant: custom rendered slider with center-fill
    if (variant === 'pan' && orientation === 'horizontal') {
      const currentVal = value ?? 0;
      const range = max - min;
      const centerRatio = (0 - min) / range; // where 0 is on the track (center for pan)
      const valueRatio = (currentVal - min) / range;

      const fillLeft = Math.min(centerRatio, valueRatio) * 100;
      const fillWidth = Math.abs(valueRatio - centerRatio) * 100;

      return (
        <div
          className={classNames("flex flex-col items-center gap-1", className)}
          style={{ width: width || '100%', height: height || 'auto' }}
        >
          {showValue && value !== undefined && (
            <div className="text-xs text-daw-text-muted whitespace-nowrap">
              {formatValue ? formatValue(value) : value.toString()}
            </div>
          )}
          <div
            ref={trackRef}
            className="relative w-full h-2 rounded cursor-pointer select-none"
            style={{ background: '#3a3a3a' }}
            onPointerDown={handlePanPointerDown}
            onPointerMove={handlePanPointerMove}
            onPointerUp={handlePanPointerEnd}
            onPointerCancel={handlePanPointerEnd}
            onLostPointerCapture={handlePanPointerEnd}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onKeyDown={handleTransactionalKeyDown}
            title={rest.title as string}
            role="slider"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={currentVal}
            aria-label={rest['aria-label'] as string}
            tabIndex={0}
          >
            {/* Center line */}
            <div
              className="absolute top-0 bottom-0 w-px bg-neutral-500"
              style={{ left: `${centerRatio * 100}%` }}
            />
            {/* Fill from center to value */}
            <div
              className="absolute top-0 bottom-0"
              style={{
                left: `${fillLeft}%`,
                width: `${fillWidth}%`,
                background: '#16a34a',
                borderRadius: currentVal < 0 ? '4px 0 0 4px' : currentVal > 0 ? '0 4px 4px 0' : '0',
              }}
            />
            {/* Thumb */}
            <div
              className="absolute top-0 bottom-0 w-2 rounded-sm border border-neutral-400 bg-neutral-300 hover:bg-white transition-colors"
              style={{
                left: `${valueRatio * 100}%`,
                transform: 'translateX(-50%)',
              }}
            />
          </div>
        </div>
      );
    }

    // --- Standard native slider for fader/default ---
    const sliderClasses = classNames(
      'cursor-pointer transition-opacity',
      orientation === 'vertical' && 'vertical-fader',
      orientation === 'horizontal' && 'w-full h-2 rounded',
      variant === 'fader' && 'vertical-fader',
      variant === 'default' && 'accent-blue-600',
      className
    );

    const containerStyle: React.CSSProperties = {
      ...(orientation === 'vertical' && {
        height: height || '100px',
        width: width || 'auto',
      }),
      ...(orientation === 'horizontal' && {
        width: width || '100%',
        height: height || 'auto',
      }),
    };

    const inputStyle: React.CSSProperties = {
      ...(orientation === 'vertical' && {
        writingMode: 'vertical-lr' as const,
        direction: 'rtl' as const,
        height: '100%',
      }),
    };

    const displayValue = value !== undefined
      ? (formatValue ? formatValue(value) : value.toString())
      : '';

    return (
      <div
        className={classNames(
          "flex flex-col items-center",
          orientation === 'vertical' && 'min-h-0 overflow-hidden',
          orientation === 'horizontal' && 'gap-1',
        )}
        style={containerStyle}
      >
        {showValue && displayValue && (
          <div className="text-xs text-daw-text-muted whitespace-nowrap shrink-0">
            {displayValue}
          </div>
        )}

        <input
          ref={ref}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleChange}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onWheel={handleWheel}
          onKeyDown={handleTransactionalKeyDown}
          onPointerDown={handleNativePointerDown}
          onPointerUp={handleNativePointerUp}
          onPointerCancel={handleNativePointerCancel}
          onBlur={handleNativeBlur}
          className={sliderClasses}
          style={inputStyle}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          {...rest}
        />
      </div>
    );
  }
);

Slider.displayName = 'Slider';
