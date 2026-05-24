import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STABLE_AUDIO_3_MODEL_ID } from "../data/aiWorkflows";
import { nativeBridge } from "../services/NativeBridge";
import { commandManager } from "../store/commands";
import { createDefaultTrack, type AudioClip, useDAWStore } from "../store/useDAWStore";

const initialState = useDAWStore.getState();

function sourceClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "clip-source",
    filePath: "C:/audio/source.wav",
    name: "Source Loop",
    startTime: 10,
    duration: 5,
    offset: 0,
    color: "#4cc9f0",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
    sampleRate: 44100,
    sourceLength: 5,
    ...overrides,
  };
}

describe("AI generation store actions", () => {
  beforeEach(() => {
    commandManager.clear();
    useDAWStore.setState(initialState);
    vi.spyOn(nativeBridge, "importMediaFile").mockResolvedValue({
      filePath: "C:/audio/generated.wav",
      duration: 3,
      sampleRate: 44100,
      numChannels: 2,
      format: "wav",
    });
    vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("track-added");
    vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removePlaybackClip").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    commandManager.clear();
    useDAWStore.setState(initialState);
  });

  it("resets incompatible AI track workflow params when the model changes", () => {
    const aiTrack = createDefaultTrack("ai-track", "AI Track", "#7c3aed", "ai");
    useDAWStore.setState({ tracks: [aiTrack], canUndo: false, canRedo: false });

    useDAWStore.getState().setAITrackModel("ai-track", STABLE_AUDIO_3_MODEL_ID);

    const updated = useDAWStore.getState().tracks[0];
    expect(updated.aiMusicModelId).toBe(STABLE_AUDIO_3_MODEL_ID);
    expect(updated.aiWorkflow).toBe("text-to-audio");
    expect(updated.aiWorkflowParams).toMatchObject({
      prompt: "",
      negative_prompt: "",
      duration: 30,
    });
    expect(useDAWStore.getState().canUndo).toBe(true);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].aiWorkflow).toBe("text-to-music");
  });

  it("adds variation output as an undoable track below the source track", async () => {
    const track = createDefaultTrack("track-source", "Guitar", "#4cc9f0", "audio");
    track.clips = [sourceClip()];
    useDAWStore.setState({ tracks: [track], canUndo: false, canRedo: false });

    await useDAWStore.getState().addGeneratedSourceAudioClip({
      sourceTrackId: "track-source",
      sourceClipId: "clip-source",
      workflowId: "variation",
      filePath: "C:/audio/generated.wav",
    });

    const tracks = useDAWStore.getState().tracks;
    expect(tracks).toHaveLength(2);
    expect(tracks[1].name).toBe("AI Variation - Source Loop");
    expect(tracks[1].clips[0].startTime).toBe(10);
    expect(useDAWStore.getState().canUndo).toBe(true);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks).toHaveLength(1);
  });

  it("places continuation on the source track when the tail range is clear", async () => {
    const track = createDefaultTrack("track-source", "Guitar", "#4cc9f0", "audio");
    track.clips = [sourceClip()];
    useDAWStore.setState({ tracks: [track], canUndo: false, canRedo: false });

    await useDAWStore.getState().addGeneratedSourceAudioClip({
      sourceTrackId: "track-source",
      sourceClipId: "clip-source",
      workflowId: "continue-clip",
      filePath: "C:/audio/generated.wav",
    });

    const tracks = useDAWStore.getState().tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].clips).toHaveLength(2);
    expect(tracks[0].clips[1].startTime).toBe(15);
  });

  it("places continuation on a new track when the source tail range collides", async () => {
    const track = createDefaultTrack("track-source", "Guitar", "#4cc9f0", "audio");
    track.clips = [
      sourceClip(),
      sourceClip({ id: "clip-existing", name: "Existing", startTime: 16, duration: 2 }),
    ];
    useDAWStore.setState({ tracks: [track], canUndo: false, canRedo: false });

    await useDAWStore.getState().addGeneratedSourceAudioClip({
      sourceTrackId: "track-source",
      sourceClipId: "clip-source",
      workflowId: "continue-clip",
      filePath: "C:/audio/generated.wav",
    });

    const tracks = useDAWStore.getState().tracks;
    expect(tracks).toHaveLength(2);
    expect(tracks[1].name).toBe("AI Continuation - Source Loop");
    expect(tracks[1].clips[0].startTime).toBe(15);
  });
});
