import { type TrackType, useDAWStore } from "../store/useDAWStore";
import { getDefaultWorkflowParams } from "../data/aiWorkflows";

export type InsertableTrackType = Extract<TrackType, "audio" | "midi" | "instrument" | "ai">;

const DEFAULT_PREFIX: Record<InsertableTrackType, string> = {
  audio: "Audio",
  midi: "MIDI",
  instrument: "Instrument",
  ai: "AI",
};

function getTrackName(type: InsertableTrackType, prefix?: string) {
  const state = useDAWStore.getState();
  const basePrefix = (prefix || DEFAULT_PREFIX[type]).trim() || DEFAULT_PREFIX[type];
  const nextIndex =
    state.tracks.filter((track) => track.type === type).length + 1;
  return `${basePrefix} ${nextIndex}`;
}

export async function createTrackOfType(
  type: InsertableTrackType,
  options?: {
    prefix?: string;
    insertAfterTrackId?: string;
    openInstrumentBrowser?: boolean;
  },
) {
  const trackId = crypto.randomUUID();
  const state = useDAWStore.getState();
  const isMidiType = type === "midi" || type === "instrument";
  const isAiType = type === "ai";

  state.addTrack({
    id: trackId,
    name: getTrackName(type, options?.prefix),
    type,
    inputType: isMidiType ? "midi" : "stereo",
    inputChannelCount: isMidiType ? 1 : 2,
    armed: type === "instrument",
    monitorEnabled: type === "instrument",
    aiWorkflow: isAiType ? "text-to-music" : undefined,
    aiWorkflowParams: isAiType
      ? getDefaultWorkflowParams("text-to-music")
      : undefined,
    aiGenerationState: isAiType ? "idle" : undefined,
    aiGenerationProgress: isAiType ? 0 : undefined,
    aiGenerationError: isAiType ? "" : undefined,
    aiGenerationPhase: isAiType ? "" : undefined,
    aiGenerationMessage: isAiType ? "" : undefined,
    aiGenerationBackend: isAiType ? "" : undefined,
    aiGenerationElapsedMs: isAiType ? 0 : undefined,
    aiGenerationHeartbeatTs: isAiType ? 0 : undefined,
    aiGenerationPhaseProgress: isAiType ? undefined : undefined,
    aiGenerationEtaMs: isAiType ? undefined : undefined,
    aiGenerationRunMode: isAiType ? undefined : undefined,
    aiGenerationRuntimeProfile: isAiType ? "" : undefined,
    aiGenerationLmModel: isAiType ? "" : undefined,
    aiGenerationStatusNote: isAiType ? "" : undefined,
    aiGenerationFailureKind: isAiType ? "" : undefined,
    aiGenerationSessionMode: isAiType ? "" : undefined,
    aiGenerationWorkerExitCode: isAiType ? 0 : undefined,
    aiGenerationLastStdoutLine: isAiType ? "" : undefined,
    aiGenerationLastStderrLine: isAiType ? "" : undefined,
    aiGenerationAttemptMode: isAiType ? "" : undefined,
    aiGenerationAttemptIndex: isAiType ? 0 : undefined,
    aiGenerationProtocolVersion: isAiType ? 0 : undefined,
    aiGenerationScriptVersion: isAiType ? "" : undefined,
    aiGenerationRequestId: isAiType ? "" : undefined,
    aiGenerationPriorFailure: isAiType ? "" : undefined,
    aiGenerationLastProgressAgeMs: isAiType ? 0 : undefined,
    icon: isAiType ? "ai" : undefined,
    insertAfterTrackId: options?.insertAfterTrackId,
  });

  state.selectTrack(trackId);
  if (type === "instrument" && options?.openInstrumentBrowser) {
    state.openPluginBrowser(trackId);
  }

  return trackId;
}

export async function createMultipleTracks(
  count: number,
  type: InsertableTrackType,
  prefix?: string,
) {
  const safeCount = Math.max(1, Math.min(128, Math.floor(count)));
  for (let index = 0; index < safeCount; index += 1) {
    await createTrackOfType(type, { prefix });
  }
}
