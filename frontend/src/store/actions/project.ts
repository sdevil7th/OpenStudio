// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

/**
 * Project management — save, load, new, settings, templates, auto-backup.
 * Extracted from useDAWStore.ts.
 */
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { resetSyncCache } from "./clips";
import { createFreshProjectDocumentState } from "../useDAWStore";
import { syncAutomationLaneToBackend, syncTempoMarkersToBackend } from "./storeHelpers";

const TRANSIENT_STATE_KEYS: ReadonlySet<string> = new Set([
  "meterLevels", "peakLevels", "masterLevel", "automatedParamValues",
  "recordingClips", "recordingMIDIPreviews", "playStartPosition",
  "selectedTrackId", "selectedTrackIds", "lastSelectedTrackId",
  "selectedClipId", "selectedClipIds", "clipboard",
  "selectedNoteIds", "selectedRegionIds", "razorEdits", "timeSelection",
  "showMixer", "showSettings", "showRenderModal", "showPluginBrowser", "pluginBrowserTrackId",
  "showVirtualKeyboard", "showUndoHistory", "showCommandPalette", "showRegionMarkerManager",
  "showClipProperties", "showBigClock", "showKeyboardShortcuts", "showContextualHelp",
  "showGettingStarted", "showPreferences", "showScriptConsole", "showPianoRoll",
  "showProjectSettings", "showDynamicSplit", "showRenderQueue", "showRoutingMatrix",
  "showMediaExplorer", "showCleanProject", "showBatchConverter", "showCrossfadeEditor",
  "showThemeEditor", "showVideoWindow", "showScriptEditor", "showToolbarEditor",
  "showDDPExport", "showStepSequencer", "showClipLauncher", "showTimecodeSettings",
  "showDrumEditor", "showMediaPool", "showLoudnessMeter",
  "showPhaseCorrelation", "showProjectTemplates",
  "showRegionRenderMatrix", "showMasterTrackInTCP", "showCrosshair", "showProjectCompare",
  "projectCompareData",
  "pianoRollTrackId", "pianoRollClipId", "dynamicSplitClipId", "crossfadeEditorClipIds",
  "stepInputEnabled", "stepInputSize", "stepInputPosition",
  "audioDeviceSetup", "canUndo", "canRedo",
  "isProjectLoading", "projectLoadingMessage",
  "toastMessage", "toastType", "toastVisible",
  "tapTimestamps", "recentActions", "scriptConsoleOutput", "pluginABStates",
]);

function projectJsonReplacer(key: string, value: unknown): unknown {
  if (key && TRANSIENT_STATE_KEYS.has(key)) return undefined;
  if (key === "meterLevel" || key === "peakLevel" || key === "clipping") return undefined;
  return value;
}

function buildProjectResetState() {
  const freshProjectState = createFreshProjectDocumentState();
  return {
    ...freshProjectState,
    showPluginBrowser: false,
    pluginBrowserTrackId: null,
    showEnvelopeManager: false,
    envelopeManagerTrackId: null,
    showChannelStripEQ: false,
    channelStripEQTrackId: null,
    showTrackRouting: false,
    trackRoutingTrackId: null,
    showPianoRoll: false,
    pianoRollTrackId: null,
    pianoRollClipId: null,
    showPitchEditor: false,
    pitchEditorTrackId: null,
    pitchEditorClipId: null,
    pitchEditorFxIndex: 0,
    showClipProperties: false,
    showDynamicSplit: false,
    dynamicSplitClipId: null,
    showCrossfadeEditor: false,
    crossfadeEditorClipIds: null,
    showClipLauncher: false,
    showStemSeparation: false,
    stemSepTrackId: null,
    stemSepClipId: null,
    stemSepClipName: "",
    stemSepClipDuration: 0,
    showProjectCompare: false,
    projectCompareData: null,
    showRegionRenderMatrix: false,
    showUnsavedChangesDialog: false,
    pendingProjectAction: null,
    pendingProjectActionLabel: "",
  };
}

function buildSerializedProjectData(
  state: any,
  serializedTracks: any[],
  masterFXPaths: string[],
  masterFXStates: string[],
) {
  return {
    version: "1.1.0",
    savedAt: Date.now(),
    projectName: state.projectName,
    projectNotes: state.projectNotes,
    projectSampleRate: state.projectSampleRate,
    projectBitDepth: state.projectBitDepth,
    processingPrecision: state.processingPrecision,
    tempo: state.transport.tempo,
    timeSignature: state.timeSignature,
    metronomeEnabled: state.metronomeEnabled,
    metronomeVolume: state.metronomeVolume,
    metronomeAccentBeats: state.metronomeAccentBeats,
    metronomeTrackId: state.metronomeTrackId,
    projectRange: state.projectRange,
    markers: state.markers,
    regions: state.regions,
    tempoMarkers: state.tempoMarkers,
    masterVolume: state.masterVolume,
    masterPan: state.masterPan,
    isMasterMuted: state.isMasterMuted,
    masterMono: state.masterMono,
    masterAutomationLanes: state.masterAutomationLanes,
    showMasterAutomation: state.showMasterAutomation,
    masterAutomationEnabled: state.masterAutomationEnabled,
    suspendedMasterAutomationState: state.suspendedMasterAutomationState,
    tracks: serializedTracks,
    masterFXPaths,
    masterFXStates,
    mixerSnapshots: state.mixerSnapshots,
    trackGroups: state.trackGroups,
    clipLauncher: state.clipLauncher,
    renderMetadata: state.renderMetadata,
    secondaryOutputEnabled: state.secondaryOutputEnabled,
    secondaryOutputFormat: state.secondaryOutputFormat,
    secondaryOutputBitDepth: state.secondaryOutputBitDepth,
    onlineRender: state.onlineRender,
    addToProjectAfterRender: state.addToProjectAfterRender,
    projectAuthor: state.projectAuthor,
    projectRevisionNotes: state.projectRevisionNotes,
    undoHistory: commandManager.serialize(),
  };
}

