import { useMemo, useState, type KeyboardEvent } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Button, Checkbox, Input, NativeSelect, ProfiledRangeInput } from "./ui";
import { Modal } from "./ui/Modal/Modal";
import { GRID_TYPE_MODE_OPTIONS, type GridSize } from "../utils/snapToGrid";
import { getShortcutPlatform } from "../utils/platform";
import {
  MOUSE_BEHAVIOR_PROFILE_OPTIONS,
  getMouseBehaviorProfile,
} from "../utils/mouseBehaviorProfiles";
import {
  MOUSE_MODIFIER_ACTIONS,
  resolveMouseModifier,
  type MouseModifierCombination,
  type MouseModifierContext,
} from "../utils/mouseModifierResolver";
import { getSafeMouseModifierNoop } from "../utils/mouseModifierTimelineBehaviors";
import { isKeyboardShortcutProfileId } from "../utils/shortcutProfiles";
import { getEffectiveShortcutLabel } from "../utils/inputProfileHelp";

interface PreferencesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabId = "general" | "editing" | "display" | "mouse" | "backup";

const PREFERENCE_TABS: readonly { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "editing", label: "Editing" },
  { id: "display", label: "Display" },
  { id: "mouse", label: "Mouse" },
  { id: "backup", label: "Backup" },
];

/**
 * PreferencesModal - Comprehensive settings beyond audio device configuration.
 * Tabs: General, Editing, Display, Backup
 */
