import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeActiveScopedAction,
  getActionShortcutConflicts,
  getActionShortcutScopes,
  getDeferredActions,
  getRegisteredAction,
  getRegisteredActions,
  registerScopedActionExecutor,
  type ActionShortcutScope,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { activateShortcutContext, type EditShortcutContext } from "../utils/shortcutContext";

const expectedExecutableInventory = [
  "file.saveNewVersion",
  "file.openRecent",
  "file.clearRecentProjects",
  "file.loadTemplate",
  "file.deleteTemplate",
  "help.checkForUpdates",
  "help.about",
  "view.renderQueue",
  "view.clipLauncher",
  "view.stepSequencer",
  "view.scriptConsole",
  "view.aiToolsSetup",
  "view.customToolbar",
  "view.bigClockFormat",
  "view.gridType.bar",
  "view.gridType.beat",
  "view.gridType.use-quantize",
  "view.gridType.adapt-to-zoom",
  "options.timecodeSettings",
  "options.toggleItemLock",
  "options.toggleEnvelopeLock",
  "options.toggleTimeSelectionLock",
  "insert.multipleTracks",
  "insert.emptyMidiClip",
  "track.selectAll",
  "track.deselectAll",
  "track.deleteSelected",
  "track.toggleSelectedMute",
  "track.toggleSelectedSolo",
  "track.duplicateSelected",
  "track.toggleSelectedArm",
  "track.linkSelected",
  "track.unlinkSelected",
  "track.setSelectedColor",
  "track.consolidateSelected",
  "track.toggleSelectedFxBypass",
  "track.toggleSelectedMonitor",
  "track.toggleSelectedAutomationRead",
  "track.toggleSelectedAutomationWrite",
  "track.toggleSelectedPhaseInvert",
  "track.moveSelectedToFolder",
  "track.removeSelectedFromFolder",
  "track.toggleSelectedFolders",
  "track.toggleSelectedAutomation",
  "track.toggleSelectedSpectralView",
  "track.toggleSelectedFreeze",
  "track.renderSelectedInPlace",
  "track.saveSelectedAsTemplate",
  "track.loadTemplate",
  "track.openSelectedEnvelopeManager",
  "track.openSelectedRouting",
  "track.openSelectedPluginBrowser",
  "track.openSelectedChannelEQ",
  "clip.openSelectedInPianoRoll",
  "clip.repeatSelected",
  "clip.setSelectedColor",
  "clip.resetSelectedMidiSourceOffset",
  "clip.setSelectedMidiSourceLengthToItem",
  "clip.setSelectedMidiSourceLengthToContent",
  "clip.setSelectedMidiSourceLength",
  "clip.humanizeSelectedMidi",
  "clip.exportSelectedMidi",
  "clip.renderSelectedInPlace",
  "clip.separateSelectedStems",
  "clip.createAIVariation",
  "clip.inpaintSelection",
  "clip.continueSelectedWithAI",
  "midi.toggleStepInput",
  "midi.toggleAudition",
  "midi.detachEditor",
  "midi.dockEditor",
  "midi.invertSelection",
  "midi.selectSamePitch",
  "midi.humanizeSelected",
  "midi.setSelectedVelocity",
  "midi.randomizeSelectedVelocity",
  "midi.setSelectedLength",
  "midi.legatoSelected",
  "midi.reverseSelected",
  "midi.invertSelectedPitches",
  "midi.mirrorSelectedPitches",
  "midi.toggleSelectedMute",
  "midi.cropClipToSelected",
  "midi.insertChord",
  "mixer.recallSnapshot",
  "mixer.deleteSnapshot",
  "mixer.toggleMasterMute",
  "mixer.toggleMasterMono",
  "mixer.detach",
  "mixer.attach",
  "track.openSelectedFxChain",
  "clip.splitAtPointer",
  "midi.loopFromSelectedNotes",
  "midi.noteProperties",
  "midi.configureControllerLanes",
  "midi.toggleGhostReference",
  "pitch.detectKeyScale",
  "pitch.correctAllToScale",
  "pitch.toggleAB",
  "fx.removeSelected",
  "fx.toggleSelectedBypass",
  "fx.openSelectedEditor",
  "fx.add",
] as const;

const expectedDeferredInventory = [] as const;

