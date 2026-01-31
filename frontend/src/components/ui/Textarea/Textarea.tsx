import classNames from 'classnames';
import { forwardRef } from 'react';
import { TextareaProps, textareaSizeStyles } from './Textarea.types';

/**
 * Textarea Component
 *
 * A styled textarea component for multi-line text input.
 * Used for project notes and other long-form text fields.
 *
 * @example
 * ```tsx
 * // Project notes
 * <Textarea
 *   label="Project Notes"
 *   rows={4}
 *   value={projectNotes}
 *   onChange={(e) => setProjectNotes(e.target.value)}
 *   placeholder="Add notes about this project..."
 * />
 *
 * // With error
 * <Textarea
 *   label="Description"
 *   error="Description is required"
 *   required
 * />
 * ```
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      size = 'md',
      fullWidth = false,
      label,
      helperText,
      error,
      disabled = false,
      required = false,
      className,
      textareaClassName,
      ...rest
    },
    ref
  ) => {
    const textareaClasses = classNames(
      textareaSizeStyles[size],
      'bg-daw-darker border border-daw-border text-daw-text',
      'focus:outline-none focus:border-blue-500',
      'rounded resize-none',
      fullWidth && 'w-full',
      error && 'border-red-500 focus:border-red-500',
      disabled && 'opacity-50 cursor-not-allowed',
      textareaClassName
    );

    return (
      <div className={className}>
        {label && (
          <label className="block text-sm font-medium text-daw-text-muted mb-1">
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}

        <textarea
          ref={ref}
          disabled={disabled}
          className={textareaClasses}
          {...rest}
        />

        {error && (
          <span className="block text-xs text-red-500 mt-1">{error}</span>
        )}

        {helperText && !error && (
          <span className="block text-xs text-daw-text-muted mt-1">{helperText}</span>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';
