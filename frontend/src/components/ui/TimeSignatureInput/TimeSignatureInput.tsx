import { useState, useEffect, KeyboardEvent } from 'react';
import classNames from 'classnames';
import {
  TimeSignatureInputProps,
  timeSignatureSizeStyles,
} from './TimeSignatureInput.types';

/**
 * TimeSignatureInput Component
 *
 * A specialized input for entering musical time signatures (e.g., 4/4, 3/4, 6/8).
 * Features blur-based validation and revert-on-invalid behavior.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <TimeSignatureInput
 *   numerator={4}
 *   denominator={4}
 *   onChange={(num, denom) => setTimeSignature(num, denom)}
 * />
 *
 * // With label and compact size
 * <TimeSignatureInput
 *   numerator={timeSignature.numerator}
 *   denominator={timeSignature.denominator}
 *   onNumeratorChange={(val) => setTimeSignature(val, timeSignature.denominator)}
 *   onDenominatorChange={(val) => setTimeSignature(timeSignature.numerator, val)}
 *   showLabel
 *   size="xs"
 * />
 * ```
 */
export function TimeSignatureInput({
  numerator,
  denominator,
  onNumeratorChange,
  onDenominatorChange,
  onChange,
  size = 'sm',
  showLabel = false,
  label = 'Time Sig',
  disabled = false,
  validDenominators = [1, 2, 4, 8, 16, 32],
  numeratorRange = { min: 1, max: 32 },
  className,
}: TimeSignatureInputProps) {
  // Local state for controlled inputs
  const [tempNumerator, setTempNumerator] = useState(numerator.toString());
  const [tempDenominator, setTempDenominator] = useState(denominator.toString());

  // Sync local state when props change
  useEffect(() => {
    setTempNumerator(numerator.toString());
  }, [numerator]);

  useEffect(() => {
    setTempDenominator(denominator.toString());
  }, [denominator]);

  const handleNumeratorBlur = () => {
    const val = parseInt(tempNumerator, 10);
    if (isNaN(val) || val < numeratorRange.min || val > numeratorRange.max) {
      // Revert to current value
      setTempNumerator(numerator.toString());
    } else {
      onNumeratorChange?.(val);
      onChange?.(val, denominator);
    }
  };

  const handleDenominatorBlur = () => {
    const val = parseInt(tempDenominator, 10);
    if (isNaN(val) || !validDenominators.includes(val)) {
      // Revert to current value
      setTempDenominator(denominator.toString());
    } else {
      onDenominatorChange?.(val);
      onChange?.(numerator, val);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  const styles = timeSignatureSizeStyles[size];

  const inputClasses = classNames(
    styles.input,
    'bg-transparent text-center text-white focus:outline-none',
    disabled && 'opacity-50 cursor-not-allowed'
  );

  return (
    <div className={classNames('flex flex-col items-center', className)}>
      {showLabel && (
        <span className={classNames(styles.label, 'text-neutral-500 uppercase mb-0.5')}>
          {label}
        </span>
      )}
      <div
        className={classNames(
          'flex items-center bg-neutral-800 border border-neutral-700 rounded',
          styles.container
        )}
      >
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          className={inputClasses}
          value={tempNumerator}
          onChange={(e) => setTempNumerator(e.target.value)}
          onBlur={handleNumeratorBlur}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          title={`Beats per bar (${numeratorRange.min}-${numeratorRange.max})`}
        />
        <span className={classNames(styles.separator, 'text-neutral-500')}>/</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          className={inputClasses}
          value={tempDenominator}
          onChange={(e) => setTempDenominator(e.target.value)}
          onBlur={handleDenominatorBlur}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          title={`Beat value (${validDenominators.join(', ')})`}
        />
      </div>
    </div>
  );
}
