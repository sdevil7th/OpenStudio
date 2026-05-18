import classNames from 'classnames';
import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  SelectProps,
  selectSizeStyles,
  selectVariantStyles,
} from './Select.types';

/**
 * Select Component
 *
 * A styled select/dropdown component for choosing from a list of options.
 * Currently wraps native HTML select for simplicity. Can be upgraded to Headless UI Listbox
 * if more complex interactions (search, custom rendering) are needed.
 *
 * @example
 * ```tsx
 * // Sample rate selection
 * <Select
 *   variant="default"
 *   size="md"
 *   fullWidth
 *   label="Sample Rate"
 *   options={[
 *     { value: 44100, label: "44100 Hz" },
 *     { value: 48000, label: "48000 Hz" },
 *     { value: 96000, label: "96000 Hz" },
 *   ]}
 *   value={sampleRate}
 *   onChange={(val) => setSampleRate(val as number)}
 * />
 *
 * // Compact track type select
 * <Select
 *   variant="compact"
 *   size="xs"
 *   options={[
 *     { value: 'audio', label: 'Audio' },
 *     { value: 'midi', label: 'MIDI' },
 *     { value: 'instrument', label: 'Instrument' },
 *   ]}
 *   value={trackType}
 *   onChange={(val) => setTrackType(val as string)}
 * />
 *
 * // Accent variant (input routing)
 * <Select
 *   variant="accent"
 *   size="xs"
 *   options={inputOptions}
 *   value={selectedInput}
 *   onChange={handleInputChange}
 * />
 * ```
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      options,
      value,
      onChange,
      size = 'md',
      variant = 'default',
      fullWidth = false,
      label,
      disabled = false,
      error,
      className,
      placeholder,
      title,
    },
    ref
  ) => {
    const selectClasses = classNames(
      selectSizeStyles[size],
      selectVariantStyles[variant],
      'w-full appearance-none rounded cursor-pointer transition-colors',
      fullWidth && 'w-full',
      error && 'border-red-500 focus:border-red-500',
      disabled && 'opacity-50 cursor-not-allowed',
      className
    );

    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (onChange) {
        const selectedValue = e.target.value;
        // Try to parse as number if original value was number
        const option = options.find(opt => String(opt.value) === selectedValue);
        onChange(option ? option.value : selectedValue);
      }
    };

    const WrapperComponent = label ? 'div' : 'span';
    const wrapperClasses = classNames(label ? 'block' : 'inline-block', fullWidth && 'w-full');
    const controlClasses = classNames('relative inline-flex min-w-0', fullWidth && 'w-full');

    return (
      <WrapperComponent className={wrapperClasses}>
        {label && (
          <label className="block text-sm font-medium text-daw-text-muted mb-1">
            {label}
          </label>
        )}

        <span className={controlClasses}>
          <select
            ref={ref}
            value={value !== undefined ? String(value) : ''}
            onChange={handleChange}
            disabled={disabled}
            title={title}
            className={selectClasses}
          >
            {placeholder && (
              <option value="" disabled className="bg-neutral-900 text-neutral-400">
                {placeholder}
              </option>
            )}
            {options.map((option) => (
              <option
                key={String(option.value)}
                value={String(option.value)}
                disabled={option.disabled}
                className="bg-neutral-900 text-white"
              >
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={12}
            className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-500"
            aria-hidden="true"
          />
        </span>

        {error && (
          <span className="block text-xs text-red-500 mt-1">{error}</span>
        )}
      </WrapperComponent>
    );
  }
);

Select.displayName = 'Select';
