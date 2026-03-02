import { useState, useEffect } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { nativeBridge } from "../services/NativeBridge";
import {
  Button,
  Input,
  Select,
  Checkbox,
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
} from "./ui";

interface RenderModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type RenderSource = "master" | "selected_tracks" | "stems" | "selected_items" | "selected_items_master" | "razor";
type RenderBounds = "entire" | "custom" | "time_selection" | "project_regions" | "selected_regions";
type AudioFormat = "wav" | "aiff" | "flac" | "mp3" | "ogg" | "raw";
type SampleRate = 44100 | 48000 | 88200 | 96000 | 192000;
type BitDepth = 16 | 24 | 32;

interface RenderOptions {
  source: RenderSource;
  bounds: RenderBounds;
  startTime: number;
  endTime: number;
  tailLength: number;
  addTail: boolean;
  directory: string;
  fileName: string;
  format: AudioFormat;
  sampleRate: SampleRate;
  bitDepth: BitDepth;
  channels: "stereo" | "mono";
  normalize: boolean;
  dither: boolean;
  mp3Bitrate: number;
  oggQuality: number;
}

const isLossyFormat = (format: AudioFormat) => format === "mp3" || format === "ogg";

/**
 * Resolve wildcard variables in filename template
 */
function resolveWildcards(
  template: string,
  context: { projectName?: string; trackName?: string; index?: number; regionName?: string }
): string {
  const now = new Date();
  let result = template;
  result = result.replace(/\$project/g, context.projectName || "untitled");
  result = result.replace(/\$track/g, context.trackName || "");
  result = result.replace(/\$region/g, context.regionName || "");
  result = result.replace(
    /\$date/g,
    now.toISOString().slice(0, 10) // YYYY-MM-DD
  );
  result = result.replace(
    /\$time/g,
    now.toTimeString().slice(0, 8).replace(/:/g, "-") // HH-MM-SS
  );
  result = result.replace(
    /\$index/g,
    context.index !== undefined ? String(context.index).padStart(2, "0") : ""
  );
  // Clean up any double underscores or trailing underscores from empty replacements
  result = result.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return result;
}

/**
 * Render/Export Modal Component
 * Allows users to export their project to various audio formats
 * Based on Reaper's render dialog design
 */
