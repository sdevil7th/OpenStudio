import { FolderOpen, Gauge, Library, Mic2, Save, Star } from "lucide-react";
import type { BuiltInPluginAddress, BuiltInPluginSchema } from "../services/NativeBridge";
import { NAMExplorer, type NAMExplorerIntent } from "./NAMExplorer";
import type { RackRightRailTab } from "./NAMRackChrome";
import { NAMRackTuner, type NAMRailTunerState } from "./NAMRackTuner";

export type NAMRailGearState = {
  pedalTitle?: string;
  pedalLabel: string;
  ampTitle?: string;
  ampLabel: string;
  cabTitle?: string;
  cabLabel: string;
};

export type NAMRailCabState = {
  title?: string;
  label: string;
  status: string;
  active: boolean;
  hasIR: boolean;
  busy: boolean;
  irItems: Array<{
    path: string;
    label: string;
    subtitle: string;
    active: boolean;
  }>;
};

export type NAMRailPresetItem = {
  key: string;
  id?: string;
  name: string;
  subtitle: string;
  title?: string;
};

export type NAMRailSavedState = {
  heading: string;
  status: string;
  saveToneBusy: boolean;
  userPresets: NAMRailPresetItem[];
  factoryPresets: NAMRailPresetItem[];
};

export function NAMRackRightRail({
  rackRailTab,
  address,
  schema,
  explorerIntent,
  gear,
  cab,
  saved,
  tuner,
  onRefreshRack,
  onShowGear,
  onOpenTones,
  onOpenCab,
  onShowSaved,
  onBrowseAmp,
  onSearchIRs,
  onLoadLocalIR,
  onClearIR,
  onApplyIRPath,
  onOpenPresetManager,
  onSaveTone,
  onLoadUserPreset,
  onLoadFactoryPreset,
}: {
  rackRailTab: RackRightRailTab;
  address: BuiltInPluginAddress;
  schema: BuiltInPluginSchema;
  explorerIntent: NAMExplorerIntent | null;
  gear: NAMRailGearState;
  cab: NAMRailCabState;
  saved: NAMRailSavedState;
  tuner: NAMRailTunerState;
  onRefreshRack: () => BuiltInPluginSchema | null | Promise<BuiltInPluginSchema | null>;
  onShowGear: () => void;
  onOpenTones: () => void;
  onOpenCab: () => void;
  onShowSaved: () => void;
  onBrowseAmp: () => void;
  onSearchIRs: () => void;
  onLoadLocalIR: () => void;
  onClearIR: () => void;
  onApplyIRPath: (path: string) => void;
  onOpenPresetManager: () => void;
  onSaveTone: () => void;
  onLoadUserPreset: (name: string) => void;
  onLoadFactoryPreset: (id: string) => void;
}) {
  return (
    <aside className="nam-stage-sidebar nam-rack-right-rail" data-tab={rackRailTab} aria-label="NAM Rack explorer">
      <div className="nam-rail-tabs" aria-label="NAM Rack right rail shortcuts">
        <button type="button" data-active={rackRailTab === "gear"} onClick={onShowGear} title="Show loaded gear">
          <Gauge size={13} />
          Gear
        </button>
        <button type="button" data-active={rackRailTab === "tones"} onClick={onOpenTones} title="Search TONE3000 Captures in the rack">
          <Library size={13} />
          Captures
        </button>
        <button type="button" data-active={rackRailTab === "cab"} onClick={onOpenCab} title="Open cabinet IR browser">
          <Mic2 size={13} />
          Cab/IR
        </button>
        <button type="button" data-active={rackRailTab === "saved"} onClick={onShowSaved} title="Show saved rack presets">
          <Star size={13} />
          Saved
        </button>
      </div>

      {rackRailTab === "gear" && (
        <div className="nam-rail-section nam-rail-loaded-gear">
          <span>Loaded Gear</span>
          <article>
            <span>Pre FX</span>
            <strong>Precision + Distortion</strong>
          </article>
          <article>
            <span>Amp</span>
            <strong title={gear.ampTitle}>{gear.ampLabel}</strong>
            <button type="button" onClick={onBrowseAmp}>Browse</button>
          </article>
          <article>
            <span>Cabinet</span>
            <strong title={gear.cabTitle}>{gear.cabLabel}</strong>
            <button type="button" onClick={onOpenCab}>Cab/IR</button>
          </article>
        </div>
      )}

      {rackRailTab === "tones" && (
        <div className="nam-rail-explorer-shell">
          <NAMExplorer
            address={address}
            schema={schema}
            onRefreshRack={onRefreshRack}
            intent={explorerIntent}
            variant="rail"
          />
        </div>
      )}

      {rackRailTab === "cab" && (
        <div className="nam-rail-section nam-rail-cab" data-qa="nam-rail-cab">
          <div className="nam-rail-panel-head">
            <span>Cab/IR</span>
            <strong title={cab.title}>{cab.label}</strong>
            <small>{cab.status}</small>
          </div>
          <div className="nam-rail-button-row">
            <button type="button" onClick={onSearchIRs}>
              <Library size={12} />
              Search IRs
            </button>
            <button type="button" onClick={onLoadLocalIR} disabled={cab.busy}>
              <FolderOpen size={12} />
              {cab.busy ? "Loading" : "Local IR"}
            </button>
            {cab.hasIR && (
              <button type="button" onClick={onClearIR} disabled={cab.busy}>
                Clear
              </button>
            )}
          </div>
          <div className="nam-rail-ir-list" data-empty={cab.irItems.length === 0}>
            {cab.irItems.length === 0 ? (
              <div className="nam-rail-empty-state">
                <Mic2 size={18} />
                <strong>No recalled IRs yet</strong>
                <p>Search TONE3000 cabinet IRs or load a local impulse response.</p>
              </div>
            ) : (
              cab.irItems.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  data-active={entry.active}
                  onClick={() => onApplyIRPath(entry.path)}
                  disabled={cab.busy}
                  title={entry.path}
                >
                  <strong>{entry.label}</strong>
                  <small>{entry.subtitle}</small>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {rackRailTab === "saved" && (
        <div className="nam-rail-section nam-rail-saved" data-qa="nam-rail-saved">
          <div className="nam-rail-panel-head">
            <span>Saved</span>
            <strong>{saved.heading}</strong>
            <small>{saved.status}</small>
          </div>
          <div className="nam-rail-button-row">
            <button type="button" onClick={onOpenPresetManager}>
              <Library size={12} />
              Preset Manager
            </button>
            <button type="button" onClick={onSaveTone} disabled={saved.saveToneBusy}>
              <Save size={12} />
              Save Preset
            </button>
          </div>
          <div className="nam-rail-preset-list">
            {saved.userPresets.map((entry) => (
              <button type="button" key={entry.key} onClick={() => onLoadUserPreset(entry.name)} title={entry.title}>
                <strong>{entry.name}</strong>
                <small>{entry.subtitle}</small>
              </button>
            ))}
            {saved.userPresets.length === 0 && saved.factoryPresets.map((entry) => (
              <button type="button" key={entry.key} onClick={() => entry.id && onLoadFactoryPreset(entry.id)}>
                <strong>{entry.name}</strong>
                <small>{entry.subtitle}</small>
              </button>
            ))}
            {saved.userPresets.length === 0 && saved.factoryPresets.length === 0 && (
              <div className="nam-rail-empty-state">
                <Star size={18} />
                <strong>No saved Presets</strong>
                <p>Save the complete NAM Rack as a Preset to make it appear here.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {rackRailTab === "tuner" && <NAMRackTuner tuner={tuner} />}
    </aside>
  );
}