/**
 * Visible buttons and menu/context-menu commands added by the final surface
 * audit. Keeping the owning surface beside each id proves that a command is
 * not merely in the palette: it can be discovered by the dispatcher while
 * that part of the DAW owns keyboard focus.
 */
const auditedVisibleCommandSurfaces: ReadonlyArray<{
  scope: ActionShortcutScope;
  actionIds: readonly string[];
}> = [
  {
    scope: "global",
    actionIds: [
      "transport.pause",
      "transport.metronome",
      "transport.metronomeSettings",
      "view.cycleTimecodeMode",
      "view.openGridQuantizePanel",
      "edit.applyCurrentQuantize",
      "options.saveQuantizePreset",
      "options.renameQuantizePreset",
      "options.removeQuantizePreset",
      "options.restoreFactoryQuantizePresets",
      "options.themeReaperGray",
    ],
  },
  {
    scope: "timeline",
    actionIds: [
      "clip.quantizeSelectedMidi",
      "clip.humanizeSelectedMidi",
      "clip.transposeSelectedMidiUp",
      "clip.transposeSelectedMidiDown",
      "clip.transposeSelectedMidiOctaveUp",
      "clip.transposeSelectedMidiOctaveDown",
      "clip.setSelectedMidiVelocity",
      "clip.increaseSelectedMidiVelocity",
      "clip.decreaseSelectedMidiVelocity",
    ],
  },
  {
    scope: "track_control_panel",
    actionIds: [
      "automation.showAllSelectedTrackEnvelopes",
      "automation.hideAllSelectedTrackEnvelopes",
      "track.clearSelectedSamplerSample",
      "track.removeSelectedInstrument",
      "track.openSelectedNotes",
      "track.loadSelectedSamplerSample",
    ],
  },
  {
    scope: "mixer",
    actionIds: [
      "mixer.toggleMasterAutomationRead",
      "mixer.toggleMasterAutomationWrite",
      "mixer.toggleMasterAutomationLanes",
      "mixer.openMasterEnvelopeManager",
      "mixer.openMasterFxChain",
      "mixer.addMonitorFx",
    ],
  },
  {
    scope: "piano_roll",
    actionIds: [
      "midi.openQuantizePanel",
      "midi.quantizeLength",
      "midi.controllerLine",
      "midi.controllerSineLfo",
      "midi.controllerTriangleLfo",
      "midi.controllerSquareLfo",
      "midi.controllerSawUpLfo",
      "midi.controllerSawDownLfo",
      "midi.controllerTransform",
      "midi.controllerThin",
      "midi.copyControllerLane",
      "midi.pasteControllerLane",
      "midi.clearControllerLane",
    ],
  },
  { scope: "pitch_editor", actionIds: ["pitch.openCorrectionMacro"] },
  {
    scope: "plugin",
    actionIds: [
      "fx.toggleSelectedAB",
      "fx.reloadSelectedScript",
      "fx.toggleSelectedParameters",
      "fx.toggleSelectedPresets",
      "fx.openInstrumentEditor",
      "fx.removeInstrument",
    ],
  },
  {
    scope: "browser",
    actionIds: [
      "browser.focusSearch",
      "browser.toggleFavorites",
      "browser.openUserEffectsFolder",
      "browser.toggleScanFolders",
      "browser.addScanFolder",
      "browser.scanPlugins",
      "browser.deepScanPlugins",
      "browser.removeCurrentInstrument",
      "browser.mediaNavigateUp",
      "browser.mediaToggleRecent",
      "browser.mediaFocusFilter",
    ],
  },
];

const originalState = {
  tracks: useDAWStore.getState().tracks,
  selectedTrackId: useDAWStore.getState().selectedTrackId,
  selectedTrackIds: useDAWStore.getState().selectedTrackIds,
  trackGroups: useDAWStore.getState().trackGroups,
  toggleRenderQueue: useDAWStore.getState().toggleRenderQueue,
  toggleTrackMute: useDAWStore.getState().toggleTrackMute,
  toggleTrackSolo: useDAWStore.getState().toggleTrackSolo,
  toggleTrackArmed: useDAWStore.getState().toggleTrackArmed,
  toggleTrackFXBypass: useDAWStore.getState().toggleTrackFXBypass,
  toggleSelectedTracksMute: useDAWStore.getState().toggleSelectedTracksMute,
  toggleSelectedTracksSolo: useDAWStore.getState().toggleSelectedTracksSolo,
  toggleSelectedTracksArmed: useDAWStore.getState().toggleSelectedTracksArmed,
  toggleSelectedTracksFXBypass: useDAWStore.getState().toggleSelectedTracksFXBypass,
  unlinkTracksFromGroups: useDAWStore.getState().unlinkTracksFromGroups,
  addTrackGroup: useDAWStore.getState().addTrackGroup,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  activateShortcutContext({ kind: "application" });
  useDAWStore.setState(originalState);
});

