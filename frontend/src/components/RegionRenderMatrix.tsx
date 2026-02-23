import { useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { nativeBridge } from "../services/NativeBridge";
import {
  Button,
  Input,
  Select,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

interface RegionRenderMatrixProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Region Render Matrix — renders intersections of tracks × regions.
 * Each checked cell produces one file.
 */
export function RegionRenderMatrix({ isOpen, onClose }: RegionRenderMatrixProps) {
  const { tracks, regions, syncClipsWithBackend } = useDAWStore(
    useShallow((s) => ({
      tracks: s.tracks,
      regions: s.regions,
      syncClipsWithBackend: s.syncClipsWithBackend,
    }))
  );
  const projectName = useDAWStore((s) => s.projectName);

  // Matrix: key = "trackId:regionId", value = checked
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [directory, setDirectory] = useState("");
  const [filePattern, setFilePattern] = useState("$project_$track_$region");
  const [format, setFormat] = useState<"wav" | "aiff" | "flac" | "mp3">("wav");
  const [bitDepth, setBitDepth] = useState(24);
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");

  const cellKey = (trackId: string, regionId: string) => `${trackId}:${regionId}`;

  const toggleCell = (trackId: string, regionId: string) => {
    const key = cellKey(trackId, regionId);
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const selectAll = () => {
    const all: Record<string, boolean> = {};
    for (const t of tracks) {
      for (const r of regions) {
        all[cellKey(t.id, r.id)] = true;
      }
    }
    setChecked(all);
  };

  const selectNone = () => setChecked({});

  const checkedCount = Object.values(checked).filter(Boolean).length;

  const resolveFilename = (trackName: string, regionName: string, index: number) => {
    const now = new Date();
    return filePattern
      .replace(/\$project/g, projectName || "untitled")
      .replace(/\$track/g, trackName)
      .replace(/\$region/g, regionName)
      .replace(/\$date/g, now.toISOString().slice(0, 10))
      .replace(/\$index/g, String(index).padStart(2, "0"));
  };

  const handleBrowse = async () => {
    try {
      const path = await nativeBridge.showRenderSaveDialog("matrix_render", format);
      if (path) {
        const lastSlash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
        if (lastSlash >= 0) setDirectory(path.substring(0, lastSlash));
      }
    } catch { /* ignore */ }
  };

  const handleRender = async () => {
    const jobs: Array<{ trackId: string; trackName: string; regionId: string; regionName: string; start: number; end: number }> = [];
    for (const t of tracks) {
      for (const r of regions) {
        if (checked[cellKey(t.id, r.id)]) {
          jobs.push({ trackId: t.id, trackName: t.name, regionId: r.id, regionName: r.name, start: r.startTime, end: r.endTime });
        }
      }
    }
    if (jobs.length === 0) return;

    setIsRendering(true);
    setProgress(0);

    try {
      await syncClipsWithBackend();

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const fileName = resolveFilename(job.trackName, job.regionName, i + 1);
        const filePath = `${directory}\\${fileName}.${format}`;
        setStatus(`Rendering ${i + 1}/${jobs.length}: ${job.trackName} × ${job.regionName}`);

        await nativeBridge.renderProject({
          source: `stem:${job.trackId}`,
          startTime: job.start,
          endTime: job.end,
          filePath,
          format,
          sampleRate: 44100,
          bitDepth,
          channels: 2,
          normalize: false,
          addTail: false,
          tailLength: 0,
        });

        setProgress(Math.round(((i + 1) / jobs.length) * 100));
      }

      setStatus("Complete!");
      setTimeout(() => {
        onClose();
        setIsRendering(false);
        setProgress(0);
        setStatus("");
      }, 500);
    } catch (error) {
      alert("Render failed: " + error);
      setIsRendering(false);
      setProgress(0);
      setStatus("");
    }
  };

  if (regions.length === 0 || tracks.length === 0) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="md">
        <ModalHeader title="Region Render Matrix" onClose={onClose} />
        <ModalContent>
          <p className="text-sm text-daw-text-muted py-4">
            {regions.length === 0
              ? "No regions defined. Add regions to your project first."
              : "No tracks in project."}
          </p>
        </ModalContent>
        <ModalFooter>
          <Button variant="default" size="md" onClick={onClose}>Close</Button>
        </ModalFooter>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" closeOnOverlayClick={!isRendering} closeOnEscape={!isRendering}>
      <ModalHeader title="Region Render Matrix" onClose={onClose} />
      <ModalContent>
        <div className="space-y-3">
          {/* Matrix grid */}
          <div className="overflow-auto max-h-64 border border-daw-border rounded">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-daw-panel sticky top-0">
                  <th className="text-left p-1.5 text-daw-text-muted border-b border-daw-border min-w-[120px]">Track \ Region</th>
                  {regions.map((r) => (
                    <th key={r.id} className="p-1.5 text-daw-text-muted border-b border-daw-border text-center min-w-[80px]">
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => (
                  <tr key={t.id} className="hover:bg-daw-surface/50">
                    <td className="p-1.5 text-daw-text border-b border-daw-border/50 truncate max-w-[150px]">
                      <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: t.color }} />
                      {t.name}
                    </td>
                    {regions.map((r) => (
                      <td key={r.id} className="p-1.5 text-center border-b border-daw-border/50">
                        <input
                          type="checkbox"
                          checked={!!checked[cellKey(t.id, r.id)]}
                          onChange={() => toggleCell(t.id, r.id)}
                          disabled={isRendering}
                          className="accent-daw-accent"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Select all / none */}
          <div className="flex items-center gap-2 text-xs">
            <Button variant="default" size="xs" onClick={selectAll} disabled={isRendering}>Select All</Button>
            <Button variant="default" size="xs" onClick={selectNone} disabled={isRendering}>Select None</Button>
            <span className="text-daw-text-muted ml-2">{checkedCount} file(s) to render</span>
          </div>

          {/* Output settings */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-daw-text-muted w-16">Directory:</span>
            <Input type="text" variant="default" size="xs" value={directory} onChange={(e) => setDirectory(e.target.value)} className="flex-1" disabled={isRendering} />
            <Button variant="default" size="xs" onClick={handleBrowse} disabled={isRendering}>Browse</Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-daw-text-muted w-16">Pattern:</span>
            <Input type="text" variant="default" size="xs" value={filePattern} onChange={(e) => setFilePattern(e.target.value)} className="flex-1" disabled={isRendering} />
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-daw-text-muted">Format:</span>
              <Select size="xs" options={[{ value: "wav", label: "WAV" }, { value: "aiff", label: "AIFF" }, { value: "flac", label: "FLAC" }, { value: "mp3", label: "MP3" }]} value={format} onChange={(v) => setFormat(v as typeof format)} disabled={isRendering} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-daw-text-muted">Bit depth:</span>
              <Select size="xs" options={[{ value: 16, label: "16-bit" }, { value: 24, label: "24-bit" }, { value: 32, label: "32-bit" }]} value={bitDepth} onChange={(v) => setBitDepth(v as number)} disabled={isRendering} />
            </div>
          </div>

          {/* Preview */}
          {checkedCount > 0 && (
            <div className="text-[10px] text-daw-text-dim">
              Preview: {resolveFilename(tracks[0].name, regions[0].name, 1)}.{format}
            </div>
          )}

          {/* Progress */}
          {isRendering && (
            <div className="space-y-1">
              <div className="text-xs text-daw-text-muted">{status} — {progress}%</div>
              <div className="w-full bg-daw-darker rounded-full h-1.5">
                <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="secondary" size="md" onClick={onClose} disabled={isRendering}>Cancel</Button>
        <Button variant="primary" size="md" onClick={handleRender} disabled={isRendering || checkedCount === 0 || !directory}>
          {isRendering ? "Rendering..." : `Render ${checkedCount} file${checkedCount !== 1 ? "s" : ""}`}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
