import { useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useDAWStore, type AutomationWriteBehavior } from "../store/useDAWStore";
import { nativeBridge, type PluginParameterInfo } from "../services/NativeBridge";
import { Modal } from "./ui";
import { showLastTouchedAutomationLane } from "../services/automationParameterLookup";
import { AutomationRangeTools } from "./AutomationRangeTools";
import { AutomationTrimControls } from "./AutomationTrimControls";
import { AutomationWriteControls } from "./AutomationWriteControls";
import { AutomationPreviewControls } from "./AutomationPreviewControls";
import { subscribeToFXChainChanged, subscribeToInstrumentChanged } from "../utils/fxChain";
import { automationParameterMetadata, type AutomationParameterMetadata, builtInAutomationParamId, getTrackAutomationParams, getMasterAutomationParams, pluginAutomationParamId, sendAutomationParamId } from "../store/automationParams";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  registerShortcutSurface,
} from "../utils/shortcutContext";

type PluginParam = PluginParameterInfo;

interface FXSlotInfo {
  index: number;
  name: string;
  isInputFX: boolean;
  chain?: "master" | "monitor";
}

interface EnvelopeRow {
  paramId: string;
  label: string;
  category: string;
  isActive: boolean;
  isVisible: boolean;
  isReadEnabled: boolean;
  laneId: string | null;
  metadata?: AutomationParameterMetadata;
  unavailable?: boolean;
  clearedReferences?: boolean;
}

const WRITE_BEHAVIOR_OPTIONS: { value: AutomationWriteBehavior; label: string }[] = [
  { value: "touch", label: "Touch" },
  { value: "latch", label: "Latch" },
  { value: "touch-latch", label: "Touch/Latch" },
  { value: "cross-over", label: "Cross-Over" },
  { value: "overwrite", label: "Overwrite" },
];

