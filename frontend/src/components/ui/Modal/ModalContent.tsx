import classNames from 'classnames';
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
export function ModalContent({ children, className }: ModalContentProps) {
  return <div className={classNames('min-h-0 flex-1 overflow-y-auto p-4', className)}>{children}</div>;
}
