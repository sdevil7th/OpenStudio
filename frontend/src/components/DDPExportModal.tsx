import { useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { nativeBridge } from "../services/NativeBridge";
import { Modal, Button } from "./ui";

interface DDPExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DDPExportModal({ isOpen, onClose }: DDPExportModalProps) {
  const { regions } = useDAWStore(useShallow((s) => ({
    regions: s.regions,
  })));
  const [isExporting, setIsExporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [sourceWav, setSourceWav] = useState("");
  const [catalogNumber, setCatalogNumber] = useState("");

  const handleSelectSource = async () => {
    const path = await nativeBridge.showOpenDialog("Select Red Book WAV (44.1kHz/16-bit)");
    if (path) setSourceWav(path);
  };

  const handleExport = async () => {
    if (!sourceWav) {
      setResult("Please select a source WAV file first.");
      return;
    }
    const dir = await nativeBridge.showSaveDialog(undefined, "Select DDP Output Directory");
    if (!dir) return;

    setIsExporting(true);
    setResult(null);
    try {
      const success = await useDAWStore.getState().exportDDP(sourceWav, dir, catalogNumber || undefined);
      setResult(success ? "DDP export completed successfully!" : "DDP export failed.");
    } catch {
      setResult("DDP export failed with an error.");
    } finally {
      setIsExporting(false);
    }
  };

  // Red Book validation
  const totalDuration = regions.reduce((sum, r) => sum + (r.endTime - r.startTime), 0);
  const maxDuration = 79 * 60 + 57; // ~79:57 in seconds
  const tooLong = totalDuration > maxDuration;
  const tooManyTracks = regions.length > 99;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="DDP Disc Image Export">
      <div className="w-[400px] flex flex-col gap-3">
        <div className="text-[10px] text-neutral-400">
          Export a DDP (Disc Description Protocol) image for CD replication.
          Regions in your project are used as CD track markers.
        </div>

        {/* Source WAV selection */}
        <div className="bg-neutral-800 rounded border border-neutral-700 p-2">
          <div className="text-[9px] text-neutral-500 uppercase mb-1">Source WAV (Red Book: 44.1kHz / 16-bit / Stereo)</div>
          <div className="flex items-center gap-2">
            <div className="text-[10px] text-neutral-300 flex-1 truncate font-mono">
              {sourceWav || "No file selected"}
            </div>
            <Button variant="default" size="sm" onClick={handleSelectSource}>
              Browse...
            </Button>
          </div>
        </div>

        {/* Catalog number */}
        <div className="bg-neutral-800 rounded border border-neutral-700 p-2">
          <div className="text-[9px] text-neutral-500 uppercase mb-1">UPC/EAN Catalog Number (optional)</div>
          <input
            type="text"
            className="w-full bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-[10px] text-neutral-300 font-mono"
            placeholder="e.g. 0123456789012"
            maxLength={13}
            value={catalogNumber}
            onChange={(e) => setCatalogNumber(e.target.value)}
          />
        </div>

        {/* Region summary */}
        <div className="bg-neutral-800 rounded border border-neutral-700 p-2">
          <div className="text-[9px] text-neutral-500 uppercase mb-1">CD Tracks (from regions)</div>
          {regions.length === 0 ? (
            <div className="text-[10px] text-neutral-600">
              No regions defined. Add regions to mark CD track boundaries.
            </div>
          ) : (
            <div className="max-h-[150px] overflow-y-auto">
              {regions.map((region, i) => (
                <div key={region.id} className="flex items-center gap-2 py-0.5 text-[10px]">
                  <span className="text-neutral-500 w-6 text-right">{i + 1}.</span>
                  <span className="text-neutral-300 flex-1 truncate">{region.name}</span>
                  <span className="text-neutral-500 font-mono">
                    {formatTime(region.endTime - region.startTime)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Validation */}
        <div className="text-[9px] flex flex-col gap-0.5">
          <div className={regions.length > 0 ? "text-green-400" : "text-yellow-400"}>
            {regions.length} track{regions.length !== 1 ? "s" : ""} {tooManyTracks ? "(max 99!)" : ""}
          </div>
          <div className={tooLong ? "text-red-400" : "text-neutral-500"}>
            Total: {formatTime(totalDuration)} {tooLong ? "(exceeds Red Book limit)" : ""}
          </div>
          <div className="text-neutral-500">
            Output: 16-bit / 44.1kHz / Stereo (Red Book standard)
          </div>
        </div>

        {/* Result message */}
        {result && (
          <div className={`text-[10px] px-2 py-1 rounded ${
            result.includes("success") ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
          }`}>
            {result}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-neutral-700">
          <Button variant="default" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleExport}
            disabled={isExporting || regions.length === 0}
          >
            {isExporting ? "Exporting..." : "Export DDP"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
