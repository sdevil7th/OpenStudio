import { create } from "zustand";
import { useDAWStore } from "../store/useDAWStore";
import { sourceClipIdentity } from "../utils/sourceClipIdentity";
import { type AIWorkflowId } from "../data/aiWorkflows";
import { type AIGenerationProgress } from "./NativeBridge";
import { cancelGenerationJob, startGenerationJob } from "./aiGenerationJobs";

export const useAIClipJob = create<{ owner: string; progress: AIGenerationProgress }>(() => ({
  owner: "", progress: { state: "idle", progress: 0 },
}));
export const clipJobOwner = (trackId: string, clipId: string) => `clip:${trackId}:${clipId}`;
export const cancelAIClipJob = (owner: string) => cancelGenerationJob(owner);

// Compare only source/placement properties, not meters, selection, colours or
// waveform readiness. Runs only when the immutable clip reference changes.
export async function startAIClipJob(options: {
  trackId: string; clipId: string; modelId: string; workflowId: AIWorkflowId;
  params: Record<string, unknown>; extensionDuration: number;
}): Promise<void> {
  const find = () => useDAWStore.getState().tracks.find(track => track.id === options.trackId)
    ?.clips.find(clip => clip.id === options.clipId);
  const source = find();
  if (!source) return;
  const identity = sourceClipIdentity(source);
  let lastClip = source;
  let unchanged = true;
  const owner = clipJobOwner(options.trackId, options.clipId);
  await startGenerationJob({ ...options, owner,
    recovery: { sourceClipId: options.clipId, sourceIdentity: identity, extensionDuration: options.extensionDuration },
    valid: () => {
      const current = find();
      if (!current) return false;
      if (current !== lastClip) {
        unchanged = sourceClipIdentity(current) === identity;
        lastClip = current;
      }
      return unchanged;
    },
    update: progress => useAIClipJob.setState({ owner, progress }),
    complete: async (filePath, valid, recoveryJobId) => {
      await useDAWStore.getState().addGeneratedSourceAudioClip({
        sourceTrackId: options.trackId, sourceClipId: options.clipId,
        workflowId: options.workflowId, extensionDuration: options.extensionDuration,
        filePath, stillValid: valid, recoveryJobId,
      });
      const current = useDAWStore.getState();
      if (valid() && current.aiClipGenerationTrackId === options.trackId
        && current.aiClipGenerationClipId === options.clipId
        && current.aiClipGenerationWorkflowId === options.workflowId)
        current.closeAIClipGeneration();
    },
  });
}
