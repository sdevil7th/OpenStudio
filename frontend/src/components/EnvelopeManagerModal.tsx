import { useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useDAWStore, AutomationModeType } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { Modal } from "./ui";
import { getTrackAutomationParams, getMasterAutomationParams } from "../store/automationParams";

interface PluginParam {
  index: number;
  name: string;
  value: number;
  text: string;
}

interface FXSlotInfo {
  index: number;
  name: string;
  isInputFX: boolean;
}

interface EnvelopeRow {
  paramId: string;
  label: string;
  category: string;
  isActive: boolean;
  isVisible: boolean;
  isArmed: boolean;
  laneId: string | null;
}

const MODE_OPTIONS: { value: AutomationModeType; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "touch", label: "Touch" },
  { value: "latch", label: "Latch" },
  { value: "write", label: "Write" },
];

export function EnvelopeManagerModal() {
  const {
    showEnvelopeManager,
    envelopeManagerTrackId,
    closeEnvelopeManager,
    tracks,
    addAutomationLane,
    toggleAutomationLaneVisibility,
    armAutomationLane,
    setTrackAutomationMode,
    showAllActiveEnvelopes,
    hideAllEnvelopes,
    armAllVisibleAutomationLanes,
    disarmAllAutomationLanes,
    toggleTrackAutomation,
    // Master-specific
    masterAutomationLanes,
    addMasterAutomationLane,
    toggleMasterAutomationLaneVisibility,
    armMasterAutomationLane,
    setMasterTrackAutomationMode,
    showAllActiveMasterEnvelopes,
    hideAllMasterEnvelopes,
    armAllVisibleMasterAutomationLanes,
    disarmAllMasterAutomationLanes,
    toggleMasterAutomation,
  } = useDAWStore(
    useShallow((s) => ({
      showEnvelopeManager: s.showEnvelopeManager,
      envelopeManagerTrackId: s.envelopeManagerTrackId,
      closeEnvelopeManager: s.closeEnvelopeManager,
      tracks: s.tracks,
      addAutomationLane: s.addAutomationLane,
      toggleAutomationLaneVisibility: s.toggleAutomationLaneVisibility,
      armAutomationLane: s.armAutomationLane,
      setTrackAutomationMode: s.setTrackAutomationMode,
      showAllActiveEnvelopes: s.showAllActiveEnvelopes,
      hideAllEnvelopes: s.hideAllEnvelopes,
      armAllVisibleAutomationLanes: s.armAllVisibleAutomationLanes,
      disarmAllAutomationLanes: s.disarmAllAutomationLanes,
      toggleTrackAutomation: s.toggleTrackAutomation,
      // Master
      masterAutomationLanes: s.masterAutomationLanes,
      addMasterAutomationLane: s.addMasterAutomationLane,
      toggleMasterAutomationLaneVisibility: s.toggleMasterAutomationLaneVisibility,
      armMasterAutomationLane: s.armMasterAutomationLane,
      setMasterTrackAutomationMode: s.setMasterTrackAutomationMode,
      showAllActiveMasterEnvelopes: s.showAllActiveMasterEnvelopes,
      hideAllMasterEnvelopes: s.hideAllMasterEnvelopes,
      armAllVisibleMasterAutomationLanes: s.armAllVisibleMasterAutomationLanes,
      disarmAllMasterAutomationLanes: s.disarmAllMasterAutomationLanes,
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
  const [pluginParams, setPluginParams] = useState<Map<number, PluginParam[]>>(new Map());
  const [loading, setLoading] = useState(false);

  // Fetch FX chain + plugin params on open
  useEffect(() => {
    if (!showEnvelopeManager || !envelopeManagerTrackId) return;

    setFilter("");
    setCollapsedSections(new Set());

    const fetchFXData = async () => {
      setLoading(true);
      try {
        const [trackFX, inputFX] = await Promise.all([
          nativeBridge.getTrackFX(envelopeManagerTrackId),
          isMaster ? Promise.resolve([]) : nativeBridge.getTrackInputFX(envelopeManagerTrackId),
        ]);

        const allSlots: FXSlotInfo[] = [
          ...inputFX.map((fx: any) => ({
            index: fx.index,
            name: fx.name || `Input FX ${fx.index + 1}`,
            isInputFX: true,
          })),
          ...trackFX.map((fx: any) => ({
            index: fx.index,
            name: fx.name || `FX ${fx.index + 1}`,
            isInputFX: false,
          })),
        ];
        setFxSlots(allSlots);

        // Fetch all plugin parameters in parallel
        const paramMap = new Map<number, PluginParam[]>();
        await Promise.all(
          allSlots.map(async (fx) => {
            try {
              const params = await nativeBridge.getPluginParameters(
                envelopeManagerTrackId,
                fx.index,
                fx.isInputFX,
              );
              paramMap.set(fx.index, params);
            } catch {
              paramMap.set(fx.index, []);
            }
          }),
        );
        setPluginParams(paramMap);
      } catch (e) {
        console.error("[EnvelopeManager] Failed to load FX data:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchFXData();
  }, [showEnvelopeManager, envelopeManagerTrackId, isMaster]);

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
        isArmed: lane ? lane.armed : false,
        laneId: lane?.id ?? null,
      });
    }

    // Per-plugin sections
    for (const fx of fxSlots) {
      const params = pluginParams.get(fx.index) || [];
      const fxCategory = fx.isInputFX ? `Input FX: ${fx.name}` : `FX: ${fx.name}`;

      for (const param of params) {
        const paramId = `plugin_${fx.index}_${param.index}`;
        const lane = automationLanes.find((l) => l.param === paramId);
        rows.push({
          paramId,
          label: param.name,
          category: fxCategory,
          isActive: lane ? lane.points.length > 0 : false,
          isVisible: lane ? lane.visible : false,
          isArmed: lane ? lane.armed : false,
          laneId: lane?.id ?? null,
        });
      }
    }

    return rows;
  }, [track, isMaster, automationLanes, fxSlots, pluginParams]);

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

  // Global automation mode (most common mode across lanes)
  const globalMode: AutomationModeType = useMemo(() => {
    if (automationLanes.length === 0) return "off";
    const counts = new Map<AutomationModeType, number>();
    for (const lane of automationLanes) {
      counts.set(lane.mode, (counts.get(lane.mode) || 0) + 1);
    }
    let best: AutomationModeType = "off";
    let bestCount = 0;
    for (const [mode, count] of counts) {
      if (count > bestCount) {
        best = mode;
        bestCount = count;
      }
    }
    return best;
  }, [automationLanes]);

  // Handlers — dispatch to master or track actions
  const trackId = envelopeManagerTrackId!;

  const ensureLane = (row: EnvelopeRow): string | null => {
    if (row.laneId) return row.laneId;
    if (isMaster) {
      return addMasterAutomationLane(row.paramId);
    }
    return addAutomationLane(trackId, row.paramId, row.label);
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

  const handleToggleArm = (row: EnvelopeRow) => {
    const laneId = ensureLane(row);
    if (!laneId) return;
    if (isMaster) armMasterAutomationLane(laneId, !row.isArmed);
    else armAutomationLane(trackId, laneId, !row.isArmed);
  };

  const handleSetMode = (mode: AutomationModeType) => {
    if (isMaster) setMasterTrackAutomationMode(mode);
    else setTrackAutomationMode(trackId, mode);
  };

  const handleShowActive = () => {
    if (isMaster) showAllActiveMasterEnvelopes();
    else showAllActiveEnvelopes(trackId);
  };

  const handleHideAll = () => {
    if (isMaster) hideAllMasterEnvelopes();
    else hideAllEnvelopes(trackId);
  };

  const handleArmVisible = () => {
    if (isMaster) armAllVisibleMasterAutomationLanes();
    else armAllVisibleAutomationLanes(trackId);
  };

  const handleDisarmAll = () => {
    if (isMaster) disarmAllMasterAutomationLanes();
    else disarmAllAutomationLanes(trackId);
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
    : `Track ${tracks.findIndex((t) => t.id === track!.id) + 1} — Envelopes`;

  return (
    <Modal isOpen={showEnvelopeManager} onClose={closeEnvelopeManager} size="lg" title={title} fullHeight>
      {/* Top controls */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <label className="text-[11px] text-neutral-400">Mode:</label>
        <select
          className="text-[11px] bg-neutral-700 text-neutral-200 rounded px-2 py-1 border border-neutral-600 cursor-pointer"
          value={globalMode}
          onChange={(e) => handleSetMode(e.target.value as AutomationModeType)}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

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
        <button
          className="text-[11px] px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300 border border-neutral-600"
          onClick={handleArmVisible}
        >
          Arm Visible
        </button>
        <button
          className="text-[11px] px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300 border border-neutral-600"
          onClick={handleDisarmAll}
        >
          Disarm All
        </button>
      </div>

      {/* Filter */}
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
      <div className="flex-1 overflow-y-auto border border-neutral-700 rounded min-h-0">
        {/* Column headers */}
        <div className="flex items-center px-3 py-1.5 bg-neutral-800 border-b border-neutral-700 text-[10px] text-neutral-500 uppercase tracking-wider sticky top-0 z-10">
          <span className="flex-1">Name</span>
          <span className="w-14 text-center">Active</span>
          <span className="w-14 text-center">Visible</span>
          <span className="w-14 text-center">Arm</span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-neutral-500 text-[11px]">Loading plugin parameters...</div>
        ) : (
          Array.from(groupedRows.entries()).map(([category, rows]) => (
            <div key={category}>
              {/* Section header */}
              <button
                className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-neutral-800/60 border-b border-neutral-700/60 text-[11px] font-medium text-neutral-300 hover:bg-neutral-700/40 cursor-pointer"
                onClick={() => handleToggleSection(category)}
              >
                {collapsedSections.has(category) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {category}
                <span className="text-neutral-500 text-[10px] ml-1">({rows.length})</span>
              </button>

              {/* Rows */}
              {!collapsedSections.has(category) &&
                rows.map((row) => (
                  <div
                    key={row.paramId}
                    className="flex items-center px-3 py-1 border-b border-neutral-800/80 hover:bg-neutral-700/20 text-[11px]"
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

                    {/* Arm */}
                    <span className="w-14 flex justify-center">
                      <button
                        onClick={() => handleToggleArm(row)}
                        className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${
                          row.isArmed
                            ? "bg-red-600 border-red-500"
                            : "border-neutral-600 hover:border-neutral-400"
                        }`}
                        title={row.isArmed ? "Disarm" : "Arm for recording"}
                      >
                        {row.isArmed && (
                          <svg viewBox="0 0 10 10" width={8} height={8} className="text-white">
                            <path d="M1.5 5 L4 7.5 L8.5 2.5" stroke="currentColor" strokeWidth={1.5} fill="none" />
                          </svg>
                        )}
                      </button>
                    </span>
                  </div>
                ))}
            </div>
          ))
        )}

        {!loading && filteredRows.length === 0 && (
          <div className="py-8 text-center text-neutral-500 text-[11px]">
            {filter ? "No parameters match filter" : "No parameters available"}
          </div>
        )}
      </div>
    </Modal>
  );
}
