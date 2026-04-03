import classNames from 'classnames';
import React, { forwardRef } from 'react';
import {
  ButtonProps,
  buttonSizeStyles,
  buttonVariantStyles,
  buttonActiveStyles,
  activeEffectStyles,
  shapeStyles,
} from './Button.types';

/**
 * Button Component
 *
 * A versatile button component supporting multiple variants, sizes, and states.
 * Used throughout the DAW for transport controls, track controls, and modal actions.
 *
 * @example
 * ```tsx
 * // Transport play button
 * <Button variant="success" size="icon-lg" active={isPlaying}>
 *   ▶
 * </Button>
 *
 * // Modal primary action
 * <Button variant="primary" size="md" onClick={handleSave}>
 *   Save
 * </Button>
 *
 * // Icon with text
 * <Button variant="default" size="md" icon={<Save size={16} />}>
 *   Save Project
 * </Button>
 *
 * // Record arm button with glow effect
 * <Button
 *   variant="danger"
 *   size="icon-md"
 *   shape="circle"
 *   active={armed}
 *   activeStyle="glow"
 * >
 *   ●
 * </Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'default',
      size = 'md',
      shape = 'default',
      active = false,
      loading = false,
      disabled = false,
      children,
      icon,
      iconPosition = 'left',
      activeStyle = 'solid',
      fullWidth = false,
      className,
      onClick,
      title,
      ...rest
    },
    ref
  ) => {
    const isIconOnly = iconPosition === 'only' || (!children && icon);

    const buttonClasses = classNames(
      // Base styles
      'inline-flex items-center justify-center font-bold transition-all hover:cursor-pointer active:scale-[0.97]',

      // Disable user select to prevent text selection on click
      'select-none',

      // Size
      buttonSizeStyles[size],

      // Variant (active or inactive)
      active ? buttonActiveStyles[variant] : buttonVariantStyles[variant],

      // Active effects (glow, subtle)
      active && activeStyle !== 'solid' && activeEffectStyles[activeStyle],

      // Shape
      shapeStyles[shape],

      // Layout
      fullWidth && 'w-full',

      // State
      disabled && 'disabled:opacity-50 disabled:cursor-not-allowed',
      loading && 'cursor-wait opacity-75',

      // Custom classes
      className
    );

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!disabled && !loading && onClick) {
        onClick(e);
      }
    };

    return (
      <button
        ref={ref}
        className={buttonClasses}
        disabled={disabled || loading}
        onClick={handleClick}
        title={title}
        type="button"
        aria-pressed={active ? true : undefined}
        {...rest}
      >
        {loading ? (
          <span className="animate-spin">⏳</span>
        ) : (
          <>
            {/* Icon on left or icon only */}
            {icon && (iconPosition === 'left' || isIconOnly) && (
              <span className={classNames('flex items-center justify-center', !isIconOnly && 'mr-1.5')}>
                {icon}
              </span>
            )}

            {/* Button text */}
            {children}

            {/* Icon on right */}
            {icon && iconPosition === 'right' && !isIconOnly && (
              <span className="flex items-center justify-center ml-1.5">
                {icon}
              </span>
            )}
          </>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
