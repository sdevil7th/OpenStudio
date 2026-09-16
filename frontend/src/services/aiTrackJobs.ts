import { useDAWStore } from "../store/useDAWStore";
import { getAIWorkflow, mergeWorkflowParams, resolveAiMusicModelId } from "../data/aiWorkflows";
import { cancelGenerationJob, startGenerationJob } from "./aiGenerationJobs";

export const cancelAITrackJob = (trackId: string) => cancelGenerationJob(`track:${trackId}`);

export async function startAITrackJob(trackId: string): Promise<void> {
  const state = useDAWStore.getState();
  const track = state.tracks.find(entry => entry.id === trackId);
  if (!track) return;
  const modelId = resolveAiMusicModelId(track.aiMusicModelId);
  const workflow = getAIWorkflow(track.aiWorkflow, modelId, "ai-track");
  const startTime = state.transport.currentTime;
  await startGenerationJob({
    owner: `track:${trackId}`, trackId, modelId, workflowId: workflow.id,
    params: mergeWorkflowParams(workflow.id, track.aiWorkflowParams, modelId),
    recovery: { startTime },
    valid: () => useDAWStore.getState().tracks.some(entry => entry.id === trackId),
    update: progress => useDAWStore.getState().setAITrackGenerationState(trackId,
      progress.state === "error" ? "error" : progress.state === "idle" ? "idle"
        : progress.state === "loading" ? "loading" : "generating", progress),
    complete: (file, valid, recoveryJobId) => useDAWStore.getState().addGeneratedAudioClip(trackId, file, startTime, undefined, valid, recoveryJobId),
  });
}
