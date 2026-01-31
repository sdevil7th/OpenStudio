/**
 * NativeSelect component types
 *
 * A simpler select component that works well with dynamically-loaded options
 * and accepts both simple arrays and structured options.
 */

export type NativeSelectSize = 'xs' | 'sm' | 'md' | 'lg';
export type NativeSelectVariant = 'default' | 'compact' | 'dark';

export interface NativeSelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export interface NativeSelectProps {
  /**
   * Select options - can be:
   * - Array of strings (auto-transformed to {value, label})
   * - Array of numbers (auto-transformed to {value, label})
   * - Array of {value, label, disabled?} objects
   */
  options: (string | number | NativeSelectOption)[];

  /**
   * Current selected value
   */
  value?: string | number;

  /**
   * Change handler
   */
  onChange?: (value: string | number) => void;

  /**
   * Size variant
   * @default 'md'
   */
  size?: NativeSelectSize;

  /**
   * Visual variant
   * @default 'default'
   */
  variant?: NativeSelectVariant;

  /**
   * Placeholder text when no value is selected
   */
  placeholder?: string;

  /**
   * Show placeholder as first disabled option
   * @default true
   */
  showPlaceholder?: boolean;

  /**
   * Full width mode
   * @default false
   */
  fullWidth?: boolean;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Loading state (shows "--" and disables)
   * @default false
   */
  loading?: boolean;

  /**
   * Label text
   */
  label?: string;

  /**
   * Error message
   */
  error?: string;

  /**
   * Format function for option labels
   * Useful for adding units like "Hz" or "samples"
   */
  formatLabel?: (value: string | number) => string;

  /**
   * Additional class name for the select element
   */
  className?: string;

  /**
   * Title attribute for tooltip
   */
  title?: string;
}

/**
 * Size style mappings
 */
export const nativeSelectSizeStyles: Record<NativeSelectSize, string> = {
  xs: 'h-5 px-1 text-[10px]',
  sm: 'h-6 px-1.5 text-[11px]',
  md: 'h-8 px-2 text-sm',
  lg: 'h-10 px-3 text-base',
};

/**
 * Variant style mappings
 */
export const nativeSelectVariantStyles: Record<NativeSelectVariant, string> = {
  default: 'bg-neutral-800 border border-neutral-700 text-neutral-200 focus:outline-none focus:border-blue-500',
  compact: 'bg-black/30 border border-white/10 text-white focus:outline-none focus:border-cyan-400',
  dark: 'bg-neutral-900 border border-neutral-600 text-white focus:outline-none focus:border-blue-500',
};
