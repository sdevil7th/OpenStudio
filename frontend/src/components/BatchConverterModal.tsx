import { useRef, useState } from "react";
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
  const running = useRef(false);
  const stopRequested = useRef(false);

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
    if (jobs.length === 0 || running.current) return;
    running.current = true;
    stopRequested.current = false;
    setProcessing(true);
    try {
    let dir = outputDir;
    if (!dir) {
      dir = await nativeBridge.browseForFolder("Choose converted audio folder");
      if (!dir) return;
      setOutputDir(dir);
    }

    const ext = outputFormat === "aiff" ? "aiff" : outputFormat;

    for (let i = 0; i < jobs.length; i++) {
      if (stopRequested.current) break;
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
      try {
        // Never overwrite an original or another same-named batch item. An
        // existing file is skipped by finding a bounded, available copy name.
        let outputPath = `${dir}/${baseName}.${ext}`;
        let suffix = 1;
        while (await nativeBridge.fileExists(outputPath)) {
          if (suffix > 1000) throw new Error("Could not find an unused output name");
          outputPath = `${dir}/${baseName}-converted-${suffix++}.${ext}`;
        }
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

    } catch (error) {
      useDAWStore.getState().showToast(`Could not start conversion: ${String(error)}`, "error");
    } finally {
      running.current = false;
      setProcessing(false);
      setProgress("");
    }
  };

  const pendingCount = jobs.filter(
    (j) => j.status === "pending" || j.status === "error",
  ).length;
  const doneCount = jobs.filter((j) => j.status === "done").length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !running.current && onClose()}
      title="Batch File Converter"
      size="lg"
    >
      <div className="min-w-0 max-h-[70vh] flex flex-col gap-3">
        {/* Output settings */}
        <div className="grid grid-cols-4 gap-2">
          <Select
            label="Format"
            size="xs"
            fullWidth
            value={outputFormat}
            disabled={processing}
            onChange={(val) => {
              setOutputFormat(String(val));
              if (val === "flac" && outputBitDepth !== 16) setOutputBitDepth(24);
            }}
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
            disabled={processing}
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
            disabled={processing}
            onChange={(val) => setOutputBitDepth(Number(val))}
            options={[
              ...(outputFormat === "flac" ? [] : [{ value: 0, label: "Keep Original" }]),
              { value: 16, label: "16-bit" },
              { value: 24, label: "24-bit" },
              ...(outputFormat === "flac" ? [] : [{ value: 32, label: "32-bit float" }]),
            ]}
          />
          <Select
            label="Channels"
            size="xs"
            fullWidth
            value={outputChannels}
            disabled={processing}
            onChange={(val) => setOutputChannels(Number(val))}
            options={[
              { value: 0, label: "Keep Original" },
              { value: 1, label: "Mono" },
              { value: 2, label: "Stereo" },
            ]}
          />
        </div>

        <div className="flex min-w-0 items-center gap-2 text-xs text-daw-text-muted">
          <Button size="sm" disabled={processing} onClick={() => void nativeBridge.browseForFolder("Choose converted audio folder")
            .then(path => { if (path) setOutputDir(path); })
            .catch(error => useDAWStore.getState().showToast(String(error), "error"))}>Output folder</Button>
          <span className="min-w-0 truncate" title={outputDir}>{outputDir || "Choose when converting"}</span>
        </div>
        <p className="text-xs leading-5 text-daw-text-muted">Rate conversion preserves pitch and duration. Existing files are kept; new copies receive a unique name.</p>

        {/* Add files */}
        <div className="flex items-center gap-2">
          <Button variant="default" size="sm" disabled={processing} onClick={addFromBrowse}>
            <Plus size={12} /> Browse File
          </Button>
          <Button variant="default" size="sm" disabled={processing} onClick={addFromProject}>
            <Plus size={12} /> From Project
          </Button>
          {doneCount > 0 && (
            <Button variant="ghost" size="sm" disabled={processing} onClick={clearDone}>
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
                <span className="max-w-[45%] break-words text-[10px] text-neutral-400" role={job.status === "error" ? "alert" : undefined}>
                  {job.status === "converting"
                    ? "Converting..."
                    : job.status === "done"
                      ? "Done"
                      : job.status === "error"
                        ? job.error || "Error"
                        : "Pending"}
                </span>
                {/* Remove button */}
                {!processing && (
                  <button
                    className="shrink-0 p-0.5 rounded hover:bg-neutral-700"
                    onClick={() => removeJob(job.id)}
                    aria-label={`Remove ${job.fileName}`}
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
            {processing && <Button size="sm" onClick={() => {
              stopRequested.current = true;
              setProgress("Stopping after the current file finishes...");
            }}>Stop after current</Button>}
            <Button variant="default" size="sm" disabled={processing} onClick={onClose}>
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