export function RenderModal({ isOpen, onClose }: RenderModalProps) {
  const {
    tracks, timeSelection, projectPath, projectRange, syncClipsWithBackend,
    selectedTrackIds, regions, selectedRegionIds, selectedClipIds, razorEdits,
    projectName, renderMetadata, secondaryOutputEnabled, secondaryOutputFormat,
    secondaryOutputBitDepth, onlineRender, addToProjectAfterRender,
  } = useDAWStore(useShallow((s) => ({
    tracks: s.tracks,
    timeSelection: s.timeSelection,
    projectPath: s.projectPath,
    projectRange: s.projectRange,
    syncClipsWithBackend: s.syncClipsWithBackend,
    selectedTrackIds: s.selectedTrackIds,
    regions: s.regions,
    selectedRegionIds: s.selectedRegionIds,
    selectedClipIds: s.selectedClipIds,
    razorEdits: s.razorEdits,
    projectName: s.projectName,
    renderMetadata: s.renderMetadata,
    secondaryOutputEnabled: s.secondaryOutputEnabled,
    secondaryOutputFormat: s.secondaryOutputFormat,
    secondaryOutputBitDepth: s.secondaryOutputBitDepth,
    onlineRender: s.onlineRender,
    addToProjectAfterRender: s.addToProjectAfterRender,
  })));
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState("");
  const [options, setOptions] = useState<RenderOptions>(() => {
    // Compute initial extent from clips if projectRange is empty
    let extent = projectRange;
    if (extent.end <= extent.start) {
      let minStart = Infinity;
      let maxEnd = 0;
      for (const track of tracks) {
        for (const clip of track.clips) {
          minStart = Math.min(minStart, clip.startTime);
          maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
        }
      }
      if (maxEnd > 0) extent = { start: Math.min(minStart, 0), end: maxEnd };
    }
    return {
      source: "master",
      bounds: "entire",
      startTime: extent.start,
      endTime: extent.end,
      tailLength: 1000,
      addTail: true,
      directory: "",
      fileName: "$project",
      format: "wav",
      sampleRate: 44100,
      bitDepth: 24,
      channels: "stereo",
      normalize: false,
      dither: false,
      mp3Bitrate: 320,
      oggQuality: 6,
    };
  });

  // Compute actual project extent from clips if projectRange is empty
  const getProjectExtent = () => {
    if (projectRange.end > projectRange.start) {
      return projectRange;
    }
    // Fall back: compute from clip positions
    let minStart = Infinity;
    let maxEnd = 0;
    for (const track of tracks) {
      for (const clip of track.clips) {
        minStart = Math.min(minStart, clip.startTime);
        maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
      }
    }
    if (maxEnd > 0) {
      return { start: Math.min(minStart, 0), end: maxEnd };
    }
    return { start: 0, end: 0 };
  };

  // Update time bounds when time selection changes
  useEffect(() => {
    if (timeSelection && options.bounds === "time_selection") {
      setOptions((prev) => ({
        ...prev,
        startTime: timeSelection.start,
        endTime: timeSelection.end,
      }));
    }
  }, [timeSelection, options.bounds]);

  // Sync with project range when bounds is "entire"
  useEffect(() => {
    if (options.bounds === "entire") {
      const extent = getProjectExtent();
      setOptions((prev) => ({
        ...prev,
        startTime: extent.start,
        endTime: extent.end,
      }));
    }
  }, [projectRange, tracks, options.bounds]);

  // Set default directory from project path
  useEffect(() => {
    if (isOpen && projectPath && !options.directory) {
      const dir = projectPath.substring(0, projectPath.lastIndexOf("\\"));
      setOptions((prev) => ({ ...prev, directory: dir }));
    }
  }, [isOpen, projectPath]);

  const handleBrowseDirectory = async () => {
    try {
      const ext = options.format;
      const path = await nativeBridge.showRenderSaveDialog(
        resolveWildcards(options.fileName, { projectName }) || "untitled",
        ext
      );
      if (path) {
        const lastSlash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
        const dir = lastSlash >= 0 ? path.substring(0, lastSlash) : "";
        let name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
        // Strip extension from filename if present
        const dotIdx = name.lastIndexOf(".");
        if (dotIdx > 0) name = name.substring(0, dotIdx);
        setOptions((prev) => ({ ...prev, directory: dir, fileName: name }));
      }
    } catch (error) {
      console.error("Failed to select directory:", error);
    }
  };

  const calculateLength = () => {
    const length = options.endTime - options.startTime;
    return length > 0 ? length.toFixed(3) : "0.000";
  };

  const getResolvedFileName = (trackName?: string, index?: number) => {
    return resolveWildcards(options.fileName, { projectName, trackName, index });
  };

  const getRenderPath = (trackName?: string, index?: number) => {
    const ext = options.format;
    const name = getResolvedFileName(trackName, index);
    return `${options.directory}\\${name}.${ext}`;
  };

  /** Calculate number of files that will be rendered */
  const getFileCount = () => {
    if (options.source === "stems") {
      return tracks.length + 1; // All tracks + master mix
    }
    if (options.source === "selected_tracks") {
      return selectedTrackIds.length || 1;
    }
    if (options.source === "razor") {
      return Math.max(1, razorEdits.length);
    }
    // Region-based bounds multiply file count
    if (options.bounds === "project_regions") {
      return Math.max(1, regions.length);
    }
    if (options.bounds === "selected_regions") {
      const selRegions = regions.filter((r) => selectedRegionIds.includes(r.id));
      return Math.max(1, selRegions.length);
    }
    return 1;
  };

  /** Build common render params for a single render call */
  const buildRenderParams = (overrides: { source?: string; startTime?: number; endTime?: number; filePath: string }) => {
    const bitDepthOrQuality = isLossyFormat(options.format)
      ? options.format === "mp3" ? options.mp3Bitrate : options.oggQuality
      : options.bitDepth;
    return {
      source: overrides.source ?? options.source,
      startTime: overrides.startTime ?? options.startTime,
      endTime: overrides.endTime ?? options.endTime,
      filePath: overrides.filePath,
      format: options.format === "raw" ? "wav" : options.format, // RAW uses wav writer, stripped later
      sampleRate: options.sampleRate,
      bitDepth: bitDepthOrQuality,
      channels: options.channels === "stereo" ? 2 : 1,
      normalize: options.normalize,
      addTail: options.addTail,
      tailLength: options.tailLength,
    };
  };

  /** Render with dither support — delegates to the appropriate bridge method */
  const doRender = async (overrides: { source?: string; startTime?: number; endTime?: number; filePath: string }) => {
    const params = buildRenderParams(overrides);
    if (options.dither) {
      const ditherType = useDAWStore.getState().ditherType === "none" ? "tpdf" : useDAWStore.getState().ditherType;
      return nativeBridge.renderProjectWithDither({ ...params, ditherType });
    }
    return nativeBridge.renderProject(params);
  };

  /** Run a secondary render (convert to secondary format) after primary render */
  const renderSecondary = async (primaryPath: string) => {
    if (!secondaryOutputEnabled) return;
    const ext = secondaryOutputFormat;
    const secPath = primaryPath.replace(/\.[^.]+$/, `.${ext}`);
    await doRender({ filePath: secPath });
  };

  /** Add rendered file(s) to project after render */
  const addRenderedToProject = async (filePaths: string[]) => {
    if (!addToProjectAfterRender) return;
    const store = useDAWStore.getState();
    for (const fp of filePaths) {
      try {
        const info = await nativeBridge.importMediaFile(fp);
        if (info) {
          const trackId = crypto.randomUUID();
          const fileName = fp.split(/[/\\]/).pop() || "Rendered";
          const trackName = fileName.replace(/\.[^.]+$/, "");
          store.addTrack({ id: trackId, name: trackName, type: "audio" });
          store.addClip(trackId, {
            id: crypto.randomUUID(),
            filePath: info.filePath,
            name: fileName,
            startTime: 0,
            duration: info.duration,
            offset: 0,
            color: "#4361ee",
            volumeDB: 0,
            fadeIn: 0,
            fadeOut: 0,
            sampleRate: info.sampleRate,
          });
        }
      } catch { /* ignore import errors for add-to-project */ }
    }
  };

  /** Collect time ranges to render based on bounds setting */
  const getRenderRanges = (): Array<{ start: number; end: number; name?: string }> => {
    if (options.bounds === "project_regions") {
      if (regions.length === 0) return [{ start: options.startTime, end: options.endTime }];
      return regions.map((r) => ({ start: r.startTime, end: r.endTime, name: r.name }));
    }
    if (options.bounds === "selected_regions") {
      const selRegions = regions.filter((r) => selectedRegionIds.includes(r.id));
      if (selRegions.length === 0) return [{ start: options.startTime, end: options.endTime }];
      return selRegions.map((r) => ({ start: r.startTime, end: r.endTime, name: r.name }));
    }
    return [{ start: options.startTime, end: options.endTime }];
  };

  const handleRender = async () => {
    if (options.endTime <= options.startTime && options.bounds !== "project_regions" && options.bounds !== "selected_regions") {
      alert("Invalid render range: end time must be greater than start time.");
      return;
    }

    setIsRendering(true);
    setRenderProgress(0);
    setRenderStatus("Syncing clips...");
    const renderedFiles: string[] = [];

    try {
      await syncClipsWithBackend();
      const ranges = getRenderRanges();
      const totalFiles = getFileCount();
      let rendered = 0;

      const advanceProgress = () => {
        rendered++;
        setRenderProgress(Math.round((rendered / totalFiles) * 100));
      };

      for (let ri = 0; ri < ranges.length; ri++) {
        const range = ranges[ri];
        const regionCtx = range.name ? { regionName: range.name } : {};

        if (options.source === "stems") {
          // Master mix + each track
          setRenderStatus(`Rendering master mix${range.name ? ` (${range.name})` : ""}...`);
          const masterPath = getRenderPath(undefined, 0);
          const resolvedMaster = range.name
            ? `${options.directory}\\${resolveWildcards(options.fileName, { projectName, index: 0, ...regionCtx })}.${options.format}`
            : masterPath;
          await doRender({ source: "master", startTime: range.start, endTime: range.end, filePath: resolvedMaster });
          renderedFiles.push(resolvedMaster);
          advanceProgress();

          for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            setRenderStatus(`Rendering stem ${i + 1} of ${tracks.length}: ${track.name}${range.name ? ` (${range.name})` : ""}...`);
            const stemPath = `${options.directory}\\${resolveWildcards(options.fileName, { projectName, trackName: track.name, index: i + 1, ...regionCtx })}.${options.format}`;
            await doRender({ source: `stem:${track.id}`, startTime: range.start, endTime: range.end, filePath: stemPath });
            renderedFiles.push(stemPath);
            advanceProgress();
          }
        } else if (options.source === "selected_tracks") {
          const tracksToRender = tracks.filter((t) => selectedTrackIds.includes(t.id));
          if (tracksToRender.length === 0) {
            alert("No tracks selected. Select tracks in the track control panel first.");
            setIsRendering(false);
            return;
          }
          for (let i = 0; i < tracksToRender.length; i++) {
            const track = tracksToRender[i];
            setRenderStatus(`Rendering track ${i + 1} of ${tracksToRender.length}: ${track.name}...`);
            const trackPath = `${options.directory}\\${resolveWildcards(options.fileName, { projectName, trackName: track.name, index: i + 1, ...regionCtx })}.${options.format}`;
            await doRender({ source: `stem:${track.id}`, startTime: range.start, endTime: range.end, filePath: trackPath });
            renderedFiles.push(trackPath);
            advanceProgress();
          }
        } else if (options.source === "selected_items" || options.source === "selected_items_master") {
          // Render only selected clips — pass as master with clip filtering
          if (selectedClipIds.length === 0) {
            alert("No media items selected. Select clips in the timeline first.");
            setIsRendering(false);
            return;
          }
          setRenderStatus(`Rendering ${selectedClipIds.length} selected item(s)${range.name ? ` (${range.name})` : ""}...`);
          // selected_items_master routes through master FX; selected_items renders direct
          const source = options.source === "selected_items_master" ? "master" : "selected_items";
          const itemPath = `${options.directory}\\${resolveWildcards(options.fileName, { projectName, ...regionCtx })}.${options.format}`;
          await doRender({ source, startTime: range.start, endTime: range.end, filePath: itemPath });
          renderedFiles.push(itemPath);
          advanceProgress();
        } else if (options.source === "razor") {
          // Render each razor edit area as a separate file
          if (razorEdits.length === 0) {
            alert("No razor edit areas defined. Use the razor tool to define areas first.");
            setIsRendering(false);
            return;
          }
          for (let i = 0; i < razorEdits.length; i++) {
            const razor = razorEdits[i];
            const track = tracks.find((t) => t.id === razor.trackId);
            setRenderStatus(`Rendering razor area ${i + 1} of ${razorEdits.length}...`);
            const razorPath = `${options.directory}\\${resolveWildcards(options.fileName, { projectName, trackName: track?.name, index: i + 1 })}.${options.format}`;
            await doRender({ source: `stem:${razor.trackId}`, startTime: razor.start, endTime: razor.end, filePath: razorPath });
            renderedFiles.push(razorPath);
            advanceProgress();
          }
        } else {
          // Master mix render
          setRenderStatus(`Rendering master mix${range.name ? ` (${range.name})` : ""}...`);
          const masterPath = `${options.directory}\\${resolveWildcards(options.fileName, { projectName, ...regionCtx })}.${options.format}`;
          await doRender({ source: options.source, startTime: range.start, endTime: range.end, filePath: masterPath });
          renderedFiles.push(masterPath);
          advanceProgress();
        }
      }

      // Secondary output pass
      if (secondaryOutputEnabled && renderedFiles.length > 0) {
        setRenderStatus("Rendering secondary output...");
        for (const fp of renderedFiles) {
          await renderSecondary(fp);
        }
      }

      // Add to project
      if (addToProjectAfterRender && renderedFiles.length > 0) {
        setRenderStatus("Adding rendered files to project...");
        await addRenderedToProject(renderedFiles);
      }

      setRenderProgress(100);
      setRenderStatus("Complete!");
      setTimeout(() => {
        onClose();
        setIsRendering(false);
        setRenderProgress(0);
        setRenderStatus("");
      }, 500);
    } catch (error) {
      console.error("Render failed:", error);
      alert("Render failed: " + error);
      setIsRendering(false);
      setRenderProgress(0);
      setRenderStatus("");
    }
  };

  const handleCancel = () => {
    if (isRendering) {
      // TODO: Implement render cancellation
      setIsRendering(false);
      setRenderProgress(0);
      setRenderStatus("");
    }
    onClose();
  };

  // Resolved filename preview
  const previewFileName = getResolvedFileName();
  const hasWildcards = options.fileName.includes("$");

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCancel}
      size="lg"
      closeOnOverlayClick={!isRendering}
      closeOnEscape={!isRendering}
    >
      <ModalHeader title="Render to File" onClose={handleCancel} />

      <ModalContent>
        <div className="space-y-4">
          {/* Source and Bounds */}
          <div className="flex gap-4">
            <Select
              variant="default"
              size="sm"
              fullWidth
              label="Source:"
              options={[
                { value: "master", label: "Master mix" },
                { value: "selected_tracks", label: "Selected tracks (stems)" },
                { value: "stems", label: "Master mix + all stems" },
                { value: "selected_items", label: "Selected media items" },
                { value: "selected_items_master", label: "Selected items via master" },
                { value: "razor", label: "Razor edit areas" },
              ]}
              value={options.source}
              onChange={(val) =>
                setOptions({ ...options, source: val as RenderSource })
              }
              disabled={isRendering}
            />

            <Select
              variant="default"
              size="sm"
              fullWidth
              label="Bounds:"
              options={[
                { value: "entire", label: "Entire project" },
                { value: "custom", label: "Custom time range" },
                { value: "time_selection", label: "Time selection" },
                { value: "project_regions", label: "Project regions" },
                { value: "selected_regions", label: "Selected regions" },
              ]}
              value={options.bounds}
              onChange={(val) => {
                const newBounds = val as RenderBounds;
                let newStart = options.startTime;
                let newEnd = options.endTime;
                if (newBounds === "entire") {
                  const extent = getProjectExtent();
                  newStart = extent.start;
                  newEnd = extent.end;
                } else if (
                  newBounds === "time_selection" &&
                  timeSelection
                ) {
                  newStart = timeSelection.start;
                  newEnd = timeSelection.end;
                }
                setOptions({
                  ...options,
                  bounds: newBounds,
                  startTime: newStart,
                  endTime: newEnd,
                });
              }}
              disabled={isRendering}
            />
          </div>

          {/* Time bounds */}
          <div className="bg-daw-darker border border-daw-border rounded p-3">
            <h3 className="text-sm font-medium text-daw-text mb-2">
              Time bounds
            </h3>
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-daw-text-muted">Start:</span>
                <Input
                  type="number"
                  variant="transparent"
                  size="xs"
                  value={options.startTime.toFixed(3)}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      startTime: parseFloat(e.target.value),
                    })
                  }
                  step="0.001"
                  className="w-24"
                  disabled={isRendering || options.bounds !== "custom"}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-daw-text-muted">End:</span>
                <Input
                  type="number"
                  variant="transparent"
                  size="xs"
                  value={options.endTime.toFixed(3)}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      endTime: parseFloat(e.target.value),
                    })
                  }
                  step="0.001"
                  className="w-24"
                  disabled={isRendering || options.bounds !== "custom"}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-daw-text-muted">Length:</span>
                <span className="text-daw-text">{calculateLength()}</span>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  checked={options.addTail}
                  onChange={(e) =>
                    setOptions({ ...options, addTail: e.target.checked })
                  }
                  disabled={isRendering}
                />
                <span className="text-daw-text-muted">Tail:</span>
                <Input
                  type="number"
                  variant="transparent"
                  size="xs"
                  value={options.tailLength.toString()}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      tailLength: parseInt(e.target.value),
                    })
                  }
                  className="w-20"
                  disabled={isRendering || !options.addTail}
                />
                <span className="text-daw-text-muted">ms</span>
              </div>
            </div>
          </div>

          {/* Output */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-daw-text">Output</h3>

            <div className="flex items-center gap-2">
              <label className="text-sm text-daw-text-muted w-24">
                Directory:
              </label>
              <Input
                type="text"
                variant="default"
                size="sm"
                value={options.directory}
                onChange={(e) =>
                  setOptions({ ...options, directory: e.target.value })
                }
                className="flex-1"
                disabled={isRendering}
              />
              <Button
                variant="default"
                size="sm"
                onClick={handleBrowseDirectory}
                disabled={isRendering}
              >
                Browse...
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-daw-text-muted w-24">
                File name:
              </label>
              <Input
                type="text"
                variant="default"
                size="sm"
                value={options.fileName}
                onChange={(e) =>
                  setOptions({ ...options, fileName: e.target.value })
                }
                className="flex-1"
                placeholder="$project"
                disabled={isRendering}
              />
            </div>

            {/* Wildcard reference */}
            <div className="text-[10px] text-daw-text-dim ml-24 pl-2">
              Wildcards: <code className="text-daw-text-muted">$project</code>{" "}
              <code className="text-daw-text-muted">$track</code>{" "}
              <code className="text-daw-text-muted">$region</code>{" "}
              <code className="text-daw-text-muted">$date</code>{" "}
              <code className="text-daw-text-muted">$time</code>{" "}
              <code className="text-daw-text-muted">$index</code>
            </div>

            {/* Resolved filename preview */}
            <div className="flex items-center gap-2">
              <label className="text-sm text-daw-text-muted w-24">
                Render to:
              </label>
              <div className="flex-1 bg-daw-darker border border-daw-border rounded px-3 py-1.5 text-sm text-daw-text-muted">
                {hasWildcards ? (
                  <>
                    <span className="text-daw-text">{previewFileName}</span>
                    <span>.{options.format}</span>
                    {(options.source === "stems" || options.source === "selected_tracks") && (
                      <span className="text-daw-text-dim ml-2">(+ track stems with $track)</span>
                    )}
                  </>
                ) : (
                  getRenderPath()
                )}
              </div>
            </div>
          </div>

          {/* Options */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-daw-text">Options</h3>

            <div className="flex gap-4">
              <div className="flex items-center gap-2 flex-1">
                <label className="text-sm text-daw-text-muted">
                  Sample rate:
                </label>
                <Select
                  variant="default"
                  size="sm"
                  fullWidth
                  options={[
                    { value: 44100, label: "44100 Hz" },
                    { value: 48000, label: "48000 Hz" },
                    { value: 88200, label: "88200 Hz" },
                    { value: 96000, label: "96000 Hz" },
                    { value: 192000, label: "192000 Hz" },
                  ]}
                  value={options.sampleRate}
                  onChange={(val) =>
                    setOptions({
                      ...options,
                      sampleRate: val as SampleRate,
                    })
                  }
                  disabled={isRendering}
                />
              </div>

              <div className="flex items-center gap-2 flex-1">
                <label className="text-sm text-daw-text-muted">
                  Channels:
                </label>
                <Select
                  variant="default"
                  size="sm"
                  fullWidth
                  options={[
                    { value: "stereo", label: "Stereo" },
                    { value: "mono", label: "Mono" },
                  ]}
                  value={options.channels}
                  onChange={(val) =>
                    setOptions({
                      ...options,
                      channels: val as "stereo" | "mono",
                    })
                  }
                  disabled={isRendering}
                />
              </div>
            </div>
          </div>

          {/* Format Selection */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-daw-text">
              Primary output format
            </h3>

            <div className="flex items-center gap-2">
              <label className="text-sm text-daw-text-muted w-24">
                Format:
              </label>
              <Select
                variant="default"
                size="sm"
                fullWidth
                options={[
                  { value: "wav", label: "WAV" },
                  { value: "aiff", label: "AIFF" },
                  { value: "flac", label: "FLAC (Lossless)" },
                  { value: "mp3", label: "MP3" },
                  { value: "ogg", label: "OGG Vorbis" },
                  { value: "raw", label: "RAW PCM (headerless)" },
                ]}
                value={options.format}
                onChange={(val) => {
                  const fmt = val as AudioFormat;
                  setOptions({
                    ...options,
                    format: fmt,
                    // Reset bit depth for FLAC if coming from 32-bit
                    bitDepth: fmt === "flac" && options.bitDepth === 32 ? 24 : options.bitDepth,
                  });
                }}
                disabled={isRendering}
              />
            </div>

            {/* Bit depth for lossless formats */}
            {!isLossyFormat(options.format) && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-daw-text-muted w-24">
                  Bit depth:
                </label>
                <Select
                  variant="default"
                  size="sm"
                  fullWidth
                  options={
                    options.format === "flac"
                      ? [
                          { value: 16, label: "16-bit" },
                          { value: 24, label: "24-bit" },
                        ]
                      : [
                          { value: 16, label: "16-bit PCM" },
                          { value: 24, label: "24-bit PCM" },
                          { value: 32, label: "32-bit float" },
                        ]
                  }
                  value={options.format === "flac" && options.bitDepth === 32 ? 24 : options.bitDepth}
                  onChange={(val) =>
                    setOptions({
                      ...options,
                      bitDepth: val as BitDepth,
                    })
                  }
                  disabled={isRendering}
                />
              </div>
            )}

            {/* MP3 bitrate */}
            {options.format === "mp3" && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-daw-text-muted w-24">
                  Bitrate:
                </label>
                <Select
                  variant="default"
                  size="sm"
                  fullWidth
                  options={[
                    { value: 128, label: "128 kbps" },
                    { value: 192, label: "192 kbps" },
                    { value: 256, label: "256 kbps" },
                    { value: 320, label: "320 kbps (Best)" },
                  ]}
                  value={options.mp3Bitrate}
                  onChange={(val) =>
                    setOptions({ ...options, mp3Bitrate: val as number })
                  }
                  disabled={isRendering}
                />
              </div>
            )}

            {/* OGG quality */}
            {options.format === "ogg" && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-daw-text-muted w-24">
                  Quality:
                </label>
                <Select
                  variant="default"
                  size="sm"
                  fullWidth
                  options={[
                    { value: 3, label: "3 (~112 kbps)" },
                    { value: 5, label: "5 (~160 kbps)" },
                    { value: 6, label: "6 (~192 kbps)" },
                    { value: 7, label: "7 (~224 kbps)" },
                    { value: 8, label: "8 (~256 kbps)" },
                    { value: 10, label: "10 (~500 kbps, Best)" },
                  ]}
                  value={options.oggQuality}
                  onChange={(val) =>
                    setOptions({ ...options, oggQuality: val as number })
                  }
                  disabled={isRendering}
                />
              </div>
            )}

            <div className="flex gap-4 text-sm">
              <Checkbox
                label="Normalize"
                checked={options.normalize}
                onChange={(e) =>
                  setOptions({ ...options, normalize: e.target.checked })
                }
                disabled={isRendering}
              />

              <div className="flex items-center gap-2">
                <Checkbox
                  label="Dither"
                  checked={options.dither}
                  onChange={(e) =>
                    setOptions({ ...options, dither: e.target.checked })
                  }
                  disabled={isRendering || options.bitDepth === 32}
                />
                {options.dither && (
                  <Select
                    options={[
                      { value: "tpdf", label: "TPDF" },
                      { value: "shaped", label: "Noise Shaped" },
                    ]}
                    value={useDAWStore.getState().ditherType === "none" ? "tpdf" : useDAWStore.getState().ditherType}
                    onChange={(v) => useDAWStore.getState().setDitherType(v as "tpdf" | "shaped")}
                    size="xs"
                  />
                )}
              </div>
            </div>

            {/* Resample Quality */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-daw-text-muted w-28">Resample Quality:</span>
              <Select
                options={[
                  { value: "fast", label: "Fast" },
                  { value: "good", label: "Good" },
                  { value: "best", label: "Best" },
                ]}
                value={useDAWStore.getState().resampleQuality}
                onChange={(v) => useDAWStore.getState().setResampleQuality(v as "fast" | "good" | "best")}
                size="xs"
              />
            </div>
          </div>

          {/* Secondary Output Format */}
          <div className="bg-daw-darker border border-daw-border rounded p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                label="Secondary output"
                checked={secondaryOutputEnabled}
                onChange={(e) => useDAWStore.getState().setSecondaryOutputEnabled(e.target.checked)}
                disabled={isRendering}
              />
            </div>
            {secondaryOutputEnabled && (
              <div className="flex items-center gap-4 ml-6">
                <Select
                  variant="default"
                  size="xs"
                  options={[
                    { value: "mp3", label: "MP3" },
                    { value: "ogg", label: "OGG" },
                    { value: "flac", label: "FLAC" },
                    { value: "wav", label: "WAV" },
                    { value: "aiff", label: "AIFF" },
                  ]}
                  value={secondaryOutputFormat}
                  onChange={(v) => useDAWStore.getState().setSecondaryOutputFormat(v as string)}
                  disabled={isRendering}
                />
                <Select
                  variant="default"
                  size="xs"
                  options={[
                    { value: 16, label: "16-bit" },
                    { value: 24, label: "24-bit" },
                    { value: 32, label: "32-bit" },
                  ]}
                  value={secondaryOutputBitDepth}
                  onChange={(v) => useDAWStore.getState().setSecondaryOutputBitDepth(v as number)}
                  disabled={isRendering}
                />
              </div>
            )}
          </div>

          {/* Metadata */}
          <details className="bg-daw-darker border border-daw-border rounded">
            <summary className="text-sm font-medium text-daw-text p-3 cursor-pointer select-none">
              Metadata
            </summary>
            <div className="px-3 pb-3 space-y-1.5">
              {(["title", "artist", "album", "genre", "year", "description", "isrc"] as const).map((field) => (
                <div key={field} className="flex items-center gap-2">
                  <span className="text-xs text-daw-text-muted w-20 capitalize">{field === "isrc" ? "ISRC" : field}:</span>
                  <Input
                    type="text"
                    variant="transparent"
                    size="xs"
                    value={renderMetadata[field]}
                    onChange={(e) => useDAWStore.getState().setRenderMetadata({ [field]: e.target.value })}
                    className="flex-1"
                    disabled={isRendering}
                  />
                </div>
              ))}
            </div>
          </details>

          {/* Post-render options */}
          <div className="flex gap-4 text-sm">
            <Checkbox
              label="Online render (1x speed)"
              checked={onlineRender}
              onChange={(e) => useDAWStore.getState().setOnlineRender(e.target.checked)}
              disabled={isRendering}
            />
            <Checkbox
              label="Add to project after render"
              checked={addToProjectAfterRender}
              onChange={(e) => useDAWStore.getState().setAddToProjectAfterRender(e.target.checked)}
              disabled={isRendering}
            />
          </div>

          {/* Progress Bar */}
          {isRendering && (
            <div className="space-y-2">
              <div className="text-sm text-daw-text-muted">
                {renderStatus} {renderProgress}%
              </div>
              <div className="w-full bg-daw-darker rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${renderProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </ModalContent>

      <ModalFooter>
        <Button
          variant="secondary"
          size="md"
          onClick={handleCancel}
          disabled={isRendering}
        >
          Cancel
        </Button>
        <Button
          variant="default"
          size="md"
          onClick={() => {
            useDAWStore.getState().addToRenderQueue(options);
            onClose();
          }}
          disabled={isRendering || !options.directory || !options.fileName}
        >
          Add to Queue
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleRender}
          disabled={isRendering || !options.directory || !options.fileName}
        >
          {isRendering
            ? "Rendering..."
            : `Render ${getFileCount()} file${getFileCount() > 1 ? "s" : ""}`}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
