import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { getRegisteredAction, getRegisteredActions } from "../store/actionRegistry";
import { commandManager } from "../store/commands";
import {
  createDefaultTrack,
  type AudioClip,
  type MIDIClip,
  type MIDIEvent,
  type MidiEditorSession,
  type Track,
  useDAWStore,
} from "../store/useDAWStore";
import {
  applyDetachedMidiQuantizeRequest,
  applyDetachedLoopRegionRequest,
  executeDetachedMainActionRequest,
  getDetachedActionOwnership,
  isLiveDetachedMidiSessionId,
  isDetachedMainActionId,
  parseDetachedMainActionRequest,
  setDetachedMainActionAvailability,
} from "../utils/detachedMainActionRouting";
import { noteIdFor } from "../utils/midiNotes";
import { dispatchGlobalShortcut, getEffectiveActionShortcuts } from "../utils/globalShortcutDispatcher";
import { activateShortcutContext, resetShortcutContextForTests } from "../utils/shortcutContext";
import { KEYBOARD_SHORTCUT_PROFILES } from "../utils/shortcutProfiles";
import {
  applyRemoteMixerUISnapshot,
  cancelPendingMixerRemoteEdit,
  extractMixerUISnapshot,
  flushPendingMixerRemoteEdit,
} from "../utils/mixerWindowSync";
import {
  applyMidiEditorUISnapshot,
  cancelPendingMidiRemoteEdits,
  extractMidiEditorUISnapshot,
  flushPendingMidiRemoteEdits,
  parseMidiEditorUISnapshot,
} from "../utils/midiEditorWindowSync";

const originalState = useDAWStore.getState();

