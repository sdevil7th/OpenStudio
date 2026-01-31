import { InputHTMLAttributes } from 'react';

/**
 * Slider orientation
 */
export type SliderOrientation = 'horizontal' | 'vertical';

/**
 * Slider variant
 */
export type SliderVariant = 'default' | 'fader' | 'pan';

/**
 * Slider component props
 */
export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'onChange'> {
  /**
   * Minimum value
   * @default 0
   */
  min?: number;

  /**
   * Maximum value
   * @default 100
   */
  max?: number;

  /**
   * Step increment
   * @default 1
   */
  step?: number;

  /**
   * Current value
   */
  value?: number;

  /**
   * Change handler
   */
  onChange?: (value: number) => void;

  /**
   * Slider orientation
   * @default 'horizontal'
   */
  orientation?: SliderOrientation;

  /**
   * Visual variant
   * @default 'default'
   */
  variant?: SliderVariant;

  /**
   * Height (for vertical sliders)
   */
  height?: string;

  /**
   * Width (for horizontal sliders)
   */
  width?: string;

  /**
   * Show current value
   * @default false
   */
  showValue?: boolean;

  /**
   * Format value for display
   */
  formatValue?: (value: number) => string;

  /**
   * Additional custom class names
   */
  className?: string;
}