describe("action catalog integrity", () => {
  it("has unique stable ids across executable and deferred catalogs", () => {
    const executableIds = getRegisteredActions().map((action) => action.id);
    const deferredIds = getDeferredActions().map((action) => action.id);
    const allIds = [...executableIds, ...deferredIds];

    expect(new Set(executableIds).size).toBe(executableIds.length);
    expect(new Set(deferredIds).size).toBe(deferredIds.length);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("gives every executable action a real implementation, category and explicit scope", () => {
    for (const action of getRegisteredActions()) {
      expect(action.name.trim(), action.id).not.toBe("");
      expect(action.category.trim(), action.id).not.toBe("");
      expect(action.shortcutScope, action.id).toBeTruthy();
      expect(getActionShortcutScopes(action).length, action.id).toBeGreaterThan(0);
      expect(action.execute, action.id).toBeTypeOf("function");
      expect(action.execute.toString().replace(/\s/g, ""), action.id).not.toMatch(/^(\(\))?=>\{\}$/);
    }
  });

  it("contains the audited executable command inventory", () => {
    const ids = new Set(getRegisteredActions().map((action) => action.id));
    for (const actionId of expectedExecutableInventory) {
      expect(ids.has(actionId), actionId).toBe(true);
    }
  });

  it("registers every audited visible command in a dispatcher-reachable surface", () => {
    for (const { scope, actionIds } of auditedVisibleCommandSurfaces) {
      for (const actionId of actionIds) {
        const action = getRegisteredAction(actionId);
        expect(action, actionId).toBeDefined();
        expect(getActionShortcutScopes(action!), actionId).toContain(scope);
      }
    }
  });

  it("keeps unsafe/local commands visible as truthful non-executable metadata", () => {
    const deferred = new Map(getDeferredActions().map((action) => [action.id, action]));
    expect(deferred.size).toBe(expectedDeferredInventory.length);
    for (const actionId of expectedDeferredInventory) {
      const action = deferred.get(actionId);
      expect(action, actionId).toBeDefined();
      expect(action?.reasonDetail.trim(), actionId).not.toBe("");
      expect(getRegisteredAction(actionId), actionId).toBeUndefined();
    }
    expect(getRegisteredAction("track.toggleSelectedArm")).toMatchObject({
      shortcut: "R",
      shortcutScope: "track_control_panel",
    });
    expect(getDeferredActions().filter((action) => action.reason === "requires_undo_support"))
      .toEqual([]);
  });

  it("has no invalid same-scope factory shortcut conflicts", () => {
    expect(getActionShortcutConflicts()).toEqual([]);
  });

  it("declares editor mode conditions for intentional Piano Roll key reuse", () => {
    expect(getRegisteredAction("midi.tool.draw")?.shortcutWhen).toBe("step_input_disabled");
    expect(getRegisteredAction("midi.stepInputD")?.shortcutWhen).toBe("step_input_enabled");
  });

  it("executes selected-track actions against the current multi-selection", () => {
    const toggleRenderQueue = vi.fn();
    const toggleSelectedTracksMute = vi.fn();
    const toggleSelectedTracksSolo = vi.fn();
    useDAWStore.setState({
      selectedTrackId: "track-a",
      selectedTrackIds: ["track-a", "track-b"],
      toggleRenderQueue,
      toggleSelectedTracksMute,
      toggleSelectedTracksSolo,
    });

    getRegisteredAction("view.renderQueue")?.execute();
    getRegisteredAction("track.toggleSelectedMute")?.execute();
    getRegisteredAction("track.toggleSelectedSolo")?.execute();

    expect(toggleRenderQueue).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksMute).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksSolo).toHaveBeenCalledTimes(1);
  });

  it("routes linked selected-track controls through one selection transaction", () => {
    const toggleSelectedTracksMute = vi.fn();
    const toggleSelectedTracksSolo = vi.fn();
    const toggleSelectedTracksArmed = vi.fn();
    const toggleSelectedTracksFXBypass = vi.fn();
    useDAWStore.setState({
      tracks: [
        { id: "track-a", armed: false, recordSafe: false },
        { id: "track-b", armed: false, recordSafe: false },
        { id: "track-c", armed: false, recordSafe: false },
      ] as never,
      selectedTrackId: "track-a",
      selectedTrackIds: ["track-a", "track-b", "track-c"],
      trackGroups: [{
        id: "group-a",
        name: "Linked pair",
        leadTrackId: "track-a",
        memberTrackIds: ["track-a", "track-b"],
        linkedParams: ["mute", "solo", "armed", "fxBypass"],
      }],
      toggleSelectedTracksMute,
      toggleSelectedTracksSolo,
      toggleSelectedTracksArmed,
      toggleSelectedTracksFXBypass,
    });

    getRegisteredAction("track.toggleSelectedMute")?.execute();
    getRegisteredAction("track.toggleSelectedSolo")?.execute();
    getRegisteredAction("track.toggleSelectedArm")?.execute();
    getRegisteredAction("track.toggleSelectedFxBypass")?.execute();

    expect(toggleSelectedTracksMute).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksSolo).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksArmed).toHaveBeenCalledTimes(1);
    expect(toggleSelectedTracksFXBypass).toHaveBeenCalledTimes(1);
  });

  it("routes link and unlink commands through selection-level store transactions", () => {
    const addTrackGroup = vi.fn();
    const unlinkTracksFromGroups = vi.fn();
    useDAWStore.setState({
      tracks: [
        { id: "track-a" },
        { id: "track-b" },
      ] as never,
      selectedTrackId: "track-a",
      selectedTrackIds: ["track-a", "track-b"],
      trackGroups: [],
      addTrackGroup,
      unlinkTracksFromGroups,
    });

    getRegisteredAction("track.linkSelected")?.execute();
    expect(addTrackGroup).toHaveBeenCalledWith(
      "Group",
      "track-a",
      ["track-a", "track-b"],
      ["volume", "pan", "mute", "solo", "armed", "fxBypass"],
    );

    useDAWStore.setState({
      trackGroups: [{
        id: "group-a",
        name: "Group",
        leadTrackId: "track-a",
        memberTrackIds: ["track-a", "track-b"],
        linkedParams: ["mute"],
      }],
    });
    getRegisteredAction("track.unlinkSelected")?.execute();
    expect(unlinkTracksFromGroups).toHaveBeenCalledWith(["track-a", "track-b"]);
  });

  it("routes component-owned catalog actions through the exact active scoped executor", () => {
    const cases: Array<{
      context: EditShortcutContext;
      actionIds: readonly string[];
    }> = [
      { context: { kind: "timeline" }, actionIds: ["clip.splitAtPointer"] },
      {
        context: { kind: "piano_roll", sessionId: "catalog-test" },
        actionIds: [
          "midi.loopFromSelectedNotes",
          "midi.noteProperties",
          "midi.toggleGhostReference",
          "midi.openQuantizePanel",
          "midi.quantizeLength",
          "midi.controllerLine",
          "midi.controllerSineLfo",
          "midi.controllerTriangleLfo",
          "midi.controllerSquareLfo",
          "midi.controllerSawUpLfo",
          "midi.controllerSawDownLfo",
          "midi.controllerTransform",
          "midi.controllerThin",
          "midi.copyControllerLane",
          "midi.pasteControllerLane",
          "midi.clearControllerLane",
        ],
      },
      {
        context: { kind: "pitch_editor" },
        actionIds: ["pitch.detectKeyScale", "pitch.correctAllToScale", "pitch.toggleAB", "pitch.openCorrectionMacro"],
      },
      {
        context: { kind: "track_control_panel" },
        actionIds: [
          "track.openSelectedFxChain",
          "track.openSelectedNotes",
          "track.loadSelectedSamplerSample",
          "mixer.openMasterFxChain",
        ],
      },
      {
        context: { kind: "mixer" },
        actionIds: ["track.openSelectedFxChain", "mixer.openMasterFxChain", "mixer.addMonitorFx"],
      },
      {
        context: { kind: "plugin", sessionId: "catalog-test" },
        actionIds: [
          "fx.removeSelected",
          "fx.toggleSelectedBypass",
          "fx.openSelectedEditor",
          "fx.toggleSelectedAB",
          "fx.reloadSelectedScript",
          "fx.toggleSelectedParameters",
          "fx.toggleSelectedPresets",
          "fx.openInstrumentEditor",
          "fx.removeInstrument",
        ],
      },
      {
        context: { kind: "browser" },
        actionIds: [
          "browser.focusSearch",
          "browser.toggleFavorites",
          "browser.openUserEffectsFolder",
          "browser.toggleScanFolders",
          "browser.addScanFolder",
          "browser.scanPlugins",
          "browser.deepScanPlugins",
          "browser.removeCurrentInstrument",
          "browser.mediaNavigateUp",
          "browser.mediaToggleRecent",
          "browser.mediaFocusFilter",
        ],
      },
    ];

    for (const { context, actionIds } of cases) {
      const executor = vi.fn((_actionId: string) => "handled" as const);
      const unregister = registerScopedActionExecutor(context, executor);
      activateShortcutContext(context);
      try {
        for (const actionId of actionIds) getRegisteredAction(actionId)?.execute();
        expect(executor.mock.calls.map(([actionId]) => actionId)).toEqual(actionIds);
      } finally {
        unregister();
      }
    }

    expect(executeActiveScopedAction("fx.removeSelected")).toBe("unmatched");
  });

  it("keeps shell-owned global commands reachable after an editor takes focus", () => {
    const applicationExecutor = vi.fn((actionId: string) => (
      actionId === "transport.metronomeSettings"
        || actionId === "view.openGridQuantizePanel"
        || actionId === "edit.applyCurrentQuantize"
        ? "handled" as const
        : "unmatched" as const
    ));
    const timelineExecutor = vi.fn(() => "unmatched" as const);
    const unregisterApplication = registerScopedActionExecutor(
      { kind: "application" },
      applicationExecutor,
    );
    const unregisterTimeline = registerScopedActionExecutor(
      { kind: "timeline" },
      timelineExecutor,
    );
    activateShortcutContext({ kind: "timeline" });

    try {
      getRegisteredAction("transport.metronomeSettings")?.execute();
      getRegisteredAction("view.openGridQuantizePanel")?.execute();
      getRegisteredAction("edit.applyCurrentQuantize")?.execute();
      expect(applicationExecutor.mock.calls.map(([actionId]) => actionId)).toEqual([
        "transport.metronomeSettings",
        "view.openGridQuantizePanel",
        "edit.applyCurrentQuantize",
      ]);
    } finally {
      unregisterTimeline();
      unregisterApplication();
    }
  });

  it("falls through co-owned surface executors until one recognizes the action", () => {
    const owner = vi.fn(() => "handled" as const);
    const unrelatedOwner = vi.fn(() => "unmatched" as const);
    const unregisterOwner = registerScopedActionExecutor({ kind: "browser" }, owner);
    const unregisterUnrelated = registerScopedActionExecutor({ kind: "browser" }, unrelatedOwner);
    activateShortcutContext({ kind: "browser" });

    try {
      expect(executeActiveScopedAction("browser.mediaNavigateUp")).toBe("handled");
      expect(unrelatedOwner).toHaveBeenCalledWith("browser.mediaNavigateUp");
      expect(owner).toHaveBeenCalledWith("browser.mediaNavigateUp");
    } finally {
      unregisterUnrelated();
      unregisterOwner();
    }
  });

  it("exposes track commands in both TCP and Mixer without widening them globally", () => {
    expect(getActionShortcutScopes(getRegisteredAction("track.toggleSelectedMute")!))
      .toEqual(["track_control_panel", "mixer"]);
    expect(getActionShortcutScopes(getRegisteredAction("track.renderSelectedInPlace")!))
      .toEqual(["track_control_panel", "mixer", "timeline"]);
    expect(getActionShortcutScopes(getRegisteredAction("track.toggleSelectedAutomationRead")!))
      .toEqual(["automation", "track_control_panel", "mixer"]);
    expect(getActionShortcutScopes(getRegisteredAction("track.toggleSelectedFxBypass")!))
      .toEqual(["track_control_panel", "mixer", "plugin"]);
  });
});
