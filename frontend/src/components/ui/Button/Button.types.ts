import { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Button size variants
 * - xs, sm, md, lg: Text buttons with padding
 * - icon-sm, icon-md, icon-lg: Icon-only buttons (square)
 */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon-xs' | 'icon-sm' | 'icon-md' | 'icon-lg';

/**
 * Button visual variants
 * Maps to semantic meanings across the DAW application
 */
export type ButtonVariant =
  | 'default'   // Neutral gray buttons
  | 'primary'   // Blue accent (modal primary actions)
  | 'secondary' // Lighter gray (modal cancel)
  | 'success'   // Green (mute, play)
  | 'warning'   // Yellow (solo, metronome)
  | 'danger'    // Red (record)
  | 'purple'    // Purple (loop)
  | 'orange'    // Orange (phase invert)
  | 'emerald'   // Emerald (input routing display)
  | 'ghost';    // Minimal styling (hover only)

/**
 * Button shape variants
 */
export type ButtonShape = 'default' | 'circle' | 'square';

/**
 * Active state styling effects
 */
export type ActiveStyle = 'solid' | 'glow' | 'subtle';

/**
 * Button component props
 */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /**
   * Visual style variant
   * @default 'default'
   */
  variant?: ButtonVariant;

  /**
   * Button size (text buttons use md/lg, icon buttons use icon-sm/md/lg)
   * @default 'md'
   */
  size?: ButtonSize;

  /**
   * Shape of the button
   * @default 'default'
   */
  shape?: ButtonShape;

  /**
   * Active/pressed state
   * @default false
   */
  active?: boolean;

  /**
   * Loading state (shows spinner)
   * @default false
   */
  loading?: boolean;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Button content
   */
  children?: ReactNode;

  /**
   * Optional icon element
   */
  icon?: ReactNode;

  /**
   * Icon position relative to text
   * @default 'left'
   */
  iconPosition?: 'left' | 'right' | 'only';

  /**
   * Active state effect style
   * @default 'solid'
   */
  activeStyle?: ActiveStyle;

  /**
   * Make button full width
   * @default false
   */
  fullWidth?: boolean;

  /**
   * Additional custom class names
   */
  className?: string;

  /**
   * Click handler
   */
  onClick?: () => void;

  /**
   * Accessible title/tooltip
   */
  title?: string;
}

/**
 * Size style mappings
 */
export const buttonSizeStyles: Record<ButtonSize, string> = {
  'xs': 'h-5 px-1.5 text-[10px]',
  'sm': 'h-6 px-2 text-[11px]',
  'md': 'h-8 px-3 text-sm',
  'lg': 'h-10 px-4 text-base',
  'icon-xs': 'w-4 h-6 text-[10px]',
  'icon-sm': 'w-6 h-6 text-[10px]',
  'icon-md': 'w-7 h-7 text-xs',
  'icon-lg': 'w-8 h-8 text-sm',
};

/**
 * Variant base styles (inactive state)
 */
export const buttonVariantStyles: Record<ButtonVariant, string> = {
  'default': 'bg-neutral-800 text-neutral-400 border border-neutral-700 hover:bg-neutral-700/50 hover:text-neutral-200 hover:border-neutral-600',
  'primary': 'bg-blue-600 text-white hover:bg-blue-500 font-medium',
  'secondary': 'bg-daw-darker border border-daw-border text-daw-text hover:bg-daw-lighter',
  'success': 'bg-neutral-800 text-green-500 border border-neutral-700 hover:bg-green-900/40 hover:text-green-400 hover:border-green-700',
  'warning': 'bg-neutral-800 text-yellow-500 border border-neutral-700 hover:bg-yellow-900/40 hover:text-yellow-400 hover:border-yellow-700',
  'danger': 'bg-neutral-800 text-red-500 border border-neutral-700 hover:bg-red-900/40 hover:text-red-400 hover:border-red-700',
  'purple': 'bg-neutral-800 text-purple-500 border border-neutral-700 hover:bg-purple-900/40 hover:text-purple-400 hover:border-purple-700',
  'orange': 'bg-neutral-800 text-orange-400 border border-neutral-600 hover:bg-orange-900/40 hover:text-orange-300 hover:border-orange-700',
  'emerald': 'bg-emerald-700 border border-emerald-600 text-white hover:bg-emerald-600',
  'ghost': 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/40',
};

/**
 * Variant active styles (when active prop is true)
 */
export const buttonActiveStyles: Record<ButtonVariant, string> = {
  'default': 'bg-neutral-600 text-white border border-neutral-400 hover:bg-neutral-500',
  'primary': 'bg-blue-700 text-white hover:bg-blue-600',
  'secondary': 'bg-daw-lighter text-white',
  'success': 'bg-green-700 text-white border border-green-600 hover:bg-green-600',
  'warning': 'bg-yellow-500 text-black border border-yellow-600 hover:bg-yellow-400',
  'danger': 'bg-red-600 text-white border border-red-500 hover:bg-red-500 hover:border-red-400',
  'purple': 'bg-purple-700 text-white border border-purple-600 hover:bg-purple-600',
  'orange': 'bg-orange-500 text-black border border-orange-400 hover:bg-orange-400',
  'emerald': 'bg-emerald-600 text-white hover:bg-emerald-500',
  'ghost': 'bg-neutral-600 text-white hover:bg-neutral-500',
};

/**
 * Active style effect mappings
 */
export const activeEffectStyles: Record<ActiveStyle, string> = {
  'solid': '',
  'glow': 'shadow-[0_0_8px_rgba(229,57,53,0.5)]',  // Red glow for record arm
  'subtle': 'shadow-[0_0_5px_rgba(255,255,255,0.1)]',
};

/**
 * Shape style mappings
 */
export const shapeStyles: Record<ButtonShape, string> = {
  'default': 'rounded',
  'circle': 'rounded-full',
  'square': 'rounded-none',
};
