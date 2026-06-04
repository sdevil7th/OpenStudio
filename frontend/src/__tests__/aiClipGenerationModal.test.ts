import { describe, expect, it } from "vitest";
import { ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID } from "../data/aiWorkflows";
import { buildAIClipGenerationRequestParams } from "../components/AIClipGenerationModal";
import modalSource from "../components/AIClipGenerationModal.tsx?raw";
import trackHeaderSource from "../components/AITrackHeader.tsx?raw";
import workflowModalSource from "../components/AIWorkflowModal.tsx?raw";

describe("AI clip generation modal", () => {
  it("requires direction prompts for Stable Audio source workflows", () => {
    expect(modalSource).toContain("stableSourcePromptMissing");
    expect(modalSource).toContain("Stable Audio source workflows need a direction prompt.");
    expect(modalSource).toContain("disabled={!sourceClip || (isModelReady && (inpaintSelectionMissing || stableSourcePromptMissing))}");
  });

  it("does not render misleading ETA or remaining-time text", () => {
    for (const source of [modalSource, workflowModalSource, trackHeaderSource]) {
      expect(source).not.toContain("formatEtaLabel");
      expect(source).not.toContain("s left");
      expect(source).not.toContain("m ${seconds}s left");
    }
    expect(modalSource).toContain("formatElapsedLabel(progress.elapsedMs)");
    expect(workflowModalSource).toContain("formatElapsedLabel(track.aiGenerationElapsedMs)");
    expect(trackHeaderSource).toContain("formatElapsedLabel(track.aiGenerationElapsedMs)");
  });

  it("injects project timing into ACE source clip requests", () => {
    const request = buildAIClipGenerationRequestParams({
      params: { prompt: "make a close variation", audio_cover_strength: 0.85 },
      modelId: ACE_STEP_MODEL_ID,
      sourceTrack: { id: "track-source", name: "Source" },
      sourceClip: {
        id: "clip-source",
        filePath: "C:/audio/source.wav",
        name: "Loop",
        startTime: 4,
        duration: 8,
        offset: 1,
        color: "#38bdf8",
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
      },
      workflowRange: null,
      extensionDuration: 20,
      transportTempo: 100,
      timeSignature: { numerator: 4, denominator: 4 },
    });

    expect(request).toMatchObject({
      bpm: 100,
      timesignature: "4/4",
      source: {
        filePath: "C:/audio/source.wav",
        clipOffset: 1,
        clipDuration: 8,
        sourceClipStartTime: 4,
      },
    });
  });

  it("leaves Stable Audio source clip requests model-specific", () => {
    const request = buildAIClipGenerationRequestParams({
      params: { prompt: "make a close variation" },
      modelId: STABLE_AUDIO_3_MODEL_ID,
      sourceTrack: { id: "track-source", name: "Source" },
      sourceClip: {
        id: "clip-source",
        filePath: "C:/audio/source.wav",
        name: "Loop",
        startTime: 4,
        duration: 8,
        offset: 0,
        color: "#38bdf8",
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
      },
      workflowRange: null,
      extensionDuration: 20,
      transportTempo: 100,
      timeSignature: { numerator: 4, denominator: 4 },
    });

    expect(request).not.toHaveProperty("bpm");
    expect(request).not.toHaveProperty("timesignature");
  });
});
