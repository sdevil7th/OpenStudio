import { nativeBridge, type MediaFileInfo } from "../../services/NativeBridge";
import { getProjectEpoch } from "../../utils/projectLifetime";
import { isClipEditLocked } from "../../utils/clipEditLock";
import { commandManager } from "../commands";
import type { AudioClip, DAWActions, DAWState } from "../useDAWStore";
import { replaceSyncedClipSource } from "./clipBackendSync";

export interface AudioConversionJob {
  id: string; stage: "converting" | "cancelling" | "publishing"; targetRate: number; label?: string;
}
type State = DAWState & DAWActions & { audioConversionJobs: Record<string, AudioConversionJob> };
type SetFn = (update: Partial<State> | ((state: State) => Partial<State>)) => void;
type GetFn = () => State;
interface ActiveJob extends AudioConversionJob { epoch: number; cancelled: boolean }
const activeJobs = new WeakMap<GetFn, Map<string, ActiveJob>>();
function jobsFor(get: GetFn) {
  let jobs = activeJobs.get(get);
  if (!jobs) { jobs = new Map(); activeJobs.set(get, jobs); }
  return jobs;
}
function updateJob(set: SetFn, clipId: string, job?: ActiveJob) {
  set((state: State) => {
    const next = { ...state.audioConversionJobs };
    if (job) next[clipId] = { id: job.id, stage: job.stage, targetRate: job.targetRate, label: job.label };
    else delete next[clipId];
    return { audioConversionJobs: next };
  });
}
function findClip(state: State, trackId: string, clipId: string) {
  return state.tracks.find(track => track.id === trackId)?.clips.find(clip => clip.id === clipId);
}
function signature(clip: AudioClip) {
  return JSON.stringify([clip.filePath, clip.offset, clip.startTime, clip.duration,
    clip.pitchCorrectionSourceFilePath, clip.pitchCorrectionSourceOffset, clip.playbackRate, clip.pitchSemitones]);
}
function abort() { const error = new Error("The conversion was cancelled or its target changed."); error.name = "AbortError"; return error; }

function beginJob(set: SetFn, get: GetFn, clipId: string, targetRate: number, label: string) {
  const job: ActiveJob = { id: crypto.randomUUID(), stage: "converting", targetRate, label, epoch: getProjectEpoch(), cancelled: false };
  jobsFor(get).set(clipId, job); updateJob(set, clipId, job);
  const valid = () => jobsFor(get).get(clipId) === job && !job.cancelled && getProjectEpoch() === job.epoch;
  const finish = () => { if (jobsFor(get).get(clipId) === job) { jobsFor(get).delete(clipId); updateJob(set, clipId); } };
  return { job, valid, finish };
}

/** Import preparation joins its caller's existing import command, without another Undo. */
export async function prepareImportedProjectRateCopy(
  set: SetFn, get: GetFn, trackId: string, clipId: string, mediaInfo: MediaFileInfo, stillValid: () => boolean,
): Promise<MediaFileInfo & { originalFilePath?: string }> {
  const targetRate = get().projectSampleRate;
  if (mediaInfo.sampleRate === targetRate) return mediaInfo;
  const { job, valid, finish } = beginJob(set, get, clipId, targetRate,
    `${get().tracks?.find(track => track.id === trackId)?.name ?? "Import"} ? ${mediaInfo.filePath.split(/[\\/]/).pop()}`);
  const targetValid = () => valid() && stillValid() && get().projectSampleRate === targetRate;
  const monitor = setInterval(() => {
    if (!targetValid() && !job.cancelled) {
      job.cancelled = true; void nativeBridge.cancelProjectRateCopy(job.id);
    }
  }, 100);
  try {
    const result = await nativeBridge.createProjectRateCopy(mediaInfo.filePath, targetRate, get().projectPath, job.id);
    if (getProjectEpoch() !== job.epoch || !stillValid()) throw abort();
    if (!targetValid() || !result.success || !result.filePath) {
      get().showToast?.(result.cancelled || job.cancelled
        ? "Rate-copy conversion cancelled; the original audio was imported."
        : `Rate copy unavailable; imported the original audio. ${result.error ?? ""}`, "info");
      return mediaInfo;
    }
    return { ...mediaInfo, filePath: result.filePath, sampleRate: result.sampleRate ?? targetRate,
      duration: mediaInfo.duration, numChannels: result.numChannels ?? mediaInfo.numChannels,
      format: "WAV", originalFilePath: mediaInfo.filePath };
  } catch (error) {
    if (getProjectEpoch() !== job.epoch || !stillValid()) throw abort();
    get().showToast?.(`Rate copy unavailable; imported the original audio. ${String(error)}`, "info");
    return mediaInfo;
  } finally { clearInterval(monitor); finish(); }
}

type SourceFields = Pick<AudioClip, "filePath" | "sampleRate" | "sourceLength" | "originalFilePath"
  | "pitchCorrectionSourceFilePath" | "pitchCorrectionSourceOffset">;