export function EnvelopeManagerModal() {
  const {
    showEnvelopeManager,
    envelopeManagerTrackId,
    closeEnvelopeManager,
    tracks,
    lastTouchedAutomationParameter,
    automationWriteBehavior,
    automationTouchReturnSeconds,
    setAutomationTouchReturnSeconds,
    masterAutomationSafeParams,
    setPluginAutomationSafe,
    setAutomationWriteBehavior,
    automationRecoveryBusy,
    retryUnavailableFX,
    unavailableFXStages,
    retryUnavailableFXStage,
    automationTransportRolling,
    globalLocked,
    lockSettings,
    addAutomationLane,
    toggleAutomationLaneVisibility,
    setAutomationLaneRead,
    showAllActiveEnvelopes,
    hideAllEnvelopes,
    toggleTrackAutomation,
    // Master-specific
    masterAutomationLanes,
    addMasterAutomationLane,
    toggleMasterAutomationLaneVisibility,
    setMasterAutomationLaneRead,
    showAllActiveMasterEnvelopes,
    hideAllMasterEnvelopes,
    toggleMasterAutomation,
  } = useDAWStore(
    useShallow((s) => ({
      showEnvelopeManager: s.showEnvelopeManager,
      envelopeManagerTrackId: s.envelopeManagerTrackId,
      closeEnvelopeManager: s.closeEnvelopeManager,
      tracks: s.tracks,
      lastTouchedAutomationParameter: s.lastTouchedAutomationParameter,
      automationWriteBehavior: s.automationWriteBehavior,
      automationTouchReturnSeconds: s.automationTouchReturnSeconds,
      setAutomationTouchReturnSeconds: s.setAutomationTouchReturnSeconds,
      masterAutomationSafeParams: s.masterAutomationSafeParams,
      setPluginAutomationSafe: s.setPluginAutomationSafe,
      setAutomationWriteBehavior: s.setAutomationWriteBehavior,
      automationRecoveryBusy: s.automationRecoveryBusy,
      retryUnavailableFX: s.retryUnavailableFX,
      unavailableFXStages: s.unavailableFXStages,
      retryUnavailableFXStage: s.retryUnavailableFXStage,
      automationTransportRolling: s.transport.isPlaying || s.transport.isRecording,
      globalLocked: s.globalLocked,
      lockSettings: s.lockSettings,
      addAutomationLane: s.addAutomationLane,
      toggleAutomationLaneVisibility: s.toggleAutomationLaneVisibility,
      setAutomationLaneRead: s.setAutomationLaneRead,
      showAllActiveEnvelopes: s.showAllActiveEnvelopes,
      hideAllEnvelopes: s.hideAllEnvelopes,
      toggleTrackAutomation: s.toggleTrackAutomation,
      // Master
      masterAutomationLanes: s.masterAutomationLanes,
      addMasterAutomationLane: s.addMasterAutomationLane,
      toggleMasterAutomationLaneVisibility: s.toggleMasterAutomationLaneVisibility,
      setMasterAutomationLaneRead: s.setMasterAutomationLaneRead,
      showAllActiveMasterEnvelopes: s.showAllActiveMasterEnvelopes,
      hideAllMasterEnvelopes: s.hideAllMasterEnvelopes,
      toggleMasterAutomation: s.toggleMasterAutomation,
    })),
  );

  const isMaster = envelopeManagerTrackId === "master";

  const track = useMemo(
    () => (isMaster ? null : tracks.find((t) => t.id === envelopeManagerTrackId)),
    [tracks, envelopeManagerTrackId, isMaster],
  );

  const automationLanes = isMaster ? masterAutomationLanes : (track?.automationLanes ?? []);

  const [filter, setFilter] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [fxSlots, setFxSlots] = useState<FXSlotInfo[]>([]);
  const [pluginParams, setPluginParams] = useState<Map<string, PluginParam[]>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!showEnvelopeManager) return;
    const fallback = getActiveShortcutContext();
    const unregister = registerShortcutSurface(
      { kind: "automation" },
      () => "unmatched",
      fallback,
    );
    activateShortcutContext({ kind: "automation" });
    return unregister;
  }, [showEnvelopeManager]);

  // Keep parameter addresses current after a reorder/removal, including edits
  // from another window. Ignore replies for a closed dialog or older request.
  useEffect(() => {
    if (!showEnvelopeManager || !envelopeManagerTrackId) return;

    setFilter("");
    setCollapsedSections(new Set());
    let active = true;
    let request = 0;

    const fetchFXData = async () => {
      const currentRequest = ++request;
      setLoading(true);
      setFxSlots([]);
      setPluginParams(new Map());
      try {
        const [trackFX, inputFX] = await Promise.all([
          isMaster ? nativeBridge.getMasterFX() : nativeBridge.getTrackFX(envelopeManagerTrackId),
          isMaster ? nativeBridge.getMonitoringFX() : nativeBridge.getTrackInputFX(envelopeManagerTrackId),
        ]);

        const allSlots: FXSlotInfo[] = [
          ...(!isMaster && (track?.instrumentPlugin || track?.type === "instrument")
            ? [{ index: -1, name: track.instrumentPlugin || "Fallback instrument", isInputFX: false }] : []),
          ...inputFX.map((fx: any) => ({
            index: fx.index,
            name: fx.name || `Input FX ${fx.index + 1}`,
            isInputFX: true,
            ...(isMaster ? { chain: "monitor" as const, isInputFX: false } : {}),
          })),
          ...trackFX.map((fx: any) => ({
            index: fx.index,
            name: fx.name || `FX ${fx.index + 1}`,
            isInputFX: false,
            ...(isMaster ? { chain: "master" as const } : {}),
          })),
        ];

        // Fetch all plugin parameters in parallel
        const paramMap = new Map<string, PluginParam[]>();
        await Promise.all(
          allSlots.map(async (fx) => {
            try {
              const params = await nativeBridge.getPluginParameters(
                fx.chain ?? envelopeManagerTrackId,
                fx.index,
                fx.isInputFX,
              );
              paramMap.set(fx.chain ? `${fx.chain}_${fx.index}` : pluginAutomationParamId(fx.isInputFX, fx.index, -1), params);
            } catch {
              paramMap.set(fx.chain ? `${fx.chain}_${fx.index}` : pluginAutomationParamId(fx.isInputFX, fx.index, -1), []);
            }
          }),
        );
        if (active && currentRequest === request) {
          setFxSlots(allSlots);
          setPluginParams(paramMap);
        }
      } catch (e) {
        console.error("[EnvelopeManager] Failed to load FX data:", e);
      } finally {
        if (active && currentRequest === request) setLoading(false);
      }
    };

    void fetchFXData();
    const stopFX = subscribeToFXChainChanged(detail => {
      if (detail.trackId === envelopeManagerTrackId || (isMaster && detail.chainType === "monitor")) void fetchFXData();
    });
    const stopInstrument = subscribeToInstrumentChanged(detail => {
      if (detail.trackId === envelopeManagerTrackId) void fetchFXData();
    });
    return () => { active = false; stopFX(); stopInstrument(); };
  }, [showEnvelopeManager, envelopeManagerTrackId, isMaster, track?.instrumentPlugin]);

  // Build envelope rows
  const envelopeRows: EnvelopeRow[] = useMemo(() => {
    if (!isMaster && !track) return [];
    const rows: EnvelopeRow[] = [];

    // Track/Master Envelopes
    const trackParams = isMaster
      ? getMasterAutomationParams()
      : getTrackAutomationParams(track!.type);
    const categoryLabel = isMaster ? "Master Envelopes" : "Track Envelopes";

    for (const tp of trackParams) {
      const lane = automationLanes.find((l) => l.param === tp.id);
      rows.push({
        paramId: tp.id,
        label: tp.label,
        category: categoryLabel,
        isActive: lane ? lane.points.length > 0 : false,
        isVisible: lane ? lane.visible : false,
        isReadEnabled: lane ? (lane.readEnabled ?? lane.mode !== "off") : false,
        laneId: lane?.id ?? null,
      });
    }

    for (const send of track?.sends ?? []) {
      const destination = tracks.find(item => item.id === send.destTrackId);
      for (const control of ["level", "pan", "mute", "trim"] as const) {
        const paramId = sendAutomationParamId(send.destTrackId, control);
        const lane = automationLanes.find(item => item.param === paramId);
        rows.push({ paramId, label: control === "level" ? "Level" : control === "pan" ? "Pan" : control === "trim" ? "Trim Level" : "Mute",
          category: `Send: ${destination?.name ?? send.destTrackId}`, isActive: !!lane?.points.length,
          isVisible: lane?.visible ?? false, isReadEnabled: lane ? (lane.readEnabled ?? lane.mode !== "off") : false,
          laneId: lane?.id ?? null });
      }
    }

    // Per-plugin sections
    for (const fx of fxSlots) {
      const params = pluginParams.get(fx.chain ? `${fx.chain}_${fx.index}` : pluginAutomationParamId(fx.isInputFX, fx.index, -1)) || [];
      const fxCategory = fx.chain ? `${fx.chain === "monitor" ? "Monitor FX (listening only)" : "Master FX"}: ${fx.name}`
        : fx.index < 0 ? `Instrument: ${fx.name}` : fx.isInputFX ? `Input FX: ${fx.name}` : `FX: ${fx.name}`;

      for (const param of params) {
        const paramId = param.automationId ?? (param.builtIn && param.paramId
          ? builtInAutomationParamId(fx.isInputFX, fx.index, param.paramId)
          : pluginAutomationParamId(fx.isInputFX, fx.index, param.index));
        const lane = automationLanes.find((l) => l.param === paramId);
        rows.push({
          paramId,
          label: param.name,
          metadata: automationParameterMetadata(param),
          category: fxCategory,
          isActive: lane ? lane.points.length > 0 : false,
          isVisible: lane ? lane.visible : false,
          isReadEnabled: lane ? (lane.readEnabled ?? lane.mode !== "off") : false,
          laneId: lane?.id ?? null,
        });
      }
    }

    for (const lane of automationLanes.filter(item => item.unavailableParameter)) rows.push({
      paramId: lane.param, label: lane.label ?? lane.metadata?.name ?? lane.unavailableParameter!.param,
      category: "Unavailable parameters (data retained)", laneId: lane.id, metadata: lane.metadata,
      isActive: !!lane.points.length, isVisible: lane.visible, isReadEnabled: false, unavailable: true,
      clearedReferences: lane.unavailableParameter!.manualRecoveryRequired,
    });
    return rows;
  }, [track, tracks, isMaster, automationLanes, fxSlots, pluginParams]);

  // Filter
  const filteredRows = useMemo(() => {
    if (!filter.trim()) return envelopeRows;
    const lc = filter.toLowerCase();
    return envelopeRows.filter(
      (r) => r.label.toLowerCase().includes(lc) || r.category.toLowerCase().includes(lc),
    );
  }, [envelopeRows, filter]);

  // Group by category
  const groupedRows = useMemo(() => {
    const groups = new Map<string, EnvelopeRow[]>();
    for (const row of filteredRows) {
      if (!groups.has(row.category)) groups.set(row.category, []);
      groups.get(row.category)!.push(row);
    }
    return groups;
  }, [filteredRows]);

  // Global write behavior is selected once for the project.
  const currentWriteBehavior = automationWriteBehavior ?? "touch";

  // Handlers — dispatch to master or track actions
  const trackId = envelopeManagerTrackId!;

  const selectLane = (laneId: string | null) => {
    if (!laneId) return;
    activateShortcutContext({ kind: "automation" });
    const state = useDAWStore.getState();
    if (isMaster) state.setSelectedAutomationLane({ kind: "master", laneId });
    else state.setSelectedAutomationLane({ kind: "track", trackId, laneId });
  };

  const ensureLane = (row: EnvelopeRow, read = false, visible = true): string | null => {
    if (row.laneId) {
      selectLane(row.laneId);
      return row.laneId;
    }
    let laneId: string | null;
    if (isMaster) {
      laneId = addMasterAutomationLane(row.paramId, `${row.category}: ${row.label}`, row.metadata, { read, visible });
    } else {
      laneId = addAutomationLane(trackId, row.paramId, `${row.category}: ${row.label}`, row.metadata, { read, visible });
    }
    selectLane(laneId);
    return laneId;
  };

  const handleToggleVisible = (row: EnvelopeRow) => {
    const laneId = ensureLane(row);
    if (!laneId) return;
    if (row.laneId) {
      if (isMaster) toggleMasterAutomationLaneVisibility(laneId);
      else toggleAutomationLaneVisibility(trackId, laneId);
    }
    // Ensure automation display is on
    if (isMaster) {
      const s = useDAWStore.getState();
      if (!s.showMasterAutomation) toggleMasterAutomation();
    } else if (!track?.showAutomation) {
      toggleTrackAutomation(trackId);
    }
  };

  const handleToggleRead = (row: EnvelopeRow) => {
    const laneId = ensureLane(row, true, false);
    if (!laneId) return;
    if (isMaster) setMasterAutomationLaneRead(laneId, !row.isReadEnabled);
    else setAutomationLaneRead(trackId, laneId, !row.isReadEnabled);
  };

  const handleShowActive = () => {
    if (isMaster) showAllActiveMasterEnvelopes();
    else showAllActiveEnvelopes(trackId);
  };

  const handleHideAll = () => {
    if (isMaster) hideAllMasterEnvelopes();
    else hideAllEnvelopes(trackId);
  };

  const handleToggleSection = (category: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  if (!showEnvelopeManager || (!isMaster && !track)) return null;

  const title = isMaster
    ? "Master Track — Envelopes"
    : `${track!.name} — Envelopes`;

  return (
    <Modal isOpen={showEnvelopeManager} onClose={closeEnvelopeManager} size="lg" title={title} fullHeight>
      <div
        className="flex shrink-0 flex-col p-3"
        data-shortcut-context="automation"
        onPointerDownCapture={() => activateShortcutContext({ kind: "automation" })}
        onContextMenuCapture={() => activateShortcutContext({ kind: "automation" })}
        onFocusCapture={() => activateShortcutContext({ kind: "automation" })}
      >
      {/* Top controls */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <label className="text-[11px] text-neutral-400">Write:</label>
        <select
          className="text-[11px] bg-neutral-700 text-neutral-200 rounded px-2 py-1 border border-neutral-600 cursor-pointer"
          value={currentWriteBehavior}
          aria-label="Automation write mode"
          title={currentWriteBehavior === "touch-latch" ? "Main volume uses Touch; other parameters use Latch."
            : currentWriteBehavior === "cross-over" ? "Release to latch; touch again and cross the original curve to return to Read." : undefined}
          onChange={(e) => setAutomationWriteBehavior(e.target.value as AutomationWriteBehavior)}
        >
          {WRITE_BEHAVIOR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-[11px] text-neutral-400">Touch return
          <select aria-label="Touch return time" value={automationTouchReturnSeconds ?? 0}
            onChange={event => setAutomationTouchReturnSeconds(Number(event.target.value))}
            className="rounded border border-neutral-600 bg-neutral-700 px-2 py-1 text-neutral-200">
            {[0, .1, .25, .5, 1, 2, 5].map(seconds => <option key={seconds} value={seconds}>{seconds ? `${seconds * 1000} ms` : "Immediate"}</option>)}
          </select>
        </label>

        <div className="w-px h-5 bg-neutral-700 mx-1" />

        <button
          className="text-[11px] px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300 border border-neutral-600"
          onClick={handleShowActive}
        >
          Show Active
        </button>
        <button
          className="text-[11px] px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300 border border-neutral-600"
          onClick={handleHideAll}
        >
          Hide All
        </button>
        <button type="button" disabled={!lastTouchedAutomationParameter}
          title={lastTouchedAutomationParameter?.name || "Touch a plugin control to select a parameter"}
          className="text-[11px] px-2 py-1 rounded border border-neutral-600 disabled:opacity-40 hover:bg-neutral-700 focus-visible:outline focus-visible:outline-daw-accent"
          onClick={() => void showLastTouchedAutomationLane()}>
          Show Last Touched
        </button>
      </div>

      {/* Filter */}
      {isMaster && (["master", "monitor"] as const).map(chain => !!unavailableFXStages?.[chain]?.length && <div key={chain} className="mb-2 flex items-center gap-2 rounded border border-amber-700/60 bg-amber-950/20 p-2 text-[11px]">
        <span className="min-w-0 flex-1 text-amber-200">{chain === "master" ? "Master" : "Monitor"} FX unavailable: {unavailableFXStages[chain]!.length} saved slots retained.</span>
        <button type="button" className="shrink-0 rounded border border-neutral-600 px-2 py-1 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent"
          disabled={automationRecoveryBusy || automationTransportRolling || globalLocked || lockSettings.envelopes}
          title="Stop playback, restore the missing plugins, then retry the saved FX stage. Recovery is undoable."
          onClick={() => void retryUnavailableFXStage(chain)}>Retry {chain === "master" ? "Master" : "Monitor"} FX</button>
      </div>)}
      {!!track?.unavailableFX?.length && <div className="mb-3 rounded border border-amber-700/60 bg-amber-950/20 p-2 text-[11px]">
        <p className="mb-1 text-amber-200">Unavailable FX: saved settings, envelopes and MIDI Learn controls are retained.</p>
        {track.unavailableFX.map(slot => <div key={slot.key} className="flex items-center gap-2 py-1">
          <span className="min-w-0 flex-1 truncate text-neutral-300" title={slot.pluginPath}>
            {slot.chain === "input" ? "Input" : "Track"} FX {slot.originalIndex + 1}: {slot.pluginPath.split(/[\\/]/).pop()}
          </span>
          <button type="button" className="shrink-0 rounded border border-neutral-600 px-2 py-1 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent"
            disabled={automationRecoveryBusy || automationTransportRolling || globalLocked || lockSettings.envelopes || track.frozen}
            title="Stop playback, install or restore the missing plugin or script, then retry. Recovery is undoable."
            onClick={() => void retryUnavailableFX(track.id, slot.key)}>Retry FX</button>
        </div>)}
      </div>}
      <p className="mb-2 text-[11px] text-neutral-400">
        {isMaster
          ? "Master FX automation is included in exports. Monitor FX automation affects listening only."
          : "Only automatable controls appear here. File/model loading and DSP setup settings are excluded."}
      </p>
      <div className="relative mb-3">
        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
        <input
          className="w-full text-[11px] bg-neutral-800 text-neutral-200 rounded px-2 py-1.5 pl-7 border border-neutral-600 placeholder:text-neutral-500 focus:outline-none focus:border-daw-accent"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter envelopes..."
        />
      </div>

      {/* Scrollable list */}
      <div role="region" aria-label="Automation envelopes" tabIndex={0}
        className="h-[clamp(12rem,40vh,30rem)] shrink-0 overflow-y-auto border border-neutral-700 rounded focus-visible:outline focus-visible:outline-daw-accent">
        {/* Column headers */}
        <div className="flex items-center px-3 py-1.5 bg-neutral-800 border-b border-neutral-700 text-[10px] text-neutral-500 uppercase tracking-wider sticky top-0 z-10">
          <span className="flex-1">Name</span>
          <span className="w-14 text-center">Active</span>
          <span className="w-14 text-center">Visible</span>
          <span className="w-14 text-center">Read</span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-neutral-500 text-[11px]">Loading plugin parameters...</div>
        ) : (
          Array.from(groupedRows.entries()).map(([category, rows]) => {
            const pluginParameters = envelopeRows.filter(row => row.category === category && row.metadata && !row.unavailable).map(row => row.paramId);
            const safeParameters = isMaster ? masterAutomationSafeParams : track?.automationSafeParams;
            const isSafe = pluginParameters.length > 0 && pluginParameters.every(param => safeParameters?.includes(param));
            return (
            <div key={category}>
              {/* Section header */}
              <div className="flex items-center bg-neutral-800/60">
              <button
                className="flex-1 flex items-center gap-1.5 px-2 py-1.5 border-b border-neutral-700/60 text-[11px] font-medium text-neutral-300 hover:bg-neutral-700/40 cursor-pointer"
                onClick={() => handleToggleSection(category)}
              >
                {collapsedSections.has(category) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {category}
                <span className="text-neutral-500 text-[10px] ml-1">({rows.length})</span>
              </button>
              {pluginParameters.length > 0 && <button type="button" aria-pressed={isSafe} aria-label={`Automation Safe for ${category}`}
                title="Protect these plugin controls from automation recording; existing envelopes still play."
                onClick={() => setPluginAutomationSafe(trackId, pluginParameters, !isSafe)}
                className={`mr-2 rounded border px-2 py-1 text-[10px] focus-visible:outline focus-visible:outline-daw-accent ${isSafe ? "border-amber-500 text-amber-300" : "border-neutral-600 text-neutral-400"}`}>
                Automation Safe
              </button>}
              </div>

              {/* Rows */}
              {!collapsedSections.has(category) &&
                rows.map((row) => (
                  <div
                    key={row.paramId}
                    data-automation-param={row.paramId}
                    className="flex items-center px-3 py-1 border-b border-neutral-800/80 hover:bg-neutral-700/20 text-[11px]"
                    tabIndex={row.laneId ? 0 : -1}
                    onPointerDown={() => selectLane(row.laneId)}
                    onFocus={() => selectLane(row.laneId)}
                  >
                    <span className="flex-1 text-neutral-300 truncate pl-4" title={row.label}>
                      {row.label}
                    </span>

                    {/* Active (has points) */}
                    <span className="w-14 flex justify-center">
                      <span
                        className={`w-2 h-2 rounded-full ${row.isActive ? "bg-blue-400" : "bg-neutral-700"}`}
                        title={row.isActive ? "Has automation data" : "No automation data"}
                      />
                    </span>

                    {/* Visible */}
                    <span className="w-14 flex justify-center">
                      <button
                        onClick={() => handleToggleVisible(row)}
                        aria-label={`${row.isVisible ? "Hide" : "Show"} envelope for ${row.label}`}
                        className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${
                          row.isVisible
                            ? "bg-green-600 border-green-500"
                            : "border-neutral-600 hover:border-neutral-400"
                        }`}
                        title={row.isVisible ? "Hide envelope" : "Show envelope"}
                      >
                        {row.isVisible && (
                          <svg viewBox="0 0 10 10" width={8} height={8} className="text-white">
                            <path d="M1.5 5 L4 7.5 L8.5 2.5" stroke="currentColor" strokeWidth={1.5} fill="none" />
                          </svg>
                        )}
                      </button>
                    </span>

                    {/* Read */}
                    <span className="w-14 flex justify-center">
                      <button
                        onClick={() => handleToggleRead(row)}
                        disabled={row.unavailable}
                        aria-label={`${row.isReadEnabled ? "Disable" : "Enable"} read for ${row.label}`}
                        className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${
                          row.isReadEnabled
                            ? "bg-teal-600 border-teal-500"
                            : "border-neutral-600 hover:border-neutral-400"
                        }`}
                        title={row.clearedReferences ? "The plugin cleared these references. Points are retained here; create a new envelope for the current parameter." : row.unavailable ? "Saved points are retained. Read resumes when the same compatible parameter is available." : row.isReadEnabled ? "Disable read" : "Enable read"}
                      >
                        {row.isReadEnabled && (
                          <svg viewBox="0 0 10 10" width={8} height={8} className="text-white">
                            <path d="M1.5 5 L4 7.5 L8.5 2.5" stroke="currentColor" strokeWidth={1.5} fill="none" />
                          </svg>
                        )}
                      </button>
                    </span>
                  </div>
                ))}
            </div>
          ); })
        )}

        {!loading && filteredRows.length === 0 && (
          <div className="py-8 text-center text-neutral-500 text-[11px]">
            {filter ? "No parameters match filter" : "No parameters available"}
          </div>
        )}
      </div>
      <AutomationTrimControls trackId={trackId} />
      <AutomationPreviewControls trackId={trackId} />
      <AutomationWriteControls />
      <AutomationRangeTools trackId={trackId} />
      </div>
    </Modal>
  );
}
