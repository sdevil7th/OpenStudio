import { useState } from "react";
import { Plus, Play, X } from "lucide-react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Modal, Button, Select } from "./ui";

interface ConvertJob {
  id: string;
  inputPath: string;
  fileName: string;
  status: "pending" | "converting" | "done" | "error";
  error?: string;
}

interface BatchConverterModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function BatchConverterModal({
  isOpen,
  onClose,
}: BatchConverterModalProps) {
  const [jobs, setJobs] = useState<ConvertJob[]>([]);
  const [outputFormat, setOutputFormat] = useState("wav");
  const [outputSampleRate, setOutputSampleRate] = useState(0); // 0 = keep original
  const [outputBitDepth, setOutputBitDepth] = useState(0); // 0 = keep original
  const [outputChannels, setOutputChannels] = useState(0); // 0 = keep original
  const [outputDir, setOutputDir] = useState("");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");

  const addFromProject = () => {
    const state = useDAWStore.getState();
    const filePaths = new Set<string>();
    for (const track of state.tracks) {
      for (const clip of track.clips) {
        if (clip.filePath) filePaths.add(clip.filePath);
      }
    }
    const newJobs: ConvertJob[] = [...filePaths]
      .filter((p) => !jobs.some((j) => j.inputPath === p))
      .map((p) => ({
        id: crypto.randomUUID(),
        inputPath: p,
        fileName: p.split(/[/\\]/).pop() || p,
        status: "pending" as const,
      }));
    setJobs((prev) => [...prev, ...newJobs]);
  };

  const addFromBrowse = async () => {
    const filePath = await nativeBridge.showOpenDialog("Select audio file to convert");
    if (filePath) {
      if (jobs.some((j) => j.inputPath === filePath)) return;
      setJobs((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          inputPath: filePath,
          fileName: filePath.split(/[/\\]/).pop() || filePath,
          status: "pending",
        },
      ]);
    }
  };

  const removeJob = (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  };

  const clearDone = () => {
    setJobs((prev) => prev.filter((j) => j.status !== "done"));
  };

  const processAll = async () => {
    if (jobs.length === 0) return;
    setProcessing(true);

    let dir = outputDir;
    if (!dir) {
      dir = await nativeBridge.showSaveDialog(undefined, "Select output directory");
      if (!dir) {
        setProcessing(false);
        return;
      }
      // Use directory part of selected path
      dir = dir.replace(/[/\\][^/\\]*$/, "");
      setOutputDir(dir);
    }

    const ext = outputFormat === "aiff" ? "aiff" : outputFormat;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (job.status === "done") continue;

      setProgress(`Converting ${i + 1}/${jobs.length}: ${job.fileName}`);
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id ? { ...j, status: "converting" } : j,
        ),
      );

      // Build output filename
      const baseName = job.fileName.replace(/\.[^.]+$/, "");
      const outputPath = `${dir}/${baseName}.${ext}`;

      try {
        const success = await nativeBridge.convertAudioFile(
          job.inputPath,
          outputPath,
          outputFormat,
          outputSampleRate,
          outputBitDepth,
          outputChannels,
        );

        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? { ...j, status: success ? "done" : "error", error: success ? undefined : "Conversion failed" }
              : j,
          ),
        );
      } catch (err) {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? { ...j, status: "error", error: String(err) }
              : j,
          ),
        );
      }
    }

    setProcessing(false);
    setProgress("");
  };

  const pendingCount = jobs.filter(
    (j) => j.status === "pending" || j.status === "error",
  ).length;
  const doneCount = jobs.filter((j) => j.status === "done").length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Batch File Converter"
    >
      <div className="w-[520px] max-h-[500px] flex flex-col gap-3">
        {/* Output settings */}
        <div className="grid grid-cols-4 gap-2">
          <Select
            label="Format"
            size="xs"
            fullWidth
            value={outputFormat}
            onChange={(val) => setOutputFormat(String(val))}
            options={[
              { value: "wav", label: "WAV" },
              { value: "aiff", label: "AIFF" },
              { value: "flac", label: "FLAC" },
            ]}
          />
          <Select
            label="Sample Rate"
            size="xs"
            fullWidth
            value={outputSampleRate}
            onChange={(val) => setOutputSampleRate(Number(val))}
            options={[
              { value: 0, label: "Keep Original" },
              { value: 44100, label: "44100 Hz" },
              { value: 48000, label: "48000 Hz" },
              { value: 88200, label: "88200 Hz" },
              { value: 96000, label: "96000 Hz" },
            ]}
          />
          <Select
            label="Bit Depth"
            size="xs"
            fullWidth
            value={outputBitDepth}
            onChange={(val) => setOutputBitDepth(Number(val))}
            options={[
              { value: 0, label: "Keep Original" },
              { value: 16, label: "16-bit" },
              { value: 24, label: "24-bit" },
              { value: 32, label: "32-bit float" },
            ]}
          />
          <Select
            label="Channels"
            size="xs"
            fullWidth
            value={outputChannels}
            onChange={(val) => setOutputChannels(Number(val))}
            options={[
              { value: 0, label: "Keep Original" },
              { value: 1, label: "Mono" },
              { value: 2, label: "Stereo" },
            ]}
          />
        </div>

        {/* Add files */}
        <div className="flex items-center gap-2">
          <Button variant="default" size="sm" onClick={addFromBrowse}>
            <Plus size={12} /> Browse File
          </Button>
          <Button variant="default" size="sm" onClick={addFromProject}>
            <Plus size={12} /> From Project
          </Button>
          {doneCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearDone}>
              Clear Done
            </Button>
          )}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto max-h-[280px] border border-neutral-700 rounded bg-neutral-800">
          {jobs.length === 0 ? (
            <div className="text-[10px] text-neutral-500 text-center py-6">
              No files added. Click "Browse File" or "From Project" to add files.
            </div>
          ) : (
            jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center gap-2 px-2 py-1 border-b border-neutral-700/50 last:border-b-0"
              >
                {/* Status indicator */}
                <span className="shrink-0 w-2 h-2 rounded-full"
                  style={{
                    backgroundColor:
                      job.status === "done" ? "#22c55e" :
                      job.status === "converting" ? "#eab308" :
                      job.status === "error" ? "#ef4444" :
                      "#6b7280",
                  }}
                />
                {/* File name */}
                <span
                  className="flex-1 text-[9px] text-neutral-300 truncate"
                  title={job.inputPath}
                >
                  {job.fileName}
                </span>
                {/* Status text */}
                <span className="shrink-0 text-[8px] text-neutral-500">
                  {job.status === "converting"
                    ? "Converting..."
                    : job.status === "done"
                      ? "Done"
                      : job.status === "error"
                        ? job.error || "Error"
                        : "Pending"}
                </span>
                {/* Remove button */}
                {job.status !== "converting" && (
                  <button
                    className="shrink-0 p-0.5 rounded hover:bg-neutral-700"
                    onClick={() => removeJob(job.id)}
                  >
                    <X size={10} className="text-neutral-500" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {/* Progress */}
        {progress && (
          <div className="text-[9px] text-yellow-400">{progress}</div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-neutral-700">
          <span className="text-[9px] text-neutral-500">
            {jobs.length} files ({pendingCount} pending, {doneCount} done)
          </span>
          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={processAll}
              disabled={processing || pendingCount === 0}
            >
              <Play size={12} />
              {processing ? "Converting..." : `Convert ${pendingCount} Files`}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
