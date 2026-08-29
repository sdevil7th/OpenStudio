import { afterEach, describe, expect, it, vi } from "vitest";
import timelineSource from "../components/Timeline.tsx?raw";
import pianoRollSource from "../components/PianoRoll.tsx?raw";
import pitchEditorSource from "../components/PitchEditorLowerZone.tsx?raw";
import trackHeaderSource from "../components/TrackHeader.tsx?raw";
import aiTrackHeaderSource from "../components/AITrackHeader.tsx?raw";
import fxChainSource from "../components/FXChainPanel.tsx?raw";
import transportBarSource from "../components/TransportBar.tsx?raw";
import mainToolbarSource from "../components/MainToolbar.tsx?raw";
import mixerPanelSource from "../components/MixerPanel.tsx?raw";
import masterTrackHeaderSource from "../components/MasterTrackHeader.tsx?raw";
import channelStripSource from "../components/ChannelStrip.tsx?raw";
import pluginBrowserSource from "../components/PluginBrowser.tsx?raw";
import mediaExplorerSource from "../components/MediaExplorer.tsx?raw";
import aiTrackSource from "../components/AITrackHeader.tsx?raw";
import aiWorkflowModalSource from "../components/AIWorkflowModal.tsx?raw";
import aiWorkflowParamSource from "../components/AIWorkflowParamField.tsx?raw";
import {
  executeActiveScopedAction,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import {
  activateShortcutContext,
  type EditShortcutContext,
} from "../utils/shortcutContext";

const cleanups: Array<() => void> = [];

function normalizeSourceText(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  activateShortcutContext({ kind: "application" });
});

