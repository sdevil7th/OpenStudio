import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { X } from 'lucide-react';
import { Fragment } from 'react';
import classNames from 'classnames';
import { ModalProps, modalSizeStyles } from './Modal.types';
import { Button } from '../Button';

/**
 * Modal Component
 *
 * A modal dialog component built on Headless UI Dialog.
 * Handles focus trap, backdrop, escape key, and accessibility automatically.
 * Used for settings, configurations, and other dialog interactions.
 *
 * @example
 * ```tsx
 * // Basic modal with title and footer
 * <Modal
 *   isOpen={isOpen}
 *   onClose={handleClose}
 *   size="md"
 *   title="Project Settings"
 *   footer={
 *     <>
 *       <Button variant="secondary" onClick={handleCancel}>
 *         Cancel
 *       </Button>
 *       <Button variant="primary" onClick={handleApply}>
 *         Apply
 *       </Button>
 *     </>
 *   }
 * >
 *   <div className="space-y-4">
 *     { /* Modal content here }
 *   </div>
 * </Modal>
 *
 * // Custom modal without built-in header/footer
 * <Modal
 *   isOpen={isOpen}
 *   onClose={handleClose}
 *   size="lg"
 * >
 *   <ModalHeader title="Custom Modal" onClose={handleClose} />
 *   <ModalContent>
 *     {/* Custom content here }
 *   </ModalContent>
 *   <ModalFooter>
 *     <Button onClick={handleClose}>Close</Button>
 *   </ModalFooter>
 * </Modal>
 * ```
 */
export function Modal({
  isOpen,
  onClose,
  size = 'md',
  fullHeight = false,
  title,
  children,
  footer,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  className,
}: ModalProps) {
  // Handle close based on user preferences
  // Note: Headless UI Dialog's onClose is triggered for both escape key and backdrop clicks
  // We can't distinguish between them, so we use the most restrictive setting
  const handleClose = () => {
    if (closeOnEscape || closeOnOverlayClick) {
      onClose();
    }
  };

  return (
    <Transition show={isOpen} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-2000"
        onClose={handleClose}
        static={!closeOnEscape && !closeOnOverlayClick}
        aria-label={title ? undefined : 'Dialog'}
      >
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div
            className="fixed inset-0 bg-black/50"
            aria-hidden="true"
          />
        </TransitionChild>

        {/* Modal container */}
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel
              className={classNames(
                'bg-daw-panel border border-daw-border rounded-lg shadow-xl',
                modalSizeStyles[size],
                fullHeight && 'max-h-[90vh]',
                'overflow-y-auto',
                className
              )}
            >
              {/* Header */}
              {title && (
                <div className="flex items-center justify-between p-4 border-b border-daw-border">
                  <DialogTitle className="text-lg font-semibold text-daw-text">
                    {title}
                  </DialogTitle>
                  {showCloseButton && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={onClose}
                      title="Close modal"
                      aria-label="Close modal"
                    >
                      <X size={16} />
                    </Button>
                  )}
                </div>
              )}

              {/* Content */}
              <div className="p-4">{children}</div>

              {/* Footer */}
              {footer && (
                <div className="flex justify-end gap-2 p-4 border-t border-daw-border">
                  {footer}
                </div>
              )}
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}
