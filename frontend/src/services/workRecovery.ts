import { nativeBridge, type WorkRecoveryEntry } from "./NativeBridge";
import { createDefaultTrack, useDAWStore, type AudioClip } from "../store/useDAWStore";
import { getProjectEpoch } from "../utils/projectLifetime";
import { sourceClipIdentity } from "../utils/sourceClipIdentity";
import { projectNativeQueue } from "../utils/projectNativeQueue";
import { startGenerationJob } from "./aiGenerationJobs";
import { AI_MUSIC_MODELS, isModelSupportedForWorkflow, normalizeWorkflowId } from "../data/aiWorkflows";
import { clipJobOwner, useAIClipJob } from "./aiClipJobs";

const importing = new Set<string>();
const key = (path?: string | null) => (path || "").replace(/\\/g, "/").toLowerCase();
export const recoveryAlreadyImported = (id: string) => useDAWStore.getState().tracks
  .some(track => track.clips.some(clip => clip.recoveryJobId === id));

export async function importRecoveredAudio(entry: WorkRecoveryEntry, file: string, targetTrackId = "") {
  if (importing.has(entry.id) || recoveryAlreadyImported(entry.id)) throw new Error("This recovery item is already imported or importing");
  importing.add(entry.id);
  const epoch = getProjectEpoch();
  try {
    const info = await nativeBridge.importMediaFile(file);
    if (!info?.filePath || !Number.isFinite(info.duration) || info.duration <= 0) throw new Error("Recovery audio is not readable");
    if (epoch !== getProjectEpoch()) throw new Error("The project changed during recovery");
    const state = useDAWStore.getState();
    const existing = targetTrackId ? state.tracks.find(track => track.id === targetTrackId) : undefined;
    if (targetTrackId && !existing) throw new Error("The destination track was removed");
    const track = existing || createDefaultTrack(crypto.randomUUID(), "Recovered audio", undefined, "audio", state.tracks);
    const clip: AudioClip = { id: crypto.randomUUID(), filePath: info.filePath,
      name: entry.kind === "recording" ? "Recovered recording" : "Recovered AI audio",
      startTime: Number.isFinite(entry.startTime) && entry.startTime! >= 0 ? entry.startTime! : 0,
      duration: info.duration, offset: 0, color: track.color, volumeDB: 0, fadeIn: 0, fadeOut: 0,
      sampleRate: info.sampleRate, sourceLength: info.duration, recoveryJobId: entry.id };
    const sync = projectNativeQueue(epoch, error =>
      useDAWStore.getState().showToast(`Recovered audio could not be synced: ${String(error)}`, "error"));
    let firstSync: Promise<void> | undefined;
    state.executeCommand({ type: "RECOVER_AUDIO", description: "Import recovered audio", timestamp: Date.now(),
      execute: () => {
        useDAWStore.setState(current => ({ tracks: existing
          ? current.tracks.map(item => item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item)
          : [...current.tracks, { ...track, clips: [clip] }], isModified: true }));
        const operation = sync(async () => {
          if (!existing) await nativeBridge.addTrack(track.id, "audio");
          if (epoch !== getProjectEpoch()) return;
          if (!await nativeBridge.addPlaybackClip(track.id, clip.filePath, clip.startTime, clip.duration, 0, 0, 0, 0, clip.id))
            throw new Error("The native engine rejected the recovered clip");
        });
        firstSync ??= operation;
      },
      undo: () => {
        useDAWStore.setState(current => ({ tracks: existing
          ? current.tracks.map(item => item.id === track.id ? { ...item, clips: item.clips.filter(itemClip => itemClip.id !== clip.id) } : item)
          : current.tracks.filter(item => item.id !== track.id), isModified: true }));
        sync(() => existing ? nativeBridge.removePlaybackClipById(track.id, clip.id) : nativeBridge.removeTrack(track.id));
      },
    });
    await firstSync;
    if (epoch !== getProjectEpoch()) throw new Error("The project changed during recovery");
    // The clip is still only in memory. Its identity prevents duplicate imports;
    // ProjectFileStore retires the journal after an explicit save contains it.
  } finally { importing.delete(entry.id); }
}

