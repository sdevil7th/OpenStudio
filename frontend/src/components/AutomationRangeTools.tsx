import { useEffect, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { getAutomationDefault, automationLaneIsDiscrete, automationParameterChoices, formatAutomationParameterValue, automationLineCoordinates } from "../store/automationParams";
import { editEnvelopeRange, thinEnvelope, type EnvelopePoint } from "../utils/automationEnvelopeEdits";

export function AutomationRangeTools({ trackId }: { trackId: string }) {
  const { target, tracks, master, selection, playing, applyEdit, showToast } = useDAWStore(useShallow(state => ({
    target: state.selectedAutomationTarget, tracks: state.tracks, master: state.masterAutomationLanes,
    selection: state.timeSelection, playing: state.transport.isPlaying || state.transport.isRecording,
    applyEdit: state.applyAutomationEnvelopeEdit, showToast: state.showToast,
  })));
  const lane = target?.kind === "master" && trackId === "master" ? master.find(item => item.id === target.laneId)
    : target?.kind === "track" && target.trackId === trackId ? tracks.find(track => track.id === trackId)?.automationLanes.find(item => item.id === target.laneId) : undefined;
  const [action, setAction] = useState<"trim" | "fill" | "thin">("trim");
  const [amount, setAmount] = useState(0);
  const [proposal, setProposal] = useState<{ before: string; points: EnvelopePoint[] } | null>(null);
  useEffect(() => { setProposal(null); }, [trackId, target?.laneId, action, amount, selection?.start, selection?.end]);
  if (!lane || !target) return null;
  const discrete = automationLaneIsDiscrete(lane);
  const choices = automationParameterChoices(lane.metadata);
  const booleanControl = lane.metadata?.type === "toggle" || lane.param === "mute" || lane.param === "midi_cc_64" || lane.param.endsWith("_mute");
  const preview = () => {
    try {
      if (discrete && action !== "fill") throw new Error("Use Fill for stepped controls");
      const points = action === "thin" ? thinEnvelope(lane.points, amount / 100)
        : editEnvelopeRange(lane.points, selection?.start ?? NaN, selection?.end ?? NaN, action, amount / 100, lane.metadata?.initialNormalized ?? getAutomationDefault(lane.param), discrete);
      setProposal({ before: JSON.stringify(lane.points), points });
    } catch (error) { showToast(String(error instanceof Error ? error.message : error), "info"); }
  };
  const commit = () => {
    if (!proposal) return;
    if (JSON.stringify(lane.points) !== proposal.before) { showToast("The envelope changed. Preview the edit again.", "info"); setProposal(null); return; }
    applyEdit(target.kind === "master" ? "master" : target.trackId, lane.id, proposal.points, `${action === "trim" ? "Trim" : action === "fill" ? "Fill" : "Thin"} automation envelope`);
    setProposal(null);
  };
  const minTime = Math.min(lane.points[0]?.time ?? 0, selection?.start ?? Infinity);
  const maxTime = Math.max(lane.points[lane.points.length - 1]?.time ?? 1, selection?.end ?? 0, minTime + .001);
  const chart = (points: readonly EnvelopePoint[]) => automationLineCoordinates(points,
    time => 8 + (time - minTime) / (maxTime - minTime) * 284, value => 72 - value * 64, discrete).join(" ");
  return <details className="mt-3 rounded border border-neutral-700 p-2 text-[11px]">
    <summary className="cursor-pointer focus-visible:outline focus-visible:outline-daw-accent">Envelope range tools — {lane.label || lane.metadata?.name || lane.param}</summary>
    <p className="mt-2 text-neutral-400">Trim and Fill use the timeline time selection. Thin reduces points across this lane. Apply commits the visual preview as one edit.</p>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select aria-label="Envelope edit operation" value={action} onChange={event => { setAction(event.target.value as typeof action); setAmount(event.target.value === "thin" ? .5 : event.target.value === "fill" ? 50 : 0); }} className="rounded bg-neutral-800 px-2 py-1">
        <option value="trim" disabled={discrete}>Trim range</option><option value="fill">Fill range</option><option value="thin" disabled={discrete}>Thin lane</option>
      </select>
      {action === "fill" && (choices.length || booleanControl) ? <select aria-label="Fill value" value={amount / 100}
        onChange={event => setAmount(Number(event.target.value) * 100)} className="rounded bg-neutral-800 px-2 py-1">
        {(choices.length ? choices : [{ value: 0, label: "Off" }, { value: 1, label: "On" }]).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <label className="flex items-center gap-1">{action === "trim" ? "Offset" : action === "thin" ? "Tolerance" : "Value"}
        <input aria-label="Envelope edit amount" type="number" value={amount} min={action === "trim" ? -100 : 0} max={action === "thin" ? 5 : 100} step={.1}
          onChange={event => setAmount(Number(event.target.value))} className="w-16 rounded bg-neutral-800 px-2 py-1" />% of range
      </label>}
      {action === "fill" && <span>{formatAutomationParameterValue(lane.metadata, amount / 100)}</span>}
      <button type="button" disabled={playing || (discrete && action !== "fill") || (action !== "thin" && !selection)} onClick={preview}
        className="rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Preview edit</button>
      <button type="button" disabled={!proposal || playing} onClick={commit} className="rounded bg-daw-accent px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-white">Apply edit</button>
      {playing && <span className="text-neutral-400">Stop transport to edit this range.</span>}
    </div>
    {proposal && <div className="mt-2">
      <svg viewBox="0 0 300 80" role="img" aria-label="Envelope edit preview: original gray, proposed blue" className="h-24 w-full rounded bg-neutral-900">
        <polyline points={chart(lane.points)} className="fill-none stroke-neutral-500" strokeWidth="1" />
        <polyline points={chart(proposal.points)} className="fill-none stroke-sky-400" strokeWidth="1.5" />
      </svg>
      <p className="text-neutral-400">Original: {lane.points.length} points · Preview: {proposal.points.length} points</p>
    </div>}
  </details>;
}