function sourceFields(clip: AudioClip): SourceFields {
  return { filePath: clip.filePath, sampleRate: clip.sampleRate, sourceLength: clip.sourceLength,
    originalFilePath: clip.originalFilePath, pitchCorrectionSourceFilePath: clip.pitchCorrectionSourceFilePath,
    pitchCorrectionSourceOffset: clip.pitchCorrectionSourceOffset };
}

export const audioConversionActions = (set: SetFn, get: GetFn) => ({
  audioConversionJobs: {} as Record<string, AudioConversionJob>,

  cancelProjectRateCopy: (clipId: string) => {
    const job = jobsFor(get).get(clipId);
    if (!job || job.stage === "publishing") return;
    job.cancelled = true; job.stage = "cancelling"; updateJob(set, clipId, job);
    void nativeBridge.cancelProjectRateCopy(job.id);
  },

  createProjectRateCopy: async (trackId: string, clipId: string): Promise<void> => {
    const initial = findClip(get(), trackId, clipId);
    if (!initial || isClipEditLocked(get(), initial) || jobsFor(get).has(clipId)) return;
    if (get().showPitchEditor && get().pitchEditorClipId === clipId) {
      get().showToast("Close this clip's pitch editor before creating a project-rate copy.", "info"); return;
    }
    const targetRate = get().projectSampleRate;
    if (initial.sampleRate === targetRate) { get().showToast("This clip already uses the project sample rate.", "info"); return; }
    const initialSignature = signature(initial);
    const { job, valid, finish } = beginJob(set, get, clipId, targetRate, `${get().tracks.find(track => track.id === trackId)?.name ?? "Track"} ? ${initial.name}`);
    const targetValid = () => {
      const clip = findClip(get(), trackId, clipId);
      return valid() && get().projectSampleRate === targetRate && !!clip && signature(clip) === initialSignature
        && !isClipEditLocked(get(), clip) && !(get().showPitchEditor && get().pitchEditorClipId === clipId);
    };
    const monitor = setInterval(() => {
      if (job.stage === "converting" && !targetValid() && !job.cancelled) {
        job.cancelled = true; void nativeBridge.cancelProjectRateCopy(job.id);
      }
    }, 100);
    try {
      const result = await nativeBridge.createProjectRateCopy(initial.filePath, targetRate, get().projectPath,
        job.id, initial.pitchCorrectionSourceFilePath ?? "");
      if (!targetValid()) throw abort();
      if (!result.success || !result.filePath) {
        if (result.cancelled) throw abort();
        throw new Error(result.error ?? "The project-rate copy could not be created.");
      }
      const current = findClip(get(), trackId, clipId)!;
      const before = sourceFields(current);
      const after: SourceFields = {
        filePath: result.filePath, sampleRate: result.sampleRate ?? targetRate,
        sourceLength: Math.max(result.duration ?? current.sourceLength ?? 0, current.offset + current.duration),
        originalFilePath: current.originalFilePath ?? current.filePath,
        pitchCorrectionSourceFilePath: current.pitchCorrectionSourceFilePath ? result.originalSourceFilePath : undefined,
        pitchCorrectionSourceOffset: current.pitchCorrectionSourceOffset,
      };
      const patch = (fields: SourceFields) => set((state: State) => ({
        tracks: state.tracks.map(track => track.id !== trackId ? track : {
          ...track, clips: track.clips.map(clip => clip.id === clipId ? { ...clip, ...fields } : clip),
        }), isModified: true,
      }));
      job.stage = "publishing"; updateJob(set, clipId, job);
      const applied = await replaceSyncedClipSource({ trackId, previousClip: current,
        nextClip: { ...current, ...after }, stillValid: targetValid, onReplaced: () => patch(after),
        getCurrent: () => findClip(get(), trackId, clipId), resync: () => get().syncClipsWithBackend() });
      if (!applied) throw new Error("The clip changed before the converted source could be published.");
      const epoch = job.epoch;
      const replay = (previous: SourceFields, next: SourceFields) => {
        if (getProjectEpoch() !== epoch || findClip(get(), trackId, clipId)?.filePath !== previous.filePath) return;
        // Undo is a synchronous document intent. Ordinary publication reads the
        // newest intent inside its queue, so fast Undo/Redo cannot reorder sources.
        patch(next);
        void get().syncClipsWithBackend().catch(error => {
          if (getProjectEpoch() === epoch) get().showToast(`The project source was restored, but audio synchronization failed: ${String(error)}`, "error");
        });
      };
      commandManager.push({ type: "CREATE_PROJECT_RATE_COPY", description: `Create ${targetRate} Hz copy of "${current.name}"`,
        timestamp: Date.now(), execute: () => replay(before, after), undo: () => replay(after, before) });
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      void nativeBridge.refreshWaveformPeaks(after.filePath);
      get().showToast(`Created a ${targetRate} Hz copy; original audio preserved.`, "success");
    } catch (error) {
      if (getProjectEpoch() === job.epoch && (error as Error).name !== "AbortError") get().showToast(String(error), "error");
    } finally { clearInterval(monitor); finish(); }
  },
});
