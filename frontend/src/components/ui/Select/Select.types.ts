/**
 * Select size variants
 */
export type SelectSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Select visual variants
 */
export type SelectVariant = 'default' | 'compact' | 'accent';

/**
 * Option type for select dropdown
 */
export interface SelectOption {
  /**
   * Option value
   */
  value: string | number;

  /**
   * Display label
   */
  label: string;

  /**
   * Disabled state for this option
   */
  disabled?: boolean;
}

/**
 * Select component props
 */
export interface SelectProps {
  /**
   * Array of options
   */
  options: SelectOption[];

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
  size?: SelectSize;

  /**
   * Visual variant
   * @default 'default'
   */
  variant?: SelectVariant;

  /**
   * Make select full width
   * @default false
   */
  fullWidth?: boolean;

  /**
   * Label text
   */
  label?: string;

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

  /**
   * Placeholder text when no value selected
   */
  placeholder?: string;

  /**
   * Tooltip text shown on hover
   */
  title?: string;
}

/**
 * Size style mappings
 */
export const selectSizeStyles: Record<SelectSize, string> = {
  'xs': 'h-5 pl-1.5 pr-5 py-0.5 text-[10px]',
  'sm': 'h-6 pl-2 pr-6 py-1 text-xs',
  'md': 'h-8 pl-3 pr-7 py-1.5 text-sm',
  'lg': 'h-10 pl-4 pr-8 py-2 text-base',
};

/**
 * Variant style mappings for button/trigger
 */
export const selectVariantStyles: Record<SelectVariant, string> = {
  'default': 'bg-daw-darker border border-daw-border text-daw-text focus:outline-none focus:border-blue-500',
  'compact': 'bg-neutral-800 border border-neutral-700 text-neutral-400 focus:outline-none',
  'accent': 'bg-emerald-700 border border-emerald-600 text-white focus:outline-none',
};

/**
 * Variant style mappings for options dropdown
 */
export const selectOptionsVariantStyles: Record<SelectVariant, string> = {
  'default': 'bg-daw-panel border border-daw-border',
  'compact': 'bg-neutral-900 border border-neutral-700',
  'accent': 'bg-emerald-800 border border-emerald-600',
};