describe("component-owned scoped action wiring", () => {
  it("splits only the clip and pointer captured by the active Timeline instance", () => {
    expect(timelineSource).toContain('actionId !== "clip.splitAtPointer"');
    expect(timelineSource).toContain("const menu = clipContextMenu");
    expect(timelineSource).toContain("state.splitMIDIClipAtPosition(menu.clipId, menu.time)");
    expect(timelineSource).toContain("state.splitClipAtPosition(menu.clipId, menu.time)");
    expect(normalizeSourceText(timelineSource)).toContain('registerScopedActionExecutor(\n      context,');
    expect(timelineSource).toContain('matchesActionShortcut(event, "clip.splitAtPointer")');
  });

  it("executes selection-dependent Piano Roll actions inside the exact editor session", () => {
    for (const actionId of [
      "midi.loopFromSelectedNotes",
      "midi.noteProperties",
      "midi.toggleGhostReference",
      "midi.configureControllerLanes",
      "midi.openQuantizePanel",
      "midi.quantizeLength",
      "midi.controllerLine",
      "midi.controllerTransform",
      "midi.controllerThin",
      "midi.copyControllerLane",
      "midi.pasteControllerLane",
      "midi.clearControllerLane",
    ]) {
      expect(pianoRollSource).toContain(`actionId === "${actionId}"`);
    }
    expect(pianoRollSource).toContain("parseNotePairs(getLatestClipEvents())");
    expect(pianoRollSource).toContain("setLoopRegion(clipStartTime + start, clipStartTime + end)");
    expect(pianoRollSource).toContain("setTransformDialog({ type: \"velocity\", value: selectedPair.velocity })");
    expect(pianoRollSource).toContain("setShowGhostMIDIClips((visible) => !visible)");
    expect(pianoRollSource).toContain("const controllerLaneSelectorRef = useRef<HTMLSelectElement>(null)");
    expect(pianoRollSource).toContain("selector.focus()");
    expect(pianoRollSource).toContain("selector.showPicker?.()");
    expect(pianoRollSource).toContain("ref={controllerLaneSelectorRef}");
    expect(pianoRollSource).toContain("pianoShortcutContext,");
  });

  it("routes pitch actions through the active editor store and its undo-aware correction", () => {
    expect(pitchEditorSource).toContain('actionId === "pitch.detectKeyScale"');
    expect(pitchEditorSource).toContain("autoDetectScale()");
    expect(pitchEditorSource).toContain('actionId === "pitch.correctAllToScale"');
    expect(pitchEditorSource).toContain("correctAllToScale()");
    expect(pitchEditorSource).toContain('actionId === "pitch.toggleAB"');
    expect(pitchEditorSource).toContain("toggleABCompare()");
    expect(pitchEditorSource).toContain('actionId === "pitch.openCorrectionMacro"');
    expect(pitchEditorSource).toContain("toggleCorrectPitchModal()");
    expect(normalizeSourceText(pitchEditorSource)).toContain('registerScopedActionExecutor(\n      context,');
  });

  it("opens only the primary selected standard or AI TrackHeader and supports the main mixer context", () => {
    for (const source of [trackHeaderSource, aiTrackHeaderSource].map(normalizeSourceText)) {
      expect(source).toContain("if (!isSelected || selectedTrackId !== track.id) return");
      expect(source).toContain("if (selectedId !== track.id) return \"claimed_noop\"");
      expect(source).toContain('registerScopedActionExecutor(\n      { kind: "track_control_panel" }');
      expect(source).toContain('registerScopedActionExecutor(\n      { kind: "mixer" }');
      expect(source).toContain("setShowFXChain(true)");
      expect(source).toContain('data-shortcut-context="track_control_panel"');
    }
    expect(trackHeaderSource).toContain('actionId === "track.openSelectedFxChain"');
    expect(aiTrackHeaderSource).toContain('actionId !== "track.openSelectedFxChain"');
    expect(trackHeaderSource).toContain('actionId === "track.openSelectedNotes"');
    expect(trackHeaderSource).toContain('actionId === "track.loadSelectedSamplerSample"');
  });

  it("keeps FX actions on the selected slot and reuses undo-aware mutations", () => {
    expect(fxChainSource).toContain("const [selectedFxIndex, setSelectedFxIndex]");
    expect(fxChainSource).toContain('actionId === "fx.add"');
    expect(fxChainSource).toContain('actionId === "fx.removeSelected"');
    expect(fxChainSource).toContain('actionId === "fx.toggleSelectedBypass"');
    expect(fxChainSource).toContain('actionId !== "fx.openSelectedEditor"');
    for (const actionId of [
      "fx.toggleSelectedAB",
      "fx.reloadSelectedScript",
      "fx.toggleSelectedParameters",
      "fx.toggleSelectedPresets",
      "fx.openInstrumentEditor",
      "fx.removeInstrument",
    ]) {
      expect(fxChainSource).toContain(`actionId === "${actionId}"`);
    }
    expect(fxChainSource).toContain("removeTrackFXWithUndo(trackId, fxIndex, chainType)");
    expect(fxChainSource).toContain("removeMasterFXWithUndo(fxIndex)");
    expect(fxChainSource).toContain("toggleFXSlotBypassWithUndo(trackId, fxIndex, chainType)");
    expect(fxChainSource).not.toContain('if (chainType === "master") return "claimed_noop"');
    expect(fxChainSource).toContain('selectedFx.type === "builtin"');
    expect(fxChainSource).toContain("handleOpenEditor(selectedFx.index)");
    expect(fxChainSource).toContain('data-shortcut-context={`plugin:${fxShortcutSessionId}`}');
  });

  it("opens the exact FX panel's chooser without guessing a plug-in", () => {
    expect(fxChainSource).toContain("const availablePluginSearchRef = useRef<HTMLInputElement>(null)");
    expect(fxChainSource).toContain("searchInput.scrollIntoView({ block: \"nearest\", inline: \"nearest\" })");
    expect(fxChainSource).toContain("searchInput.focus()");
    expect(fxChainSource).toContain("searchInput.select()");
    expect(fxChainSource).toContain("ref={availablePluginSearchRef}");
    const addActionBranch = fxChainSource.slice(
      fxChainSource.indexOf('if (actionId === "fx.add")'),
      fxChainSource.indexOf("const selectedFx = selectedFxIndex"),
    );
    expect(addActionBranch).not.toContain("handleAddPlugin(");
  });

  it("wires shell, mixer, browser, and media commands to their real UI owners", () => {
    expect(transportBarSource).toContain('actionId !== "transport.metronomeSettings"');
    expect(transportBarSource).toContain("setShowMetronomeSettings(true)");
    expect(mainToolbarSource).toContain('actionId === "view.openGridQuantizePanel"');
    expect(mainToolbarSource).toContain("setShowQuantizePanel(true)");
    expect(mainToolbarSource).toContain('actionId === "edit.applyCurrentQuantize"');
    expect(mainToolbarSource).toContain("handleApplyQuantize()");

    expect(mixerPanelSource).toContain('actionId === "mixer.addMonitorFx"');
    expect(mixerPanelSource).toContain('actionId === "mixer.close"');
    expect(normalizeSourceText(mixerPanelSource)).toContain('registerShortcutSurface(\n      context,');
    expect(mixerPanelSource).toContain('activateShortcutContext({ kind: "mixer" })');
    expect(masterTrackHeaderSource).toContain('actionId !== "mixer.openMasterFxChain"');
    expect(channelStripSource).toContain('actionId === "mixer.openMasterFxChain"');

    for (const actionId of [
      "browser.focusSearch",
      "browser.toggleFavorites",
      "browser.openUserEffectsFolder",
      "browser.toggleScanFolders",
      "browser.addScanFolder",
      "browser.scanPlugins",
      "browser.deepScanPlugins",
      "browser.removeCurrentInstrument",
    ]) {
      expect(pluginBrowserSource).toContain(`actionId === "${actionId}"`);
    }
    for (const actionId of [
      "browser.mediaNavigateUp",
      "browser.mediaToggleRecent",
      "browser.mediaFocusFilter",
    ]) {
      expect(mediaExplorerSource).toContain(`actionId === "${actionId}"`);
    }
    for (const source of [pluginBrowserSource, mediaExplorerSource]) {
      expect(source).toContain('registerShortcutSurface(context, () => "unmatched", fallback)');
      expect(source).toContain('registerScopedActionExecutor(');
      expect(source).toContain('activateShortcutContext({ kind: "browser" })');
    }
  });

  it("connects wheel-edited faders to one reusable begin/commit transaction", () => {
    expect(channelStripSource).toContain("const beginVolumeEdit = useCallback");
    expect(channelStripSource).toContain("const commitVolumeEdit = useCallback");
    expect(channelStripSource).toContain("const beginPanEdit = useCallback");
    expect(channelStripSource).toContain("const commitPanEdit = useCallback");
    expect(channelStripSource).toContain("onBeginEdit={beginVolumeEdit}");
    expect(channelStripSource).toContain("onCommitEdit={commitVolumeEdit}");
    expect(channelStripSource).toContain("onBeginEdit={beginPanEdit}");
    expect(channelStripSource).toContain("onCommitEdit={commitPanEdit}");
    expect(channelStripSource).toContain("beginMasterVolumeEdit()");
    expect(channelStripSource).toContain("commitMasterVolumeEdit()");
    expect(channelStripSource).toContain("beginMasterPanEdit()");
    expect(channelStripSource).toContain("commitMasterPanEdit()");
    expect(channelStripSource).toContain('gesture.ruleId === "cakewalk-sonar.console-all-faders"');
    expect(channelStripSource).toContain('gesture.ruleId === "cakewalk-sonar.console-selected-faders"');
    expect(channelStripSource).toContain("state.selectedTrackIds");
    expect(channelStripSource).toContain("beginTrackVolumeBatchEdit(targetIds)");
    expect(channelStripSource).toContain("adjustTrackVolumeBatch(deltaDB)");
    expect(channelStripSource).toContain("commitTrackVolumeBatchEdit()");
    expect(channelStripSource).toContain("if (isMaster) return;");
    expect(channelStripSource).toContain("onWheel={handleGroupedVolumeWheel}");
    expect(channelStripSource).not.toContain("handleVolumePointerDown");
    expect(channelStripSource).not.toContain("handlePanPointerDown");
    expect(trackHeaderSource).toContain("onBeginEdit={beginInlineFaderEdit}");
    expect(trackHeaderSource).toContain("onCommitEdit={commitInlineFaderEdit}");
    expect(trackHeaderSource).not.toContain("document.addEventListener(\"pointerup\", commitOnce");
  });

  it("coalesces continuous AI workflow parameter controls through store edit sessions", () => {
    expect(aiTrackSource).toContain("beginAITrackParamsEdit: state.beginAITrackParamsEdit");
    expect(aiTrackSource).toContain("commitAITrackParamsEdit: state.commitAITrackParamsEdit");
    expect(aiTrackSource).toContain("onBeginParamsEdit={() => beginAITrackParamsEdit(track.id)}");
    expect(aiTrackSource).toContain("onCommitParamsEdit={() => commitAITrackParamsEdit(track.id)}");
    expect(aiWorkflowModalSource).toContain("onBeginEdit={onBeginParamsEdit}");
    expect(aiWorkflowModalSource).toContain("onCommitEdit={onCommitParamsEdit}");
    expect(aiWorkflowParamSource).toContain("onBeginEdit={onBeginEdit}");
    expect(aiWorkflowParamSource).toContain("onCommitEdit={onCommitEdit}");
  });
});