async function teardownCurrentProject(get: GetFn, set: SetFn) {
  const freshProjectState = createFreshProjectDocumentState();
  await get().stop();
  await nativeBridge.closeAllPluginWindows().catch(() => false);

  if (typeof get().closePitchEditor === "function")
    get().closePitchEditor();
  if (typeof get().closePianoRoll === "function")
    get().closePianoRoll();
  if (typeof get().closePluginBrowser === "function")
    get().closePluginBrowser();
  if (typeof get().closeEnvelopeManager === "function")
    get().closeEnvelopeManager();
  if (typeof get().closeChannelStripEQ === "function")
    get().closeChannelStripEQ();
  if (typeof get().closeTrackRouting === "function")
    get().closeTrackRouting();
  if (typeof get().closeStemSeparation === "function")
    get().closeStemSeparation();
  if (typeof get().closeDynamicSplit === "function")
    get().closeDynamicSplit();
  if (typeof get().closeCrossfadeEditor === "function")
    get().closeCrossfadeEditor();

  resetSyncCache();

  const tracks = [...get().tracks];
  for (let i = tracks.length - 1; i >= 0; i--) {
    await get().removeTrack(tracks[i].id);
  }

  set(buildProjectResetState());
  await nativeBridge.setProcessingPrecision(freshProjectState.processingPrecision).catch(logBridgeError("sync"));
  await nativeBridge.setTempo(freshProjectState.transport.tempo).catch(logBridgeError("sync"));
  await nativeBridge.setTimeSignature(
    freshProjectState.timeSignature.numerator,
    freshProjectState.timeSignature.denominator,
  ).catch(logBridgeError("sync"));
  await nativeBridge.setMetronomeEnabled(false).catch(logBridgeError("sync"));
  await nativeBridge.setMetronomeAccentBeats(freshProjectState.metronomeAccentBeats).catch(logBridgeError("sync"));
  await nativeBridge.setMetronomeVolume(freshProjectState.metronomeVolume).catch(logBridgeError("sync"));
  await nativeBridge.setMasterVolume(freshProjectState.masterVolume).catch(logBridgeError("sync"));
  await nativeBridge.setMasterPan(freshProjectState.masterPan).catch(logBridgeError("sync"));
  await nativeBridge.setMasterMono(Boolean(freshProjectState.masterMono)).catch(logBridgeError("sync"));
  syncTempoMarkersToBackend([]);
  for (const lane of freshProjectState.masterAutomationLanes) {
    syncAutomationLaneToBackend("master", lane);
  }
  commandManager.clear();
}

async function performPendingProjectAction(action: any, get: GetFn) {
  if (!action) return false;

  switch (action.type) {
    case "newProject":
    case "closeProject":
      await get().newProject();
      return true;
    case "openProject":
      return await get().loadProject(action.path, action.options);
    case "quit":
      await nativeBridge.quitApplication();
      return true;
    case "loadTemplate":
      get().loadTemplate(action.index);
      return true;
    default:
      return false;
  }
}

