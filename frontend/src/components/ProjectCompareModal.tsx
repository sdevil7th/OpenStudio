import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import {
  Button,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

interface ProjectCompareModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Project Compare Modal
 * Shows a diff between the current project state and the last saved version.
 * Categories: Settings, Tracks (added/removed/modified), Clips (added/removed/moved).
 */
export function ProjectCompareModal({
  isOpen,
  onClose,
}: ProjectCompareModalProps) {
  const { projectCompareData, projectPath } = useDAWStore(
    useShallow((s) => ({
      projectCompareData: s.projectCompareData,
      projectPath: s.projectPath,
    })),
  );

  const data = projectCompareData;
  const hasChanges =
    data &&
    (data.tracksDiff.length > 0 ||
      data.clipsDiff.length > 0 ||
      data.settingsDiff.length > 0);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalHeader title="Project Compare" onClose={onClose} />

      <ModalContent>
        <div className="space-y-4">
          {/* Current file path */}
          <div className="text-xs text-daw-text-muted truncate">
            Comparing with: {projectPath || "(unsaved project)"}
          </div>

          {!data && (
            <div className="text-center text-daw-text-muted py-8">
              Loading comparison...
            </div>
          )}

          {data && !hasChanges && (
            <div className="text-center py-12">
              <div className="text-lg font-medium text-daw-text mb-2">
                No changes detected
              </div>
              <div className="text-sm text-daw-text-muted">
                The current project matches the saved version.
              </div>
            </div>
          )}

          {data && hasChanges && (
            <>
              {/* Settings Changes */}
              {data.settingsDiff.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-daw-text border-b border-daw-border pb-1 mb-2">
                    Settings Changes
                    <span className="ml-2 text-xs font-normal text-daw-text-muted">
                      ({data.settingsDiff.length})
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {data.settingsDiff.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/20"
                      >
                        <span className="text-yellow-400 font-medium w-3 text-center">
                          ~
                        </span>
                        <span className="text-daw-text font-medium min-w-[120px]">
                          {s.field}:
                        </span>
                        <span className="text-red-400 line-through">
                          {s.oldValue}
                        </span>
                        <span className="text-daw-text-muted">-&gt;</span>
                        <span className="text-green-400">{s.newValue}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Track Changes */}
              {data.tracksDiff.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-daw-text border-b border-daw-border pb-1 mb-2">
                    Track Changes
                    <span className="ml-2 text-xs font-normal text-daw-text-muted">
                      ({data.tracksDiff.length})
                    </span>
                  </h3>
                  <div className="space-y-1">
                    {data.tracksDiff.map((t, i) => (
                      <div
                        key={i}
                        className={`flex items-start gap-2 text-xs px-2 py-1 rounded border ${
                          t.type === "added"
                            ? "bg-green-500/10 border-green-500/20"
                            : t.type === "removed"
                              ? "bg-red-500/10 border-red-500/20"
                              : "bg-yellow-500/10 border-yellow-500/20"
                        }`}
                      >
                        <span
                          className={`font-medium w-3 text-center flex-shrink-0 ${
                            t.type === "added"
                              ? "text-green-400"
                              : t.type === "removed"
                                ? "text-red-400"
                                : "text-yellow-400"
                          }`}
                        >
                          {t.type === "added"
                            ? "+"
                            : t.type === "removed"
                              ? "-"
                              : "~"}
                        </span>
                        <div>
                          <span className="text-daw-text font-medium">
                            {t.name}
                          </span>
                          {t.details && (
                            <div className="text-daw-text-muted mt-0.5">
                              {t.details}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Clip Changes */}
              {data.clipsDiff.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-daw-text border-b border-daw-border pb-1 mb-2">
                    Clip Changes
                    <span className="ml-2 text-xs font-normal text-daw-text-muted">
                      ({data.clipsDiff.length})
                    </span>
                  </h3>
                  <div className="space-y-1 max-h-[300px] overflow-y-auto">
                    {data.clipsDiff.map((c, i) => (
                      <div
                        key={i}
                        className={`flex items-start gap-2 text-xs px-2 py-1 rounded border ${
                          c.type === "added"
                            ? "bg-green-500/10 border-green-500/20"
                            : c.type === "removed"
                              ? "bg-red-500/10 border-red-500/20"
                              : "bg-yellow-500/10 border-yellow-500/20"
                        }`}
                      >
                        <span
                          className={`font-medium w-3 text-center flex-shrink-0 ${
                            c.type === "added"
                              ? "text-green-400"
                              : c.type === "removed"
                                ? "text-red-400"
                                : "text-yellow-400"
                          }`}
                        >
                          {c.type === "added"
                            ? "+"
                            : c.type === "removed"
                              ? "-"
                              : "~"}
                        </span>
                        <div>
                          <span className="text-daw-text font-medium">
                            {c.name}
                          </span>
                          <span className="text-daw-text-muted ml-1">
                            on "{c.trackName}"
                          </span>
                          {c.details && (
                            <div className="text-daw-text-muted mt-0.5">
                              {c.details}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Summary */}
              <div className="text-xs text-daw-text-muted border-t border-daw-border pt-2 flex gap-4">
                <span>
                  <span className="text-green-400 font-medium">
                    +{data.tracksDiff.filter((t) => t.type === "added").length +
                      data.clipsDiff.filter((c) => c.type === "added").length}
                  </span>{" "}
                  added
                </span>
                <span>
                  <span className="text-red-400 font-medium">
                    -{data.tracksDiff.filter((t) => t.type === "removed").length +
                      data.clipsDiff.filter((c) => c.type === "removed").length}
                  </span>{" "}
                  removed
                </span>
                <span>
                  <span className="text-yellow-400 font-medium">
                    ~{data.tracksDiff.filter((t) => t.type === "modified").length +
                      data.clipsDiff.filter((c) => c.type === "modified").length +
                      data.settingsDiff.length}
                  </span>{" "}
                  modified
                </span>
              </div>
            </>
          )}
        </div>
      </ModalContent>

      <ModalFooter>
        <Button variant="secondary" size="md" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