describe("scoped executor context ownership", () => {
  function register(
    context: EditShortcutContext,
    execute: (actionId: string) => "handled" | "claimed_noop" | "unmatched",
  ) {
    cleanups.push(registerScopedActionExecutor(context, execute));
  }

  it("never dispatches an action to a different editor session or surface", () => {
    const timeline = vi.fn(() => "handled" as const);
    const dockedPiano = vi.fn(() => "handled" as const);
    const detachedPiano = vi.fn(() => "handled" as const);
    const pitch = vi.fn(() => "handled" as const);
    const trackHeader = vi.fn(() => "handled" as const);
    const mixer = vi.fn(() => "handled" as const);
    const fxPanel = vi.fn(() => "handled" as const);
    const detachedPlugin = vi.fn(() => "handled" as const);

    register({ kind: "timeline" }, timeline);
    register({ kind: "piano_roll", sessionId: "docked" }, dockedPiano);
    register({ kind: "piano_roll", sessionId: "detached" }, detachedPiano);
    register({ kind: "pitch_editor" }, pitch);
    register({ kind: "track_control_panel" }, trackHeader);
    register({ kind: "mixer" }, mixer);
    register({ kind: "plugin", sessionId: "fx-chain:track:track-a" }, fxPanel);
    register({ kind: "plugin", sessionId: "detached-plugin" }, detachedPlugin);

    const cases: Array<{
      context: EditShortcutContext;
      actionId: string;
      expected: ReturnType<typeof vi.fn>;
    }> = [
      { context: { kind: "timeline" }, actionId: "clip.splitAtPointer", expected: timeline },
      { context: { kind: "piano_roll", sessionId: "docked" }, actionId: "midi.noteProperties", expected: dockedPiano },
      { context: { kind: "piano_roll", sessionId: "detached" }, actionId: "midi.configureControllerLanes", expected: detachedPiano },
      { context: { kind: "pitch_editor" }, actionId: "pitch.toggleAB", expected: pitch },
      { context: { kind: "track_control_panel" }, actionId: "track.openSelectedFxChain", expected: trackHeader },
      { context: { kind: "mixer" }, actionId: "track.openSelectedFxChain", expected: mixer },
      { context: { kind: "plugin", sessionId: "fx-chain:track:track-a" }, actionId: "fx.openSelectedEditor", expected: fxPanel },
      { context: { kind: "plugin", sessionId: "detached-plugin" }, actionId: "fx.add", expected: detachedPlugin },
    ];

    for (const [index, testCase] of cases.entries()) {
      activateShortcutContext(testCase.context);
      expect(executeActiveScopedAction(testCase.actionId)).toBe("handled");
      for (const executor of [timeline, dockedPiano, detachedPiano, pitch, trackHeader, mixer, fxPanel, detachedPlugin]) {
        expect(executor).toHaveBeenCalledTimes(executor === testCase.expected ? 1 : 0);
        executor.mockClear();
      }
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not fall back to another plugin instance when the active session has no executor", () => {
    const fxPanel = vi.fn(() => "handled" as const);
    register({ kind: "plugin", sessionId: "fx-chain:track:track-a" }, fxPanel);

    activateShortcutContext({ kind: "plugin", sessionId: "detached-plugin" });
    expect(executeActiveScopedAction("fx.removeSelected")).toBe("unmatched");
    expect(fxPanel).not.toHaveBeenCalled();
  });
});
