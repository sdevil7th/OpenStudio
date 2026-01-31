import { InputHTMLAttributes } from 'react';

/**
 * Input size variants
 */
export type InputSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Input visual variants
 */
export type InputVariant = 'default' | 'inline' | 'transparent' | 'compact';

/**
 * Input component props
 */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className'> {
  /**
   * Input size
   * @default 'md'
   */
  size?: InputSize;

  /**
   * Visual variant
   * @default 'default'
   */
  variant?: InputVariant;

  /**
   * Make input full width
   * @default false
   */
  fullWidth?: boolean;

  /**
   * Label text
   */
  label?: string;

  /**
   * Helper text below input
   */
  helperText?: string;

  /**
   * Error message (replaces helper text)
   */
  error?: string;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Required field indicator
   * @default false
   */
  required?: boolean;

  /**
   * Unit suffix (e.g., "BPM", "ms", "Hz")
   */
  unit?: string;

  /**
   * Center text alignment
   * @default false
   */
  centerText?: boolean;

  /**
   * Additional custom class names
   */
  className?: string;

  /**
   * Additional class names for the input element itself
   */
  inputClassName?: string;
}

/**
 * Size style mappings
 */
export const inputSizeStyles: Record<InputSize, string> = {
  'xs': 'h-5 px-1 text-[10px]',
  'sm': 'h-6 px-2 text-xs',
  'md': 'h-8 px-3 text-sm',
  'lg': 'h-10 px-4 text-base',
};

/**
 * Variant style mappings
 */
export const inputVariantStyles: Record<InputVariant, string> = {
  'default': 'bg-daw-darker border border-daw-border text-daw-text focus:outline-none focus:border-blue-500 rounded',
  'inline': 'bg-neutral-700 border-none text-white rounded focus:outline-none focus:ring-1 focus:ring-neutral-500',
  'transparent': 'bg-transparent border-none text-white focus:outline-none',
  'compact': 'bg-neutral-900 border border-neutral-700 text-neutral-400 focus:outline-none focus:border-blue-600 rounded',
};
