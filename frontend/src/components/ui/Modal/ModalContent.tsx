import classNames from 'classnames';
import { forwardRef } from 'react';
import { ModalContentProps } from './Modal.types';

/**
 * Modal Content Component
 *
 * A wrapper component for modal content with consistent padding.
 *
 * @example
 * ```tsx
 * <Modal isOpen={isOpen} onClose={handleClose}>
 *   <ModalHeader title="Settings" onClose={handleClose} />
 *   <ModalContent>
 *     <div className="space-y-4">
 *       {/* Content here }
 *     </div>
 *   </ModalContent>
 * </Modal>
 * ```
 */
export const ModalContent = forwardRef<HTMLDivElement, ModalContentProps>(
  ({ children, className }, ref) => (
    <div
      ref={ref}
      data-modal-scroll="true"
      className={classNames('min-h-0 flex-1 overflow-y-auto p-4', className)}
    >
      {children}
    </div>
  ),
);

ModalContent.displayName = 'ModalContent';
