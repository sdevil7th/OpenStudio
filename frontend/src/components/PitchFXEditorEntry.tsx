import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { getPitchClipChoices, getSelectedPitchClip, resolvePitchClipTarget, type PitchClipTarget } from "../utils/pitchEditorEntry";
import { getProjectEpoch } from "../utils/projectLifetime";
import { capturePitchFXOrigin, reviewPitchFXEditorEntry, type PitchFXEntryReview, type PitchFXOrigin } from "../services/pitchEditorFXEntry";
import { Button, Modal } from "./ui";

interface Props { origin: PitchFXOrigin; onCancel: () => void; onOpened: () => void; }
const formatTime = (time: number) => `${Math.floor(time / 60)}:${(time % 60).toFixed(2).padStart(5, "0")}`;

/** A route into the existing editor, not another pitch editor or live-input canvas. */
export function PitchFXEditorEntry({ origin, onCancel, onOpened }: Props) {
  const state = useDAWStore(useShallow(s => ({ tracks: s.tracks, globalLocked: s.globalLocked,
    lockSettings: s.lockSettings, selectedClipId: s.selectedClipId, selectedClipIds: s.selectedClipIds })));
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [review, setReview] = useState<(PitchFXEntryReview & { target: PitchClipTarget }) | null>(null);
  const captured = useRef<PitchFXOrigin | null>(null);
  const epoch = useRef(getProjectEpoch());
  const alive = useRef(true);
  const choices = getPitchClipChoices(state, origin.chain === "track" ? origin.trackId : undefined);

  const choose = async (target: PitchClipTarget, approvedSignature?: string) => {
    if (!captured.current || !alive.current) return;
    setBusy(true); setError("");
    try {
      const result = await reviewPitchFXEditorEntry(captured.current, target, epoch.current);
      if (!alive.current) return;
      if (result.activeEffects.length && result.signature !== approvedSignature) {
        setReview({ ...result, target });
        return;
      }
      // Recheck synchronously immediately before entering the authoritative shared session.
      const current = useDAWStore.getState();
      if (getProjectEpoch() !== epoch.current || !resolvePitchClipTarget(current, target))
        throw new Error("This clip is no longer available for editing. Choose another audio clip.");
      // The graph applies to the clip, not an index that can move in a realtime FX chain.
      current.openPitchEditor(target.trackId, target.clipId, -1);
      onOpened();
    } catch (cause) {
      if (alive.current) { setReview(null); setError(cause instanceof Error ? cause.message : "Could not open the pitch editor."); }
    } finally { if (alive.current) setBusy(false); }
  };

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    void capturePitchFXOrigin(origin).then(async value => {
      if (cancelled) return;
      captured.current = value;
      if (getProjectEpoch() !== epoch.current) throw new Error("The project changed. Open Pitch Correct again.");
      const target = getSelectedPitchClip(useDAWStore.getState(), origin.trackId, origin.chain);
      if (target) await choose(target);
      else setBusy(false);
    }).catch(cause => {
      if (!cancelled) { setError(cause instanceof Error ? cause.message : "Could not find this effect."); setBusy(false); }
    });
    return () => { cancelled = true; alive.current = false; };
    // The parent keys this dialog by each explicit open request. Changes in selection do not retarget it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reviewedClip = review && choices.find(clip => clip.trackId === review.target.trackId && clip.clipId === review.target.clipId);
  return <Modal isOpen onClose={onCancel} size="md" title={review ? "Realtime pitch correction is active" : "Edit pitch · choose audio"}
    footer={<><Button onClick={onCancel}>Cancel</Button>{review && <Button variant="primary" disabled={busy || !reviewedClip}
      onClick={() => void choose(review.target, review.signature)}>Open with realtime FX active</Button>}</>}>
    <div className="flex flex-col gap-3 text-sm text-daw-text">
      {review ? <>
        <p><strong>{reviewedClip?.name || "Unavailable clip"}</strong> will open in the existing pitch editor. Its edits change this clip’s audio.</p>
        <p>Playback will also pass through active Pitch Correct effects:</p>
        <ul className="list-disc pl-5">{review.activeEffects.map(label => <li key={label}>{label}</li>)}</ul>
        <p>To use clip correction alone, cancel and bypass those effects using their FX-chain checkboxes. Bypass can be undone. Continuing keeps them active, so the audio may be corrected twice.</p>
        {!reviewedClip && <p role="alert" className="text-amber-300">The selected clip was removed or locked. Cancel and choose another clip.</p>}
        <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Choose another clip</Button>
      </> : <>
        <p>{origin.chain === "track"
          ? "Choose an audio clip on this track to open the existing pitch editor."
          : "Graphical pitch editing needs recorded audio. Choose a clip below; incoming audio and realtime FX settings stay unchanged."}</p>
        <p className="text-xs text-daw-text-secondary">Pitch edits apply only to the chosen clip. Realtime settings and presets remain available from the FX chain’s parameter and preset buttons.</p>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label="Available audio clips">
          {choices.map(clip => <button key={`${clip.trackId}:${clip.clipId}`} type="button" disabled={busy || !captured.current}
            onClick={() => void choose(clip)} className="flex flex-col gap-1 rounded border border-daw-border p-3 text-left hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-daw-accent disabled:opacity-50">
            <strong className="break-words">{clip.name}</strong><span className="text-xs text-daw-text-secondary">{clip.trackName} · {formatTime(clip.startTime)} · {clip.duration.toFixed(2)} s</span>
          </button>)}
          {!choices.length && !busy && <p role="status">No editable audio clips are available. Record or import audio, or unlock the clip and unfreeze its track first.</p>}
        </div>
      </>}
      {busy && <p role="status">Checking clip and audio route…</p>}
      {error && <p role="alert" className="text-amber-300">{error}</p>}
    </div>
  </Modal>;
}
