import classNames from 'classnames';
import { forwardRef } from 'react';
import { SliderProps } from './Slider.types';

/**
 * Slider Component
 *
 * A range input component supporting both horizontal and vertical orientations.
 * Used for volume faders, pan controls, and other range inputs throughout the DAW.
 *
 * @example
 * ```tsx
 * // Horizontal pan slider
 * <Slider
 *   orientation="horizontal"
 *   variant="pan"
 *   min={-100}
 *   max={100}
 *   value={pan}
 *   onChange={(val) => setPan(val)}
 * />
 *
 * // Vertical volume fader
 * <Slider
 *   orientation="vertical"
 *   variant="fader"
 *   min={-60}
 *   max={12}
 *   step={0.1}
 *   value={volume}
 *   onChange={(val) => setVolume(val)}
 *   height="100px"
 *   showValue
 *   formatValue={(v) => v <= -60 ? "-∞" : v.toFixed(1) + " dB"}
 * />
 * ```
 */
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
      className,
      ...rest
    },
    ref
  ) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value);
      if (onChange) {
        onChange(newValue);
      }
    };

    const sliderClasses = classNames(
      'cursor-pointer transition-opacity',
      orientation === 'vertical' && 'vertical-fader',
      orientation === 'horizontal' && 'w-full h-2 rounded',
      variant === 'fader' && 'vertical-fader',
      variant === 'pan' && 'accent-green-600',
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
      }),
    };

    const displayValue = value !== undefined
      ? (formatValue ? formatValue(value) : value.toString())
      : '';

    return (
      <div className="flex flex-col items-center gap-1" style={containerStyle}>
        {showValue && displayValue && (
          <div className="text-xs text-daw-text-muted whitespace-nowrap">
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
          className={sliderClasses}
          style={inputStyle}
          {...rest}
        />
      </div>
    );
  }
);

Slider.displayName = 'Slider';
