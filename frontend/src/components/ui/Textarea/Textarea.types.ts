import { TextareaHTMLAttributes } from 'react';

/**
 * Textarea size variants
 */
export type TextareaSize = 'sm' | 'md' | 'lg';

/**
 * Textarea component props
 */
export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  /**
   * Size variant
   * @default 'md'
   */
  size?: TextareaSize;

  /**
   * Make textarea full width
   * @default false
   */
  fullWidth?: boolean;

  /**
   * Label text
   */
  label?: string;

  /**
   * Helper text below textarea
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
   * Additional custom class names
   */
  className?: string;

  /**
   * Additional class names for the textarea element itself
   */
  textareaClassName?: string;
}

/**
 * Size style mappings
 */
export const textareaSizeStyles: Record<TextareaSize, string> = {
  'sm': 'px-2 py-1 text-xs',
  'md': 'px-3 py-2 text-sm',
  'lg': 'px-4 py-3 text-base',
};
