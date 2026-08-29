import { describe, expect, it } from "vitest";
import timelineSource from "../components/Timeline.tsx?raw";
import trackActionsSource from "../store/actions/tracks.ts?raw";
import storeSource from "../store/useDAWStore.ts?raw";

describe("timeline track drop regression guards", () => {
  it("creates ghost-drop tracks with one explicit backend-created id path", () => {
    expect(timelineSource).toContain("finalizingTimelineClipGestureRef");
    expect(timelineSource).toContain("createTimelineGeneratedTrack");
    expect(timelineSource).toContain("nativeBridge.addTrack(trackId, newTrackType)");
    expect(timelineSource).toContain("backendAlreadyCreated: true");
    expect(timelineSource).not.toContain("nativeBridge.addTrack(undefined, newTrackType)");
  });

  it("keeps audio clips on new audio tracks and midi clips on new midi tracks", () => {
    expect(timelineSource).toContain('function getNewTrackTypeForTimelineClip(isMidi: boolean): "audio" | "midi"');
    expect(timelineSource).toContain('return isMidi ? "midi" : "audio";');
  });

  it("lets undoable addTrack skip duplicate ids and backend re-adds when already created", () => {
    expect(storeSource).toContain("backendAlreadyCreated?: boolean");
    expect(trackActionsSource).toContain("Ignoring duplicate addTrack");
    expect(trackActionsSource).toContain("const includeAddTrack = !(options.backendAlreadyCreated && !hasExecutedOnce)");
    expect(trackActionsSource).toContain("syncTrackCoreToBackend(fullTrack, { includeAddTrack })");
  });

  it("dedupes external file drops and allows multi-track MIDI files to land on one compatible track", () => {
    expect(timelineSource).toContain("dedupeExternalMediaFiles");
    expect(timelineSource).toContain("processedExternalDropKeysRef");
    expect(timelineSource).toContain("getExternalMediaDropKey");
    expect(timelineSource).toContain('isExternalTrackCompatible(targetTrack, "midi");');
    expect(timelineSource).not.toContain("(preview.midiTrackCount ?? 1) <= 1");
  });
});
