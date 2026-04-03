import classNames from 'classnames';
import { forwardRef, useRef, useCallback } from 'react';
import { SliderProps } from './Slider.types';

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    {
      min = 0,
      max = 100,
      step = 1,
      value,
      onChange,
      orientation = 'horizontal',
      variant = 'default',
      height,
      width,
      showValue = false,
      formatValue,
      defaultValue,
      className,
      ...rest
    },
    ref
  ) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value);
      if (onChange) {
        onChange(newValue);
      }
    };

    // Ctrl+Click resets to default value
    const handleClick = (e: React.MouseEvent) => {
      if (e.ctrlKey && defaultValue !== undefined && onChange) {
        e.preventDefault();
        onChange(defaultValue);
      }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
      if (defaultValue === undefined || !onChange) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(defaultValue);
    };

    // --- Custom pan slider logic (center-fill) ---
    const getValueFromMouseEvent = useCallback((e: MouseEvent | React.MouseEvent) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const rawValue = min + ratio * (max - min);
      // Snap to step
      const stepped = Math.round(rawValue / step) * step;
      return Math.max(min, Math.min(max, stepped));
    }, [min, max, step]);

    const handlePanMouseDown = useCallback((e: React.MouseEvent) => {
      if (e.ctrlKey && defaultValue !== undefined && onChange) {
        e.preventDefault();
        onChange(defaultValue);
        return;
      }
      e.preventDefault();
      draggingRef.current = true;
      const val = getValueFromMouseEvent(e);
      if (val !== undefined && onChange) onChange(val);

      const handleMouseMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const val = getValueFromMouseEvent(ev);
        if (val !== undefined && onChange) onChange(val);
      };
      const handleMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }, [getValueFromMouseEvent, onChange, defaultValue]);

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
            onMouseDown={handlePanMouseDown}
            onDoubleClick={handleDoubleClick}
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