function audioClip(id: string): AudioClip {
  return {
    id,
    filePath: `C:/audio/${id}.wav`,
    name: id,
    startTime: 0,
    duration: 2,
    offset: 0,
    color: "#123456",
    volumeDB: 0,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function noteEvents(velocity: number): MIDIEvent[] {
  return [
    { type: "noteOn", timestamp: 0.25, note: 60, velocity, channel: 1 },
    { type: "noteOff", timestamp: 0.75, note: 60, velocity: 0, channel: 1 },
  ];
}

function midiClip(id: string, velocity = 60): MIDIClip {
  return {
    id,
    name: id,
    startTime: 10,
    duration: 4,
    sourceLength: 4,
    loopLength: 4,
    events: noteEvents(velocity),
    ccEvents: [],
    color: "#654321",
  };
}

function windowedMidiSession(
  trackId: string,
  clipId: string,
  sessionId = "midi-window-session",
): MidiEditorSession {
  return {
    sessionId,
    trackId,
    clipId,
    mode: "windowed",
    selectedNoteIds: [],
    midiEditRange: null,
    editCursorTime: null,
    activeTool: "select",
    visibleLanes: [],
    activeLaneId: "velocity",
    scrollY: 0,
    windowPixelsPerSecond: 100,
    windowScrollX: 0,
    openedAt: 1,
    updatedAt: 1,
  };
}

function resetProject(): void {
  cancelPendingMixerRemoteEdit();
  cancelPendingMidiRemoteEdits();
  commandManager.clear();
  resetShortcutContextForTests();
  useDAWStore.setState({
    tracks: [],
    trackGroups: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    lastSelectedTrackId: null,
    selectedClipId: null,
    selectedClipIds: [],
    selectedNoteIds: [],
    midiEditorSessions: [],
    activeMidiEditorSessionId: null,
    dockedMidiEditorSessionId: null,
    pianoRollTrackId: null,
    pianoRollClipId: null,
    showPianoRoll: false,
    globalLocked: false,
    lockSettings: { items: false, envelopes: false, timeSelection: false, markers: false },
    timeSelection: null,
    canUndo: false,
    canRedo: false,
    isModified: false,
  });
}

function currentMidiClip(trackId: string, clipId: string): MIDIClip {
  return useDAWStore.getState().tracks
    .find((track) => track.id === trackId)!
    .midiClips.find((clip) => clip.id === clipId)!;
}

beforeEach(resetProject);

afterEach(() => {
  vi.restoreAllMocks();
  cancelPendingMixerRemoteEdit();
  cancelPendingMidiRemoteEdits();
  commandManager.clear();
  useDAWStore.setState(originalState);
});

describe("authoritative detached-window project routing", () => {
  it("classifies every catalog action and every macOS/Windows profile binding for detached ownership", () => {
    const actions = getRegisteredActions();
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      useDAWStore.setState({
        keyboardShortcutProfileId: profile.id,
        activeCustomKeyboardProfileId: null,
        customShortcuts: {},
      });
      for (const action of actions) {
        const ownership = getDetachedActionOwnership(action.id);
        expect(ownership, `${profile.id}:${action.id}`).not.toBeNull();
        expect(
          isDetachedMainActionId(action.id),
          `${profile.id}:${action.id}`,
        ).toBe(ownership !== "local-editor");
        for (const platform of ["macos", "windows"] as const) {
          for (const binding of getEffectiveActionShortcuts(action, platform)) {
            expect(ownership, `${profile.id}:${platform}:${binding}:${action.id}`).not.toBeNull();
          }
        }
      }
    }
  });

  it.each([
    ["mixer", { kind: "mixer" } as const],
    ["midi", { kind: "piano_roll", sessionId: "detached-midi" } as const],
    ["plugin", { kind: "plugin", sessionId: "detached-plugin" } as const],
  ])("forwards a project transport binding from the detached %s realm without local mutation", (
    role,
    context,
  ) => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      activeCustomKeyboardProfileId: null,
      customShortcuts: {},
      transport: { ...useDAWStore.getState().transport, currentTime: 5 },
    });
    setDetachedMainActionAvailability(["transport.rewind"]);
    activateShortcutContext(context);
    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    const preventDefault = vi.fn();

    expect(dispatchGlobalShortcut({
      key: "Home",
      code: "Home",
      source: "browser",
      preventDefault,
    }, "windows", { role })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      command: "action.execute",
      actionId: "transport.rewind",
    }));
    expect(useDAWStore.getState().transport.currentTime).toBe(5);
  });

  it("rejects arbitrary action payloads and filters track selection in the main realm", () => {
    expect(parseDetachedMainActionRequest({
      command: "action.execute",
      actionId: "internal.runAnything",
      selectedTrackIds: [],
    })).toBeNull();
    expect(parseDetachedMainActionRequest({
      command: "action.execute",
      actionId: "track.toggleSelectedMute",
      selectedTrackIds: "track-a",
    })).toBeNull();

    const track = createDefaultTrack("track-a", "A", "#111", "audio", []);
    useDAWStore.setState({ tracks: [track] });
    const execute = vi.fn();
    expect(executeDetachedMainActionRequest({
      command: "action.execute",
      actionId: "track.toggleSelectedMute",
      selectedTrackIds: ["missing", "track-a", "track-a"],
    }, () => ({
      canHandleShortcut: () => useDAWStore.getState().selectedTrackIds.length > 0,
      execute,
    }))).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["track-a"]);
  });

  it("runs a mixer structural shortcut in main against the complete source track", async () => {
    const source = createDefaultTrack("source", "Source", "#111", "audio", []);
    source.clips = [audioClip("full-audio")];
    useDAWStore.setState({
      tracks: [source],
      selectedTrackId: null,
      selectedTrackIds: [],
      lastSelectedTrackId: null,
    });
    const duplicateSelectedTracks = vi.fn(async () => {
      const state = useDAWStore.getState();
      const selected = state.tracks.find((track) => track.id === state.selectedTrackIds[0])!;
      expect(selected.clips.map((clip) => clip.id)).toEqual(["full-audio"]);
      const duplicate: Track = {
        ...structuredClone(selected),
        id: "source-copy",
        clips: selected.clips.map((clip) => ({ ...clip, id: `${clip.id}-copy` })),
      };
      useDAWStore.setState({ tracks: [selected, duplicate] });
      return [duplicate.id];
    });
    useDAWStore.setState({ duplicateSelectedTracks });

    expect(executeDetachedMainActionRequest({
      command: "action.execute",
      actionId: "track.duplicateSelected",
      selectedTrackIds: ["source"],
    }, getRegisteredAction)).toBe(true);
    await Promise.resolve();

    expect(duplicateSelectedTracks).toHaveBeenCalledOnce();
    expect(useDAWStore.getState().tracks[1].clips[0].id).toBe("full-audio-copy");
  });

  it("preserves clip content and coalesces a detached mixer fader burst into one undo", () => {
    const track = createDefaultTrack("track-a", "A", "#111", "audio", []);
    track.clips = [audioClip("audio-a")];
    useDAWStore.setState({ tracks: [track] });
    const first = structuredClone(extractMixerUISnapshot());
    first.tracks[0].volumeDB = -3;
    first.tracks[0].volume = 0.7;
    applyRemoteMixerUISnapshot(first);
    const second = structuredClone(first);
    second.tracks[0].volumeDB = -9;
    second.tracks[0].volume = 0.35;
    applyRemoteMixerUISnapshot(second);

    expect(flushPendingMixerRemoteEdit()).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ volumeDB: -9, volume: 0.35 });
    expect(useDAWStore.getState().tracks[0].clips.map((clip) => clip.id)).toEqual(["audio-a"]);

    // A main-window clip mutation after the mixer packet is outside the
    // detached mixer's ownership and must survive mixer undo/redo.
    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((candidate) => candidate.id === track.id
        ? { ...candidate, clips: candidate.clips.map((clip) => ({ ...clip, name: "main-edit" })) }
        : candidate),
    }));

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ volumeDB: 0, volume: 0.8 });
    expect(useDAWStore.getState().tracks[0].clips[0]).toMatchObject({ id: "audio-a", name: "main-edit" });
    useDAWStore.getState().redo();
    expect(useDAWStore.getState().tracks[0]).toMatchObject({ volumeDB: -9, volume: 0.35 });
    expect(useDAWStore.getState().tracks[0].clips[0].name).toBe("main-edit");
  });

  it("splits rapid detached mixer edits when the target or parameter changes", () => {
    const firstTrack = createDefaultTrack("track-a", "A", "#111", "audio", []);
    const secondTrack = createDefaultTrack("track-b", "B", "#222", "audio", []);
    useDAWStore.setState({ tracks: [firstTrack, secondTrack] });
    const panPacket = structuredClone(extractMixerUISnapshot());
    panPacket.tracks[0].pan = 0.4;
    applyRemoteMixerUISnapshot(panPacket);
    const volumePacket = structuredClone(panPacket);
    volumePacket.tracks[1].volumeDB = -6;
    volumePacket.tracks[1].volume = 0.5;
    applyRemoteMixerUISnapshot(volumePacket);

    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(flushPendingMixerRemoteEdit()).toBe(true);
    expect(commandManager.getUndoStack()).toHaveLength(2);

    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].pan).toBe(0.4);
    expect(useDAWStore.getState().tracks[1]).toMatchObject({ volumeDB: 0, volume: 0.8 });
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].pan).toBe(0);
  });

  it("does not create mixer history when a detached gesture returns to its start", () => {
    const track = createDefaultTrack("track-a", "A", "#111", "audio", []);
    useDAWStore.setState({ tracks: [track] });
    const changed = structuredClone(extractMixerUISnapshot());
    changed.tracks[0].pan = 0.5;
    applyRemoteMixerUISnapshot(changed);
    const restored = structuredClone(changed);
    restored.tracks[0].pan = 0;
    applyRemoteMixerUISnapshot(restored);

    expect(flushPendingMixerRemoteEdit()).toBe(false);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(useDAWStore.getState().tracks[0].pan).toBe(0);
  });

  it("uses boundary-only mixer packets to commit two quick gestures on the same target", () => {
    const track = createDefaultTrack("track-a", "A", "#111", "audio", []);
    useDAWStore.setState({ tracks: [track] });

    const firstPreview = structuredClone(extractMixerUISnapshot());
    firstPreview.editBoundaryToken = "remote-mixer:0";
    firstPreview.tracks[0].pan = 0.25;
    applyRemoteMixerUISnapshot(firstPreview);
    const firstCommit = structuredClone(firstPreview);
    firstCommit.editBoundaryToken = "remote-mixer:1";
    applyRemoteMixerUISnapshot(firstCommit);

    const secondPreview = structuredClone(firstCommit);
    secondPreview.tracks[0].pan = 0.75;
    applyRemoteMixerUISnapshot(secondPreview);
    const secondCommit = structuredClone(secondPreview);
    secondCommit.editBoundaryToken = "remote-mixer:2";
    applyRemoteMixerUISnapshot(secondCommit);

    expect(commandManager.getUndoStack()).toHaveLength(2);
    expect(flushPendingMixerRemoteEdit()).toBe(false);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].pan).toBe(0.25);
    useDAWStore.getState().undo();
    expect(useDAWStore.getState().tracks[0].pan).toBe(0);
  });

  it("coalesces multiple MIDI preview packets and supports authoritative undo/redo", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip", 60)];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      pianoRollTrackId: track.id,
      pianoRollClipId: "midi-clip",
      selectedTrackIds: ["unrelated-main-selection"],
      selectedClipIds: ["unrelated-main-clip"],
    });
    const first = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    first.tracks[0].midiClips[0].events = noteEvents(72);
    first.selectedTrackIds = [track.id];
    first.selectedClipIds = ["midi-clip"];
    applyMidiEditorUISnapshot(first);
    const second = structuredClone(first);
    second.tracks[0].midiClips[0].events = noteEvents(88);
    applyMidiEditorUISnapshot(second);

    expect(flushPendingMidiRemoteEdits()).toBe(1);
    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(currentMidiClip(track.id, "midi-clip").events[0].velocity).toBe(88);
    expect(useDAWStore.getState().selectedTrackIds).toEqual(["unrelated-main-selection"]);
    expect(useDAWStore.getState().selectedClipIds).toEqual(["unrelated-main-clip"]);

    useDAWStore.getState().undo();
    expect(currentMidiClip(track.id, "midi-clip").events[0].velocity).toBe(60);
    useDAWStore.getState().redo();
    expect(currentMidiClip(track.id, "midi-clip").events[0].velocity).toBe(88);
  });

  it("does not create MIDI history when a multi-packet gesture is cancelled", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip", 60)];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      pianoRollTrackId: track.id,
      pianoRollClipId: "midi-clip",
    });
    const changed = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    changed.tracks[0].midiClips[0].events = noteEvents(91);
    applyMidiEditorUISnapshot(changed);
    const restored = structuredClone(changed);
    restored.tracks[0].midiClips[0].events = noteEvents(60);
    applyMidiEditorUISnapshot(restored);

    expect(flushPendingMidiRemoteEdits()).toBe(0);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    expect(currentMidiClip(track.id, "midi-clip").events[0].velocity).toBe(60);
  });

  it("splits rapid MIDI edits when their semantic property target changes", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip", 60)];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      pianoRollTrackId: track.id,
      pianoRollClipId: "midi-clip",
    });
    const velocityPacket = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    velocityPacket.tracks[0].midiClips[0].events = noteEvents(75);
    applyMidiEditorUISnapshot(velocityPacket);
    const timingPacket = structuredClone(velocityPacket);
    timingPacket.tracks[0].midiClips[0].events = timingPacket.tracks[0].midiClips[0].events.map(
      (event) => ({ ...event, timestamp: event.timestamp + 0.1 }),
    );
    applyMidiEditorUISnapshot(timingPacket);

    expect(commandManager.getUndoStack()).toHaveLength(1);
    expect(flushPendingMidiRemoteEdits()).toBe(1);
    expect(commandManager.getUndoStack()).toHaveLength(2);

    useDAWStore.getState().undo();
    expect(currentMidiClip(track.id, "midi-clip").events[0]).toMatchObject({
      timestamp: 0.25,
      velocity: 75,
    });
    useDAWStore.getState().undo();
    expect(currentMidiClip(track.id, "midi-clip").events[0]).toMatchObject({
      timestamp: 0.25,
      velocity: 60,
    });
  });

  it("uses boundary-only MIDI packets to commit two quick edits on the same property", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip", 60)];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      pianoRollTrackId: track.id,
      pianoRollClipId: "midi-clip",
    });

    const firstPreview = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    firstPreview.editBoundaryToken = "remote-midi:0";
    firstPreview.tracks[0].midiClips[0].events = noteEvents(70);
    applyMidiEditorUISnapshot(firstPreview);
    const firstCommit = structuredClone(firstPreview);
    firstCommit.editBoundaryToken = "remote-midi:1";
    applyMidiEditorUISnapshot(firstCommit);

    const secondPreview = structuredClone(firstCommit);
    secondPreview.tracks[0].midiClips[0].events = noteEvents(90);
    applyMidiEditorUISnapshot(secondPreview);
    const secondCommit = structuredClone(secondPreview);
    secondCommit.editBoundaryToken = "remote-midi:2";
    applyMidiEditorUISnapshot(secondCommit);

    expect(commandManager.getUndoStack()).toHaveLength(2);
    expect(flushPendingMidiRemoteEdits()).toBe(0);
    useDAWStore.getState().undo();
    expect(currentMidiClip(track.id, "midi-clip").events[0].velocity).toBe(70);
    useDAWStore.getState().undo();
    expect(currentMidiClip(track.id, "midi-clip").events[0].velocity).toBe(60);
  });

  it("accepts only MIDI event content and preserves main-owned clip structure", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [{
      ...midiClip("midi-clip", 60),
      name: "Authoritative name",
      startTime: 10,
      duration: 4,
      sourceLength: 4,
      color: "#112233",
      groupId: "main-group",
      muted: false,
      locked: false,
    }];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
    });

    const packet = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    Object.assign(packet.tracks[0].midiClips[0], {
      name: "Stale detached name",
      startTime: 99,
      duration: 99,
      sourceLength: 99,
      color: "#ffffff",
      groupId: "detached-group",
      muted: true,
      locked: true,
      events: noteEvents(96),
      ccEvents: [{ cc: 1, time: 0.5, value: 100 }],
      quantizeBackup: { events: noteEvents(60), ccEvents: [] },
    });

    expect(applyMidiEditorUISnapshot(packet)).toBe(true);
    expect(currentMidiClip(track.id, "midi-clip")).toMatchObject({
      id: "midi-clip",
      name: "Authoritative name",
      startTime: 10,
      duration: 4,
      sourceLength: 4,
      color: "#112233",
      groupId: "main-group",
      muted: false,
      locked: false,
      events: noteEvents(96),
      ccEvents: [{ cc: 1, time: 0.5, value: 100 }],
    });
    expect(currentMidiClip(track.id, "midi-clip").quantizeBackup?.events).toEqual(noteEvents(60));
  });

  it("preserves a concurrent main structural edit on the same MIDI clip through detached undo/redo", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip", 60)];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({ tracks: [track], midiEditorSessions: [session] });
    const packet = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    packet.tracks[0].midiClips[0].events = noteEvents(91);
    expect(applyMidiEditorUISnapshot(packet)).toBe(true);
    expect(flushPendingMidiRemoteEdits()).toBe(1);

    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((candidate) => candidate.id === track.id
        ? {
          ...candidate,
          midiClips: candidate.midiClips.map((clip) => clip.id === "midi-clip"
            ? { ...clip, name: "Main rename", startTime: 24, duration: 8, locked: true }
            : clip),
        }
        : candidate),
    }));
    useDAWStore.getState().undo();
    expect(currentMidiClip(track.id, "midi-clip")).toMatchObject({
      name: "Main rename",
      startTime: 24,
      duration: 8,
      locked: true,
      events: noteEvents(60),
    });
    useDAWStore.getState().redo();
    expect(currentMidiClip(track.id, "midi-clip")).toMatchObject({
      name: "Main rename",
      startTime: 24,
      duration: 8,
      locked: true,
      events: noteEvents(91),
    });
  });

  it.each([
    ["global lock", { globalLocked: true }],
    ["item lock", { lockSettings: { items: true, envelopes: false, timeSelection: false, markers: false } }],
    ["frozen track", { frozen: true }],
    ["clip lock", { clipLocked: true }],
  ])("rejects detached MIDI content under %s without history", (_label, condition) => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.frozen = "frozen" in condition ? Boolean(condition.frozen) : false;
    track.midiClips = [{
      ...midiClip("midi-clip", 60),
      locked: "clipLocked" in condition ? Boolean(condition.clipLocked) : false,
    }];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
      ...("globalLocked" in condition ? { globalLocked: condition.globalLocked } : {}),
      ...("lockSettings" in condition ? { lockSettings: condition.lockSettings } : {}),
    });
    const packet = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    packet.tracks[0].midiClips[0].events = noteEvents(99);

    expect(applyMidiEditorUISnapshot(packet)).toBe(false);
    expect(currentMidiClip(track.id, "midi-clip").events).toEqual(noteEvents(60));
    expect(flushPendingMidiRemoteEdits()).toBe(0);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("cancels and restores an uncommitted MIDI preview when a lock engages mid-gesture", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [{ ...midiClip("midi-clip", 60), locked: false }];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
    });
    const preview = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    preview.editBoundaryToken = "remote-midi:preview";
    preview.tracks[0].midiClips[0].events = noteEvents(78);
    expect(applyMidiEditorUISnapshot(preview)).toBe(true);
    expect(currentMidiClip(track.id, "midi-clip").events).toEqual(noteEvents(78));

    useDAWStore.setState((state) => ({
      tracks: state.tracks.map((candidate) => candidate.id === track.id
        ? {
          ...candidate,
          midiClips: candidate.midiClips.map((clip) => clip.id === "midi-clip"
            ? { ...clip, locked: true }
            : clip),
        }
        : candidate),
    }));
    const latePacket = structuredClone(preview);
    latePacket.tracks[0].midiClips[0].events = noteEvents(101);
    expect(applyMidiEditorUISnapshot(latePacket)).toBe(false);

    expect(currentMidiClip(track.id, "midi-clip")).toMatchObject({
      locked: true,
      events: noteEvents(60),
    });
    expect(flushPendingMidiRemoteEdits()).toBe(0);
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("revalidates MIDI editability at idle commit even without another detached packet", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip", 60)];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({
      tracks: [track],
      midiEditorSessions: [session],
      activeMidiEditorSessionId: session.sessionId,
    });
    const preview = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    preview.tracks[0].midiClips[0].events = noteEvents(84);
    expect(applyMidiEditorUISnapshot(preview)).toBe(true);
    expect(currentMidiClip(track.id, "midi-clip").events).toEqual(noteEvents(84));

    useDAWStore.setState({ globalLocked: true });
    expect(flushPendingMidiRemoteEdits()).toBe(0);
    expect(currentMidiClip(track.id, "midi-clip").events).toEqual(noteEvents(60));
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("rejects stale or mismatched detached MIDI sessions", () => {
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip", 60)];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({ tracks: [track], midiEditorSessions: [session] });
    const base = structuredClone(extractMidiEditorUISnapshot(useDAWStore.getState(), session.sessionId)!);
    base.tracks[0].midiClips[0].events = noteEvents(90);

    expect(applyMidiEditorUISnapshot({ ...base, sessionId: "stale-session" })).toBe(false);
    expect(applyMidiEditorUISnapshot({ ...base, mode: "docked" })).toBe(false);
    expect(applyMidiEditorUISnapshot({
      ...base,
      trackId: "wrong-track",
      tracks: [{ ...base.tracks[0], id: "wrong-track" }],
    })).toBe(false);
    expect(currentMidiClip(track.id, "midi-clip").events).toEqual(noteEvents(60));
    expect(commandManager.getUndoStack()).toHaveLength(0);
  });

  it("quantizes only the validated selection owned by the sending MIDI session", () => {
    const firstTrack = createDefaultTrack("midi-a", "MIDI A", "#111", "midi", []);
    const secondTrack = createDefaultTrack("midi-b", "MIDI B", "#222", "midi", []);
    firstTrack.midiClips = [midiClip("clip-a")];
    secondTrack.midiClips = [midiClip("clip-b")];
    const firstSession = windowedMidiSession(firstTrack.id, "clip-a", "session-a");
    const secondSession = windowedMidiSession(secondTrack.id, "clip-b", "session-b");
    const originalMainSelection = [noteIdFor("clip-b", 0.25, 60)];
    const quantize = vi.fn((trackId?: string, clipId?: string) => {
      expect(trackId).toBe("midi-a");
      expect(clipId).toBe("clip-a");
      expect(useDAWStore.getState().selectedNoteIds).toEqual([
        noteIdFor("clip-a", 0.25, 60),
      ]);
      return [noteIdFor("clip-a", 0, 60)];
    });
    useDAWStore.setState({
      tracks: [firstTrack, secondTrack],
      midiEditorSessions: [firstSession, secondSession],
      activeMidiEditorSessionId: secondSession.sessionId,
      pianoRollTrackId: secondTrack.id,
      pianoRollClipId: "clip-b",
      selectedNoteIds: originalMainSelection,
      quantizeSelectedMIDINotesUsingLast: quantize,
    });

    expect(applyDetachedMidiQuantizeRequest({
      command: "midi.quantize",
      sessionId: firstSession.sessionId,
      selectedNoteIds: [noteIdFor("clip-a", 0.25, 60)],
      midiEditRange: null,
    }, "main")).toBe(true);
    expect(quantize).toHaveBeenCalledOnce();
    expect(useDAWStore.getState().selectedNoteIds).toEqual(originalMainSelection);
    expect(useDAWStore.getState().midiEditorSessions.find((entry) => entry.sessionId === "session-a")?.selectedNoteIds)
      .toEqual([noteIdFor("clip-a", 0, 60)]);

    expect(applyDetachedMidiQuantizeRequest({
      command: "midi.quantize",
      sessionId: secondSession.sessionId,
      selectedNoteIds: [noteIdFor("clip-a", 0.25, 60)],
      midiEditRange: null,
    }, "main")).toBe(false);
    expect(applyDetachedMidiQuantizeRequest({
      command: "midi.quantize",
      sessionId: "stale-session",
      selectedNoteIds: [],
      midiEditRange: null,
    }, "main")).toBe(false);
    expect(isLiveDetachedMidiSessionId("stale-session", "main")).toBe(false);
  });

  it("validates MIDI payloads and applies loop-from-selection only to its live windowed clip", () => {
    expect(parseMidiEditorUISnapshot({ sessionId: "bad", tracks: [] })).toBeNull();
    const track = createDefaultTrack("midi-track", "MIDI", "#222", "midi", []);
    track.midiClips = [midiClip("midi-clip")];
    const session = windowedMidiSession(track.id, "midi-clip");
    useDAWStore.setState({ tracks: [track], midiEditorSessions: [session] });

    expect(applyDetachedLoopRegionRequest({
      command: "transport.setLoopRegion",
      sessionId: session.sessionId,
      start: 10.25,
      end: 10.75,
    })).toBe(true);
    expect(useDAWStore.getState().transport).toMatchObject({
      loopStart: 10.25,
      loopEnd: 10.75,
    });
    expect(applyDetachedLoopRegionRequest({
      command: "transport.setLoopRegion",
      sessionId: "other-session",
      start: 10.25,
      end: 10.75,
    })).toBe(false);
    expect(applyDetachedLoopRegionRequest({
      command: "transport.setLoopRegion",
      sessionId: session.sessionId,
      start: 9,
      end: 15,
    })).toBe(false);
  });

  it("flushes a live detached gesture before executing main undo", () => {
    const track = createDefaultTrack("track-a", "A", "#111", "audio", []);
    useDAWStore.setState({ tracks: [track] });
    const changed = structuredClone(extractMixerUISnapshot());
    changed.tracks[0].pan = -0.75;
    applyRemoteMixerUISnapshot(changed);
    expect(commandManager.getUndoStack()).toHaveLength(0);

    expect(executeDetachedMainActionRequest({
      command: "action.execute",
      actionId: "edit.undo",
      selectedTrackIds: [],
    }, getRegisteredAction, {
      flushPendingEdits: () => { flushPendingMixerRemoteEdit(); },
    })).toBe(true);
    expect(useDAWStore.getState().tracks[0].pan).toBe(0);
    expect(commandManager.getRedoStack()).toHaveLength(1);
  });

  it("routes detached Ctrl+Z while both replica and advertised undo availability are stale", () => {
    const track = createDefaultTrack("track-a", "A", "#111", "audio", []);
    useDAWStore.setState({ tracks: [track], canUndo: false, canRedo: false });
    const changed = structuredClone(extractMixerUISnapshot());
    changed.editBoundaryToken = "remote-mixer:live-preview";
    changed.tracks[0].pan = -0.6;
    applyRemoteMixerUISnapshot(changed);
    expect(commandManager.getUndoStack()).toHaveLength(0);
    setDetachedMainActionAvailability([]);
    activateShortcutContext({ kind: "mixer" });

    const publish = vi.spyOn(nativeBridge, "publishAppCommand").mockResolvedValue(true);
    const preventDefault = vi.fn();
    expect(dispatchGlobalShortcut({
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
      source: "browser",
      preventDefault,
    }, "windows", {
      role: "mixer",
      canHandleAction: () => false,
    })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    const request = publish.mock.calls[0][0];
    expect(request).toMatchObject({ command: "action.execute", actionId: "edit.undo" });

    expect(executeDetachedMainActionRequest(request, getRegisteredAction, {
      role: "main",
      flushPendingEdits: () => { flushPendingMixerRemoteEdit(); },
    })).toBe(true);
    expect(useDAWStore.getState().tracks[0].pan).toBe(0);
    expect(commandManager.getRedoStack()).toHaveLength(1);
  });
});
