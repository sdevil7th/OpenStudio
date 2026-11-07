import { useEffect, useMemo, useState } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { useShallow } from "zustand/react/shallow";
import { Modal, Button, Select } from "./ui";
import { resolveCrossfadeSelection, getClipPlaybackGainEnvelope, interpolateClipGain, planClipCrossfades } from "../utils/clipCrossfades";
import { fadeCurve } from "../utils/fadeUtils";

const FADE_SHAPES = [
  { value: 0, label: "Linear" }, { value: 1, label: "Equal Power" },
  { value: 2, label: "S-Curve" }, { value: 3, label: "Logarithmic" }, { value: 4, label: "Exponential" },
];
const COLORS = ["#ef4444", "#60a5fa", "#4ade80", "#fbbf24", "#c084fc", "#2dd4bf"];
interface CrossfadeEditorProps { isOpen: boolean; onClose: () => void }

export function CrossfadeEditor({ isOpen, onClose }: CrossfadeEditorProps) {
  const { ids, tracks, defaultLength, apply, clear } = useDAWStore(useShallow(state => ({
    ids: state.crossfadeEditorClipIds, tracks: state.tracks, defaultLength: state.defaultCrossfadeLength,
    apply: state.applyClipCrossfades, clear: state.clearClipCrossfades,
  })));
  const affected = useMemo(() => resolveCrossfadeSelection(tracks.flatMap(track => track.clips), ids ?? []), [ids, tracks]);
  const { clips, groupIds } = affected;
  const groupId = [...groupIds].sort()[0];
  const existing = clips.flatMap(clip => clip.crossfadeLayers ?? []).find(layer => layer.id === groupId);
  const [fadeInShape, setFadeInShape] = useState(0);
  const [fadeOutShape, setFadeOutShape] = useState(0);
  const [automaticLength, setAutomaticLength] = useState(true);
  const [lengthDraft, setLengthDraft] = useState("0.05");
  const [error, setError] = useState("");
  useEffect(() => {
    const settings = existing?.settings;
    setFadeInShape(settings?.fadeInShape ?? 0);
    setFadeOutShape(settings?.fadeOutShape ?? 0);
    setAutomaticLength(settings?.transitionLength === undefined);
    const initialPlan = planClipCrossfades(clips, settings, defaultLength);
    setLengthDraft(String(settings?.transitionLength ?? Math.min(defaultLength,
      initialPlan?.maximumTransitionLength ?? defaultLength)));
    setError("");
  }, [ids]);
  const transitionLength = Number(lengthDraft);
  const validLength = automaticLength || (lengthDraft.trim() !== "" && Number.isFinite(transitionLength) && transitionLength > 0);
  const options = { fadeInShape, fadeOutShape, ...(automaticLength ? {} : { transitionLength }) };
  const sameTrack = tracks.some(track => clips.length > 0 && clips.every(clip => track.clips.some(item => item.id === clip.id)));
  const plan = useMemo(() => validLength && sameTrack ? planClipCrossfades(clips, options, defaultLength, groupId) : null,
    [clips, fadeInShape, fadeOutShape, automaticLength, transitionLength, validLength, defaultLength, groupId, sameTrack]);
  const start = clips.length ? Math.min(...clips.map(clip => clip.startTime)) : 0;
  const end = clips.length ? Math.max(...clips.map(clip => clip.startTime + clip.duration)) : 1;
  const duration = Math.max(0.001, end - start);
  const unchanged = groupIds.size === 1 && Boolean(plan) && clips.every(clip => JSON.stringify(clip.crossfadeLayers?.find(layer => layer.id === groupId))
    === JSON.stringify(plan?.layers.get(clip.id)));
  const previews = clips.map(clip => {
    const layer = plan?.layers.get(clip.id);
    const preview = plan ? { ...clip, crossfadeLayers: [...(clip.crossfadeLayers ?? []).filter(item => !groupIds.has(item.id)), ...(layer ? [layer] : [])] } : clip;
    const envelope = getClipPlaybackGainEnvelope(preview);
    const times = [...new Set([0, clip.duration, ...envelope.map(point => point.time),
      ...Array.from({ length: 129 }, (_, index) => clip.duration * index / 128)])].sort((a, b) => a - b);
    return times.map(time => {
      let gain = interpolateClipGain(envelope, time);
      if (clip.fadeIn > 0 && time < clip.fadeIn) gain *= fadeCurve(time / clip.fadeIn, clip.fadeInShape ?? 0);
      if (clip.fadeOut > 0 && time > clip.duration - clip.fadeOut) gain *= fadeCurve((clip.duration - time) / clip.fadeOut, clip.fadeOutShape ?? 0);
      return `${(clip.startTime + time - start) / duration * 600},${100 - Math.min(2, gain) * 45}`;
    }).join(" ");
  });
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Crossfade Editor" size="lg">
      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-sm text-neutral-300">{clips.length} clips · {plan?.transitions.length ?? 0} handoffs. Contained clips fade in and back out; the underlying clip returns between edits.</p>
        {affected.expanded && <p className="text-sm text-amber-200">This crossfade also affects the linked clips listed below. Applying or removing it updates the complete group in one Undo step.</p>}
        {groupIds.size > 1 && <p className="text-sm text-neutral-300">{groupIds.size} connected crossfades will be replaced together. Remove clears these crossfades from all listed clips.</p>}
        {!sameTrack && <p className="text-sm text-neutral-300">Move the clips onto one track to reapply a crossfade. You can still remove their existing crossfades.</p>}
        <svg viewBox="0 0 600 130" className="h-44 w-full rounded border border-neutral-700 bg-neutral-950" role="img" aria-label="Resulting clip gain curves, including existing clip fades and gain automation">
          <line x1="0" x2="600" y1="100" y2="100" stroke="#555" />
          <line x1="0" x2="600" y1="55" y2="55" stroke="#333" strokeDasharray="4 4" />
          {plan?.transitions.map((transition, index) => <rect key={index}
            x={(transition.startTime - start) / duration * 600} y="4"
            width={(transition.endTime - transition.startTime) / duration * 600} height="96" fill="#fff" opacity="0.06" />)}
          {previews.map((points, index) => <polyline key={clips[index].id} points={points} fill="none" stroke={COLORS[index % COLORS.length]} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
          <text x="4" y="122" fontSize="11" fill="#aaa">{start.toFixed(3)} s</text>
          <text x="596" y="122" textAnchor="end" fontSize="11" fill="#aaa">{end.toFixed(3)} s</text>
        </svg>
        <div className="flex max-h-24 flex-wrap gap-x-4 gap-y-1 overflow-auto text-xs">
          {clips.map((clip, index) => <span key={clip.id} className="flex min-w-0 max-w-full items-center gap-1.5" title={clip.name}>
            <svg viewBox="0 0 8 8" className="size-2 shrink-0" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={COLORS[index % COLORS.length]} /></svg>
            <span className="truncate">{clip.name}</span>
          </span>)}
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-40 flex-1"><Select label="Outgoing Curve" size="sm" fullWidth value={fadeOutShape} onChange={value => setFadeOutShape(Number(value))} options={FADE_SHAPES} /></div>
          <div className="min-w-40 flex-1"><Select label="Incoming Curve" size="sm" fullWidth value={fadeInShape} onChange={value => setFadeInShape(Number(value))} options={FADE_SHAPES} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input type="checkbox" checked={automaticLength} onChange={event => setAutomaticLength(event.target.checked)} />
          Automatic transition lengths
        </label>
        <label className="flex flex-wrap items-center gap-2 text-sm text-neutral-300">
          Handoff length
          <input type="number" min="0.000001" step="0.001" value={lengthDraft} disabled={automaticLength}
            aria-label="Crossfade transition length in seconds" aria-invalid={!validLength || undefined}
            onChange={event => setLengthDraft(event.target.value)}
            className="w-28 rounded border border-neutral-600 bg-neutral-950 px-2 py-1 tabular-nums focus-visible:outline-2 focus-visible:outline-daw-accent disabled:opacity-50" />
          seconds
        </label>
        <p className="text-xs text-neutral-400">Automatic uses the available overlap for adjoining clips and short entry/exit transitions for contained clips. Custom lengths are bounded to keep handoffs separate. Existing clip fades and gain automation stay active.</p>
        {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-700 pt-3">
          {existing && <Button variant="default" size="sm" onClick={() => {
            if (ids && clear(ids)) onClose();
            else setError("The crossfade could not be removed. Check whether a linked clip is locked.");
          }}>Remove Crossfade</Button>}
          <Button variant="default" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!plan || !validLength} onClick={() => {
            if (!ids || !plan) return;
            if (unchanged || apply(ids, options)) onClose();
            else setError("No change was applied. The selected clips may have changed or be locked.");
          }}>Apply</Button>
        </div>
      </div>
    </Modal>
  );
}
