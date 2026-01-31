import { forwardRef } from 'react';
import classNames from 'classnames';
import {
  NativeSelectProps,
  NativeSelectOption,
  nativeSelectSizeStyles,
  nativeSelectVariantStyles,
} from './NativeSelect.types';

/**
 * NativeSelect Component
 *
 * A flexible select component designed for dynamic options from APIs.
 * Accepts simple arrays (strings/numbers) and auto-transforms them to options.
 *
 * @example
 * ```tsx
 * // With string array (common for API data)
 * <NativeSelect
 *   options={config.inputs} // ["Input 1", "Input 2", "Input 3"]
 *   value={selectedInput}
 *   onChange={(val) => setSelectedInput(val)}
 * />
 *
 * // With number array and format function
 * <NativeSelect
 *   options={[44100, 48000, 96000]}
 *   value={sampleRate}
 *   onChange={(val) => setSampleRate(Number(val))}
 *   formatLabel={(val) => `${val} Hz`}
 * />
 *
 * // With loading state
 * <NativeSelect
 *   options={devices}
 *   value={selectedDevice}
 *   onChange={handleChange}
 *   loading={isLoading}
 *   placeholder="Select device"
 * />
 *
 * // Compact variant for track headers
 * <NativeSelect
 *   variant="compact"
 *   size="xs"
 *   options={midiDevices}
 *   value={track.midiInputDevice}
 *   onChange={handleDeviceChange}
 *   title={track.midiInputDevice || "No Device"}
 * />
 * ```
 */
export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  (
    {
      options,
      value,
      onChange,
      size = 'md',
      variant = 'default',
      placeholder,
      showPlaceholder = true,
      fullWidth = false,
      disabled = false,
      loading = false,
      label,
      error,
      formatLabel,
      className,
      title,
    },
    ref
  ) => {
    // Normalize options to {value, label, disabled?} format
    const normalizedOptions: NativeSelectOption[] = options.map((opt) => {
      if (typeof opt === 'string' || typeof opt === 'number') {
        const optValue = opt;
        const optLabel = formatLabel ? formatLabel(opt) : String(opt);
        return { value: optValue, label: optLabel };
      }
      // Already structured option
      return {
        value: opt.value,
        label: formatLabel ? formatLabel(opt.value) : opt.label,
        disabled: opt.disabled,
      };
    });

    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (onChange) {
        const selectedValue = e.target.value;
        // Try to find original type from options
        const matchingOpt = normalizedOptions.find(
          (opt) => String(opt.value) === selectedValue
        );
        if (matchingOpt) {
          onChange(matchingOpt.value);
        } else {
          onChange(selectedValue);
        }
      }
    };

    const isDisabled = disabled || loading;

    const selectClasses = classNames(
      nativeSelectSizeStyles[size],
      nativeSelectVariantStyles[variant],
      'rounded cursor-pointer transition-colors',
      fullWidth && 'w-full',
      error && 'border-red-500 focus:border-red-500',
      isDisabled && 'opacity-60 cursor-not-allowed',
      loading && 'bg-neutral-900',
      className
    );

    const WrapperComponent = label ? 'div' : 'span';
    const wrapperClasses = classNames(fullWidth && 'w-full');

    return (
      <WrapperComponent className={wrapperClasses}>
        {label && (
          <label className="block text-sm font-medium text-neutral-400 mb-1">
            {label}
          </label>
        )}

        <select
          ref={ref}
          value={loading ? '' : (value !== undefined ? String(value) : '')}
          onChange={handleChange}
          disabled={isDisabled}
          className={selectClasses}
          title={title}
        >
          {loading ? (
            <option className="bg-neutral-900 text-white">--</option>
          ) : (
            <>
              {showPlaceholder && placeholder && (
                <option value="" disabled className="bg-neutral-900 text-neutral-400">
                  {placeholder}
                </option>
              )}
              {normalizedOptions.map((opt) => (
                <option
                  key={String(opt.value)}
                  value={String(opt.value)}
                  disabled={opt.disabled}
                  className="bg-neutral-900 text-white"
                >
                  {opt.label}
                </option>
              ))}
            </>
          )}
        </select>

        {error && (
          <span className="block text-xs text-red-500 mt-1">{error}</span>
        )}
      </WrapperComponent>
    );
  }
);

NativeSelect.displayName = 'NativeSelect';
