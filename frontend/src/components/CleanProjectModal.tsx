import { useState, useEffect } from "react";
import { Trash2, AlertTriangle, RefreshCw } from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Modal, Button } from "./ui";

interface OrphanedFile {
  path: string;
  size: number;
  selected: boolean;
}

interface CleanProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function CleanProjectModal({ isOpen, onClose }: CleanProjectModalProps) {
  const [orphanedFiles, setOrphanedFiles] = useState<OrphanedFile[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const scan = async () => {
    const state = useDAWStore.getState();
    const projectPath = state.projectPath;
    if (!projectPath) return;

    const projectDir = projectPath.replace(/[/\\][^/\\]*$/, "");

    // Collect all referenced file paths
    const referencedFiles: string[] = [];
    for (const track of state.tracks) {
      for (const clip of track.clips) {
        if (clip.filePath) referencedFiles.push(clip.filePath);
      }
    }
    // Add project file itself
    referencedFiles.push(projectPath);

    setScanning(true);
    setDeleteResult(null);
    try {
      const result = await nativeBridge.cleanProjectDirectory(
        projectDir,
        referencedFiles,
      );
      setOrphanedFiles(
        result.orphanedFiles.map((f) => ({ ...f, selected: true })),
      );
      setTotalSize(result.totalSize);
    } catch (err) {
      console.error("[CleanProject] Scan failed:", err);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      scan();
    }
  }, [isOpen]);

  const toggleFile = (index: number) => {
    setOrphanedFiles((prev) =>
      prev.map((f, i) =>
        i === index ? { ...f, selected: !f.selected } : f,
      ),
    );
  };

  const toggleAll = (selected: boolean) => {
    setOrphanedFiles((prev) => prev.map((f) => ({ ...f, selected })));
  };

  const selectedFiles = orphanedFiles.filter((f) => f.selected);
  const selectedSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    setDeleting(true);
    try {
      const paths = selectedFiles.map((f) => f.path);
      const result = await nativeBridge.deleteFiles(paths);
      setDeleteResult(
        `Deleted ${result.deleted} files.${result.errors.length > 0 ? ` ${result.errors.length} errors.` : ""}`,
      );
      // Re-scan
      await scan();
      setConfirmDelete(false);
    } catch (err) {
      setDeleteResult("Delete failed: " + String(err));
    } finally {
      setDeleting(false);
    }
  };

  const projectPath = useDAWStore.getState().projectPath;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Clean Project Directory">
      <div className="w-[500px] max-h-[500px] flex flex-col gap-3">
        {/* Info */}
        <div className="text-[10px] text-neutral-400">
          Scan the project directory for files not referenced by any clip.
          {!projectPath && (
            <span className="text-yellow-500 ml-1">
              (Save project first to enable scanning)
            </span>
          )}
        </div>

        {/* Scan button */}
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={scan}
            disabled={scanning || !projectPath}
          >
            <RefreshCw size={12} className={scanning ? "animate-spin" : ""} />
            {scanning ? "Scanning..." : "Rescan"}
          </Button>
          {orphanedFiles.length > 0 && (
            <span className="text-[9px] text-neutral-500">
              Found {orphanedFiles.length} orphaned files ({formatSize(totalSize)})
            </span>
          )}
        </div>

        {/* File list */}
        {orphanedFiles.length > 0 ? (
          <>
            <div className="flex items-center gap-2 text-[9px]">
              <button
                className="text-blue-400 hover:underline"
                onClick={() => toggleAll(true)}
              >
                Select All
              </button>
              <span className="text-neutral-600">|</span>
              <button
                className="text-blue-400 hover:underline"
                onClick={() => toggleAll(false)}
              >
                Select None
              </button>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[300px] border border-neutral-700 rounded bg-neutral-800">
              {orphanedFiles.map((file, i) => (
                <label
                  key={file.path}
                  className="flex items-center gap-2 px-2 py-1 hover:bg-neutral-700 cursor-pointer text-[9px]"
                >
                  <input
                    type="checkbox"
                    checked={file.selected}
                    onChange={() => toggleFile(i)}
                    className="shrink-0"
                  />
                  <span className="flex-1 text-neutral-300 truncate" title={file.path}>
                    {file.path.split(/[/\\]/).pop()}
                  </span>
                  <span className="shrink-0 text-neutral-500 font-mono">
                    {formatSize(file.size)}
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : !scanning ? (
          <div className="text-[10px] text-green-400 text-center py-4">
            No orphaned files found. Project directory is clean.
          </div>
        ) : null}

        {/* Delete result */}
        {deleteResult && (
          <div className="text-[9px] text-yellow-400">{deleteResult}</div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-neutral-700">
          <div className="text-[9px] text-neutral-500">
            {selectedFiles.length > 0
              ? `${selectedFiles.length} selected (${formatSize(selectedSize)})`
              : "No files selected"}
          </div>
          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={onClose}>
              Close
            </Button>
            {selectedFiles.length > 0 && (
              <Button
                variant="danger"
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
              >
                {confirmDelete ? (
                  <>
                    <AlertTriangle size={12} />
                    Confirm Delete ({selectedFiles.length})
                  </>
                ) : (
                  <>
                    <Trash2 size={12} />
                    Delete Selected
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
