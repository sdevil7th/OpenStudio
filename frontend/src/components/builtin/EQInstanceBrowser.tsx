import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import { nativeBridge, type BuiltInPluginAddress } from "../../services/NativeBridge";
import { useDAWStore } from "../../store/useDAWStore";
import { Modal } from "../ui";
import { EQInstanceOverview } from "./EQInstanceOverview";

const storageKey = "openstudio.eq.instanceViews";
type Preferences = { pins: string[]; sets: Record<string, string[]>; names: Record<string, string>; order: string[] };
const empty = (): Preferences => ({ pins: [], sets: {}, names: {}, order: [] });
function readPreferences(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!raw || typeof raw !== "object") return empty();
    const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length < 256).slice(0, 2048) : [];
    return { pins: ids(raw.pins), order: ids(raw.order),
      sets: Object.fromEntries(Object.entries(raw.sets ?? {}).slice(0, 32).map(([name, value]) => [name.slice(0, 80), ids(value)])),
      names: Object.fromEntries(Object.entries(raw.names ?? {}).filter(([, value]) => typeof value === "string").slice(0, 2048).map(([id, name]) => [id, String(name).slice(0, 80)])) };
  } catch { return empty(); }
}

/** View preferences never rename/reorder tracks or mutate plugin processing. */
export function EQInstanceBrowser({ current, onSelect, onClose }: {
  current: BuiltInPluginAddress; onSelect: (address: BuiltInPluginAddress) => void; onClose: () => void;
}) {
  const { tracks } = useDAWStore(useShallow(state => ({ tracks: state.tracks })));
  const [instances, setInstances] = useState<BuiltInPluginAddress[]>([]);
  const [preferences, setPreferences] = useState(readPreferences);
  const [query, setQuery] = useState("");
  const [graphs, setGraphs] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [setName, setSetName] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let retired = false; setLoading(true);
    void nativeBridge.eqMatch("list").then(result => {
      if (retired) return;
      if (!result.success) throw new Error(result.error ?? "Instances unavailable");
      setInstances((result.candidates ?? []).filter(item => Boolean(item.instanceId))); setError("");
    }).catch(reason => { if (!retired) setError(reason instanceof Error ? reason.message : "Instances unavailable"); })
      .finally(() => { if (!retired) setLoading(false); });
    return () => { retired = true; };
  }, [revision]);
  const update = (change: (previous: Preferences) => Preferences) => setPreferences(previous => {
    const next = change(previous);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { setError("View preferences could not be saved"); }
    return next;
  });
  const trackName = (address: BuiltInPluginAddress) => address.chain === "master" ? "Master" : tracks.find(track => track.id === address.trackId)?.name ?? address.trackId ?? "Track";
  const label = (address: BuiltInPluginAddress) => preferences.names[address.instanceId!] || `${trackName(address)} / ${address.chain === "input" ? "Input" : "FX"} ${(address.fxIndex ?? 0) + 1}`;
  const rows = useMemo(() => {
    const rank = (address: BuiltInPluginAddress) => {
      const explicit = preferences.order.indexOf(address.instanceId!);
      if (explicit >= 0) return explicit;
      const track = tracks.findIndex(item => item.id === address.trackId);
      return preferences.order.length + (track < 0 ? tracks.length : track) * 2048 + (address.chain === "input" ? 0 : 1024) + (address.fxIndex ?? 0);
    };
    return [...instances].sort((a, b) => rank(a) - rank(b));
  }, [instances, preferences.order, tracks]);
  const visible = rows.filter(address => (!pinnedOnly || preferences.pins.includes(address.instanceId!)) && `${label(address)} ${trackName(address)}`.toLowerCase().includes(query.toLowerCase()));
  const move = (id: string, direction: number) => {
    const order = rows.map(row => row.instanceId!), index = order.indexOf(id), next = index + direction;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    update(previous => ({ ...previous, order }));
  };
  return <Modal isOpen onClose={onClose} title="EQ instances" size={graphs ? "xl" : "lg"}>
    <div className="flex min-w-0 flex-col gap-3 p-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input autoFocus className={`${editorSelect} min-w-0 flex-1`} aria-label="Find EQ instance" placeholder="Find track or EQ name" value={query} onChange={event => setQuery(event.target.value)} />
        <button className={editorButton} aria-pressed={pinnedOnly} onClick={() => setPinnedOnly(!pinnedOnly)}>Pinned only</button>
        <button className={editorButton} aria-pressed={graphs} onClick={() => setGraphs(!graphs)}>{graphs ? "List view" : "Graph overview"}</button>
        <button className={editorButton} disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${editorSelect} max-w-40`} aria-label="Restore pin set" value="" onChange={event => update(previous => ({ ...previous, pins: previous.sets[event.target.value] ?? previous.pins }))}>
          <option value="">Restore pin set</option>{Object.keys(preferences.sets).map(name => <option key={name}>{name}</option>)}
        </select>
        <input className={`${editorSelect} min-w-0 flex-1`} maxLength={80} aria-label="Pin set name" placeholder="Pin set name" value={setName} onChange={event => setSetName(event.target.value)} />
        <button className={editorButton} disabled={!setName.trim() || (!preferences.sets[setName.trim()] && Object.keys(preferences.sets).length >= 32)} onClick={() => { update(previous => ({ ...previous, sets: { ...previous.sets, [setName.trim()]: [...previous.pins] } })); setSetName(""); }}>Save pins</button>
        <button className={editorButton} onClick={() => update(previous => ({ ...previous, order: [] }))}>Track order</button>
      </div>
      {graphs ? <EQInstanceOverview rows={visible.map(address => ({ address, name: label(address), current: current.instanceId === address.instanceId }))} revision={revision} onSelect={onSelect} /> : <div className="flex max-h-[48vh] min-h-24 flex-col gap-2 overflow-y-auto" aria-label="EQ instance list">
        {visible.map(address => {
          const id = address.instanceId!, color = tracks.find(track => track.id === address.trackId)?.color;
          const currentInstance = current.instanceId ? current.instanceId === id : current.chain === address.chain && current.trackId === address.trackId && current.fxIndex === address.fxIndex;
          return <div key={id} className="flex min-w-0 flex-wrap items-center gap-2 rounded border border-daw-border-light p-2" aria-label={`EQ instance ${label(address)}`}>
            <button className={`${editorButton} shrink-0`} aria-label={`Pin ${label(address)}`} aria-pressed={preferences.pins.includes(id)} onClick={event => update(previous => ({ ...previous, pins: event.altKey ? [id] : previous.pins.includes(id) ? previous.pins.filter(pin => pin !== id) : [...previous.pins, id] }))}>Pin</button>
            <label className="flex min-w-28 flex-1 flex-col gap-1"><span className="truncate text-daw-text-muted">{trackName(address)}{currentInstance ? " · Current" : ""}</span>
              <input className={`${editorSelect} min-w-0`} aria-label={`EQ name ${id}`} maxLength={80} value={preferences.names[id] ?? ""} placeholder={label(address)} onChange={event => update(previous => ({ ...previous, names: { ...previous.names, [id]: event.target.value } }))} />
            </label>
            {color && <button className={editorButton} title={`Pin tracks with color ${color}`} aria-label={`Pin similar colors ${label(address)}`} onClick={() => update(previous => ({ ...previous, pins: [...new Set([...previous.pins, ...instances.filter(item => tracks.find(track => track.id === item.trackId)?.color === color).map(item => item.instanceId!)])] }))}>Same color</button>}
            <button className={editorButton} aria-label={`Move up ${label(address)}`} disabled={rows[0]?.instanceId === id} onClick={() => move(id, -1)}>↑</button>
            <button className={editorButton} aria-label={`Move down ${label(address)}`} disabled={rows[rows.length - 1]?.instanceId === id} onClick={() => move(id, 1)}>↓</button>
            <button className={editorButton} onClick={() => onSelect(address)} aria-label={`Edit ${label(address)}`}>Edit</button>
          </div>;
        })}
        {!visible.length && <p role="status">{loading ? "Finding instances…" : "No matching EQ instances"}</p>}
      </div>
      }
      {error && <p role="alert">{error}</p>}
      {!graphs && <p className="text-[10px] leading-relaxed text-daw-text-muted">Edit opens the full EQ here. Each instance retains its own Undo history in this window. Pins, names and order are local view preferences for these running instances; they do not change track data. Alt-click Pin selects one instance. Reference spectra and Overlap remain in References.</p>}
    </div>
  </Modal>;
}