export function PreferencesModal({ isOpen, onClose }: PreferencesModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>("general");

  if (!isOpen) return null;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % PREFERENCE_TABS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + PREFERENCE_TABS.length) % PREFERENCE_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = PREFERENCE_TABS.length - 1;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = PREFERENCE_TABS[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(`preferences-tab-${nextTab.id}`)?.focus();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Preferences"
      size="lg"
      className="!w-[calc(100vw-2rem)] max-w-[700px]"
    >
      <div className="flex min-h-0 flex-col gap-3 sm:min-h-[400px] sm:flex-row sm:gap-4">
        {/* Tab sidebar */}
        <div
          className="flex min-w-0 gap-1 overflow-x-auto border-b border-daw-border pb-2 sm:min-w-[120px] sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3"
          role="tablist"
          aria-label="Preference categories"
        >
          {PREFERENCE_TABS.map((tab, index) => (
            <button
              key={tab.id}
              id={`preferences-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls="preferences-panel"
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={`shrink-0 rounded px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daw-accent ${
                activeTab === tab.id
                  ? "bg-daw-accent text-white"
                  : "text-daw-text-muted hover:bg-neutral-800"
              }`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div
          id="preferences-panel"
          role="tabpanel"
          aria-labelledby={`preferences-tab-${activeTab}`}
          tabIndex={0}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daw-accent"
        >
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

function shortcut(actionId: string, fallback: string): string {
  return getEffectiveShortcutLabel(actionId, fallback);
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
      <Row label="Default Grid Type">
        <NativeSelect
          options={[...GRID_TYPE_MODE_OPTIONS]}
          value={gridSize}
          onChange={(val) => useDAWStore.getState().setGridSize(val as GridSize)}
        />
      </Row>

      <SectionHeader>Project Defaults</SectionHeader>
      <Row label="Default Track Type">
        <span className="text-xs text-daw-text-muted">Audio</span>
      </Row>
      <Row label="Project Extension">
        <span className="text-xs text-daw-text-muted">.osproj</span>
      </Row>
    </div>
  );
}

// ========== Editing Tab ==========
function EditingTab() {
  const {
    autoCrossfade,
    defaultCrossfadeLength,
    rippleMode,
    recordMode,
    midiInputQuantizeEnabled,
    midiInputQuantizeGridBeats,
    midiInputQuantizeStrength,
  } = useDAWStore(useShallow((s) => ({
    autoCrossfade: s.autoCrossfade,
    defaultCrossfadeLength: s.defaultCrossfadeLength,
    rippleMode: s.rippleMode,
    recordMode: s.recordMode,
    midiInputQuantizeEnabled: s.midiInputQuantizeEnabled,
    midiInputQuantizeGridBeats: s.midiInputQuantizeGridBeats,
    midiInputQuantizeStrength: s.midiInputQuantizeStrength,
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
      <Row label="MIDI Input Quantize">
        <Checkbox
          checked={midiInputQuantizeEnabled}
          onChange={() => useDAWStore.getState().setMIDIInputQuantize({ midiInputQuantizeEnabled: !midiInputQuantizeEnabled })}
          size="sm"
        />
      </Row>
      <Row label="Input Quantize Grid">
        <NativeSelect
          options={["0.125", "0.25", "0.5", "1"]}
          value={String(midiInputQuantizeGridBeats)}
          onChange={(val) => useDAWStore.getState().setMIDIInputQuantize({ midiInputQuantizeGridBeats: Number(val) })}
          formatLabel={(v) => {
            const labels: Record<string, string> = { "0.125": "1/32", "0.25": "1/16", "0.5": "1/8", "1": "1/4" };
            return labels[String(v)] || String(v);
          }}
        />
      </Row>
      <Row label="Input Quantize Strength">
        <Input
          type="number"
          variant="compact"
          size="xs"
          value={Math.round(midiInputQuantizeStrength * 100).toString()}
          onChange={(e) => {
            const percent = parseInt(e.target.value, 10);
            if (!isNaN(percent)) {
              useDAWStore.getState().setMIDIInputQuantize({ midiInputQuantizeStrength: Math.max(0, Math.min(100, percent)) / 100 });
            }
          }}
          className="w-16"
          inputClassName="w-16"
        />
        <span className="text-xs text-daw-text-muted">%</span>
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
  const {
    timecodeMode,
    smpteFrameRate,
    uiFontScale,
    keyboardShortcutProfileId,
    customShortcuts,
  } = useDAWStore(useShallow((s) => ({
    timecodeMode: s.timecodeMode,
    smpteFrameRate: s.smpteFrameRate,
    uiFontScale: s.uiFontScale,
    keyboardShortcutProfileId: s.keyboardShortcutProfileId,
    customShortcuts: s.customShortcuts,
  })));
  const mixerShortcut = useMemo(
    () => shortcut("view.toggleMixer", "Ctrl+M"),
    [keyboardShortcutProfileId, customShortcuts],
  );

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
          <ProfiledRangeInput
            min={0.75}
            max={1.5}
            step={0.05}
            value={uiFontScale}
            onValueChange={(value) => useDAWStore.getState().setUIFontScale(value)}
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
        <span className="text-xs text-daw-text-muted">Use {mixerShortcut} to toggle</span>
      </Row>
      <div className="text-[9px] text-daw-text-muted mb-2 ml-1">
        Keyboard shortcut rebinding is handled in the Keyboard Shortcuts window, not in Preferences.
      </div>
    </div>
  );
}

// ========== Mouse Modifier Tab ==========
const MODIFIER_CONTEXTS: { key: MouseModifierContext; label: string }[] = [
  { key: "clip_drag", label: "Clip Drag" },
  { key: "clip_resize", label: "Clip Resize" },
  { key: "timeline_click", label: "Timeline Click" },
  { key: "track_header", label: "Track Header" },
  { key: "automation_point", label: "Automation Point" },
  { key: "fade_handle", label: "Fade Handle" },
  { key: "ruler_click", label: "Ruler Click" },
];

const MODIFIER_COMBOS = [
  "none",
  "primary",
  "secondary",
  "alt",
  "shift",
  "primary+secondary",
  "primary+alt",
  "primary+shift",
  "secondary+alt",
  "secondary+shift",
  "alt+shift",
  "primary+secondary+alt",
  "primary+secondary+shift",
  "primary+alt+shift",
  "secondary+alt+shift",
  "primary+secondary+alt+shift",
] as const satisfies readonly MouseModifierCombination[];

function MouseModifierTab() {
  const { mouseModifiers, mouseBehaviorProfileId, setMouseBehaviorProfile } = useDAWStore(useShallow((s) => ({
    mouseModifiers: s.mouseModifiers,
    mouseBehaviorProfileId: s.mouseBehaviorProfileId,
    setMouseBehaviorProfile: s.setMouseBehaviorProfile,
  })));
  const platform = getShortcutPlatform();
  const behaviorProfile = getMouseBehaviorProfile(mouseBehaviorProfileId, platform);
  const primaryLabel = platform === "macos" ? "Cmd" : "Ctrl";
  const secondaryLabel = platform === "macos" ? "Ctrl" : "Win";
  const comboLabel = (combination: MouseModifierCombination) => {
    if (combination === "none") return "Click";
    return combination
      .split("+")
      .map((modifier) => modifier === "primary"
        ? primaryLabel
        : modifier === "secondary"
          ? secondaryLabel
          : modifier === "alt"
            ? platform === "macos" ? "Option" : "Alt"
            : "Shift")
      .join("+");
  };
  const effectiveResolution = (context: MouseModifierContext, combination: MouseModifierCombination) => {
    const active = new Set(combination === "none" ? [] : combination.split("+"));
    return resolveMouseModifier({
      ctrlKey: platform === "macos" ? active.has("secondary") : active.has("primary"),
      metaKey: platform === "macos" ? active.has("primary") : active.has("secondary"),
      altKey: active.has("alt"),
      shiftKey: active.has("shift"),
    }, context, {
      platform: platform === "macos" ? "macos" : platform === "windows" ? "windows" : "other",
      profile: behaviorProfile.modifiers,
      overrides: mouseModifiers,
    });
  };

  return (
    <div>
      <SectionHeader>Mouse Modifier Actions</SectionHeader>
      <div className="text-[9px] text-daw-text-muted mb-2">
        Configure exact modifier combinations. Custom cells override the selected profile; multi-key combinations fall back by profile precedence when left unmapped.
      </div>

      <div className="mb-3 max-w-sm">
        <NativeSelect
          label="Mouse & scroll profile"
          options={MOUSE_BEHAVIOR_PROFILE_OPTIONS}
          value={mouseBehaviorProfileId}
          onChange={(value) => {
            if (isKeyboardShortcutProfileId(value)) setMouseBehaviorProfile(value);
          }}
          showPlaceholder={false}
          fullWidth
          size="sm"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[10px] border-collapse">
          <caption className="sr-only">
            Mouse modifier actions by editing context and exact modifier combination
          </caption>
          <thead>
            <tr>
              <th scope="col" className="text-left py-1 px-1 text-daw-text-muted font-normal border-b border-daw-border">
                Context
              </th>
              {MODIFIER_COMBOS.map((mod) => (
                <th
                  key={mod}
                  scope="col"
                  className="text-center py-1 px-1 text-daw-text-muted font-normal border-b border-daw-border capitalize"
                >
                  {comboLabel(mod)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MODIFIER_CONTEXTS.map(({ key, label }) => (
              <tr key={key} className="hover:bg-neutral-800/50">
                <th scope="row" className="py-1 px-1 text-left font-normal text-daw-text border-b border-daw-border/50 whitespace-nowrap">
                  {label}
                </th>
                {MODIFIER_COMBOS.map((mod) => {
                  const resolution = effectiveResolution(key, mod);
                  const inheritanceTitle = resolution.matchKind === "precedence"
                    ? `Inherited from ${comboLabel(resolution.matchedCombination ?? "none")}`
                    : resolution.source === "override" ? "Custom override" : "Profile default";
                  return (
                  <td key={mod} className="min-w-28 py-0.5 px-0.5 border-b border-daw-border/50">
                    <select
                      className="w-full bg-neutral-800 text-neutral-300 text-[9px] py-0.5 px-1 rounded border border-neutral-700 cursor-pointer"
                      value={resolution.action}
                      title={inheritanceTitle}
                      aria-label={`${label}, ${comboLabel(mod)} action`}
                      onChange={(e) =>
                        useDAWStore.getState().setMouseModifier(key, mod, e.target.value)
                      }
                    >
                      {(MOUSE_MODIFIER_ACTIONS[key] || []).map((action) => {
                        const unavailable = getSafeMouseModifierNoop(key, action);
                        return (
                          <option
                            key={action}
                            value={action}
                            disabled={Boolean(unavailable)}
                            title={unavailable?.reason}
                            className="bg-neutral-900 text-white"
                          >
                            {action.split("_").join(" ")}
                            {unavailable ? " (unavailable)" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  );
                })}
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
          Clear Custom Overrides
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
