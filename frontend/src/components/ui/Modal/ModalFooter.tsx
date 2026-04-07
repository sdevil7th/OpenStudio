import classNames from 'classnames';
import { ModalFooterProps } from './Modal.types';

/**
 * Modal Footer Component
 *
 * A wrapper component for modal footer with action buttons.
 *
 * @example
 * ```tsx
 * <Modal isOpen={isOpen} onClose={handleClose}>
 *   <ModalHeader title="Settings" onClose={handleClose} />
 *   <ModalContent>...</ModalContent>
 *   <ModalFooter>
 *     <Button variant="secondary" onClick={handleCancel}>
 *       Cancel
 *     </Button>
 *     <Button variant="primary" onClick={handleApply}>
 *       Apply
 *     </Button>
 *   </ModalFooter>
 * </Modal>
 * ```
 */
export function ModalFooter({ children, className }: ModalFooterProps) {
  return (
    <div className={classNames('sticky bottom-0 flex shrink-0 justify-end gap-2 border-t border-daw-border bg-daw-panel p-4', className)}>
      {children}
    </div>
  );
}
