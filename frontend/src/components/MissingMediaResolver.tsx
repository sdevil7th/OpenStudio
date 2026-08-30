import { useEffect, useState } from "react";
import { AlertTriangle, Check, Download, FolderOpen, Search, X } from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import type { MissingMediaEntry, NAMCatalogModel, NAMProjectAssetTarget } from "../services/NativeBridge";
import { ensureTONE3000Session } from "../services/tone3000Session";
import { normalizeNAMAssetChecksum } from "../utils/namAssetIdentity";
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
  kind: "media" | "nam";
  namTargets: NAMProjectAssetTarget[];
  resolved: boolean;
  newPath?: string;
}

interface MissingMediaResolverProps {
  isOpen: boolean;
  onClose: () => void;
  missingFiles: MissingMediaEntry[];
  onResolve: (originalPath: string, newPath: string) => void;
  onResolveNAMAsset?: (target: NAMProjectAssetTarget, newPath: string) => Promise<boolean>;
  onResolveAll: () => void;
}

/**
 * MissingMediaResolver
 * Handles missing audio clips and project-level NAM Rack assets.
 */
export function MissingMediaResolver({
  isOpen,
  onClose,
  missingFiles,
  onResolve,
  onResolveNAMAsset,
  onResolveAll,
}: MissingMediaResolverProps) {
  const [files, setFiles] = useState<MissingFile[]>(() => missingFiles.map(toMissingFile));
  const [searchDir, setSearchDir] = useState("");
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    setFiles(missingFiles.map(toMissingFile));
  }, [missingFiles]);

  const resolvedCount = files.filter((f) => f.resolved).length;

  const resolveFile = async (index: number, newPath: string) => {
    const file = files[index];
    if (!file) return false;

    if (file.kind === "nam") {
      if (!onResolveNAMAsset || file.namTargets.length === 0) return false;
      const results = await Promise.all(file.namTargets.map((target) => onResolveNAMAsset(target, newPath)));
      if (!results.every(Boolean)) return false;
    } else {
      onResolve(file.originalPath, newPath);
    }

    const updated = [...files];
    updated[index] = { ...updated[index], resolved: true, newPath };
    setFiles(updated);
    return true;
  };

  const handleLocateFile = async (index: number) => {
    try {
      const file = files[index];
      const result = await nativeBridge.browseForFile(
        "Locate: " + getFileName(file.originalPath),
        file.kind === "nam"
          ? getNAMLocateFilter(file)
          : "Audio Files|*.wav;*.mp3;*.flac;*.aif;*.aiff;*.ogg",
      );
      if (!result) return;

      setBusyIndex(index);
      if (file.kind === "nam" && !(await verifyLocatedNAMAsset(file, result))) {
        setStatusMessage("That file is not a compatible NAM/IR asset or does not match the SHA-256 identity saved with this project.");
        return;
      }
      await resolveFile(index, result);
    } catch {
      // User cancelled.
    } finally {
      setBusyIndex(null);
    }
  };

  const handleReDownload = async (index: number) => {
    const file = files[index];
    const target = file?.namTargets.find(hasDownloadMetadata);
    if (!file || !target) return;

    setBusyIndex(index);
    setStatusMessage("Preparing TONE3000 restore...");
    try {
      const authenticated = await ensureTONE3000AuthForRestore();
      if (!authenticated) {
        setStatusMessage("Connect TONE3000 to re-download this NAM model.");
        return;
      }

      setStatusMessage("Re-downloading NAM model...");
      const result = await nativeBridge.installNAMModel(makeReinstallPayload(target));
      const localPath = result.record?.localPath || "";
      if (result.success && localPath) {
        if (await resolveFile(index, localPath)) {
          setStatusMessage("NAM model restored.");
        } else {
          setStatusMessage("Downloaded model, but the rack slot could not be relinked.");
        }
      } else {
        setStatusMessage(result.error || "Could not re-download this NAM model.");
      }
    } catch (error) {
      console.warn("[MissingMediaResolver] NAM re-download failed", error);
      setStatusMessage("Could not re-download this NAM model.");
    } finally {
      setBusyIndex(null);
    }
  };

  const handleSearchDirectory = async () => {
    try {
      const dir = await nativeBridge.browseForFolder("Search in folder");
      if (!dir) return;
      setSearchDir(dir);

      const updated = [...files];
      for (let i = 0; i < updated.length; i++) {
        if (updated[i].resolved) continue;
        const fileName = getFileName(updated[i].originalPath);
        try {
          let foundPath = "";
          if (updated[i].kind === "nam") {
            const target = updated[i].namTargets[0];
            const result = await nativeBridge.findNAMAssetInDirectory(
              dir,
              target?.originalFileName || fileName,
              target?.checksum || "",
              Number(target?.fileSizeBytes || 0),
              target?.slot || "amp",
            );
            foundPath = result.success ? String(result.foundPath || "") : "";
            if (!foundPath && result.error) setStatusMessage(result.error);
          } else {
            const directPath = dir + "/" + fileName;
            foundPath = await nativeBridge.fileExists(directPath) ? directPath : "";
          }

          if (foundPath && await resolveFile(i, foundPath)) {
            updated[i] = { ...updated[i], resolved: true, newPath: foundPath };
          }
        } catch {
          // File not found in this directory.
        }
      }
      setFiles(updated);
    } catch {
      // User cancelled.
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
      <ModalHeader title="Missing Project Assets" onClose={onClose} />
      <ModalContent>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 bg-yellow-900/30 border border-yellow-700/50 rounded px-3 py-2">
            <AlertTriangle size={16} className="text-yellow-500 flex-shrink-0" />
            <span className="text-xs text-yellow-300">
              {files.length} project asset{files.length !== 1 ? "s" : ""} could not be found. Locate or re-download them to restore playback and NAM racks.
            </span>
          </div>

          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={handleSearchDirectory}>
              <FolderOpen size={12} className="mr-1" />
              Search in Folder
            </Button>
            {searchDir && (
              <span className="text-xs text-daw-text-muted self-center truncate">
                Searched: {searchDir}
              </span>
            )}
          </div>
          {statusMessage && (
            <div className="text-xs text-daw-text-muted border border-daw-border rounded px-3 py-2 bg-daw-panel">
              {statusMessage}
            </div>
          )}

          <div className="max-h-[300px] overflow-y-auto border border-daw-border rounded">
            {files.map((file, index) => (
              <div
                key={`${file.kind}:${file.originalPath}`}
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
                    {file.kind === "nam" ? formatNAMTargets(file.namTargets) : file.originalPath}
                  </p>
                  {file.kind === "nam" && (
                    <p className="text-[10px] text-daw-text-muted truncate">
                      {file.originalPath}
                    </p>
                  )}
                  {file.newPath && (
                    <p className="text-[10px] text-green-400 truncate">
                      -&gt; {file.newPath}
                    </p>
                  )}
                </div>
                <span className="text-[10px] text-daw-text-muted flex-shrink-0">
                  {file.kind === "nam"
                    ? `${file.namTargets.length} rack slot${file.namTargets.length !== 1 ? "s" : ""}`
                    : `${file.clipIds.length} clip${file.clipIds.length !== 1 ? "s" : ""}`}
                </span>
                {!file.resolved && (
                  <div className="flex gap-2">
                    {file.kind === "nam" && uniqueRelinkCandidate(file) && (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={async () => {
                          const candidate = uniqueRelinkCandidate(file);
                          if (!candidate) return;
                          setBusyIndex(index);
                          try {
                            if (!(await verifyLocatedNAMAsset(file, candidate))) {
                              setStatusMessage("The library copy no longer matches the SHA-256 identity saved with this project.");
                              return;
                            }
                            if (await resolveFile(index, candidate)) {
                              setStatusMessage("Relinked to the matching copy already present in the NAM library.");
                            }
                          } finally {
                            setBusyIndex(null);
                          }
                        }}
                        disabled={busyIndex === index}
                      >
                        <FolderOpen size={12} className="mr-1" />
                        Use Library Copy
                      </Button>
                    )}
                    {file.kind === "nam" && file.namTargets.some(hasDownloadMetadata) && (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => handleReDownload(index)}
                        disabled={busyIndex === index}
                      >
                        <Download size={12} className="mr-1" />
                        Re-download
                      </Button>
                    )}
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => handleLocateFile(index)}
                      disabled={busyIndex === index}
                    >
                      <Search size={12} className="mr-1" />
                      Locate
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>

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

async function verifyLocatedNAMAsset(file: MissingFile, candidatePath: string): Promise<boolean> {
  if (!file.namTargets.every((target) => isCompatibleNAMAssetExtension(candidatePath, target.slot))) {
    return false;
  }

  const expectedChecksums = [...new Set(file.namTargets
    .map((target) => normalizeNAMAssetChecksum(target.checksum))
    .filter(Boolean))];
  if (expectedChecksums.length === 0) return true;
  if (expectedChecksums.length > 1) return false;

  const inspection = await nativeBridge.inspectNAMAsset(candidatePath).catch(() => null);
  return Boolean(inspection?.success
    && normalizeNAMAssetChecksum(inspection.checksum) === expectedChecksums[0]);
}

function isCompatibleNAMAssetExtension(candidatePath: string, slot: NAMProjectAssetTarget["slot"]): boolean {
  const extension = candidatePath.replace(/^.*(?=\.)/, "").toLowerCase();
  if (slot === "cab") return [".wav", ".aif", ".aiff", ".flac", ".ogg"].includes(extension);
  return extension === ".nam";
}

function getNAMLocateFilter(file: MissingFile): string {
  const slots = new Set(file.namTargets.map((target) => target.slot));
  if (slots.size > 0 && [...slots].every((slot) => slot === "cab")) {
    return "Cab IR Files|*.wav;*.aif;*.aiff;*.flac;*.ogg";
  }
  if (slots.size > 0 && [...slots].every((slot) => slot !== "cab")) {
    return "NAM Model Files|*.nam";
  }
  return "NAM and IR Files|*.nam;*.wav;*.aif;*.aiff;*.flac;*.ogg";
}

function uniqueRelinkCandidate(file: MissingFile): string {
  const candidates = [...new Set(file.namTargets
    .map((target) => String(target.relinkCandidatePath || ""))
    .filter(Boolean))];
  return candidates.length === 1 ? candidates[0] : "";
}

function toMissingFile(entry: MissingMediaEntry): MissingFile {
  return {
    originalPath: entry.path,
    clipIds: entry.clipIds || [],
    kind: entry.kind === "nam" ? "nam" : "media",
    namTargets: entry.namTargets || [],
    resolved: false,
  };
}

function getFileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function hasDownloadMetadata(target: NAMProjectAssetTarget): boolean {
  const metadata = target.lastSeenMetadata || {};
  return Boolean(target.modelUrl || metadata.model_url || metadata.modelUrl);
}

async function ensureTONE3000AuthForRestore(): Promise<boolean> {
  const result = await ensureTONE3000Session("re-downloading NAM models");
  return result.ok;
}

function makeReinstallPayload(target: NAMProjectAssetTarget): NAMCatalogModel {
  const metadata = target.lastSeenMetadata || {};
  const modelUrl = String(target.modelUrl || metadata.model_url || metadata.modelUrl || "");
  return {
    ...metadata,
    id: Number(metadata.id ?? metadata.model_id ?? target.modelId ?? 0),
    model_id: Number(metadata.model_id ?? metadata.id ?? target.modelId ?? 0),
    tone_id: Number(metadata.tone_id ?? metadata.toneId ?? target.toneId ?? 0),
    toneId: Number(metadata.toneId ?? metadata.tone_id ?? target.toneId ?? 0),
    name: String(metadata.name ?? metadata.title ?? target.toneTitle ?? getFileName(target.path)),
    title: String(metadata.title ?? metadata.name ?? target.toneTitle ?? getFileName(target.path)),
    model_url: modelUrl,
    modelUrl,
    source_url: String(metadata.source_url ?? metadata.sourceUrl ?? target.sourceUrl ?? ""),
    sourceUrl: String(metadata.sourceUrl ?? metadata.source_url ?? target.sourceUrl ?? ""),
    architecture_version: metadata.architecture_version ?? metadata.architecture ?? target.architecture,
    architecture: metadata.architecture ?? metadata.architecture_version ?? target.architecture,
    license_name: String(metadata.license_name ?? metadata.license ?? target.license ?? ""),
    license: String(metadata.license ?? metadata.license_name ?? target.license ?? ""),
    creator_name: String(metadata.creator_name ?? metadata.creator ?? target.creator ?? ""),
    creator: String(metadata.creator ?? metadata.creator_name ?? target.creator ?? ""),
    gear_type: String(metadata.gear_type ?? metadata.gearType ?? target.gearType ?? ""),
    gearType: String(metadata.gearType ?? metadata.gear_type ?? target.gearType ?? ""),
    tone_title: String(metadata.tone_title ?? metadata.toneTitle ?? target.toneTitle ?? ""),
    toneTitle: String(metadata.toneTitle ?? metadata.tone_title ?? target.toneTitle ?? ""),
    sha256: String(metadata.sha256 ?? metadata.checksum ?? target.checksum ?? ""),
    checksum: String(metadata.checksum ?? metadata.sha256 ?? target.checksum ?? ""),
  };
}

function formatNAMTargets(targets: NAMProjectAssetTarget[]): string {
  if (targets.length === 0) return "NAM Rack";
  return targets
    .map((target) => {
      const track = target.trackName || target.trackId || "Track";
      const chain = target.chain === "input" ? "Input FX" : target.chain === "master" ? "Master FX" : "Track FX";
      const slot = target.slot === "cab" ? "Cab/IR" : target.slot === "pedal" ? "Pedal" : "Amp";
      const compare = target.compareSnapshot && target.compareSlot ? ` ${target.compareSlot}` : "";
      return `${track} - ${chain} ${target.fxIndex + 1} -${compare} ${slot}`;
    })
    .join(", ");
}
