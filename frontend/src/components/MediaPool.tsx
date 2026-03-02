import { useState, useMemo } from "react";
import {
  Music,
  FileAudio,
  HardDrive,
  Search,
} from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import {
  Button,
  Input,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

interface MediaItem {
  filePath: string;
  fileName: string;
  usageCount: number;
  clipIds: string[];
  trackNames: string[];
}

interface MediaPoolProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * MediaPool (Sprint 20.7)
 * Lists all audio files referenced in the project with usage counts.
 * Helps identify unused files and navigate to clips using them.
 */
export function MediaPool({ isOpen, onClose }: MediaPoolProps) {
  const { tracks } = useDAWStore(useShallow((s) => ({ tracks: s.tracks })));
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "usage">("name");

  const mediaItems = useMemo(() => {
    const fileMap = new Map<string, MediaItem>();

    for (const track of tracks) {
      for (const clip of track.clips) {
        if ((clip as any).type !== "audio" && !(clip as any).filePath) continue;
        const audioClip = clip as any;
        const fp = audioClip.filePath || audioClip.file;
        if (!fp) continue;

        const existing = fileMap.get(fp);
        if (existing) {
          existing.usageCount++;
          existing.clipIds.push(clip.id);
          if (!existing.trackNames.includes(track.name)) {
            existing.trackNames.push(track.name);
          }
        } else {
          fileMap.set(fp, {
            filePath: fp,
            fileName: fp.replace(/\\/g, "/").split("/").pop() || fp,
            usageCount: 1,
            clipIds: [clip.id],
            trackNames: [track.name],
          });
        }
      }
    }

    return Array.from(fileMap.values());
  }, [tracks]);

  const filtered = useMemo(() => {
    let items = mediaItems;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      items = items.filter(
        (m) =>
          m.fileName.toLowerCase().includes(q) ||
          m.filePath.toLowerCase().includes(q),
      );
    }
    items.sort((a, b) =>
      sortBy === "name"
        ? a.fileName.localeCompare(b.fileName)
        : b.usageCount - a.usageCount,
    );
    return items;
  }, [mediaItems, searchTerm, sortBy]);

  const totalFiles = mediaItems.length;
  const unusedFiles = mediaItems.filter((m) => m.usageCount === 0).length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalHeader title="Media Pool" onClose={onClose} />
      <ModalContent>
        <div className="flex flex-col gap-3">
          {/* Summary */}
          <div className="flex gap-4 text-xs text-daw-text-muted">
            <span className="flex items-center gap-1">
              <FileAudio size={12} />
              {totalFiles} file{totalFiles !== 1 ? "s" : ""}
            </span>
            {unusedFiles > 0 && (
              <span className="flex items-center gap-1 text-yellow-400">
                <HardDrive size={12} />
                {unusedFiles} unused
              </span>
            )}
          </div>

          {/* Search + Sort */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
              />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search files..."
                className="pl-7"
                size="sm"
              />
            </div>
            <Button
              variant={sortBy === "name" ? "primary" : "default"}
              size="sm"
              onClick={() => setSortBy("name")}
            >
              Name
            </Button>
            <Button
              variant={sortBy === "usage" ? "primary" : "default"}
              size="sm"
              onClick={() => setSortBy("usage")}
            >
              Usage
            </Button>
          </div>

          {/* File list */}
          <div className="max-h-[400px] overflow-y-auto border border-daw-border rounded">
            {filtered.length === 0 ? (
              <p className="text-xs text-daw-text-muted py-4 text-center">
                {searchTerm ? "No files match search." : "No media files in project."}
              </p>
            ) : (
              filtered.map((item) => (
                <div
                  key={item.filePath}
                  className="flex items-center gap-2 px-3 py-2 border-b border-daw-border last:border-b-0 hover:bg-daw-panel"
                >
                  <Music size={14} className="text-daw-accent flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-daw-text truncate">
                      {item.fileName}
                    </p>
                    <p className="text-[10px] text-daw-text-muted truncate">
                      {item.filePath}
                    </p>
                    {item.trackNames.length > 0 && (
                      <p className="text-[10px] text-daw-text-muted">
                        Tracks: {item.trackNames.join(", ")}
                      </p>
                    )}
                  </div>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      item.usageCount === 0
                        ? "bg-yellow-900/30 text-yellow-400"
                        : "bg-daw-panel text-daw-text-muted"
                    }`}
                  >
                    {item.usageCount}x
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <span className="text-xs text-daw-text-muted">
          {filtered.length} of {totalFiles} files shown
        </span>
        <Button variant="default" size="sm" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
