import { type CSSProperties, type ReactNode } from "react";
import { Activity, CircleDot, FolderOpen, Library, Mic2, Power, Star, Trash2 } from "lucide-react";
import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import {
  AMP_HARDWARE_SCENE,
  AmpCabHardwareArt,
  CabRoomHardwareArt,
  hardwareAnchorStyle,
  hardwareRegionStyle,
} from "./NAMRackHardwareArt";
import { RackKnob } from "./NAMRackKnob";

export type NAMRackIRLibraryEntry = {
  path: string;
  favorite?: boolean;
  lastUsed: number;
};

type ParamChangeHandler = (param: BuiltInParamDescriptor, value: number) => void;

function RackStageEmpty({
  icon,
  title,
  body,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="nam-stage-empty-card">
      <span aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <small>{body}</small>
      <button type="button" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

function PhysicalToggleSwitch({
  active,
  disabled,
  title,
  className = "",
  onToggle,
  qa,
  sceneAnchor,
  style,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  className?: string;
  onToggle: () => void;
  qa?: string;
  sceneAnchor?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={`nam-physical-toggle ${className}`.trim()}
      data-active={active}
      data-qa={qa}
      data-scene-anchor={sceneAnchor}
      style={style}
      disabled={disabled}
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      <span className="nam-physical-toggle-label nam-physical-toggle-label-off" aria-hidden="true">OFF</span>
      <span className="nam-physical-toggle-led" aria-hidden="true" />
      <span className="nam-physical-toggle-slot" aria-hidden="true">
        <span className="nam-physical-toggle-lever" />
      </span>
      <span className="nam-physical-toggle-label nam-physical-toggle-label-on" aria-hidden="true">ON</span>
      <span className="nam-physical-toggle-state" aria-hidden="true">{active ? "On" : "Off"}</span>
    </button>
  );
}

function NAMRackAmpStage({
  ampName,
  ampModelPath,
  cabIRPath,
  hardwareAmpLabel,
  hardwareCabLabel,
  hasAmpModel,
  hasPedalModel,
  ampMix,
  ampActive,
  ampFaceplateParams,
  onOpenAmpLibrary,
  onToggleAmpPower,
  onParamChange,
}: {
  ampName?: string;
  ampModelPath?: string;
  cabIRPath?: string;
  hardwareAmpLabel: string;
  hardwareCabLabel: string;
  hasAmpModel: boolean;
  hasPedalModel: boolean;
  ampMix?: BuiltInParamDescriptor;
  ampActive: boolean;
  ampFaceplateParams: BuiltInParamDescriptor[];
  onOpenAmpLibrary: () => void;
  onToggleAmpPower: () => void;
  onParamChange: ParamChangeHandler;
}) {
  return (
    <div className="nam-amp-head nam-stage-large">
      <div className="nam-amp-topline">
        <span>
          <Activity size={15} />
          Neural Capture
        </span>
        <strong title={ampModelPath}>{ampName || "Load an amp or full-rig model"}</strong>
      </div>
      <div className="nam-amp-faceplate">
        <div
          className="nam-amp-surface-frame nam-hardware-scene"
          data-qa="nam-amp-image-space"
          data-scene="amp-cab"
          data-asset-treatment="hardware-parity-v2"
        >
          <AmpCabHardwareArt>
            <div
              className="nam-hardware-nameplate nam-hardware-nameplate-amp"
              title={ampModelPath || hardwareAmpLabel}
              aria-label={`Amp model: ${hardwareAmpLabel}`}
              data-scene-anchor="amp-nameplate"
              style={hardwareRegionStyle(AMP_HARDWARE_SCENE.nameplates.amp)}
            >
              <strong>{hardwareAmpLabel}</strong>
            </div>
            <div
              className="nam-hardware-nameplate nam-hardware-nameplate-cab"
              title={cabIRPath || hardwareCabLabel}
              aria-label={`Cabinet: ${hardwareCabLabel}`}
              data-scene-anchor="cab-nameplate"
              style={hardwareRegionStyle(AMP_HARDWARE_SCENE.nameplates.cab)}
            >
              <strong>{hardwareCabLabel}</strong>
            </div>
            <div className="nam-amp-badges">
              <div className="nam-amp-window" data-empty={!hasAmpModel}>
                <span>Architecture</span>
                <strong>{hasAmpModel || hasPedalModel ? "A1/A2 ready" : "No amp loaded"}</strong>
                {!hasAmpModel && (
                  <button
                    type="button"
                    className="nam-primary-stage-action"
                    onClick={onOpenAmpLibrary}
                  >
                    Open Tone Library
                  </button>
                )}
              </div>
              {ampName && (
                <div className="nam-amp-model-chip" title={ampModelPath}>
                  <span>Model</span>
                  <strong>{ampName}</strong>
                </div>
              )}
            </div>
            {ampMix && (
              <PhysicalToggleSwitch
                className="nam-amp-power-switch"
                active={ampActive}
                disabled={!hasAmpModel}
                onToggle={onToggleAmpPower}
                title={ampActive ? "Bypass amp capture" : "Enable amp capture"}
                qa="nam-physical-toggle"
                sceneAnchor="power"
                style={hardwareAnchorStyle(AMP_HARDWARE_SCENE.anchors.power)}
              />
            )}
            <div className="nam-amp-knobs">
              {ampFaceplateParams.map((param) => (
                <RackKnob
                  key={param.id}
                  param={param}
                  onChange={onParamChange}
                  size="large"
                />
              ))}
            </div>
          </AmpCabHardwareArt>
        </div>
      </div>
    </div>
  );
}

function NAMRackCabStage({
  cabName,
  cabIRPath,
  cabActive,
  hasCabIR,
  postCabOrderLabel,
  cabBusy,
  cabEnabledParam,
  cabPhaseInvertParam,
  currentCabIRPath,
  currentIREntry,
  visibleFavoriteIRs,
  visibleRecentIRs,
  cabRoomKnobs,
  onOpenCabLibrary,
  onLoadCabIR,
  onClearCabIR,
  onToggleIRFavorite,
  onRemoveIRFromLibrary,
  onApplyIRPath,
  onParamChange,
  formatIRLastUsed,
  formatIRName,
}: {
  cabName?: string;
  cabIRPath?: string;
  cabActive: boolean;
  hasCabIR: boolean;
  postCabOrderLabel: string;
  cabBusy: boolean;
  cabEnabledParam?: BuiltInParamDescriptor;
  cabPhaseInvertParam?: BuiltInParamDescriptor;
  currentCabIRPath: string;
  currentIREntry?: NAMRackIRLibraryEntry;
  visibleFavoriteIRs: NAMRackIRLibraryEntry[];
  visibleRecentIRs: NAMRackIRLibraryEntry[];
  cabRoomKnobs: BuiltInParamDescriptor[];
  onOpenCabLibrary: () => void;
  onLoadCabIR: () => void;
  onClearCabIR: () => void;
  onToggleIRFavorite: (path: string) => void;
  onRemoveIRFromLibrary: (path: string) => void;
  onApplyIRPath: (path: string) => void;
  onParamChange: ParamChangeHandler;
  formatIRLastUsed: (value: number | undefined) => string;
  formatIRName: (path: string | undefined) => string;
}) {
  const cabPhaseInverted = (cabPhaseInvertParam?.value ?? 0) >= 0.5;

  return (
    <div className="nam-cab-room nam-stage-large" data-active={cabActive} data-ir={hasCabIR}>
      <div className="nam-cab-room-scene">
        <CabRoomHardwareArt />
        <div className="nam-cab-room-slot">
          <span>Cabinet</span>
          <strong title={cabIRPath}>{cabName || (cabActive ? "Studio filter" : "Bypassed")}</strong>
          <div className="nam-cab-room-actions">
            <button type="button" onClick={onOpenCabLibrary} title="Open TONE3000 cabinet IRs">
              <Library size={13} />
              Tone Library
            </button>
            <button type="button" onClick={onLoadCabIR} disabled={cabBusy} title="Load local cabinet impulse response">
              <FolderOpen size={13} />
              {cabBusy ? "Loading" : "Local IR"}
            </button>
            {hasCabIR && (
              <button type="button" onClick={onClearCabIR} disabled={cabBusy} title="Clear cabinet impulse response">
                Clear IR
              </button>
            )}
          </div>
        </div>
        <div className="nam-cab-room-badges" aria-label="Cabinet stage state">
          <span data-active={cabActive}>Cab {cabActive ? "On" : "Off"}</span>
          <span data-active={hasCabIR}>IR {hasCabIR ? "Configured" : "Open"}</span>
          <span>{postCabOrderLabel}</span>
        </div>
      </div>

      <div className="nam-cab-room-console">
        <div className="nam-stage-head">
          <Mic2 size={15} />
          <span>Cab Room</span>
        </div>
        <strong title={cabIRPath}>{cabName || "Cab filter ready"}</strong>
        <small>IR, filter, phase, and level stage</small>
        <div className="nam-cab-room-switches">
          {cabEnabledParam && (
            <button
              type="button"
              className="nam-hardware-switch"
              data-active={cabActive}
              onClick={() => onParamChange(cabEnabledParam, cabActive ? 0 : 1)}
            >
              <Power size={13} />
              Cab {cabActive ? "On" : "Off"}
            </button>
          )}
          {cabPhaseInvertParam && (
            <button
              type="button"
              className="nam-hardware-switch"
              data-active={cabPhaseInverted}
              onClick={() => onParamChange(cabPhaseInvertParam, cabPhaseInverted ? 0 : 1)}
            >
              <CircleDot size={13} />
              Phase {cabPhaseInverted ? "Inv" : "Norm"}
            </button>
          )}
        </div>
        <div className="nam-ir-library" data-empty={visibleFavoriteIRs.length === 0 && visibleRecentIRs.length === 0}>
          <div className="nam-ir-library-head">
            <span>IR Library</span>
            {currentCabIRPath && (
              <button
                type="button"
                className="nam-ir-library-favorite-current"
                data-active={Boolean(currentIREntry?.favorite)}
                onClick={() => onToggleIRFavorite(currentCabIRPath)}
                title={currentIREntry?.favorite ? "Remove current IR from favorites" : "Favorite current IR"}
              >
                <Star size={12} />
                {currentIREntry?.favorite ? "Favorited" : "Favorite"}
              </button>
            )}
          </div>
          {visibleFavoriteIRs.length > 0 || visibleRecentIRs.length > 0 ? (
            <>
              {visibleFavoriteIRs.length > 0 && (
                <div className="nam-ir-library-group">
                  <small>Favorites</small>
                  {visibleFavoriteIRs.map((entry) => (
                    <div
                      key={`favorite-${entry.path}`}
                      className="nam-ir-library-row"
                      data-active={entry.path === currentCabIRPath}
                    >
                      <button
                        type="button"
                        className="nam-ir-library-load"
                        onClick={() => onApplyIRPath(entry.path)}
                        disabled={cabBusy}
                        title={entry.path}
                      >
                        <strong>{formatIRName(entry.path) || "Impulse response"}</strong>
                        <span>{formatIRLastUsed(entry.lastUsed)}</span>
                      </button>
                      <button
                        type="button"
                        className="nam-ir-library-icon"
                        data-active="true"
                        onClick={() => onToggleIRFavorite(entry.path)}
                        title="Remove from favorites"
                      >
                        <Star size={12} />
                      </button>
                      <button
                        type="button"
                        className="nam-ir-library-icon"
                        onClick={() => onRemoveIRFromLibrary(entry.path)}
                        title="Remove from recent IRs"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {visibleRecentIRs.length > 0 && (
                <div className="nam-ir-library-group">
                  <small>Recent</small>
                  {visibleRecentIRs.map((entry) => (
                    <div
                      key={`recent-${entry.path}`}
                      className="nam-ir-library-row"
                      data-active={entry.path === currentCabIRPath}
                    >
                      <button
                        type="button"
                        className="nam-ir-library-load"
                        onClick={() => onApplyIRPath(entry.path)}
                        disabled={cabBusy}
                        title={entry.path}
                      >
                        <strong>{formatIRName(entry.path) || "Impulse response"}</strong>
                        <span>{formatIRLastUsed(entry.lastUsed)}</span>
                      </button>
                      <button
                        type="button"
                        className="nam-ir-library-icon"
                        onClick={() => onToggleIRFavorite(entry.path)}
                        title="Add to favorites"
                      >
                        <Star size={12} />
                      </button>
                      <button
                        type="button"
                        className="nam-ir-library-icon"
                        onClick={() => onRemoveIRFromLibrary(entry.path)}
                        title="Remove from recent IRs"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p>Loaded IRs appear here for fast cabinet recall.</p>
          )}
        </div>
        {!hasCabIR && (
          <RackStageEmpty
            icon={<Mic2 size={22} />}
            title="No cabinet IR configured"
            body="Use the cabinet filter now, or add an IR for a captured cab stage."
            actionLabel="Tone Library"
            onAction={onOpenCabLibrary}
          />
        )}
        <div className="nam-cab-control-grid">
          {cabRoomKnobs.map((param) => (
            <RackKnob key={param.id} param={param} onChange={onParamChange} size="large" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function NAMRackAmpCabStage({
  focusedModule,
  ampName,
  ampModelPath,
  cabName,
  cabIRPath,
  hardwareAmpLabel,
  hardwareCabLabel,
  hasAmpModel,
  hasPedalModel,
  hasCabIR,
  ampMix,
  ampActive,
  ampFaceplateParams,
  cabActive,
  postCabOrderLabel,
  cabBusy,
  cabEnabledParam,
  cabPhaseInvertParam,
  currentCabIRPath,
  currentIREntry,
  visibleFavoriteIRs,
  visibleRecentIRs,
  cabRoomKnobs,
  onOpenAmpLibrary,
  onOpenCabLibrary,
  onLoadCabIR,
  onClearCabIR,
  onToggleAmpPower,
  onToggleIRFavorite,
  onRemoveIRFromLibrary,
  onApplyIRPath,
  onParamChange,
  formatIRLastUsed,
  formatIRName,
}: {
  focusedModule: "amp" | "cab";
  ampName?: string;
  ampModelPath?: string;
  cabName?: string;
  cabIRPath?: string;
  hardwareAmpLabel: string;
  hardwareCabLabel: string;
  hasAmpModel: boolean;
  hasPedalModel: boolean;
  hasCabIR: boolean;
  ampMix?: BuiltInParamDescriptor;
  ampActive: boolean;
  ampFaceplateParams: BuiltInParamDescriptor[];
  cabActive: boolean;
  postCabOrderLabel: string;
  cabBusy: boolean;
  cabEnabledParam?: BuiltInParamDescriptor;
  cabPhaseInvertParam?: BuiltInParamDescriptor;
  currentCabIRPath: string;
  currentIREntry?: NAMRackIRLibraryEntry;
  visibleFavoriteIRs: NAMRackIRLibraryEntry[];
  visibleRecentIRs: NAMRackIRLibraryEntry[];
  cabRoomKnobs: BuiltInParamDescriptor[];
  onOpenAmpLibrary: () => void;
  onOpenCabLibrary: () => void;
  onLoadCabIR: () => void;
  onClearCabIR: () => void;
  onToggleAmpPower: () => void;
  onToggleIRFavorite: (path: string) => void;
  onRemoveIRFromLibrary: (path: string) => void;
  onApplyIRPath: (path: string) => void;
  onParamChange: ParamChangeHandler;
  formatIRLastUsed: (value: number | undefined) => string;
  formatIRName: (path: string | undefined) => string;
}) {
  if (focusedModule === "amp") {
    return (
      <NAMRackAmpStage
        ampName={ampName}
        ampModelPath={ampModelPath}
        cabIRPath={cabIRPath}
        hardwareAmpLabel={hardwareAmpLabel}
        hardwareCabLabel={hardwareCabLabel}
        hasAmpModel={hasAmpModel}
        hasPedalModel={hasPedalModel}
        ampMix={ampMix}
        ampActive={ampActive}
        ampFaceplateParams={ampFaceplateParams}
        onOpenAmpLibrary={onOpenAmpLibrary}
        onToggleAmpPower={onToggleAmpPower}
        onParamChange={onParamChange}
      />
    );
  }

  return (
    <NAMRackCabStage
      cabName={cabName}
      cabIRPath={cabIRPath}
      cabActive={cabActive}
      hasCabIR={hasCabIR}
      postCabOrderLabel={postCabOrderLabel}
      cabBusy={cabBusy}
      cabEnabledParam={cabEnabledParam}
      cabPhaseInvertParam={cabPhaseInvertParam}
      currentCabIRPath={currentCabIRPath}
      currentIREntry={currentIREntry}
      visibleFavoriteIRs={visibleFavoriteIRs}
      visibleRecentIRs={visibleRecentIRs}
      cabRoomKnobs={cabRoomKnobs}
      onOpenCabLibrary={onOpenCabLibrary}
      onLoadCabIR={onLoadCabIR}
      onClearCabIR={onClearCabIR}
      onToggleIRFavorite={onToggleIRFavorite}
      onRemoveIRFromLibrary={onRemoveIRFromLibrary}
      onApplyIRPath={onApplyIRPath}
      onParamChange={onParamChange}
      formatIRLastUsed={formatIRLastUsed}
      formatIRName={formatIRName}
    />
  );
}
