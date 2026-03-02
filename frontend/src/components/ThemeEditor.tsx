import { useDAWStore, THEME_PRESETS } from "../store/useDAWStore";
import { useShallow } from "zustand/shallow";
import { Modal, Button } from "./ui";

interface ThemeEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

// Editable CSS properties with human-friendly labels
const EDITABLE_PROPS = [
  { prop: "--color-daw-dark", label: "Background" },
  { prop: "--color-daw-panel", label: "Panel" },
  { prop: "--color-daw-lighter", label: "Lighter Surface" },
  { prop: "--color-daw-selection", label: "Selection" },
  { prop: "--color-daw-text", label: "Text" },
  { prop: "--color-daw-text-muted", label: "Muted Text" },
  { prop: "--color-daw-accent", label: "Accent" },
  { prop: "--color-daw-border", label: "Border" },
  { prop: "--color-daw-border-light", label: "Light Border" },
  { prop: "--color-daw-record", label: "Record" },
  { prop: "--color-daw-mute", label: "Mute" },
  { prop: "--color-daw-solo", label: "Solo" },
];

export function ThemeEditor({ isOpen, onClose }: ThemeEditorProps) {
  const { theme, customThemeOverrides, setTheme, setCustomThemeOverride, clearCustomThemeOverrides } = useDAWStore(useShallow((s) => ({
    theme: s.theme,
    customThemeOverrides: s.customThemeOverrides,
    setTheme: s.setTheme,
    setCustomThemeOverride: s.setCustomThemeOverride,
    clearCustomThemeOverrides: s.clearCustomThemeOverrides,
  })));

  const currentPreset = THEME_PRESETS.find((t) => t.name === theme) || THEME_PRESETS[0];

  const getEffectiveColor = (prop: string): string => {
    return customThemeOverrides[prop] || currentPreset.colors[prop] || "#000000";
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Theme Editor">
      <div className="w-[480px] flex flex-col gap-4">
        {/* Theme Preset Selector */}
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1.5 uppercase tracking-wider">
            Theme Preset
          </label>
          <div className="flex gap-2">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.name}
                className={`flex-1 px-2 py-1.5 text-[10px] rounded border transition-colors ${
                  theme === preset.name
                    ? "border-blue-500 bg-blue-500/20 text-blue-300"
                    : "border-neutral-700 bg-neutral-800 text-neutral-400 hover:border-neutral-600"
                }`}
                onClick={() => setTheme(preset.name)}
              >
                {/* Color preview dots */}
                <div className="flex gap-1 justify-center mb-1">
                  {["--color-daw-dark", "--color-daw-panel", "--color-daw-accent"].map((p) => (
                    <div
                      key={p}
                      className="w-3 h-3 rounded-full border border-neutral-600"
                      style={{ backgroundColor: preset.colors[p] }}
                    />
                  ))}
                </div>
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Color Editors */}
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1.5 uppercase tracking-wider">
            Customize Colors
          </label>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {EDITABLE_PROPS.map(({ prop, label }) => (
              <div key={prop} className="flex items-center gap-2">
                <input
                  type="color"
                  value={getEffectiveColor(prop)}
                  onChange={(e) => setCustomThemeOverride(prop, e.target.value)}
                  className="w-6 h-5 rounded border border-neutral-600 cursor-pointer bg-transparent p-0"
                />
                <span className="text-[10px] text-neutral-300 flex-1">{label}</span>
                {customThemeOverrides[prop] && (
                  <button
                    className="text-[8px] text-neutral-500 hover:text-neutral-300"
                    onClick={() => {
                      const newOverrides = { ...customThemeOverrides };
                      delete newOverrides[prop];
                      useDAWStore.setState({ customThemeOverrides: newOverrides });
                      // Re-apply the theme without this override
                      const root = document.documentElement;
                      root.style.setProperty(prop, currentPreset.colors[prop] || "");
                    }}
                    title="Reset to preset"
                  >
                    reset
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Live Preview */}
        <div>
          <label className="text-[10px] text-neutral-400 block mb-1.5 uppercase tracking-wider">
            Preview
          </label>
          <div
            className="rounded border p-3 flex flex-col gap-2"
            style={{
              backgroundColor: getEffectiveColor("--color-daw-dark"),
              borderColor: getEffectiveColor("--color-daw-border"),
            }}
          >
            <div
              className="rounded px-2 py-1 flex items-center justify-between"
              style={{
                backgroundColor: getEffectiveColor("--color-daw-panel"),
                borderLeft: `3px solid ${getEffectiveColor("--color-daw-accent")}`,
              }}
            >
              <span style={{ color: getEffectiveColor("--color-daw-text"), fontSize: "10px" }}>
                Track 1 - Audio
              </span>
              <div className="flex gap-1">
                <span
                  className="px-1 rounded text-[8px] font-bold"
                  style={{ backgroundColor: getEffectiveColor("--color-daw-mute"), color: "#fff" }}
                >
                  M
                </span>
                <span
                  className="px-1 rounded text-[8px] font-bold"
                  style={{ backgroundColor: getEffectiveColor("--color-daw-solo"), color: "#000" }}
                >
                  S
                </span>
                <span
                  className="px-1 rounded text-[8px] font-bold"
                  style={{ backgroundColor: getEffectiveColor("--color-daw-record"), color: "#fff" }}
                >
                  R
                </span>
              </div>
            </div>
            <div
              className="rounded h-6 flex items-center px-2"
              style={{
                backgroundColor: getEffectiveColor("--color-daw-selection"),
              }}
            >
              <span style={{ color: getEffectiveColor("--color-daw-text-muted"), fontSize: "9px" }}>
                Selected clip area
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="h-2 flex-1 rounded"
                style={{ backgroundColor: getEffectiveColor("--color-daw-accent") }}
              />
              <span style={{ color: getEffectiveColor("--color-daw-text-dim"), fontSize: "8px" }}>
                0:00.000
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-2 border-t border-neutral-700">
          <div className="flex gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={clearCustomThemeOverrides}
              disabled={Object.keys(customThemeOverrides).length === 0}
            >
              Reset to Preset
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
