import { afterEach, describe, expect, it, vi } from "vitest";
import { shallow } from "zustand/shallow";
import type { ActionDef } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import {
  executeShortcutActionFromModal,
  getShortcutActionAvailability,
  selectShortcutAvailabilityInputs,
} from "../components/KeyboardShortcutsModal";
import keyboardShortcutsModalSource from "../components/KeyboardShortcutsModal.tsx?raw";

const originalTransport = useDAWStore.getState().transport;
const originalStepInputEnabled = useDAWStore.getState().stepInputEnabled;

function action(overrides: Partial<ActionDef> = {}): ActionDef {
  return {
    id: "test.modal-action",
    name: "Modal action",
    category: "Test",
    execute: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  useDAWStore.setState({
    transport: originalTransport,
    stepInputEnabled: originalStepInputEnabled,
  });
  vi.restoreAllMocks();
});

describe("KeyboardShortcutsModal action availability", () => {
  it("projects every store input used by shortcut availability guards", () => {
    const base = useDAWStore.getState();
    type StoreSnapshot = typeof base;
    const withPatch = (patch: Partial<StoreSnapshot>): StoreSnapshot => ({
      ...base,
      ...patch,
    });
    const alternateEditRange = {
      startTime: 0,
      endTime: 1,
      minNote: 48,
      maxNote: 72,
      includeCC: false,
    };
    const cases: Array<[string, StoreSnapshot]> = [
      ["tracks", withPatch({ tracks: [...base.tracks] })],
      ["trackGroups", withPatch({ trackGroups: [...base.trackGroups] })],
      ["selectedTrackId", withPatch({ selectedTrackId: base.selectedTrackId ? null : "projection-track" })],
      ["selectedTrackIds", withPatch({ selectedTrackIds: [...base.selectedTrackIds] })],
      ["selectedClipId", withPatch({ selectedClipId: base.selectedClipId ? null : "projection-clip" })],
      ["selectedClipIds", withPatch({ selectedClipIds: [...base.selectedClipIds] })],
      ["selectedNoteIds", withPatch({ selectedNoteIds: [...base.selectedNoteIds] })],
      ["selectedRegionIds", withPatch({ selectedRegionIds: [...base.selectedRegionIds] })],
      ["selectedAutomationTarget", withPatch({
        selectedAutomationTarget: base.selectedAutomationTarget
          ? null
          : { kind: "master", laneId: "projection-lane", pointId: null },
      })],
      ["razorEdits", withPatch({ razorEdits: [...base.razorEdits] })],
      ["midiEditRange", withPatch({
        midiEditRange: base.midiEditRange ? null : alternateEditRange,
      })],
      ["pianoRollEditCursorTime", withPatch({
        pianoRollEditCursorTime: base.pianoRollEditCursorTime === null
          ? 1
          : base.pianoRollEditCursorTime + 1,
      })],
      ["midiEditorSessions", withPatch({ midiEditorSessions: [...base.midiEditorSessions] })],
      ["timeSelection", withPatch({
        timeSelection: base.timeSelection ? null : { start: 0, end: 1 },
      })],
      ["clipboard", withPatch({ clipboard: { ...base.clipboard } })],
      ["markers", withPatch({ markers: [...base.markers] })],
      ["regions", withPatch({ regions: [...base.regions] })],
      ["transport.currentTime", withPatch({
        transport: { ...base.transport, currentTime: base.transport.currentTime + 1 },
      })],
      ["transport.tempo", withPatch({
        transport: { ...base.transport, tempo: base.transport.tempo + 1 },
      })],
      ["transport.isPlaying", withPatch({
        transport: { ...base.transport, isPlaying: !base.transport.isPlaying },
      })],
      ["transport.isRecording", withPatch({
        transport: { ...base.transport, isRecording: !base.transport.isRecording },
      })],
      ["recordSession", withPatch({
        recordSession: base.recordSession
          ? null
          : { id: "projection-session", startTime: 0, trackIds: [] },
      })],
      ["recordingClips", withPatch({ recordingClips: [...base.recordingClips] })],
      ["stepInputEnabled", withPatch({ stepInputEnabled: !base.stepInputEnabled })],
      ["canUndo", withPatch({ canUndo: !base.canUndo })],
      ["canRedo", withPatch({ canRedo: !base.canRedo })],
      ["globalLocked", withPatch({ globalLocked: !base.globalLocked })],
      ["lockSettings", withPatch({ lockSettings: { ...base.lockSettings } })],
      ["timeSignature", withPatch({ timeSignature: { ...base.timeSignature } })],
      ["gridSize", withPatch({ gridSize: base.gridSize === "1/4" ? "1/8" : "1/4" })],
      ["pixelsPerSecond", withPatch({ pixelsPerSecond: base.pixelsPerSecond + 1 })],
      ["quantizePresets", withPatch({ quantizePresets: [...base.quantizePresets] })],
      ["quantizePresetId", withPatch({ quantizePresetId: `${base.quantizePresetId}-projection` })],
      ["masterAutomationLanes", withPatch({ masterAutomationLanes: [...base.masterAutomationLanes] })],
      ["masterAutomationReadEnabled", withPatch({
        masterAutomationReadEnabled: !base.masterAutomationReadEnabled,
      })],
      ["masterAutomationWriteEnabled", withPatch({
        masterAutomationWriteEnabled: !base.masterAutomationWriteEnabled,
      })],
      ["suspendedMasterAutomationState", withPatch({
        suspendedMasterAutomationState: base.suspendedMasterAutomationState
          ? null
          : { showAutomation: false, lanes: {} },
      })],
      ["mixerSnapshots", withPatch({ mixerSnapshots: [...base.mixerSnapshots] })],
      ["detachedPanels", withPatch({ detachedPanels: [...base.detachedPanels] })],
      ["recentProjects", withPatch({ recentProjects: [...base.recentProjects] })],
      ["projectTemplates", withPatch({ projectTemplates: [...base.projectTemplates] })],
      ["customToolbars", withPatch({ customToolbars: [...base.customToolbars] })],
      ["trackTemplates", withPatch({ trackTemplates: [...base.trackTemplates] })],
      ["activeMidiEditorSessionId", withPatch({
        activeMidiEditorSessionId: base.activeMidiEditorSessionId ? null : "projection-editor",
      })],
      ["pianoRollTrackId", withPatch({ pianoRollTrackId: base.pianoRollTrackId ? null : "projection-track" })],
      ["pianoRollClipId", withPatch({ pianoRollClipId: base.pianoRollClipId ? null : "projection-clip" })],
      ["showPianoRoll", withPatch({ showPianoRoll: !base.showPianoRoll })],
      ["showPitchEditor", withPatch({ showPitchEditor: !base.showPitchEditor })],
      ["pitchEditorTrackId", withPatch({ pitchEditorTrackId: base.pitchEditorTrackId ? null : "projection-track" })],
      ["pitchEditorClipId", withPatch({ pitchEditorClipId: base.pitchEditorClipId ? null : "projection-clip" })],
      ["trackHeight", withPatch({ trackHeight: base.trackHeight + 1 })],
      ["tcpWidth", withPatch({ tcpWidth: base.tcpWidth + 1 })],
    ];

    const baseline = selectShortcutAvailabilityInputs(base);
    for (const [dependency, state] of cases) {
      expect(
        shallow(baseline, selectShortcutAvailabilityInputs(state)),
        `${dependency} must invalidate the availability projection`,
      ).toBe(false);
    }
  });

  it("exposes the unavailable state and reason to assistive technology", () => {
    expect(keyboardShortcutsModalSource).toContain("aria-disabled={!availability.available || undefined}");
    expect(keyboardShortcutsModalSource).toContain("aria-describedby={!availability.available ? unavailableReasonId : undefined}");
    expect(keyboardShortcutsModalSource).toMatch(/role="status"\s+aria-live="polite"/);
    expect(keyboardShortcutsModalSource).toContain("{availability.reason}");

    const actionButtonStart = keyboardShortcutsModalSource.indexOf("aria-describedby={!availability.available ? unavailableReasonId : undefined}");
    const actionButtonEnd = keyboardShortcutsModalSource.indexOf("</button>", actionButtonStart);
    const reasonNode = keyboardShortcutsModalSource.indexOf("id={unavailableReasonId}", actionButtonStart);
    expect(actionButtonStart).toBeGreaterThan(-1);
    expect(actionButtonEnd).toBeGreaterThan(actionButtonStart);
    expect(reasonNode).toBeGreaterThan(actionButtonEnd);
  });

  it("does not execute or close for a failed canHandleShortcut guard", () => {
    const execute = vi.fn();
    const onClose = vi.fn();
    const result = executeShortcutActionFromModal(action({
      execute,
      canHandleShortcut: () => false,
    }), onClose);

    expect(result).toEqual({
      available: false,
      reason: "Unavailable in the current context",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not execute or close when shortcutWhen is inactive", () => {
    useDAWStore.setState((state) => ({
      transport: { ...state.transport, isPlaying: false, isRecording: false },
    }));
    const execute = vi.fn();
    const onClose = vi.fn();
    const guarded = action({ execute, shortcutWhen: "transport_running" });

    expect(getShortcutActionAvailability(guarded)).toEqual({
      available: false,
      reason: "Available while transport is running",
    });
    expect(executeShortcutActionFromModal(guarded, onClose).available).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("executes and closes only when condition and contextual guard both pass", () => {
    useDAWStore.setState((state) => ({
      transport: { ...state.transport, isPlaying: true, isRecording: false },
    }));
    const execute = vi.fn();
    const onClose = vi.fn();

    expect(executeShortcutActionFromModal(action({
      execute,
      shortcutWhen: "transport_running",
      canHandleShortcut: () => true,
    }), onClose)).toEqual({ available: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
