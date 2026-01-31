/**
 * TimeSignatureInput component types
 */

export type TimeSignatureInputSize = 'xs' | 'sm' | 'md';

export interface TimeSignatureInputProps {
  /**
   * Time signature numerator (beats per bar)
   */
  numerator: number;

  /**
   * Time signature denominator (beat value: 2, 4, 8, 16, etc.)
   */
  denominator: number;

  /**
   * Callback when numerator changes
   */
  onNumeratorChange?: (value: number) => void;

  /**
   * Callback when denominator changes
   */
  onDenominatorChange?: (value: number) => void;

  /**
   * Combined callback when either value changes
   */
  onChange?: (numerator: number, denominator: number) => void;

  /**
   * Size variant
   * @default 'sm'
   */
  size?: TimeSignatureInputSize;

  /**
   * Show label above the input
   * @default false
   */
  showLabel?: boolean;

  /**
   * Label text
   * @default 'Time Sig'
   */
  label?: string;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Valid denominator values
   * @default [1, 2, 4, 8, 16, 32]
   */
  validDenominators?: number[];

  /**
   * Min/max numerator values
   * @default { min: 1, max: 32 }
   */
  numeratorRange?: { min: number; max: number };

  /**
   * Additional class name
   */
  className?: string;
}

/**
 * Size style mappings
 */
export const timeSignatureSizeStyles: Record<TimeSignatureInputSize, {
  container: string;
  input: string;
  separator: string;
  label: string;
}> = {
  xs: {
    container: 'px-1 gap-0.5',
    input: 'w-4 text-xs',
    separator: 'text-xs',
    label: 'text-[8px]',
  },
  sm: {
    container: 'px-1 gap-1',
    input: 'w-5 text-sm',
    separator: 'text-sm',
    label: 'text-[9px]',
  },
  md: {
    container: 'px-2 gap-1',
    input: 'w-6 text-base',
    separator: 'text-base',
    label: 'text-xs',
  },
};
