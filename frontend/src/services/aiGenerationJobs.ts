import { nativeBridge, type AIGenerationProgress } from "./NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { getProjectEpoch } from "../utils/projectLifetime";

type Options = {
  owner: string;
  trackId: string;
  modelId: string;
  workflowId: string;
  params: Record<string, unknown>;
  recovery?: Record<string, unknown>;
  valid: () => boolean;
  update: (progress: AIGenerationProgress) => void;
  complete: (file: string, valid: () => boolean, recoveryJobId?: string) => Promise<void>;
};
type Job = Options & {
  epoch: number;
  cancelled: boolean;
  requestId?: string;
  journalId?: string;
  starting?: Promise<void>;
  stopping?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  stalePolls: number;
  failedPolls: number;
  idlePolls: number;
};

// One lease for ALL forms using the native music worker. Never tied to a React
// mount, never cancel an unbound request, and never retry a partial import.
let active: Job | undefined;
const owns = (job: Job) => active === job && !job.cancelled
  && job.epoch === getProjectEpoch() && job.valid();

function release(job: Job) {
  clearTimeout(job.timer);
  job.unsubscribe?.();
  if (active === job) active = undefined;
}

function fail(job: Job, message: string, phase: string) {
  if (active === job && job.epoch === getProjectEpoch())
    job.update({ state: "error", progress: 0, message, error: message, phase });
  release(job);
  if (job.journalId) void nativeBridge.workRecovery("updateAI", job.journalId, { error: message }).catch(() => {});
}

export async function cancelGenerationJob(owner: string, reason?: string): Promise<void> {
  const job = active;
  if (!job || job.owner !== owner) return;
  if (job.stopping) return job.stopping;
  job.cancelled = true;
  clearTimeout(job.timer);
  job.unsubscribe?.();
  job.stopping = (async () => {
    try {
      await job.starting;
      if (job.requestId) await nativeBridge.cancelAIGeneration(job.requestId);
      if (job.journalId) await nativeBridge.workRecovery("updateAI", job.journalId, { status: "cancelled" });
      if (job.epoch === getProjectEpoch()) job.update(reason
        ? { state: "error", progress: 0, error: reason, message: reason, phase: "source_changed" }
        : { state: "idle", progress: 0 });
    } catch (error) {
      fail(job, String(error), "cancel_failed");
    } finally { release(job); }
  })();
  return job.stopping;
}

async function poll(job: Job): Promise<void> {
  if (!owns(job)) {
    await cancelGenerationJob(job.owner, "The source or project changed. Generate again from the current source.");
    return;
  }
  let importing = false;
  try {
    const progress = await nativeBridge.getAIGenerationProgress();
    if (!owns(job)) return;
    if (progress.requestId !== job.requestId) {
      if (++job.stalePolls >= 3) {
        fail(job, "The generation worker belongs to a different request.", "request_superseded");
        return;
      }
    } else {
      job.stalePolls = 0;
      job.failedPolls = 0;
      if (progress.state === "error") {
        fail(job, progress.error || progress.message || "Generation failed.", progress.phase || "generation_failed");
        return;
      }
      if (progress.state === "cancelled") {
        job.update({ state: "idle", progress: 0 }); release(job); return;
      }
      if (progress.state === "done") {
        if (!progress.outputFile) { fail(job, "Generation finished without an audio file.", "missing_output"); return; }
        importing = true;
        if (job.journalId) await nativeBridge.workRecovery("updateAI", job.journalId, { status: "completed", outputFile: progress.outputFile });
        if (!owns(job)) return;
        job.update({ ...progress, state: "generating", phase: "importing", message: "Preparing generated audio..." });
        await job.complete(progress.outputFile, () => owns(job), job.journalId);
        // Insertion is not a durable save. Keep the completed journal until
        // ProjectFileStore saves a document containing this recoveryJobId.
        if (owns(job)) job.update({ state: "idle", progress: 0 });
        release(job); return;
      }
      job.idlePolls = progress.state === "idle" ? job.idlePolls + 1 : 0;
      if (job.idlePolls >= 10) {
        await cancelGenerationJob(job.owner, "The generation worker stopped without a result."); return;
      }
      job.update({ ...progress, state: progress.state === "loading" ? "loading" : "generating" });
    }
  } catch (error) {
    if (!owns(job)) return;
    if (importing) { fail(job, String(error), "generated_audio_import_failed"); return; }
    if (++job.failedPolls >= 3) {
      try { await nativeBridge.cancelAIGeneration(job.requestId); } catch { /* Preserve original failure. */ }
      if (!job.cancelled) fail(job, String(error), "generation_session_failed");
      return;
    }
  }
  if (owns(job)) job.timer = setTimeout(() => void poll(job), 250);
}

export async function startGenerationJob(options: Options): Promise<boolean> {
  if (active) {
    useDAWStore.getState().showToast("An AI generation is already running or stopping.", "error");
    return false;
  }
  if (!options.valid()) return false;
  const job: Job = { ...options, epoch: getProjectEpoch(), cancelled: false,
    stalePolls: 0, failedPolls: 0, idlePolls: 0 };
  active = job;
  job.update({ state: "loading", progress: 0.01, phase: "starting", error: "" });
  job.unsubscribe = useDAWStore.subscribe(() => {
    if (!owns(job) && !job.cancelled)
      void cancelGenerationJob(job.owner, "The source or project changed. Generate again from the current source.");
  });
  // Publish the promise before invoking bridge code (including synchronous mocks).
  job.starting = Promise.resolve().then(async () => {
    try {
      const state = useDAWStore.getState();
      const seed = Number(job.params.seed);
      if (!Number.isSafeInteger(seed) || seed < 0) job.params = { ...job.params, seed: crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff };
      const journalId = await nativeBridge.workRecovery("createAI", "", {
        ...job.recovery, status: "queued", trackId: job.trackId, modelId: job.modelId,
        workflowId: job.workflowId, params: job.params, projectId: state.projectPersistentId,
        projectPath: state.projectPath || "", projectName: state.projectName,
      });
      if (typeof journalId !== "string" || !journalId) throw new Error("Could not save the generation recovery request");
      job.journalId = journalId;
      const result = await nativeBridge.startAIGeneration(job.trackId, job.modelId, job.workflowId,
        { ...job.params, _openStudioRecoveryId: journalId });
      if (result.started && result.requestId) job.requestId = result.requestId;
      if (!owns(job)) return;
      if (!result.started || !job.requestId) {
        fail(job, result.error || "Generation did not return a request identity. Update the app and retry.", "start_failed");
        return;
      }
      void poll(job);
    } catch (error) { if (!job.cancelled) fail(job, String(error), "start_failed"); }
  });
  await job.starting;
  return !!job.requestId && !job.cancelled;
}
