import { nativeBridge, type BuiltInPluginAddress } from "./NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { getFXChainSlots, type FXChainType } from "../utils/fxChain";
import { getProjectEpoch } from "../utils/projectLifetime";
import { getPitchPlaybackRoutes, isPitchCorrectFX, resolvePitchClipTarget, type PitchClipTarget } from "../utils/pitchEditorEntry";

export interface PitchFXOrigin extends BuiltInPluginAddress { trackId: string; chain: FXChainType; fxIndex: number; }
export interface PitchFXEntryReview { activeEffects: string[]; signature: string; }

export async function capturePitchFXOrigin(origin: PitchFXOrigin): Promise<PitchFXOrigin> {
  const resolved = origin.instanceId ? await nativeBridge.resolveBuiltInAddress(origin) : origin;
  const schema = await nativeBridge.getBuiltInPluginSchema(resolved);
  if (origin.instanceId && schema.instanceId !== origin.instanceId)
    throw new Error("This Pitch Correct instance was replaced. Reopen it from the FX chain.");
  if (schema.pluginId !== "pitch" && schema.name !== "OpenStudio Pitch Correct")
    throw new Error("This Pitch Correct instance is no longer available. Reopen it from the FX chain.");
  return { ...resolved, trackId: origin.trackId, chain: origin.chain, fxIndex: resolved.fxIndex ?? origin.fxIndex, instanceId: schema.instanceId };
}

function assertCurrentProject(epoch: number) {
  if (getProjectEpoch() !== epoch) throw new Error("The project changed. Open Pitch Correct again from the current FX chain.");
}

/** Navigation never changes an effect. Review active correction before the user edits rendered audio. */
export async function reviewPitchFXEditorEntry(origin: PitchFXOrigin, target: PitchClipTarget, epoch: number): Promise<PitchFXEntryReview> {
  assertCurrentProject(epoch);
  const state = useDAWStore.getState();
  const clip = resolvePitchClipTarget(state, target);
  if (!clip) throw new Error("This audio clip is unavailable or locked. Choose an editable recorded audio clip.");
  const source = clip.pitchCorrectionSourceFilePath || clip.filePath;
  const resolved = await nativeBridge.resolveBuiltInAddress(origin);
  const originSlots = await getFXChainSlots(origin.trackId, origin.chain);
  if (!originSlots.some(slot => slot.index === resolved.fxIndex && isPitchCorrectFX(slot)))
    throw new Error("This Pitch Correct instance was removed. Reopen it from the FX chain.");
  if (!await nativeBridge.fileExists(source)) throw new Error(`The source audio for “${clip.name}” is missing. Relink it before editing pitch.`);

  const routes = getPitchPlaybackRoutes(state.tracks, target.trackId);
  const labels = await Promise.all(routes.trackIds.map(async trackId => {
    const track = state.tracks.find(candidate => candidate.id === trackId)!;
    if (track.fxBypassed) return [];
    return (await getFXChainSlots(trackId, "track"))
      .filter(slot => isPitchCorrectFX(slot) && !slot.bypassed)
      .map(slot => ({ key: `${trackId}:${slot.index}`, label: `${track.name} · FX ${slot.index + 1}` }));
  }));
  if (routes.master) labels.push((await getFXChainSlots("master", "master"))
    .filter(slot => isPitchCorrectFX(slot) && !slot.bypassed)
    .map(slot => ({ key: `master:${slot.index}`, label: `Master · FX ${slot.index + 1}` })));

  assertCurrentProject(epoch);
  await nativeBridge.resolveBuiltInAddress(origin);
  assertCurrentProject(epoch);
  const current = useDAWStore.getState();
  const currentClip = resolvePitchClipTarget(current, target);
  if (!currentClip || currentClip.filePath !== clip.filePath
    || currentClip.pitchCorrectionSourceFilePath !== clip.pitchCorrectionSourceFilePath
    || currentClip.offset !== clip.offset || currentClip.duration !== clip.duration
    || currentClip.startTime !== clip.startTime)
    throw new Error("The audio clip changed while opening. Choose it again.");
  // A changed route needs a new review; never approve a stale processing path.
  const routeState = (value: typeof state) => JSON.stringify(value.tracks.map(track =>
    [track.id, track.sends, track.masterSendEnabled, track.fxBypassed]));
  if (routeState(state) !== routeState(current)) throw new Error("Audio routing changed while opening. Choose the clip again.");
  const active = labels.flat();
  return { activeEffects: active.map(effect => effect.label), signature: active.map(effect => effect.key).sort().join("|") };
}
