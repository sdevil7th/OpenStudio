import { X } from 'lucide-react';
import { ModalHeaderProps } from './Modal.types';
import { Button } from '../Button';

/**
 * Modal Header Component
 *
 * A reusable header component for modals when you need more control than the built-in Modal header.
 *
 * @example
 * ```tsx
 * <Modal isOpen={isOpen} onClose={handleClose}>
 *   <ModalHeader title="Settings" onClose={handleClose} />
 *   <ModalContent>...</ModalContent>
 * </Modal>
 * ```
 */
export function ModalHeader({
  title,
  onClose,
  showCloseButton = true,
}: ModalHeaderProps) {
  return (
    <div className="flex items-center justify-between p-4 border-b border-daw-border">
      <h2 className="text-lg font-semibold text-daw-text">{title}</h2>
      {showCloseButton && onClose && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close modal"
        >
          <X size={16} />
        </Button>
      )}
    </div>
  );
}
