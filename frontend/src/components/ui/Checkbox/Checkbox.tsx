import classNames from 'classnames';
import { forwardRef } from 'react';
import { CheckboxProps, checkboxSizeStyles } from './Checkbox.types';

/**
 * Checkbox Component
 *
 * A styled checkbox component for boolean options.
 * Used in modals and settings for toggleable options.
 *
 * @example
 * ```tsx
 * // With label
 * <Checkbox
 *   label="Normalize"
 *   checked={normalize}
 *   onChange={(e) => setNormalize(e.target.checked)}
 * />
 *
 * // Standalone
 * <Checkbox
 *   checked={enabled}
 *   onChange={(e) => setEnabled(e.target.checked)}
 * />
 *
 * // Disabled
 * <Checkbox
 *   label="Dither"
 *   checked={dither}
 *   disabled
 * />
 * ```
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      label,
      size = 'md',
      disabled = false,
      error,
      className,
      ...rest
    },
    ref
  ) => {
    const checkboxClasses = classNames(
      checkboxSizeStyles[size],
      'rounded cursor-pointer',
      'accent-blue-600',
      disabled && 'opacity-50 cursor-not-allowed',
    );

    const WrapperComponent = label ? 'label' : 'span';

    return (
      <WrapperComponent className={classNames('inline-flex items-center gap-2', className)}>
        <input
          ref={ref}
          type="checkbox"
          disabled={disabled}
          className={checkboxClasses}
          {...rest}
        />

        {label && (
          <span className={classNames(
            'text-sm text-daw-text select-none',
            disabled && 'opacity-50'
          )}>
            {label}
          </span>
        )}

        {error && (
          <span className="block text-xs text-red-500 mt-1">{error}</span>
        )}
      </WrapperComponent>
    );
  }
);

Checkbox.displayName = 'Checkbox';
