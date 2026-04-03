import { useState, useEffect, useRef, useCallback } from "react";
import { nativeBridge } from "../services/NativeBridge";
import { Modal, NativeSelect, Button } from "./ui";

interface TimecodeSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type SyncSource = "internal" | "midi_clock" | "mtc";
type FrameRate = "24" | "25" | "29.97df" | "30";

interface SyncStatus {
  locked: boolean;
  source: string;
  externalBPM: number;
  mtcPosition: number;
}

const SYNC_SOURCE_OPTIONS = [
  { value: "internal", label: "Internal" },
  { value: "midi_clock", label: "MIDI Clock" },
  { value: "mtc", label: "MTC (SMPTE)" },
];

const FRAME_RATE_OPTIONS = [
  { value: "24", label: "24 fps" },
  { value: "25", label: "25 fps" },
  { value: "29.97df", label: "29.97 fps (Drop Frame)" },
  { value: "30", label: "30 fps" },
];

function formatMTCPosition(totalFrames: number, fps: number): string {
  if (totalFrames <= 0) return "00:00:00:00";
  const effectiveFps = Math.round(fps);
  const frames = Math.floor(totalFrames % effectiveFps);
  const totalSeconds = Math.floor(totalFrames / effectiveFps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

export function TimecodeSettingsPanel({
  isOpen,
  onClose,
}: TimecodeSettingsPanelProps) {
  const [syncSource, setSyncSource] = useState<SyncSource>("internal");
  const [frameRate, setFrameRate] = useState<FrameRate>("24");
  const [midiInputDevices, setMidiInputDevices] = useState<string[]>([]);
  const [midiOutputDevices, setMidiOutputDevices] = useState<string[]>([]);
  const [selectedMidiInput, setSelectedMidiInput] = useState<string>("");
  const [selectedMidiOutput, setSelectedMidiOutput] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    locked: true,
    source: "internal",
    externalBPM: 120,
    mtcPosition: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch initial state on mount
  useEffect(() => {
    if (!isOpen) return;

    const fetchInitialState = async () => {
      setIsLoading(true);
      try {
        const [status, inputs, outputs] = await Promise.all([
          nativeBridge.getSyncStatus(),
          nativeBridge.getMIDIInputDevices(),
          nativeBridge.getMIDIOutputDevices(),
        ]);

        setSyncStatus(status);
        setMidiInputDevices(inputs);
        setMidiOutputDevices(outputs);

        // Set sync source from backend status
        if (
          status.source === "internal" ||
          status.source === "midi_clock" ||
          status.source === "mtc"
        ) {
          setSyncSource(status.source as SyncSource);
        }
      } catch (err) {
        console.error("[TimecodeSettings] Failed to fetch initial state:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchInitialState();
  }, [isOpen]);

  // Poll sync status every 500ms when panel is open
  useEffect(() => {
    if (!isOpen) return;

    pollIntervalRef.current = setInterval(async () => {
      try {
        const status = await nativeBridge.getSyncStatus();
        setSyncStatus(status);
      } catch (err) {
        console.error("[TimecodeSettings] Failed to poll sync status:", err);
      }
    }, 500);

    return () => {
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isOpen]);

  const handleSyncSourceChange = useCallback(
    async (value: string | number) => {
      const source = String(value) as SyncSource;
      setSyncSource(source);
      try {
        await nativeBridge.setSyncSource(source);
      } catch (err) {
        console.error("[TimecodeSettings] Failed to set sync source:", err);
      }
    },
    [],
  );

  const handleFrameRateChange = useCallback(
    async (value: string | number) => {
      const fps = String(value) as FrameRate;
      setFrameRate(fps);
      try {
        await nativeBridge.setTimecodeFrameRate(fps);
      } catch (err) {
        console.error("[TimecodeSettings] Failed to set frame rate:", err);
      }
    },
    [],
  );

  const handleMidiInputChange = useCallback(
    async (value: string | number) => {
      const deviceId = String(value);
      setSelectedMidiInput(deviceId);
      try {
        await nativeBridge.setTimecodeMIDIDevice(deviceId, true);
      } catch (err) {
        console.error(
          "[TimecodeSettings] Failed to set MIDI input device:",
          err,
        );
      }
    },
    [],
  );

  const handleMidiOutputChange = useCallback(
    async (value: string | number) => {
      const deviceId = String(value);
      setSelectedMidiOutput(deviceId);
      try {
        await nativeBridge.setTimecodeMIDIDevice(deviceId, false);
      } catch (err) {
        console.error(
          "[TimecodeSettings] Failed to set MIDI output device:",
          err,
        );
      }
    },
    [],
  );

  const refreshDevices = useCallback(async () => {
    try {
      const [inputs, outputs] = await Promise.all([
        nativeBridge.getMIDIInputDevices(),
        nativeBridge.getMIDIOutputDevices(),
      ]);
      setMidiInputDevices(inputs);
      setMidiOutputDevices(outputs);
    } catch (err) {
      console.error("[TimecodeSettings] Failed to refresh devices:", err);
    }
  }, []);

  // Determine effective FPS number for MTC position formatting
  const effectiveFps =
    frameRate === "29.97df" ? 29.97 : Number(frameRate);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Timecode Sync Settings"
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-6">
        {/* Sync Source */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-daw-text-secondary">
            Sync Source
          </label>
          <NativeSelect
            options={SYNC_SOURCE_OPTIONS}
            value={syncSource}
            onChange={handleSyncSourceChange}
            variant="dark"
            size="md"
            fullWidth
            loading={isLoading}
          />
          <p className="text-xs text-neutral-500">
            {syncSource === "internal" &&
              "The DAW uses its own internal clock for timing."}
            {syncSource === "midi_clock" &&
              "Synchronize to an external MIDI Clock source."}
            {syncSource === "mtc" &&
              "Synchronize to MIDI Timecode (SMPTE) for frame-accurate sync."}
          </p>
        </div>

        {/* SMPTE Frame Rate — only shown when MTC is selected */}
        {syncSource === "mtc" && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-daw-text-secondary">
              SMPTE Frame Rate
            </label>
            <NativeSelect
              options={FRAME_RATE_OPTIONS}
              value={frameRate}
              onChange={handleFrameRateChange}
              variant="dark"
              size="md"
              fullWidth
              loading={isLoading}
            />
          </div>
        )}

        {/* MIDI Devices Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-daw-text">
              MIDI Devices
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshDevices}
              title="Refresh MIDI device list"
            >
              Refresh
            </Button>
          </div>

          {/* MIDI Input Device */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-daw-text-secondary">
              MIDI Input Device
            </label>
            <NativeSelect
              options={
                midiInputDevices.length > 0
                  ? midiInputDevices
                  : []
              }
              value={selectedMidiInput}
              onChange={handleMidiInputChange}
              variant="dark"
              size="md"
              fullWidth
              placeholder="No device selected"
              loading={isLoading}
            />
            <p className="text-xs text-neutral-500">
              Receives external MIDI Clock or MTC messages.
            </p>
          </div>

          {/* MIDI Output Device */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-daw-text-secondary">
              MIDI Output Device
            </label>
            <NativeSelect
              options={
                midiOutputDevices.length > 0
                  ? midiOutputDevices
                  : []
              }
              value={selectedMidiOutput}
              onChange={handleMidiOutputChange}
              variant="dark"
              size="md"
              fullWidth
              placeholder="No device selected"
              loading={isLoading}
            />
            <p className="text-xs text-neutral-500">
              Sends MIDI Clock or MTC to external devices.
            </p>
          </div>
        </div>

        {/* Sync Status */}
        <div className="space-y-3 rounded-lg border border-daw-border bg-daw-dark p-4">
          <h3 className="text-sm font-medium text-daw-text">
            Sync Status
          </h3>

          <div className="grid grid-cols-2 gap-3">
            {/* Lock Status */}
            <div className="space-y-1">
              <span className="block text-xs text-neutral-500">Status</span>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${
                    syncStatus.locked
                      ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
                      : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"
                  }`}
                />
                <span className="text-sm text-daw-text">
                  {syncStatus.locked ? "Locked" : "Unlocked"}
                </span>
              </div>
            </div>

            {/* Source */}
            <div className="space-y-1">
              <span className="block text-xs text-neutral-500">Source</span>
              <span className="text-sm text-daw-text">
                {syncStatus.source === "internal" && "Internal"}
                {syncStatus.source === "midi_clock" && "MIDI Clock"}
                {syncStatus.source === "mtc" && "MTC"}
                {!["internal", "midi_clock", "mtc"].includes(
                  syncStatus.source,
                ) && syncStatus.source}
              </span>
            </div>

            {/* External BPM */}
            <div className="space-y-1">
              <span className="block text-xs text-neutral-500">
                External BPM
              </span>
              <span className="text-sm font-mono text-daw-text">
                {syncStatus.source !== "internal"
                  ? syncStatus.externalBPM.toFixed(1)
                  : "--"}
              </span>
            </div>

            {/* MTC Position */}
            <div className="space-y-1">
              <span className="block text-xs text-neutral-500">
                MTC Position
              </span>
              <span className="text-sm font-mono text-daw-text">
                {syncStatus.source === "mtc"
                  ? formatMTCPosition(syncStatus.mtcPosition, effectiveFps)
                  : "--:--:--:--"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
