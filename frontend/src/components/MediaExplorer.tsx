import { useState, useEffect, useCallback } from "react";
import {
  Folder,
  File,
  Music,
  Play,
  Square,
  ArrowUp,
  Search,
  Clock,
  X,
  ChevronRight,
} from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Input } from "./ui";

interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  format: string;
  duration: number;
  sampleRate: number;
  numChannels: number;
}

interface MediaExplorerProps {
  isVisible: boolean;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "ogg", "flac", "aiff", "aif", "m4a", "wma"]);

export function MediaExplorer({ isVisible, onClose }: MediaExplorerProps) {
  const {
    mediaExplorerPath,
    setMediaExplorerPath,
    mediaExplorerRecentPaths,
    addMediaExplorerRecentPath,
  } = useDAWStore(useShallow((s) => ({
    mediaExplorerPath: s.mediaExplorerPath,
    setMediaExplorerPath: s.setMediaExplorerPath,
    mediaExplorerRecentPaths: s.mediaExplorerRecentPaths,
    addMediaExplorerRecentPath: s.addMediaExplorerRecentPath,
  })));

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [previewingPath, setPreviewingPath] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [, setDraggedFile] = useState<FileEntry | null>(null);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!path) return;
      setLoading(true);
      try {
        const entries = await nativeBridge.browseDirectory(path);
        setFiles(entries);
        setMediaExplorerPath(path);
        addMediaExplorerRecentPath(path);
      } catch (err) {
        console.error("[MediaExplorer] Failed to browse:", err);
        setFiles([]);
      } finally {
        setLoading(false);
      }
    },
    [setMediaExplorerPath, addMediaExplorerRecentPath],
  );

  // Load home directory on first open
  useEffect(() => {
    if (isVisible && !mediaExplorerPath) {
      nativeBridge.getHomeDirectory().then((home) => {
        loadDirectory(home);
      });
    } else if (isVisible && mediaExplorerPath && files.length === 0) {
      loadDirectory(mediaExplorerPath);
    }
  }, [isVisible, mediaExplorerPath, files.length, loadDirectory]);

  const handleNavigateUp = () => {
    if (!mediaExplorerPath) return;
    const parent = mediaExplorerPath.replace(/[/\\][^/\\]*$/, "");
    if (parent && parent !== mediaExplorerPath) {
      loadDirectory(parent);
    }
  };

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.isDirectory) {
      loadDirectory(entry.path);
    }
  };

  const handleEntryDoubleClick = (entry: FileEntry) => {
    if (!entry.isDirectory && AUDIO_EXTENSIONS.has(entry.format)) {
      // Import to selected track at playhead
      const state = useDAWStore.getState();
      const trackId =
        state.selectedTrackIds[0] ||
        state.tracks.find((t) => t.type === "audio")?.id;
      if (trackId) {
        state.importMedia(entry.path, trackId, state.transport.currentTime);
      }
    }
  };

  const handlePreview = (entry: FileEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    if (previewingPath === entry.path) {
      nativeBridge.stopPreview();
      setPreviewingPath(null);
    } else {
      nativeBridge.previewAudioFile(entry.path);
      setPreviewingPath(entry.path);
    }
  };

  const handleDragStart = (entry: FileEntry, e: React.DragEvent) => {
    if (entry.isDirectory) return;
    setDraggedFile(entry);
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.setData("application/x-media-explorer-file", JSON.stringify(entry));
    e.dataTransfer.effectAllowed = "copy";
  };

  const filteredFiles = files.filter((f) => {
    if (!filter) return true;
    return f.name.toLowerCase().includes(filter.toLowerCase());
  });

  // Sort: directories first, then by name
  const sortedFiles = [...filteredFiles].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  if (!isVisible) return null;

  const currentDir = mediaExplorerPath
    ? mediaExplorerPath.split(/[/\\]/).pop() || mediaExplorerPath
    : "Media Explorer";

  return (
    <div className="w-[260px] bg-neutral-900 border-r border-neutral-700 flex flex-col shrink-0 h-full overflow-hidden">
      {/* Header */}
      <div className="h-6 bg-neutral-800 border-b border-neutral-700 flex items-center justify-between px-2 shrink-0">
        <span className="text-[9px] font-semibold text-neutral-400 uppercase tracking-wider">
          Media Explorer
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close">
          <X size={12} />
        </Button>
      </div>

      {/* Path bar */}
      <div className="flex items-center gap-1 px-1 py-1 bg-neutral-850 border-b border-neutral-700 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleNavigateUp}
          title="Go up"
        >
          <ArrowUp size={12} />
        </Button>
        <div
          className="flex-1 text-[9px] text-neutral-300 truncate cursor-pointer hover:text-white px-1 py-0.5 rounded bg-neutral-800"
          title={mediaExplorerPath}
          onClick={() => setShowRecent(!showRecent)}
        >
          {currentDir}
          <ChevronRight size={8} className="inline ml-1 opacity-50" />
        </div>
      </div>

      {/* Recent paths dropdown */}
      {showRecent && mediaExplorerRecentPaths.length > 0 && (
        <div className="bg-neutral-800 border-b border-neutral-700 max-h-[120px] overflow-y-auto shrink-0">
          <div className="flex items-center gap-1 px-2 py-1 text-[8px] text-neutral-500 uppercase">
            <Clock size={8} /> Recent
          </div>
          {mediaExplorerRecentPaths.map((p) => (
            <div
              key={p}
              className="text-[9px] text-neutral-400 px-2 py-1 cursor-pointer hover:bg-neutral-700 hover:text-white truncate"
              onClick={() => {
                loadDirectory(p);
                setShowRecent(false);
              }}
              title={p}
            >
              {p}
            </div>
          ))}
        </div>
      )}

      {/* Search/Filter */}
      <div className="px-1 py-1 shrink-0">
        <div className="relative">
          <Search
            size={10}
            className="absolute left-1.5 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="pl-5 h-5 text-[9px]"
          />
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {loading ? (
          <div className="text-[9px] text-neutral-500 text-center py-4">
            Loading...
          </div>
        ) : sortedFiles.length === 0 ? (
          <div className="text-[9px] text-neutral-500 text-center py-4">
            {filter ? "No matches" : "Empty directory"}
          </div>
        ) : (
          sortedFiles.map((entry) => {
            const isAudio = !entry.isDirectory && AUDIO_EXTENSIONS.has(entry.format);
            const isPreviewing = previewingPath === entry.path;

            return (
              <div
                key={entry.path}
                className="flex items-center gap-1 px-1.5 py-0.5 cursor-pointer hover:bg-neutral-800 group"
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
                draggable={!entry.isDirectory}
                onDragStart={(e) => handleDragStart(entry, e)}
                onDragEnd={() => setDraggedFile(null)}
                title={`${entry.name}${isAudio ? `\n${formatDuration(entry.duration)} | ${entry.sampleRate}Hz | ${entry.numChannels}ch | ${formatSize(entry.size)}` : ""}`}
              >
                {/* Icon */}
                <span className="shrink-0 text-neutral-500">
                  {entry.isDirectory ? (
                    <Folder size={12} className="text-yellow-600" />
                  ) : isAudio ? (
                    <Music size={12} className="text-blue-400" />
                  ) : (
                    <File size={12} />
                  )}
                </span>

                {/* Name */}
                <span className="flex-1 text-[9px] text-neutral-300 truncate">
                  {entry.name}
                </span>

                {/* Preview button for audio files */}
                {isAudio && (
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-neutral-700 transition-opacity"
                    onClick={(e) => handlePreview(entry, e)}
                    title={isPreviewing ? "Stop preview" : "Preview"}
                  >
                    {isPreviewing ? (
                      <Square size={8} className="text-orange-400" />
                    ) : (
                      <Play size={8} className="text-green-400" />
                    )}
                  </button>
                )}

                {/* Duration for audio files */}
                {isAudio && entry.duration > 0 && (
                  <span className="shrink-0 text-[7px] text-neutral-500 font-mono">
                    {formatDuration(entry.duration)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Status bar */}
      <div className="h-4 bg-neutral-800 border-t border-neutral-700 flex items-center px-2 shrink-0">
        <span className="text-[8px] text-neutral-500">
          {sortedFiles.length} items
          {filter && ` (${files.length} total)`}
        </span>
      </div>
    </div>
  );
}
