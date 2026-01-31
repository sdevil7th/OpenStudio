import classNames from 'classnames';
import { forwardRef } from 'react';
import { InputProps, inputSizeStyles, inputVariantStyles } from './Input.types';

/**
 * Input Component
 *
 * A flexible input component supporting text, number, and other input types with multiple variants.
 * Used for project settings, tempo, track names, and various form inputs throughout the DAW.
 *
 * @example
 * ```tsx
 * // Default modal input with label
 * <Input
 *   variant="default"
 *   size="md"
 *   fullWidth
 *   label="Project Name"
 *   value={projectName}
 *   onChange={(e) => setProjectName(e.target.value)}
 *   placeholder="Untitled Project"
 * />
 *
 * // Compact BPM input
 * <Input
 *   type="text"
 *   variant="compact"
 *   size="xs"
 *   centerText
 *   value={tempo}
 *   onChange={(e) => setTempo(e.target.value)}
 *   className="w-12"
 * />
 *
 * // Inline track name input
 * <Input
 *   variant="inline"
 *   size="sm"
 *   value={trackName}
 *   onChange={(e) => setTrackName(e.target.value)}
 * />
 *
 * // Number input with unit
 * <Input
 *   type="number"
 *   variant="default"
 *   size="md"
 *   label="Tempo"
 *   unit="BPM"
 *   min={20}
 *   max={300}
 *   value={tempo}
 * />
 * ```
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      size = 'md',
      variant = 'default',
      fullWidth = false,
      label,
      helperText,
      error,
      disabled = false,
      required = false,
      unit,
      centerText = false,
      className,
      inputClassName,
      ...rest
    },
    ref
  ) => {
    const inputClasses = classNames(
      inputSizeStyles[size],
      inputVariantStyles[variant],
      centerText && 'text-center',
      fullWidth && 'w-full',
      error && 'border-red-500 focus:border-red-500',
      disabled && 'opacity-50 cursor-not-allowed',
      unit && 'pr-8', // Add right padding for unit suffix
      inputClassName
    );

    const WrapperComponent = label ? 'div' : 'span';

    return (
      <WrapperComponent className={className}>
        {label && (
          <label className="block text-sm font-medium text-daw-text-muted mb-1">
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}

        <div className="relative inline-flex items-center w-full">
          <input
            ref={ref}
            disabled={disabled}
            className={inputClasses}
            {...rest}
          />

          {unit && (
            <span className="absolute right-2 text-daw-text-muted text-xs pointer-events-none">
              {unit}
            </span>
          )}
        </div>

        {error && (
          <span className="block text-xs text-red-500 mt-1">{error}</span>
        )}

        {helperText && !error && (
          <span className="block text-xs text-daw-text-muted mt-1">{helperText}</span>
        )}
      </WrapperComponent>
    );
  }
);

Input.displayName = 'Input';
