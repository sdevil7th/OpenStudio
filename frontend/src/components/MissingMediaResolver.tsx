import { useState } from "react";
import { AlertTriangle, Search, FolderOpen, X, Check } from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import {
  Button,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

interface MissingFile {
  originalPath: string;
  clipIds: string[];
  resolved: boolean;
  newPath?: string;
}

interface MissingMediaResolverProps {
  isOpen: boolean;
  onClose: () => void;
  missingFiles: Array<{ path: string; clipIds: string[] }>;
  onResolve: (originalPath: string, newPath: string) => void;
  onResolveAll: () => void;
}

/**
 * MissingMediaResolver (Sprint 20.6)
 * Detects missing audio files on project load and provides
 * a dialog to locate or skip them.
 */
export function MissingMediaResolver({
  isOpen,
  onClose,
  missingFiles,
  onResolve,
  onResolveAll,
}: MissingMediaResolverProps) {
  const [files, setFiles] = useState<MissingFile[]>(
    missingFiles.map((f) => ({
      originalPath: f.path,
      clipIds: f.clipIds,
      resolved: false,
    })),
  );
  const [searchDir, setSearchDir] = useState("");

  const resolvedCount = files.filter((f) => f.resolved).length;

  const handleLocateFile = async (index: number) => {
    try {
      const result = await nativeBridge.browseForFile(
        "Locate: " + getFileName(files[index].originalPath),
        "Audio Files|*.wav;*.mp3;*.flac;*.aif;*.aiff;*.ogg",
      );
      if (result) {
        const updated = [...files];
        updated[index] = { ...updated[index], resolved: true, newPath: result };
        setFiles(updated);
        onResolve(files[index].originalPath, result);
      }
    } catch {
      // User cancelled
    }
  };

  const handleSearchDirectory = async () => {
    try {
      const dir = await nativeBridge.browseForFolder("Search in folder");
      if (!dir) return;
      setSearchDir(dir);

      // Try to find each missing file by name in the selected directory
      const updated = [...files];
      for (let i = 0; i < updated.length; i++) {
        if (updated[i].resolved) continue;
        const fileName = getFileName(updated[i].originalPath);
        // Check if file exists in the selected directory
        try {
          const found = await nativeBridge.fileExists(dir + "/" + fileName);
          if (found) {
            const newPath = dir + "/" + fileName;
            updated[i] = { ...updated[i], resolved: true, newPath };
            onResolve(updated[i].originalPath, newPath);
          }
        } catch {
          // File not found in dir
        }
      }
      setFiles(updated);
    } catch {
      // User cancelled
    }
  };

  const handleSkipAll = () => {
    onClose();
  };

  const handleDone = () => {
    onResolveAll();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalHeader title="Missing Media Files" onClose={onClose} />
      <ModalContent>
        <div className="flex flex-col gap-3">
          {/* Warning banner */}
          <div className="flex items-center gap-2 bg-yellow-900/30 border border-yellow-700/50 rounded px-3 py-2">
            <AlertTriangle size={16} className="text-yellow-500 flex-shrink-0" />
            <span className="text-xs text-yellow-300">
              {files.length} media file{files.length !== 1 ? "s" : ""} could
              not be found. Locate them to restore playback.
            </span>
          </div>

          {/* Search in directory */}
          <div className="flex gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleSearchDirectory}
            >
              <FolderOpen size={12} className="mr-1" />
              Search in Folder
            </Button>
            {searchDir && (
              <span className="text-xs text-daw-text-muted self-center truncate">
                Searched: {searchDir}
              </span>
            )}
          </div>

          {/* File list */}
          <div className="max-h-[300px] overflow-y-auto border border-daw-border rounded">
            {files.map((file, index) => (
              <div
                key={file.originalPath}
                className={`flex items-center gap-2 px-3 py-2 border-b border-daw-border last:border-b-0 ${
                  file.resolved ? "bg-green-900/10" : "bg-red-900/10"
                }`}
              >
                {file.resolved ? (
                  <Check size={14} className="text-green-500 flex-shrink-0" />
                ) : (
                  <X size={14} className="text-red-500 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-daw-text truncate">
                    {getFileName(file.originalPath)}
                  </p>
                  <p className="text-[10px] text-daw-text-muted truncate">
                    {file.originalPath}
                  </p>
                  {file.newPath && (
                    <p className="text-[10px] text-green-400 truncate">
                      → {file.newPath}
                    </p>
                  )}
                </div>
                <span className="text-[10px] text-daw-text-muted flex-shrink-0">
                  {file.clipIds.length} clip{file.clipIds.length !== 1 ? "s" : ""}
                </span>
                {!file.resolved && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => handleLocateFile(index)}
                  >
                    <Search size={12} className="mr-1" />
                    Locate
                  </Button>
                )}
              </div>
            ))}
          </div>

          {/* Status */}
          <p className="text-xs text-daw-text-muted">
            {resolvedCount} of {files.length} resolved
          </p>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="default" size="sm" onClick={handleSkipAll}>
          Skip All
        </Button>
        <Button variant="primary" size="sm" onClick={handleDone}>
          Done
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function getFileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}
