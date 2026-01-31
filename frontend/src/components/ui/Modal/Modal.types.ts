import { ReactNode } from 'react';

/**
 * Modal size variants
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Modal component props
 */
export interface ModalProps {
  /**
   * Whether the modal is open
   */
  isOpen: boolean;

  /**
   * Close handler
   */
  onClose: () => void;

  /**
   * Modal size
   * @default 'md'
   */
  size?: ModalSize;

  /**
   * Use max height (90vh)
   * @default false
   */
  fullHeight?: boolean;

  /**
   * Modal title
   */
  title?: string;

  /**
   * Modal content
   */
  children: ReactNode;

  /**
   * Footer content (typically buttons)
   */
  footer?: ReactNode;

  /**
   * Close on overlay click
   * @default true
   */
  closeOnOverlayClick?: boolean;

  /**
   * Close on Escape key
   * @default true
   */
  closeOnEscape?: boolean;

  /**
   * Show close button in header
   * @default true
   */
  showCloseButton?: boolean;

  /**
   * Additional custom class names
   */
  className?: string;
}

/**
 * Modal header props
 */
export interface ModalHeaderProps {
  /**
   * Header title
   */
  title: string;

  /**
   * Close handler
   */
  onClose?: () => void;

  /**
   * Show close button
   * @default true
   */
  showCloseButton?: boolean;
}

/**
 * Modal content props
 */
export interface ModalContentProps {
  /**
   * Content children
   */
  children: ReactNode;

  /**
   * Additional custom class names
   */
  className?: string;
}

/**
 * Modal footer props
 */
export interface ModalFooterProps {
  /**
   * Footer children (typically buttons)
   */
  children: ReactNode;

  /**
   * Additional custom class names
   */
  className?: string;
}

/**
 * Size style mappings
 */
export const modalSizeStyles: Record<ModalSize, string> = {
  'sm': 'w-[400px]',
  'md': 'w-[600px]',
  'lg': 'w-[700px]',
  'xl': 'w-[900px]',
};
