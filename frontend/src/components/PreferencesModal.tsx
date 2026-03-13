import { useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Checkbox, Input, NativeSelect } from "./ui";
import { Modal } from "./ui/Modal/Modal";

interface PreferencesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabId = "general" | "editing" | "display" | "mouse" | "backup";

/**
 * PreferencesModal - Comprehensive settings beyond audio device configuration.
 * Tabs: General, Editing, Display, Backup
 */
export function PreferencesModal({ isOpen, onClose }: PreferencesModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>("general");

  if (!isOpen) return null;

  const tabs: { id: TabId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "editing", label: "Editing" },
    { id: "display", label: "Display" },
    { id: "mouse", label: "Mouse" },
    { id: "backup", label: "Backup" },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Preferences" size="lg">
      <div className="flex gap-4 min-h-[400px]">
        {/* Tab sidebar */}
        <div className="flex flex-col gap-1 min-w-[120px] border-r border-daw-border pr-3">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`text-left px-3 py-1.5 text-sm rounded transition-colors ${
                activeTab === tab.id
                  ? "bg-daw-accent text-white"
                  : "text-daw-text-muted hover:bg-neutral-800"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "general" && <GeneralTab />}
          {activeTab === "editing" && <EditingTab />}
          {activeTab === "display" && <DisplayTab />}
          {activeTab === "mouse" && <MouseModifierTab />}
          {activeTab === "backup" && <BackupTab />}
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-end pt-3 mt-3 border-t border-daw-border">
        <Button variant="default" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase text-daw-text-muted mb-2 mt-3 first:mt-0">
      {children}
    </h3>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-daw-text">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

// ========== General Tab ==========
function GeneralTab() {
  const { snapEnabled, gridSize, playheadStopBehavior } = useDAWStore(useShallow((s) => ({
    snapEnabled: s.snapEnabled,
    gridSize: s.gridSize,
    playheadStopBehavior: s.playheadStopBehavior,
  })));

  return (
    <div>
      <SectionHeader>Transport</SectionHeader>
      <Row label="Playhead on Stop">
        <NativeSelect
          options={["return-to-start", "stop-in-place"]}
          value={playheadStopBehavior}
          onChange={(val) => useDAWStore.getState().setPlayheadStopBehavior(val as any)}
          formatLabel={(v) => {
            const labels: Record<string, string> = {
              "return-to-start": "Return to start position",
              "stop-in-place": "Stop at current position",
            };
            return labels[String(v)] || String(v);
          }}
        />
      </Row>
      <div className="text-[9px] text-daw-text-muted mb-2 ml-1">
        With "Stop at current position", pressing Stop twice returns to the start position.
      </div>

      <SectionHeader>Snap & Grid</SectionHeader>
      <Row label="Snap to Grid">
        <Checkbox
          checked={snapEnabled}
          onChange={() => useDAWStore.getState().toggleSnap()}
          size="sm"
        />
      </Row>
      <Row label="Default Grid Size">
        <NativeSelect
          options={["bar", "half_bar", "quarter_bar", "eighth_bar", "beat", "half_beat", "quarter_beat", "second", "minute"]}
          value={gridSize}
          onChange={(val) => useDAWStore.getState().setGridSize(val as any)}
          formatLabel={(v) => {
            const labels: Record<string, string> = { bar: "Bar", half_bar: "1/2 Bar", quarter_bar: "1/4 Bar", eighth_bar: "1/8 Bar", beat: "Beat", half_beat: "Half Beat", quarter_beat: "Quarter Beat", second: "Second", minute: "Minute" };
            return labels[String(v)] || String(v);
          }}
        />
      </Row>

      <SectionHeader>Project Defaults</SectionHeader>
      <Row label="Default Track Type">
        <span className="text-xs text-daw-text-muted">Audio</span>
      </Row>
      <Row label="Project Extension">
        <span className="text-xs text-daw-text-muted">.s13</span>
      </Row>
    </div>
  );
}

// ========== Editing Tab ==========
function EditingTab() {
  const { autoCrossfade, defaultCrossfadeLength, rippleMode, recordMode } = useDAWStore(useShallow((s) => ({
    autoCrossfade: s.autoCrossfade,
    defaultCrossfadeLength: s.defaultCrossfadeLength,
    rippleMode: s.rippleMode,
    recordMode: s.recordMode,
  })));

  return (
    <div>
      <SectionHeader>Crossfade</SectionHeader>
      <Row label="Auto-Crossfade">
        <Checkbox
          checked={autoCrossfade}
          onChange={() => useDAWStore.getState().toggleAutoCrossfade()}
          size="sm"
        />
      </Row>
      <Row label="Default Crossfade Length">
        <Input
          type="number"
          variant="compact"
          size="xs"
          value={Math.round(defaultCrossfadeLength * 1000).toString()}
          onChange={(e) => {
            const ms = parseInt(e.target.value, 10);
            if (!isNaN(ms) && ms >= 1 && ms <= 5000) {
              useDAWStore.setState({ defaultCrossfadeLength: ms / 1000 });
            }
          }}
          className="w-16"
          inputClassName="w-16"
        />
        <span className="text-xs text-daw-text-muted">ms</span>
      </Row>

      <SectionHeader>Recording</SectionHeader>
      <Row label="Record Mode">
        <NativeSelect
          options={["normal", "overdub", "replace"]}
          value={recordMode}
          onChange={(val) => useDAWStore.getState().setRecordMode(val as any)}
          formatLabel={(v) => String(v).charAt(0).toUpperCase() + String(v).slice(1)}
        />
      </Row>

      <SectionHeader>Ripple Editing</SectionHeader>
      <Row label="Ripple Mode">
        <NativeSelect
          options={["off", "per_track", "all_tracks"]}
          value={rippleMode}
          onChange={(val) => useDAWStore.getState().setRippleMode(val as any)}
          formatLabel={(v) => {
            const labels: Record<string, string> = { off: "Off", per_track: "Per Track", all_tracks: "All Tracks" };
            return labels[String(v)] || String(v);
          }}
        />
      </Row>
    </div>
  );
}

// ========== Display Tab ==========
function DisplayTab() {
  const { timecodeMode, smpteFrameRate, uiFontScale } = useDAWStore(useShallow((s) => ({
    timecodeMode: s.timecodeMode,
    smpteFrameRate: s.smpteFrameRate,
    uiFontScale: s.uiFontScale,
  })));

  return (
    <div>
      <SectionHeader>Time Display</SectionHeader>
      <Row label="Timecode Mode">
        <NativeSelect
          options={["time", "beats", "smpte"]}
          value={timecodeMode}
          onChange={(val) => useDAWStore.getState().setTimecodeMode(val as any)}
          formatLabel={(v) => {
            const labels: Record<string, string> = { time: "Time (MM:SS.ms)", beats: "Beats (BAR.BEAT.TICK)", smpte: "SMPTE (HH:MM:SS:FF)" };
            return labels[String(v)] || String(v);
          }}
        />
      </Row>
      {timecodeMode === "smpte" && (
        <Row label="SMPTE Frame Rate">
          <NativeSelect
            options={["24", "25", "29.97", "30"]}
            value={smpteFrameRate.toString()}
            onChange={(val) => useDAWStore.getState().setSmpteFrameRate(parseFloat(String(val)) as any)}
            formatLabel={(v) => `${v} fps`}
          />
        </Row>
      )}

      <SectionHeader>Accessibility</SectionHeader>
      <Row label="UI Font Scale">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0.75}
            max={1.5}
            step={0.05}
            value={uiFontScale}
            onChange={(e) => useDAWStore.getState().setUIFontScale(Number.parseFloat(e.target.value))}
            className="w-24 cursor-pointer accent-blue-600"
            aria-label="UI Font Scale"
            aria-valuemin={0.75}
            aria-valuemax={1.5}
            aria-valuenow={uiFontScale}
          />
          <span className="text-xs text-daw-text-muted w-10 text-right">
            {Math.round(uiFontScale * 100)}%
          </span>
        </div>
      </Row>

      <SectionHeader>Panels</SectionHeader>
      <Row label="Show Mixer on Start">
        <span className="text-xs text-daw-text-muted">Use Ctrl+M to toggle</span>
      </Row>
    </div>
  );
}

// ========== Mouse Modifier Tab ==========
const MODIFIER_CONTEXTS: { key: string; label: string }[] = [
  { key: "clip_drag", label: "Clip Drag" },
  { key: "clip_resize", label: "Clip Resize" },
  { key: "timeline_click", label: "Timeline Click" },
  { key: "track_header", label: "Track Header" },
  { key: "automation_point", label: "Automation Point" },
  { key: "fade_handle", label: "Fade Handle" },
  { key: "ruler_click", label: "Ruler Click" },
];

const MODIFIER_COMBOS = ["none", "ctrl", "shift", "alt"];

const ACTION_OPTIONS: Record<string, string[]> = {
  clip_drag: ["move", "copy", "constrain", "bypass_snap", "select", "none"],
  clip_resize: ["resize", "fine", "symmetric", "stretch", "none"],
  timeline_click: ["seek", "select_range", "extend_selection", "zoom", "none"],
  track_header: ["select", "toggle_select", "range_select", "solo", "mute", "none"],
  automation_point: ["move", "fine", "constrain_y", "delete", "none"],
  fade_handle: ["adjust", "fine", "symmetric", "shape_cycle", "none"],
  ruler_click: ["seek", "loop_set", "time_select", "zoom_to", "none"],
};

function MouseModifierTab() {
  const { mouseModifiers } = useDAWStore(useShallow((s) => ({
    mouseModifiers: s.mouseModifiers,
  })));

  return (
    <div>
      <SectionHeader>Mouse Modifier Actions</SectionHeader>
      <div className="text-[9px] text-daw-text-muted mb-2">
        Configure what happens when you click with different modifier keys held down.
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr>
              <th className="text-left py-1 px-1 text-daw-text-muted font-normal border-b border-daw-border">
                Context
              </th>
              {MODIFIER_COMBOS.map((mod) => (
                <th
                  key={mod}
                  className="text-center py-1 px-1 text-daw-text-muted font-normal border-b border-daw-border capitalize"
                >
                  {mod === "none" ? "Click" : mod}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MODIFIER_CONTEXTS.map(({ key, label }) => (
              <tr key={key} className="hover:bg-neutral-800/50">
                <td className="py-1 px-1 text-daw-text border-b border-daw-border/50 whitespace-nowrap">
                  {label}
                </td>
                {MODIFIER_COMBOS.map((mod) => (
                  <td key={mod} className="py-0.5 px-0.5 border-b border-daw-border/50">
                    <select
                      className="w-full bg-neutral-800 text-neutral-300 text-[9px] py-0.5 px-1 rounded border border-neutral-700 cursor-pointer"
                      value={mouseModifiers[key]?.[mod] || "none"}
                      onChange={(e) =>
                        useDAWStore.getState().setMouseModifier(key, mod, e.target.value)
                      }
                    >
                      {(ACTION_OPTIONS[key] || []).map((action) => (
                        <option key={action} value={action} className="bg-neutral-900 text-white">
                          {action.split("_").join(" ")}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <Button
          variant="default"
          size="sm"
          onClick={() => useDAWStore.getState().resetMouseModifiers()}
        >
          Reset to Defaults
        </Button>
      </div>
    </div>
  );
}

// ========== Backup Tab ==========
function BackupTab() {
  const { autoBackupEnabled, autoBackupInterval } = useDAWStore(useShallow((s) => ({
    autoBackupEnabled: s.autoBackupEnabled,
    autoBackupInterval: s.autoBackupInterval,
  })));

  const intervalMinutes = Math.round(autoBackupInterval / 60000);

  return (
    <div>
      <SectionHeader>Auto-Backup</SectionHeader>
      <Row label="Enable Auto-Backup">
        <Checkbox
          checked={autoBackupEnabled}
          onChange={() => useDAWStore.getState().setAutoBackupEnabled(!autoBackupEnabled)}
          size="sm"
        />
      </Row>
      <Row label="Backup Interval">
        <Input
          type="number"
          variant="compact"
          size="xs"
          value={intervalMinutes.toString()}
          onChange={(e) => {
            const mins = parseInt(e.target.value, 10);
            if (!isNaN(mins) && mins >= 1 && mins <= 60) {
              useDAWStore.getState().setAutoBackupInterval(mins * 60000);
            }
          }}
          className="w-12"
          inputClassName="w-12"
          disabled={!autoBackupEnabled}
        />
        <span className="text-xs text-daw-text-muted">min</span>
      </Row>
      <div className="mt-2 text-xs text-daw-text-muted">
        Auto-backup saves the project at regular intervals when changes are detected.
        Only works when the project has been saved at least once.
      </div>
    </div>
  );
}