export const projectActions = (set: SetFn, get: GetFn) => ({
    newProject: async () => {
      await teardownCurrentProject(get, set);
    },

    requestNewProject: async () => {
      const action = { type: "newProject" };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before creating a new project",
      });
      return true;
    },

    requestOpenProject: async (path, options) => {
      const action = { type: "openProject", path, options };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before opening another project",
      });
      return true;
    },

    requestCloseProject: async () => {
      const action = { type: "closeProject" };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before closing the current project",
      });
      return true;
    },

    requestQuit: async () => {
      const action = { type: "quit" };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before closing OpenStudio",
      });
      return true;
    },

    requestLoadTemplate: async (index) => {
      const action = { type: "loadTemplate", index };
      if (!get().isModified)
        return performPendingProjectAction(action, get);

      set({
        showUnsavedChangesDialog: true,
        pendingProjectAction: action,
        pendingProjectActionLabel: "before loading a project template",
      });
      return true;
    },

    dismissUnsavedChangesDialog: () =>
      set({
        showUnsavedChangesDialog: false,
        pendingProjectAction: null,
        pendingProjectActionLabel: "",
      }),

    resolveUnsavedChanges: async (choice) => {
      const pendingAction = get().pendingProjectAction;
      if (!pendingAction) {
        get().dismissUnsavedChangesDialog();
        return;
      }

      if (choice === "cancel") {
        get().dismissUnsavedChangesDialog();
        return;
      }

      if (choice === "save") {
        const saved = await get().saveProject(!get().projectPath);
        if (!saved)
          return;
      }

      set({
        showUnsavedChangesDialog: false,
        pendingProjectAction: null,
        pendingProjectActionLabel: "",
      });

      await performPendingProjectAction(pendingAction, get);
    },

    setModified: (modified) => set({ isModified: modified }),

    saveProject: async (saveAs = false) => {
      let path = get().projectPath;

      if (!path || saveAs) {
        path = await nativeBridge.showSaveDialog(path || undefined);
        if (!path) return false;
      }

      try {
      const state = get();
      console.log(`[DEBUG SAVE] Starting save. ${state.tracks.length} tracks.`);

      // 1. Serialize Tracks with Plugin States
      const serializedTracks = await Promise.all(
        state.tracks.map(async (track) => {
          const inputFXStates: string[] = [];

          const inputFXList = await nativeBridge.getTrackInputFX(track.id);
          console.log(`[DEBUG SAVE] Track "${track.name}" (${track.id}): getTrackInputFX returned`, JSON.stringify(inputFXList));
          const inputFXPaths: string[] = [];
          for (let i = 0; i < inputFXList.length; i++) {
            const item = inputFXList[i];
            console.log(`[DEBUG SAVE]   inputFX[${i}] raw object keys:`, Object.keys(item), `pluginPath="${item.pluginPath}"`);
            if (item.pluginPath) inputFXPaths.push(item.pluginPath);
            const fxState = await nativeBridge.getPluginState(track.id, i, true);
            console.log(`[DEBUG SAVE]   inputFX[${i}] state length: ${fxState ? fxState.length : 0}`);
            if (fxState) inputFXStates.push(fxState);
          }

          const trackFXStates: string[] = [];
          const trackFXPaths: string[] = [];
          const trackFXList = await nativeBridge.getTrackFX(track.id);
          console.log(`[DEBUG SAVE] Track "${track.name}" (${track.id}): getTrackFX returned`, JSON.stringify(trackFXList));
          for (let i = 0; i < trackFXList.length; i++) {
            const item = trackFXList[i];
            console.log(`[DEBUG SAVE]   trackFX[${i}] raw object keys:`, Object.keys(item), `pluginPath="${item.pluginPath}"`);
            if (item.pluginPath) trackFXPaths.push(item.pluginPath);
            const fxState = await nativeBridge.getPluginState(track.id, i, false);
            console.log(`[DEBUG SAVE]   trackFX[${i}] state length: ${fxState ? fxState.length : 0}`);
            if (fxState) trackFXStates.push(fxState);
          }

          console.log(`[DEBUG SAVE] Track "${track.name}" RESULT: ${inputFXPaths.length} input FX paths, ${trackFXPaths.length} track FX paths`);

          return {
            id: track.id,
            name: track.name,
            color: track.color,
            type: track.type,
            inputType: track.inputType,
            inputStartChannel: track.inputStartChannel,
            inputChannelCount: track.inputChannelCount,
            volumeDB: track.volumeDB,
            pan: track.pan,
            muted: track.muted,
            soloed: track.soloed,
            armed: track.armed,
            monitorEnabled: track.monitorEnabled,
            inputChannel: track.inputChannel,
            clips: track.clips,
            midiClips: track.midiClips,
            inputFXPaths,
            inputFXStates,
            trackFXPaths,
            trackFXStates,
            instrumentPlugin: track.instrumentPlugin,
          };
        }),
      );

      // 2. Master Bus FX serialization
      const masterFXPaths: string[] = [];
      const masterFXStates: string[] = [];
      try {
        const masterFXList = await nativeBridge.getMasterFX();
        for (let i = 0; i < masterFXList.length; i++) {
          const path = masterFXList[i].pluginPath;
          if (path) masterFXPaths.push(path);
          const fxState = await nativeBridge.getMasterPluginState(i);
          if (fxState) masterFXStates.push(fxState);
        }
      } catch (e) {
        console.warn("[saveProject] Failed to serialize master FX:", e);
      }

      const projectData = buildSerializedProjectData(
        state,
        serializedTracks,
        masterFXPaths,
        masterFXStates,
      );

      const success = await nativeBridge.saveProjectToFile(
        path,
        JSON.stringify(projectData, projectJsonReplacer, 2),
      );

      if (success) {
        console.log(`[DEBUG SAVE] Saved successfully to: ${path}`);
        get().showToast("Project saved", "success");
        set((ctx) => {
          const newRecent = [
            path!,
            ...ctx.recentProjects.filter((p) => p !== path),
          ].slice(0, 10);
          return {
            projectPath: path,
            isModified: false,
            recentProjects: newRecent,
          };
        });
        localStorage.setItem(
          "recentProjects",
          JSON.stringify(get().recentProjects),
        );
      } else {
        console.error(`[DEBUG SAVE] Save FAILED for path: ${path}`);
        get().showToast("Failed to save project", "error");
      }

      return success;
      } catch (e) {
        console.error("[DEBUG SAVE] Exception during save:", e);
        get().showToast("Save failed: " + String(e), "error");
        return false;
      }
    },

    saveNewVersion: async () => {
      const state = get();
      let basePath = state.projectPath;
      if (!basePath) {
        // No existing path — fallback to Save As
        return get().saveProject(true);
      }

      // Increment version: "project.s13" → "project_v2.s13" → "project_v3.s13"
      const ext = basePath.match(/\.[^.]+$/)?.[0] || ".osproj";
      const base = basePath.replace(/\.[^.]+$/, "");
      const versionMatch = base.match(/_v(\d+)$/);
      let newPath: string;
      if (versionMatch) {
        const nextVersion = parseInt(versionMatch[1], 10) + 1;
        newPath = base.replace(/_v\d+$/, `_v${nextVersion}`) + ext;
      } else {
        newPath = base + "_v2" + ext;
      }

      // Update projectPath and save
      set({ projectPath: newPath });
      return get().saveProject(false);
    },

    loadProject: async (path, options) => {
      resetSyncCache();

      const bypassFX = options?.bypassFX ?? false;
      if (!path) {
        path = await nativeBridge.showOpenDialog();
        if (!path) return false;
      }

      const json = await nativeBridge.loadProjectFromFile(path);
      if (!json) return false;

      set({ isProjectLoading: true, projectLoadingMessage: "Parsing project..." });
      await new Promise((r) => setTimeout(r, 0));

      try {
        const data = JSON.parse(json);
        console.log(`[DEBUG LOAD] Parsed project. ${data.tracks?.length || 0} tracks.`);
        for (const t of data.tracks || []) {
          console.log(`[DEBUG LOAD] Saved track "${t.name}": inputFXPaths=${JSON.stringify(t.inputFXPaths || [])}, trackFXPaths=${JSON.stringify(t.trackFXPaths || [])}, inputFXStates=${(t.inputFXStates || []).length} states, trackFXStates=${(t.trackFXStates || []).length} states`);
        }
        if (data.masterFXPaths) {
          console.log(`[DEBUG LOAD] Saved masterFXPaths=${JSON.stringify(data.masterFXPaths)}`);
        }

        set({ projectLoadingMessage: "Resetting current project..." });
        await new Promise((r) => setTimeout(r, 0));

        await get().newProject();
        const freshProjectState = createFreshProjectDocumentState();
        const loadedTempo = data.tempo || 120;
        const loadedTimeSignature = data.timeSignature || freshProjectState.timeSignature;
        const loadedMasterVolume = data.masterVolume ?? 1.0;
        const loadedMasterPan = data.masterPan ?? 0.0;
        const loadedProcessingPrecision =
          data.processingPrecision || freshProjectState.processingPrecision;
        const loadedMetronomeVolume = data.metronomeVolume ?? freshProjectState.metronomeVolume;
        const loadedMetronomeAccentBeats =
          Array.isArray(data.metronomeAccentBeats) && data.metronomeAccentBeats.length > 0
            ? data.metronomeAccentBeats
            : freshProjectState.metronomeAccentBeats;
        const loadedMasterAutomationLanes =
          Array.isArray(data.masterAutomationLanes) && data.masterAutomationLanes.length > 0
            ? data.masterAutomationLanes
            : freshProjectState.masterAutomationLanes;
        const loadedRenderMetadata = {
          ...freshProjectState.renderMetadata,
          ...(data.renderMetadata || {}),
        };
        const loadedClipLauncher = {
          ...freshProjectState.clipLauncher,
          ...(data.clipLauncher || {}),
        };

        await nativeBridge.setProcessingPrecision(loadedProcessingPrecision).catch(logBridgeError("sync"));
        await nativeBridge.setTempo(loadedTempo).catch(logBridgeError("sync"));
        await nativeBridge.setTimeSignature(
          loadedTimeSignature.numerator,
          loadedTimeSignature.denominator,
        ).catch(logBridgeError("sync"));
        await nativeBridge.setMetronomeAccentBeats(loadedMetronomeAccentBeats).catch(logBridgeError("sync"));
        await nativeBridge.setMetronomeVolume(loadedMetronomeVolume).catch(logBridgeError("sync"));
        await nativeBridge.setMetronomeEnabled(Boolean(data.metronomeEnabled)).catch(logBridgeError("sync"));
        await nativeBridge.setMasterVolume(loadedMasterVolume).catch(logBridgeError("sync"));
        await nativeBridge.setMasterPan(loadedMasterPan).catch(logBridgeError("sync"));
        await nativeBridge.setMasterMono(Boolean(data.masterMono)).catch(logBridgeError("sync"));

        set({
          projectName: data.projectName || "Untitled Project",
          projectNotes: data.projectNotes || "",
          projectSampleRate: data.projectSampleRate || 44100,
          projectBitDepth: data.projectBitDepth || 24,
          processingPrecision: loadedProcessingPrecision,
          projectAuthor: data.projectAuthor || "",
          projectRevisionNotes: data.projectRevisionNotes || [],
          transport: { ...freshProjectState.transport, tempo: loadedTempo },
          timeSignature: loadedTimeSignature,
          metronomeEnabled: Boolean(data.metronomeEnabled),
          metronomeVolume: loadedMetronomeVolume,
          metronomeAccentBeats: loadedMetronomeAccentBeats,
          metronomeTrackId: data.metronomeTrackId ?? null,
          projectRange: data.projectRange || freshProjectState.projectRange,
          markers: Array.isArray(data.markers) ? data.markers : freshProjectState.markers,
          regions: Array.isArray(data.regions) ? data.regions : freshProjectState.regions,
          tempoMarkers: Array.isArray(data.tempoMarkers) ? data.tempoMarkers : freshProjectState.tempoMarkers,
          masterVolume: loadedMasterVolume,
          masterPan: loadedMasterPan,
          isMasterMuted: Boolean(data.isMasterMuted),
          masterMono: Boolean(data.masterMono),
          masterAutomationLanes: loadedMasterAutomationLanes,
          showMasterAutomation: Boolean(data.showMasterAutomation),
          masterAutomationEnabled:
            typeof data.masterAutomationEnabled === "boolean"
              ? data.masterAutomationEnabled
              : true,
          suspendedMasterAutomationState: data.suspendedMasterAutomationState || null,
          mixerSnapshots: Array.isArray(data.mixerSnapshots) ? data.mixerSnapshots : [],
          trackGroups: Array.isArray(data.trackGroups) ? data.trackGroups : [],
          clipLauncher: loadedClipLauncher,
          renderMetadata: loadedRenderMetadata,
          secondaryOutputEnabled: Boolean(data.secondaryOutputEnabled),
          secondaryOutputFormat:
            data.secondaryOutputFormat || freshProjectState.secondaryOutputFormat,
          secondaryOutputBitDepth:
            data.secondaryOutputBitDepth ?? freshProjectState.secondaryOutputBitDepth,
          onlineRender: Boolean(data.onlineRender),
          addToProjectAfterRender: Boolean(data.addToProjectAfterRender),
        });
        syncTempoMarkersToBackend(
          Array.isArray(data.tempoMarkers) ? data.tempoMarkers : [],
        );
        if (data.isMasterMuted) {
          await nativeBridge.setMasterVolume(0).catch(logBridgeError("sync"));
        }

        const totalTracks = data.tracks.length;
        for (let ti = 0; ti < totalTracks; ti++) {
          const trackData = data.tracks[ti];
          set({ projectLoadingMessage: `Loading track ${ti + 1}/${totalTracks}: ${trackData.name}` });
          await new Promise((r) => setTimeout(r, 0));

          console.log("Loading track:", trackData.name, trackData.id);

          try {
            await nativeBridge.addTrack(trackData.id);
            await nativeBridge.setTrackVolume(trackData.id, trackData.volumeDB);
            await nativeBridge.setTrackPan(trackData.id, trackData.pan);

            if (trackData.muted)
              await nativeBridge.setTrackMute(trackData.id, true);
            if (trackData.soloed)
              await nativeBridge.setTrackSolo(trackData.id, true);
            if (trackData.armed)
              await nativeBridge.setTrackRecordArm(trackData.id, true);
            if (trackData.monitorEnabled)
              await nativeBridge.setTrackInputMonitoring(trackData.id, true);

            const inputStartCh = trackData.inputStartChannel ?? 0;
            const inputChCount = trackData.inputChannelCount ?? 2;
            await nativeBridge.setTrackInputChannels(
              trackData.id,
              inputStartCh,
              inputChCount,
            );

            if (trackData.clips) {
              for (const clip of trackData.clips) {
                if (clip.filePath) {
                  await nativeBridge.addPlaybackClip(
                    trackData.id,
                    clip.filePath,
                    clip.startTime,
                    clip.duration,
                    clip.offset || 0,
                    clip.volumeDB || 0,
                    clip.fadeIn || 0,
                    clip.fadeOut || 0,
                    clip.id,
                    clip.pitchCorrectionSourceFilePath,
                    clip.pitchCorrectionSourceOffset,
                  );
                }
              }
            }

            console.log(`[DEBUG LOAD] Track "${trackData.name}" FX data from file: bypassFX=${bypassFX}, inputFXPaths=${JSON.stringify(trackData.inputFXPaths || "MISSING")}, trackFXPaths=${JSON.stringify(trackData.trackFXPaths || "MISSING")}`);
            let inputFxRestored = 0;
            if (!bypassFX && trackData.inputFXPaths && trackData.inputFXPaths.length > 0) {
              set({ projectLoadingMessage: `Restoring input FX for ${trackData.name}...` });
              await new Promise((r) => setTimeout(r, 0));
              for (let i = 0; i < trackData.inputFXPaths.length; i++) {
                console.log(`[DEBUG LOAD]   Restoring input FX[${i}]: "${trackData.inputFXPaths[i]}"`);
                const success = await nativeBridge.addTrackInputFX(trackData.id, trackData.inputFXPaths[i], false);
                console.log(`[DEBUG LOAD]   addTrackInputFX result: ${success}`);
                if (success) {
                  if (trackData.inputFXStates && trackData.inputFXStates[i]) {
                    const stateResult = await nativeBridge.setPluginState(trackData.id, i, true, trackData.inputFXStates[i]);
                    console.log(`[DEBUG LOAD]   setPluginState(input) result: ${stateResult}`);
                  }
                  inputFxRestored++;
                }
              }
            }

            let trackFxRestored = 0;
            if (!bypassFX && trackData.trackFXPaths && trackData.trackFXPaths.length > 0) {
              set({ projectLoadingMessage: `Restoring track FX for ${trackData.name}...` });
              await new Promise((r) => setTimeout(r, 0));
              for (let i = 0; i < trackData.trackFXPaths.length; i++) {
                console.log(`[DEBUG LOAD]   Restoring track FX[${i}]: "${trackData.trackFXPaths[i]}"`);
                const success = await nativeBridge.addTrackFX(trackData.id, trackData.trackFXPaths[i], false);
                console.log(`[DEBUG LOAD]   addTrackFX result: ${success}`);
                if (success) {
                  if (trackData.trackFXStates && trackData.trackFXStates[i]) {
                    const stateResult = await nativeBridge.setPluginState(trackData.id, i, false, trackData.trackFXStates[i]);
                    console.log(`[DEBUG LOAD]   setPluginState(track) result: ${stateResult}`);
                  }
                  trackFxRestored++;
                }
              }
            }

            console.log(`[DEBUG LOAD] Track "${trackData.name}" restored ${inputFxRestored} input FX and ${trackFxRestored} track FX`);

            const frontendTrack: Track = {
              ...trackData,
              clips: trackData.clips || [],
              midiClips: trackData.midiClips || [],
              automationLanes: trackData.automationLanes || [],
              meterLevel: 0,
              peakLevel: 0,
              clipping: false,
              suspendedAutomationState: null,
            };

            set((state) => ({ tracks: [...state.tracks, frontendTrack] }));
          } catch (trackError) {
            console.error(`[DEBUG LOAD] Failed to load track "${trackData.name}"`, trackError);
          }
        }

        let restoredMasterFxCount = 0;
        if (!bypassFX && data.masterFXPaths && data.masterFXPaths.length > 0) {
          set({ projectLoadingMessage: "Restoring master FX..." });
          await new Promise((r) => setTimeout(r, 0));
          for (let i = 0; i < data.masterFXPaths.length; i++) {
            const success = await nativeBridge.addMasterFX(data.masterFXPaths[i]);
            if (success && data.masterFXStates && data.masterFXStates[i]) {
              await nativeBridge.setMasterPluginState(i, data.masterFXStates[i]);
            }
            if (success) {
              restoredMasterFxCount++;
            }
          }
        }

        set({ masterFxCount: restoredMasterFxCount });
        for (const lane of get().masterAutomationLanes) {
          syncAutomationLaneToBackend("master", lane);
        }

        if (data.undoHistory) {
          commandManager.deserialize(data.undoHistory);
          set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
        }

        set((ctx) => {
          const newRecent = [
            path,
            ...ctx.recentProjects.filter((p) => p !== path),
          ].slice(0, 10);

          return {
            projectPath: path,
            isModified: false,
            recentProjects: newRecent,
          };
        });
        localStorage.setItem("recentProjects", JSON.stringify(get().recentProjects));

        set({ projectLoadingMessage: "Checking media files..." });
        await new Promise((r) => setTimeout(r, 0));
        const missingFiles: Array<{ path: string; clipIds: string[] }> = [];
        const checkedPaths = new Map<string, boolean>();
        for (const track of get().tracks) {
          for (const clip of track.clips) {
            if (!clip.filePath) continue;
            if (!checkedPaths.has(clip.filePath)) {
              const exists = await nativeBridge.fileExists(clip.filePath).catch(() => true);
              checkedPaths.set(clip.filePath, exists);
            }
            if (!checkedPaths.get(clip.filePath)) {
              const existing = missingFiles.find((entry) => entry.path === clip.filePath);
              if (existing) {
                existing.clipIds.push(clip.id);
              } else {
                missingFiles.push({ path: clip.filePath, clipIds: [clip.id] });
              }
            }
          }
        }
        if (missingFiles.length > 0) {
          set({ showMissingMedia: true, missingMediaFiles: missingFiles });
        }

        set({ isProjectLoading: false, projectLoadingMessage: "" });
        get().showToast(`Loaded project "${data.projectName || "Untitled Project"}"`, "success");
        return true;
      } catch (e) {
        console.error("[loadProject]", e);
        set({ isProjectLoading: false, projectLoadingMessage: "" });
        get().showToast("Failed to load project: " + String(e), "error");
        return false;
      }
    },


    saveAsTemplate: (name: string) => {
      const state = get();
      // Capture track layout without clips
      const templateTracks = state.tracks.map((t) => ({
        ...t,
        clips: [],        // No clips in templates
        midiClips: [],     // No MIDI clips
        takes: [],         // No takes
        meterLevel: 0,
        peakLevel: 0,
        clipping: false,
      }));

      const template: ProjectTemplate = {
        name,
        tracks: templateTracks,
        masterVolume: state.masterVolume,
        masterPan: state.masterPan,
        tempo: state.transport.tempo,
        timeSignature: { ...state.timeSignature },
      };

      set((s) => {
        const updated = [...s.projectTemplates, template];
        localStorage.setItem("s13_projectTemplates", JSON.stringify(updated));
        return { projectTemplates: updated };
      });
      get().showToast(`Template "${name}" saved`, "success");
    },

    loadTemplate: (index: number) => {
      const state = get();
      const template = state.projectTemplates[index];
      if (!template) return;

      // Capture old state for undo
      const oldTracks = JSON.parse(JSON.stringify(state.tracks)) as Track[];
      const oldMasterVolume = state.masterVolume;
      const oldMasterPan = state.masterPan;
      const oldTempo = state.transport.tempo;
      const oldTimeSig = { ...state.timeSignature };

      const command: Command = {
        type: "LOAD_TEMPLATE",
        description: `Load template "${template.name}"`,
        timestamp: Date.now(),
        execute: async () => {
          // Clear current project
          await get().newProject();

          // Restore global settings from template
          get().setTempo(template.tempo);
          get().setTimeSignature(template.timeSignature.numerator, template.timeSignature.denominator);
          get().setMasterVolume(template.masterVolume);
          get().setMasterPan(template.masterPan);

          // Add template tracks (skip undo for individual tracks during template load)
          for (const trackData of template.tracks) {
            const newId = crypto.randomUUID();
            const newTrack = {
              ...trackData,
              id: newId,
              clips: [],
              midiClips: [],
              takes: [],
              meterLevel: 0,
              peakLevel: 0,
              clipping: false,
            };
            set((s) => ({ tracks: [...s.tracks, newTrack] }));
            nativeBridge.addTrack(newId).catch(logBridgeError("sync"));
            // Sync track properties to backend
            nativeBridge.setTrackVolume(newId, trackData.volumeDB).catch(logBridgeError("sync"));
            nativeBridge.setTrackPan(newId, trackData.pan).catch(logBridgeError("sync"));
            if (trackData.muted) nativeBridge.setTrackMute(newId, true).catch(logBridgeError("sync"));
            if (trackData.soloed) nativeBridge.setTrackSolo(newId, true).catch(logBridgeError("sync"));
          }

          set({ isModified: true });
          get().showToast(`Loaded template "${template.name}"`, "success");
        },
        undo: async () => {
          // Clear current project
          const currentTracks = get().tracks;
          for (let i = currentTracks.length - 1; i >= 0; i--) {
            await nativeBridge.removeTrack(currentTracks[i].id).catch(logBridgeError("sync"));
          }

          // Restore old state
          set({
            tracks: oldTracks,
            masterVolume: oldMasterVolume,
            masterPan: oldMasterPan,
            transport: { ...get().transport, tempo: oldTempo },
            timeSignature: oldTimeSig,
          });

          // Sync old tracks to backend
          for (const t of oldTracks) {
            await nativeBridge.addTrack(t.id).catch(logBridgeError("sync"));
            nativeBridge.setTrackVolume(t.id, t.volumeDB).catch(logBridgeError("sync"));
            nativeBridge.setTrackPan(t.id, t.pan).catch(logBridgeError("sync"));
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    deleteTemplate: (index: number) => {
      set((s) => {
        const updated = s.projectTemplates.filter((_, i) => i !== index);
        localStorage.setItem("s13_projectTemplates", JSON.stringify(updated));
        return { projectTemplates: updated };
      });
    },

    // toggleProjectCompare → store/actions/uiState.ts

    compareWithSavedProject: async () => {
      const state = get();
      const filePath = state.projectPath;
      if (!filePath) {
        set({ projectCompareData: { tracksDiff: [], clipsDiff: [], settingsDiff: [{ field: "Project", oldValue: "-", newValue: "Project has not been saved yet" }] } });
        set({ showProjectCompare: true });
        return;
      }

      try {
        const json = await nativeBridge.loadProjectFromFile(filePath);
        if (!json) {
          get().showToast("Could not read saved project file", "error");
          return;
        }
        const saved = JSON.parse(json);

        // --- Settings diff ---
        const settingsDiff: Array<{ field: string; oldValue: string; newValue: string }> = [];
        if (saved.projectName !== state.projectName) {
          settingsDiff.push({ field: "Project Name", oldValue: saved.projectName || "", newValue: state.projectName });
        }
        if ((saved.tempo || 120) !== state.transport.tempo) {
          settingsDiff.push({ field: "Tempo (BPM)", oldValue: String(saved.tempo || 120), newValue: String(state.transport.tempo) });
        }
        if (saved.timeSignature) {
          const savedTS = `${saved.timeSignature.numerator}/${saved.timeSignature.denominator}`;
          const currentTS = `${state.timeSignature.numerator}/${state.timeSignature.denominator}`;
          if (savedTS !== currentTS) {
            settingsDiff.push({ field: "Time Signature", oldValue: savedTS, newValue: currentTS });
          }
        }
        if ((saved.masterVolume ?? 1.0) !== state.masterVolume) {
          settingsDiff.push({ field: "Master Volume", oldValue: String(saved.masterVolume ?? 1.0), newValue: String(state.masterVolume) });
        }
        if ((saved.masterPan ?? 0.0) !== state.masterPan) {
          settingsDiff.push({ field: "Master Pan", oldValue: String(saved.masterPan ?? 0.0), newValue: String(state.masterPan) });
        }
        if ((saved.projectSampleRate || 44100) !== state.projectSampleRate) {
          settingsDiff.push({ field: "Sample Rate", oldValue: String(saved.projectSampleRate || 44100), newValue: String(state.projectSampleRate) });
        }
        if ((saved.projectBitDepth || 24) !== state.projectBitDepth) {
          settingsDiff.push({ field: "Bit Depth", oldValue: String(saved.projectBitDepth || 24), newValue: String(state.projectBitDepth) });
        }
        if ((saved.processingPrecision || "float32") !== state.processingPrecision) {
          settingsDiff.push({ field: "Processing Precision", oldValue: String(saved.processingPrecision || "float32"), newValue: String(state.processingPrecision) });
        }

        // --- Tracks diff ---
        const savedTrackMap = new Map<string, any>();
        for (const t of saved.tracks || []) savedTrackMap.set(t.id, t);
        const currentTrackMap = new Map<string, any>();
        for (const t of state.tracks) currentTrackMap.set(t.id, t);

        const tracksDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; details?: string }> = [];

        // Added tracks (in current but not saved)
        for (const t of state.tracks) {
          if (!savedTrackMap.has(t.id)) {
            tracksDiff.push({ type: "added", id: t.id, name: t.name });
          }
        }
        // Removed tracks (in saved but not current)
        for (const t of saved.tracks || []) {
          if (!currentTrackMap.has(t.id)) {
            tracksDiff.push({ type: "removed", id: t.id, name: t.name });
          }
        }
        // Modified tracks
        for (const t of state.tracks) {
          const st = savedTrackMap.get(t.id);
          if (!st) continue;
          const changes: string[] = [];
          if (st.name !== t.name) changes.push(`renamed: "${st.name}" -> "${t.name}"`);
          if (st.volumeDB !== t.volumeDB) changes.push(`volume: ${st.volumeDB}dB -> ${t.volumeDB}dB`);
          if (st.pan !== t.pan) changes.push(`pan: ${st.pan} -> ${t.pan}`);
          if (st.muted !== t.muted) changes.push(`muted: ${st.muted} -> ${t.muted}`);
          if (st.soloed !== t.soloed) changes.push(`soloed: ${st.soloed} -> ${t.soloed}`);
          if (changes.length > 0) {
            tracksDiff.push({ type: "modified", id: t.id, name: t.name, details: changes.join(", ") });
          }
        }

        // --- Clips diff ---
        const clipsDiff: Array<{ type: "added" | "removed" | "modified"; id: string; name: string; trackName: string; details?: string }> = [];

        // Build clip maps: clipId -> { clip, trackName }
        const savedClipMap = new Map<string, { clip: any; trackName: string }>();
        for (const t of saved.tracks || []) {
          for (const c of t.clips || []) {
            savedClipMap.set(c.id, { clip: c, trackName: t.name });
          }
        }
        const currentClipMap = new Map<string, { clip: any; trackName: string }>();
        for (const t of state.tracks) {
          for (const c of t.clips || []) {
            currentClipMap.set(c.id, { clip: c, trackName: t.name });
          }
        }

        // Added clips
        for (const [id, { clip, trackName }] of currentClipMap) {
          if (!savedClipMap.has(id)) {
            clipsDiff.push({ type: "added", id, name: clip.name || clip.filePath?.split(/[/\\]/).pop() || id, trackName });
          }
        }
        // Removed clips
        for (const [id, { clip, trackName }] of savedClipMap) {
          if (!currentClipMap.has(id)) {
            clipsDiff.push({ type: "removed", id, name: clip.name || clip.filePath?.split(/[/\\]/).pop() || id, trackName });
          }
        }
        // Modified clips
        for (const [id, { clip: cur, trackName }] of currentClipMap) {
          const saved = savedClipMap.get(id);
          if (!saved) continue;
          const sc = saved.clip;
          const changes: string[] = [];
          if (Math.abs((sc.startTime || 0) - (cur.startTime || 0)) > 0.001) changes.push(`moved: ${sc.startTime?.toFixed(3)}s -> ${cur.startTime?.toFixed(3)}s`);
          if (Math.abs((sc.duration || 0) - (cur.duration || 0)) > 0.001) changes.push(`duration: ${sc.duration?.toFixed(3)}s -> ${cur.duration?.toFixed(3)}s`);
          if ((sc.volumeDB || 0) !== (cur.volumeDB || 0)) changes.push(`volume: ${sc.volumeDB || 0}dB -> ${cur.volumeDB || 0}dB`);
          if (sc.muted !== cur.muted) changes.push(`muted: ${sc.muted} -> ${cur.muted}`);
          if (changes.length > 0) {
            clipsDiff.push({ type: "modified", id, name: cur.name || cur.filePath?.split(/[/\\]/).pop() || id, trackName, details: changes.join(", ") });
          }
        }

        set({ projectCompareData: { tracksDiff, clipsDiff, settingsDiff }, showProjectCompare: true });
      } catch (e) {
        console.error("[compareWithSavedProject]", e);
        get().showToast("Failed to compare project: " + String(e), "error");
      }
    },

    // ========== Collaborative Metadata ==========
    setProjectAuthor: (author) => {
      set({ projectAuthor: author, isModified: true });
    },
    addRevisionNote: (note) => {
      set((s) => ({
        projectRevisionNotes: [...s.projectRevisionNotes, { date: new Date().toISOString(), note }],
        isModified: true,
      }));
    },
    deleteRevisionNote: (index) => {
      set((s) => ({
        projectRevisionNotes: s.projectRevisionNotes.filter((_, i) => i !== index),
        isModified: true,
      }));
    },
});
