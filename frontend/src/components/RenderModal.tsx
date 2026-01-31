import { useState, useEffect } from "react";
import { useDAWStore } from "../store/useDAWStore";
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

type RenderSource = "master" | "selected_tracks" | "stems";
type RenderBounds = "entire" | "custom" | "time_selection";
type AudioFormat = "wav" | "aiff" | "flac" | "mp3" | "ogg";
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
}

/**
 * Render/Export Modal Component
 * Allows users to export their project to various audio formats
 * Based on Reaper's render dialog design
 */
export function RenderModal({ isOpen, onClose }: RenderModalProps) {
  const { transport, tracks, timeSelection, projectPath } = useDAWStore();
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [options, setOptions] = useState<RenderOptions>({
    source: "master",
    bounds: "entire",
    startTime: 0,
    endTime: transport.currentTime || 60,
    tailLength: 1000,
    addTail: true,
    directory: "",
    fileName: "untitled",
    format: "wav",
    sampleRate: 44100,
    bitDepth: 24,
    channels: "stereo",
    normalize: false,
    dither: false,
  });

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

  // Set default directory from project path
  useEffect(() => {
    if (isOpen && projectPath && !options.directory) {
      const dir = projectPath.substring(0, projectPath.lastIndexOf("\\"));
      setOptions((prev) => ({ ...prev, directory: dir }));
    }
  }, [isOpen, projectPath]);

  const handleBrowseDirectory = async () => {
    try {
      // Get file filter based on selected format
      const fileFilters = [
        {
          name: getFormatName(options.format),
          extensions: [options.format],
        },
      ];

      const path = await nativeBridge.showSaveDialog(
        options.directory || "",
        fileFilters
      );
      if (path) {
        const dir = path.substring(0, path.lastIndexOf("\\"));
        setOptions((prev) => ({ ...prev, directory: dir }));
      }
    } catch (error) {
      console.error("Failed to select directory:", error);
    }
  };

  const getFormatName = (format: AudioFormat): string => {
    switch (format) {
      case "wav":
        return "WAV Audio";
      case "aiff":
        return "AIFF Audio";
      case "flac":
        return "FLAC Audio";
      case "mp3":
        return "MP3 Audio";
      case "ogg":
        return "OGG Vorbis Audio";
      default:
        return "Audio File";
    }
  };

  const calculateLength = () => {
    const length = options.endTime - options.startTime;
    return length > 0 ? length.toFixed(3) : "0.000";
  };

  const getRenderPath = () => {
    const ext = options.format;
    return `${options.directory}\\${options.fileName}.${ext}`;
  };

  const handleRender = async () => {
    setIsRendering(true);
    setRenderProgress(0);

    try {
      // Call native render function
      await nativeBridge.renderProject({
        source: options.source,
        startTime: options.startTime,
        endTime: options.endTime,
        filePath: getRenderPath(),
        format: options.format,
        sampleRate: options.sampleRate,
        bitDepth: options.bitDepth,
        channels: options.channels === "stereo" ? 2 : 1,
        normalize: options.normalize,
        addTail: options.addTail,
        tailLength: options.tailLength,
      });

      setRenderProgress(100);
      setTimeout(() => {
        onClose();
        setIsRendering(false);
        setRenderProgress(0);
      }, 500);
    } catch (error) {
      console.error("Render failed:", error);
      alert("Render failed: " + error);
      setIsRendering(false);
      setRenderProgress(0);
    }
  };

  const handleCancel = () => {
    if (isRendering) {
      // TODO: Implement render cancellation
      setIsRendering(false);
      setRenderProgress(0);
    }
    onClose();
  };

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
                { value: "selected_tracks", label: "Selected tracks" },
                { value: "stems", label: "Master mix + stems" },
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
              ]}
              value={options.bounds}
              onChange={(val) =>
                setOptions({ ...options, bounds: val as RenderBounds })
              }
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
                disabled={isRendering}
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-daw-text-muted w-24">
                Render to:
              </label>
              <div className="flex-1 bg-daw-darker border border-daw-border rounded px-3 py-1.5 text-sm text-daw-text-muted">
                {getRenderPath()}
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
                  { value: "mp3", label: "MP3 (LAME encoder)" },
                  { value: "ogg", label: "OGG Vorbis" },
                ]}
                value={options.format}
                onChange={(val) =>
                  setOptions({ ...options, format: val as AudioFormat })
                }
                disabled={isRendering}
              />
            </div>

            {(options.format === "wav" || options.format === "aiff") && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-daw-text-muted w-24">
                  Bit depth:
                </label>
                <Select
                  variant="default"
                  size="sm"
                  fullWidth
                  options={[
                    { value: 16, label: "16-bit PCM" },
                    { value: 24, label: "24-bit PCM" },
                    { value: 32, label: "32-bit float" },
                  ]}
                  value={options.bitDepth}
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

            <div className="flex gap-4 text-sm">
              <Checkbox
                label="Normalize"
                checked={options.normalize}
                onChange={(e) =>
                  setOptions({ ...options, normalize: e.target.checked })
                }
                disabled={isRendering}
              />

              <Checkbox
                label="Dither"
                checked={options.dither}
                onChange={(e) =>
                  setOptions({ ...options, dither: e.target.checked })
                }
                disabled={isRendering}
              />
            </div>
          </div>

          {/* Progress Bar */}
          {isRendering && (
            <div className="space-y-2">
              <div className="text-sm text-daw-text-muted">
                Rendering... {renderProgress}%
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
          variant="primary"
          size="md"
          onClick={handleRender}
          disabled={isRendering || !options.directory || !options.fileName}
        >
          {isRendering ? "Rendering..." : "Render 1 file"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
