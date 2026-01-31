import { InputHTMLAttributes } from 'react';

/**
 * Checkbox size variants
 */
export type CheckboxSize = 'sm' | 'md' | 'lg';

/**
 * Checkbox component props
 */
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'className'> {
  /**
   * Label text
   */
  label?: string;

  /**
   * Size variant
   * @default 'md'
   */
  size?: CheckboxSize;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Error message
   */
  error?: string;

  /**
   * Additional custom class names
   */
  className?: string;
}

/**
 * Size style mappings
 */
export const checkboxSizeStyles: Record<CheckboxSize, string> = {
  'sm': 'w-3 h-3',
  'md': 'w-4 h-4',
  'lg': 'w-5 h-5',
};
