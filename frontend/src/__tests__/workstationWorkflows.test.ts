import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import { commandManager } from "../store/commands";
import { importMediaWithDialog, midiImportFilter } from "../services/mediaImport";
import { getEffectiveActionShortcut } from "../store/actionRegistry";
import { extractMixerUISnapshot, parseMixerUISnapshot } from "../utils/mixerWindowSync";
const initial = useDAWStore.getState();
beforeEach(() => { commandManager.clear(); useDAWStore.setState({ ...initial, tracks: [], selectedTrackIds: [], selectedTrackId: null, globalLocked: false }); });
afterEach(() => { vi.restoreAllMocks(); useDAWStore.setState(initial); commandManager.clear(); });
describe("workstation workflows", () => {
  it("imports MIDI from a menu with a MIDI filter and the captured cursor", async () => {
    useDAWStore.setState({ transport: { ...initial.transport, currentTime: 12 } });
    const dialog = vi.spyOn(nativeBridge, "showImportFilesDialog").mockImplementation(async () => {
      useDAWStore.setState({ transport: { ...initial.transport, currentTime: 99 } }); return ["C:/melody.mid"];
    });
    const action = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ importExternalMIDIAtTimeline: action });
    await importMediaWithDialog("midi");
    expect(dialog).toHaveBeenCalledWith("Import MIDI Files", midiImportFilter);
    expect(action).toHaveBeenCalledWith({ filePath: "C:/melody.mid", startTime: 12, targetTrackId: undefined });
  });
  it("does not import audio into an incompatible selected MIDI track", async () => {
    useDAWStore.setState({ tracks: [createDefaultTrack("m", "MIDI", "#fff", "midi")], selectedTrackIds: ["m"] });
    vi.spyOn(nativeBridge, "showImportFilesDialog").mockResolvedValue(["C:/voice.wav"]);
    const action = vi.fn().mockResolvedValue(undefined);
    useDAWStore.setState({ importExternalMediaAtTimeline: action });
    await importMediaWithDialog("audio");
    expect(action.mock.calls[0][0].trackId).toBeUndefined();
  });
  it("cancelling import creates no undo entry", async () => {
    vi.spyOn(nativeBridge, "showImportFilesDialog").mockResolvedValue([]);
    await importMediaWithDialog("media");
    expect(commandManager.canUndo()).toBe(false);
    expect(useDAWStore.getState().tracks).toEqual([]);
  });
  it("makes Solo Safe undoable without changing solo or mute", () => {
    const track = { ...createDefaultTrack("a", "Reference", "#fff", "audio"), muted: true };
    useDAWStore.setState({ tracks: [track] });
    const bridge = vi.spyOn(nativeBridge, "setTrackSoloSafe").mockResolvedValue(true);
    useDAWStore.getState().toggleTrackSoloSafe("a");
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ soloSafe: true, muted: true, soloed: false });
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].soloSafe).toBe(false);
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0].soloSafe).toBe(true);
    expect(bridge.mock.calls).toEqual([["a", true], ["a", false], ["a", true]]);
  });
  it("retains Solo Safe in the detached mixer snapshot", () => {
    useDAWStore.setState({ tracks: [{ ...createDefaultTrack("a", "Reference", "#fff", "audio"), soloSafe: true }] });
    const snapshot = extractMixerUISnapshot();
    expect(snapshot.tracks[0].soloSafe).toBe(true);
    expect(parseMixerUISnapshot(JSON.parse(JSON.stringify(snapshot)))?.tracks[0].soloSafe).toBe(true);
  });
  it("provides OpenStudio and Pro Tools import shortcuts without stealing Quick Add", () => {
    useDAWStore.setState({ keyboardShortcutProfileId: "openstudio", customShortcuts: {} });
    expect(getEffectiveActionShortcut("file.importAudio")).toBe("Ctrl+I");
    expect(getEffectiveActionShortcut("file.importMIDI")).toBe("Ctrl+Alt+I");
    expect(getEffectiveActionShortcut("insert.quickAddInstrument")).toBe("Ctrl+Shift+I");
    useDAWStore.setState({ keyboardShortcutProfileId: "pro_tools" });
    expect(getEffectiveActionShortcut("file.importAudio")).toBe("Ctrl+Shift+I");
    expect(getEffectiveActionShortcut("insert.quickAddInstrument")).toBe("");
  });
  it("restores decoded audio after Undo during inspection", async () => {
    let resolveProbe!: (value: any) => void;
    const probe = new Promise<any>(resolve => { resolveProbe = resolve; });
    vi.spyOn(nativeBridge, "probeMediaFile").mockReturnValue(probe);
    vi.spyOn(nativeBridge, "addTrack").mockResolvedValue("backend-track");
    vi.spyOn(nativeBridge, "removeTrack").mockResolvedValue(true);
    vi.spyOn(nativeBridge, "removePlaybackClipById").mockResolvedValue(true);
    const playback = vi.spyOn(nativeBridge, "addPlaybackClip").mockResolvedValue(true);
    const importing = useDAWStore.getState().importExternalMediaAtTimeline({ filePath: "C:/take.wav", startTime: 7 });
    useDAWStore.getState().undo();
    resolveProbe({ filePath: "C:/take.wav", duration: 3, sampleRate: 96000, numChannels: 1 });
    await importing;
    expect(useDAWStore.getState().tracks).toHaveLength(0);
    expect(playback).not.toHaveBeenCalled();
    useDAWStore.getState().redo();
    await vi.waitFor(() => expect(playback).toHaveBeenCalledOnce());
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ duration: 3, sampleRate: 96000, startTime: 7, importStatus: "ready" });
  });

});