export function aiRecoveryProblem(entry: WorkRecoveryEntry): string | null {
  const state = useDAWStore.getState();
  const sameProject = entry.projectId ? state.projectPersistentId === entry.projectId
    : (!!entry.projectPath && key(state.projectPath) === key(entry.projectPath));
  if (!sameProject) return "Open the original project or its recovery copy before restarting this request.";
  const track = state.tracks.find(track => track.id === entry.trackId);
  if (!track) return "The original destination track is missing.";
  if (entry.sourceClipId) {
    const source = track.clips.find(clip => clip.id === entry.sourceClipId);
    if (!source || sourceClipIdentity(source) !== entry.sourceIdentity)
      return "The source clip changed or is missing. Start a new request from the current source.";
  }
  if (!AI_MUSIC_MODELS.some(model => model.id === entry.modelId)
    || !normalizeWorkflowId(entry.workflowId) || !isModelSupportedForWorkflow(entry.modelId, entry.workflowId)
    || !entry.params || typeof entry.params !== "object" || Array.isArray(entry.params))
    return "The saved generation request is invalid.";
  return null;
}

export async function restartRecoveredAI(entry: WorkRecoveryEntry): Promise<boolean> {
  const problem = aiRecoveryProblem(entry);
  if (problem) throw new Error(problem);
  const epoch = getProjectEpoch();
  const owner = entry.sourceClipId ? clipJobOwner(entry.trackId!, entry.sourceClipId) : `track:${entry.trackId}`;
  const accepted = await startGenerationJob({ owner, trackId: entry.trackId!,
    modelId: entry.modelId!, workflowId: entry.workflowId!, params: entry.params!, recovery: {
      startTime: entry.startTime, sourceClipId: entry.sourceClipId, sourceIdentity: entry.sourceIdentity,
      extensionDuration: entry.extensionDuration,
    }, valid: () => epoch === getProjectEpoch() && !aiRecoveryProblem(entry),
    update: progress => {
      if (entry.sourceClipId) useAIClipJob.setState({ owner, progress });
      else useDAWStore.getState().setAITrackGenerationState(entry.trackId!,
        progress.state === "error" ? "error" : progress.state === "idle" ? "idle"
          : progress.state === "loading" ? "loading" : "generating", progress);
    },
    complete: async (file, valid, recoveryJobId) => {
      if (!valid()) return;
      if (entry.sourceClipId) await useDAWStore.getState().addGeneratedSourceAudioClip({
        sourceTrackId: entry.trackId!, sourceClipId: entry.sourceClipId, workflowId: normalizeWorkflowId(entry.workflowId)!,
        extensionDuration: entry.extensionDuration ?? 0, filePath: file, stillValid: valid, recoveryJobId,
      });
      else await useDAWStore.getState().addGeneratedAudioClip(entry.trackId!, file, entry.startTime ?? 0, "Recovered AI generation", valid, recoveryJobId);
    },
  });
  if (accepted) await nativeBridge.workRecovery("dismiss", entry.id);
  return accepted;
}

export async function resumeRecoveredAIImport(entry: WorkRecoveryEntry) {
  const problem = aiRecoveryProblem(entry);
  if (problem || !entry.outputFile) throw new Error(problem || "No completed audio artifact");
  if (!entry.sourceClipId) return importRecoveredAudio(entry, entry.outputFile, entry.trackId);
  if (importing.has(entry.id) || recoveryAlreadyImported(entry.id)) throw new Error("This recovery item is already imported or importing");
  importing.add(entry.id);
  const epoch = getProjectEpoch();
  const valid = () => epoch === getProjectEpoch() && !aiRecoveryProblem(entry);
  try {
    await useDAWStore.getState().addGeneratedSourceAudioClip({
      sourceTrackId: entry.trackId!, sourceClipId: entry.sourceClipId, workflowId: normalizeWorkflowId(entry.workflowId)!,
      filePath: entry.outputFile, extensionDuration: entry.extensionDuration ?? 0, stillValid: valid, recoveryJobId: entry.id,
    });
    if (!valid() || !recoveryAlreadyImported(entry.id)) throw new Error("The source changed while recovery was being prepared");
    // Keep the completed result discoverable until an explicit project save.
  } finally { importing.delete(entry.id); }
}
