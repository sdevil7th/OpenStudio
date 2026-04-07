import { Button, Modal, ModalContent, ModalFooter, ModalHeader } from "./ui";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";

export function UnsavedChangesDialog() {
  const {
    showUnsavedChangesDialog,
    pendingProjectActionLabel,
    projectName,
    resolveUnsavedChanges,
    dismissUnsavedChangesDialog,
  } = useDAWStore(
    useShallow((state) => ({
      showUnsavedChangesDialog: state.showUnsavedChangesDialog,
      pendingProjectActionLabel: state.pendingProjectActionLabel,
      projectName: state.projectName,
      resolveUnsavedChanges: state.resolveUnsavedChanges,
      dismissUnsavedChangesDialog: state.dismissUnsavedChangesDialog,
    })),
  );

  const displayName = projectName?.trim() || "Untitled Project";

  return (
    <Modal
      isOpen={showUnsavedChangesDialog}
      onClose={dismissUnsavedChangesDialog}
      size="sm"
      closeOnEscape={false}
      closeOnOverlayClick={false}
      showCloseButton={false}
    >
      <ModalHeader title="Save Changes?" />
      <ModalContent className="space-y-4">
        <div className="rounded-md border border-daw-border bg-daw-dark/40 p-3">
          <p className="text-sm font-semibold text-daw-text">{displayName}</p>
          <p className="mt-2 text-sm text-daw-text-muted">
            You have unsaved changes {pendingProjectActionLabel || "before continuing"}.
          </p>
          <p className="mt-2 text-sm text-daw-text-muted">
            Save your work before continuing, or continue without saving.
          </p>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost" onClick={dismissUnsavedChangesDialog}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => void resolveUnsavedChanges("discard")}>
          Don&apos;t Save
        </Button>
        <Button variant="primary" onClick={() => void resolveUnsavedChanges("save")}>
          Save
        </Button>
      </ModalFooter>
    </Modal>
  );
}
