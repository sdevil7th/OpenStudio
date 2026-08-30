import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { X } from 'lucide-react';
import { Fragment } from 'react';
import classNames from 'classnames';
import { ModalProps, modalSizeStyles } from './Modal.types';
import { Button } from '../Button';
import {
  guardModalContextMenu,
  guardModalPointerEvent,
} from '../../../utils/modalEventGuards';
import {
  routeModalShortcutEvent,
  useModalShortcutScope,
} from '../../../utils/modalShortcutScope';
import { activateShortcutContext } from '../../../utils/shortcutContext';

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
  useModalShortcutScope(isOpen, onClose, closeOnEscape);

  // Keyboard closure is owned by modal.close below. Headless UI's onClose is
  // retained only for its outside-click path, so unassigning/rebinding the
  // action cannot be bypassed by the library's built-in raw-Escape handler.
  const handleClose = () => {
    if (closeOnOverlayClick) {
      onClose();
    }
  };

  return (
    <Transition show={isOpen} as={Fragment}>
      <Dialog
        as="div"
        className="fixed inset-0 z-[10000]"
        data-modal-root="true"
        onClose={handleClose}
        onContextMenu={guardModalContextMenu}
        onPointerDownCapture={() => activateShortcutContext({ kind: 'modal' })}
        onFocusCapture={() => activateShortcutContext({ kind: 'modal' })}
        onKeyDown={(event) => {
          const routed = routeModalShortcutEvent(event.nativeEvent);
          if (routed.result !== 'unmatched') event.preventDefault();
          if (routed.result !== 'unmatched' || routed.suppressedHeadlessEscape) {
            // Also mark the React synthetic event. Native stopImmediatePropagation
            // suppresses Headless UI, while this prevents a nested Dialog's key
            // from continuing through React to an outer modal owner.
            event.stopPropagation();
          }
        }}
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
            data-modal-overlay="true"
            className="fixed inset-0 bg-black/50"
            aria-hidden="true"
            onContextMenu={guardModalContextMenu}
          />
        </TransitionChild>

        {/* Modal container */}
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          data-modal-overlay="true"
          onContextMenu={guardModalContextMenu}
        >
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
              data-modal-panel="true"
              onContextMenu={guardModalContextMenu}
              onMouseDown={guardModalPointerEvent}
              onMouseMove={guardModalPointerEvent}
              onMouseUp={guardModalPointerEvent}
              onPointerDown={guardModalPointerEvent}
              onPointerMove={guardModalPointerEvent}
              onPointerUp={guardModalPointerEvent}
              className={classNames(
                'bg-daw-panel border border-daw-border rounded-lg shadow-xl',
                modalSizeStyles[size],
                fullHeight ? 'flex max-h-[90vh] flex-col overflow-hidden' : 'max-h-[90vh] flex flex-col overflow-hidden',
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
              <div className={classNames('flex min-h-0 flex-1 flex-col overflow-y-auto', !fullHeight && 'p-4')}>
                {children}
              </div>

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
