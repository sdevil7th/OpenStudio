import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useShallow } from "zustand/shallow";
import { X } from "lucide-react";
import { nativeBridge, type NativeGlobalShortcutEvent } from "./services/NativeBridge";
import { getGlobalShortcutConflicts } from "./store/actionRegistry";
import {
  useDAWStore,
  getEffectiveTrackHeight,
  BOTTOM_INTERACTION_BUFFER,
  DEFAULT_HORIZONTAL_SCROLLBAR_HEIGHT,
  getMasterTrackHeaderHeight,
} from "./store/useDAWStore";
import { dispatchGlobalShortcut } from "./utils/globalShortcutDispatcher";
import {
  publishCurrentMixerUISnapshot,
  startMixerUISync,
} from "./utils/mixerWindowSync";
import { Button } from "./components/ui";
import { Timeline } from "./components/Timeline";
import { TimelineRuler } from "./components/TimelineRuler";
import { MixerPanel } from "./components/MixerPanel";
import { MainToolbar } from "./components/MainToolbar";
import { TransportBar as BottomTransportBar } from "./components/TransportBar";
import { MenuBar } from "./components/MenuBar";
import { MasterTrackHeader } from "./components/MasterTrackHeader";
import { ProjectTabBar } from "./components/ProjectTabBar";
import { CustomToolbarStrip } from "./components/ToolbarEditor";
import { SortableTrackHeader } from "./components/SortableTrackHeader";
import { AddMultipleTracksModal } from "./components/AddMultipleTracksModal";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { EssentialControlsCard } from "./components/EssentialControlsCard";
import { UnsavedChangesDialog } from "./components/UnsavedChangesDialog";
import {
  createMultipleTracks,
  createTrackOfType,
  type InsertableTrackType,
} from "./utils/trackCreation";

const SettingsModal = React.lazy(() => import("./components/SettingsModal").then(m => ({ default: m.SettingsModal })));
const ProjectSettingsModal = React.lazy(() => import("./components/ProjectSettingsModal").then(m => ({ default: m.ProjectSettingsModal })));
const RenderModal = React.lazy(() => import("./components/RenderModal").then(m => ({ default: m.RenderModal })));
const VirtualPianoKeyboard = React.lazy(() => import("./components/VirtualPianoKeyboard").then(m => ({ default: m.VirtualPianoKeyboard })));
const PianoRoll = React.lazy(() => import("./components/PianoRoll").then(m => ({ default: m.PianoRoll })));
const UndoHistoryPanel = React.lazy(() => import("./components/UndoHistoryPanel").then(m => ({ default: m.UndoHistoryPanel })));
const CommandPalette = React.lazy(() => import("./components/CommandPalette").then(m => ({ default: m.CommandPalette })));
const RegionMarkerManager = React.lazy(() => import("./components/RegionMarkerManager").then(m => ({ default: m.RegionMarkerManager })));
const ClipPropertiesPanel = React.lazy(() => import("./components/ClipPropertiesPanel").then(m => ({ default: m.ClipPropertiesPanel })));
const BigClock = React.lazy(() => import("./components/BigClock").then(m => ({ default: m.BigClock })));
const KeyboardShortcutsModal = React.lazy(() => import("./components/KeyboardShortcutsModal").then(m => ({ default: m.KeyboardShortcutsModal })));
const PreferencesModal = React.lazy(() => import("./components/PreferencesModal").then(m => ({ default: m.PreferencesModal })));
const RenderQueuePanel = React.lazy(() => import("./components/RenderQueuePanel").then(m => ({ default: m.RenderQueuePanel })));
const DynamicSplitModal = React.lazy(() => import("./components/DynamicSplitModal").then(m => ({ default: m.DynamicSplitModal })));
const RegionRenderMatrix = React.lazy(() => import("./components/RegionRenderMatrix").then(m => ({ default: m.RegionRenderMatrix })));
const RoutingMatrix = React.lazy(() => import("./components/RoutingMatrix").then(m => ({ default: m.RoutingMatrix })));
const MediaExplorer = React.lazy(() => import("./components/MediaExplorer").then(m => ({ default: m.MediaExplorer })));
const CleanProjectModal = React.lazy(() => import("./components/CleanProjectModal").then(m => ({ default: m.CleanProjectModal })));
const BatchConverterModal = React.lazy(() => import("./components/BatchConverterModal").then(m => ({ default: m.BatchConverterModal })));
const CrossfadeEditor = React.lazy(() => import("./components/CrossfadeEditor").then(m => ({ default: m.CrossfadeEditor })));
const ThemeEditor = React.lazy(() => import("./components/ThemeEditor").then(m => ({ default: m.ThemeEditor })));
const VideoWindow = React.lazy(() => import("./components/VideoWindow").then(m => ({ default: m.VideoWindow })));
const ScriptEditor = React.lazy(() => import("./components/ScriptEditor").then(m => ({ default: m.ScriptEditor })));
const PitchEditorLowerZone = React.lazy(() => import("./components/PitchEditorLowerZone").then(m => ({ default: m.PitchEditorLowerZone })));
const ToolbarEditor = React.lazy(() => import("./components/ToolbarEditor").then(m => ({ default: m.ToolbarEditor })));
const DDPExportModal = React.lazy(() => import("./components/DDPExportModal").then(m => ({ default: m.DDPExportModal })));
const ProjectCompareModal = React.lazy(() => import("./components/ProjectCompareModal").then(m => ({ default: m.ProjectCompareModal })));
const PluginBrowser = React.lazy(() => import("./components/PluginBrowser").then(m => ({ default: m.PluginBrowser })));
const EnvelopeManagerModal = React.lazy(() => import("./components/EnvelopeManagerModal").then(m => ({ default: m.EnvelopeManagerModal })));
const ChannelStripEQModal = React.lazy(() => import("./components/ChannelStripEQModal").then(m => ({ default: m.ChannelStripEQModal })));
const TrackRoutingModal = React.lazy(() => import("./components/TrackRoutingModal").then(m => ({ default: m.TrackRoutingModal })));
const ClipLauncherView = React.lazy(() => import("./components/ClipLauncherView").then(m => ({ default: m.ClipLauncherView })));
const MissingMediaResolver = React.lazy(() => import("./components/MissingMediaResolver").then(m => ({ default: m.MissingMediaResolver })));
const TimecodeSettingsPanel = React.lazy(() => import("./components/TimecodeSettingsPanel").then(m => ({ default: m.TimecodeSettingsPanel })));
const HelpOverlay = React.lazy(() => import("./components/HelpOverlay").then(m => ({ default: m.HelpOverlay })));
const GettingStartedGuide = React.lazy(() => import("./components/GettingStartedGuide").then(m => ({ default: m.GettingStartedGuide })));
const StemSeparationModal = React.lazy(() => import("./components/StemSeparationModal"));
const AiToolsSetupModal = React.lazy(() => import("./components/AiToolsSetupModal"));
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

function App() {
  // Use useShallow to prevent re-renders when unrelated state changes (like currentTime)
  const {
    tracks,
    addTrack,
    showMixer,
    showMasterTrackInTCP,
    toggleMasterTrackInTCP,
    toggleMixer,
    showSettings,
    showProjectSettings,
    showRenderModal,
    showVirtualKeyboard,
    openSettings,
    closeSettings,
    closeProjectSettings,
    closeRenderModal,
    batchUpdateMeterLevels,
    reorderTrack,
    setCurrentTime,
    showPianoRoll,
    pianoRollTrackId,
    pianoRollClipId,
    selectedClipIds,
    closePianoRoll,
    showUndoHistory,
    showCommandPalette,
    showRegionMarkerManager,
    showClipProperties,
    showBigClock,
    showKeyboardShortcuts,
    showPreferences,
    showRenderQueue,
    showDynamicSplit,
    showRegionRenderMatrix,
    showRoutingMatrix,
    showMediaExplorer,
    showCleanProject,
    showBatchConverter,
    showCrossfadeEditor,
    showThemeEditor,
    showScriptEditor,
    showPitchEditor,
    pitchEditorTrackId,
    pitchEditorClipId,
    showToolbarEditor,
    showDDPExport,
    showProjectCompare,
    showPluginBrowser,
    pluginBrowserTrackId,
    showEnvelopeManager,
    envelopeManagerTrackId,
    showChannelStripEQ,
    closeChannelStripEQ,
    showTrackRouting,
    closeTrackRouting,
    tcpWidth,
    setTcpWidth,
    detachedPanels,
    showClipLauncher,
    showTimecodeSettings,
    showContextualHelp,
    showGettingStarted,
    showMissingMedia,
    missingMediaFiles,
    masterAutomationLanes,
    showMasterAutomation,
    showStemSeparation,
    showAiToolsSetup,
  } = useDAWStore(
    useShallow((state) => ({
      tracks: state.tracks,
      addTrack: state.addTrack,
      showMixer: state.showMixer,
      showMasterTrackInTCP: state.showMasterTrackInTCP,
      toggleMasterTrackInTCP: state.toggleMasterTrackInTCP,
      toggleMixer: state.toggleMixer,
      showSettings: state.showSettings,
      showProjectSettings: state.showProjectSettings,
      showRenderModal: state.showRenderModal,
      showVirtualKeyboard: state.showVirtualKeyboard,
      openSettings: state.openSettings,
      closeSettings: state.closeSettings,
      closeProjectSettings: state.closeProjectSettings,
      closeRenderModal: state.closeRenderModal,
      batchUpdateMeterLevels: state.batchUpdateMeterLevels,
      reorderTrack: state.reorderTrack,
      setCurrentTime: state.setCurrentTime,
      showPianoRoll: state.showPianoRoll,
      pianoRollTrackId: state.pianoRollTrackId,
      pianoRollClipId: state.pianoRollClipId,
      selectedClipIds: state.selectedClipIds,
      closePianoRoll: state.closePianoRoll,
      showUndoHistory: state.showUndoHistory,
      showCommandPalette: state.showCommandPalette,
      showRegionMarkerManager: state.showRegionMarkerManager,
      showClipProperties: state.showClipProperties,
      showBigClock: state.showBigClock,
      showKeyboardShortcuts: state.showKeyboardShortcuts,
      showPreferences: state.showPreferences,
      showRenderQueue: state.showRenderQueue,
      showDynamicSplit: state.showDynamicSplit,
      showRegionRenderMatrix: state.showRegionRenderMatrix,
      showRoutingMatrix: state.showRoutingMatrix,
      showMediaExplorer: state.showMediaExplorer,
      showCleanProject: state.showCleanProject,
      showBatchConverter: state.showBatchConverter,
      showCrossfadeEditor: state.showCrossfadeEditor,
      showThemeEditor: state.showThemeEditor,
      showScriptEditor: state.showScriptEditor,
      showPitchEditor: state.showPitchEditor,
      pitchEditorTrackId: state.pitchEditorTrackId,
      pitchEditorClipId: state.pitchEditorClipId,
      showToolbarEditor: state.showToolbarEditor,
      showDDPExport: state.showDDPExport,
      showProjectCompare: state.showProjectCompare,
      showPluginBrowser: state.showPluginBrowser,
      pluginBrowserTrackId: state.pluginBrowserTrackId,
      showEnvelopeManager: state.showEnvelopeManager,
      envelopeManagerTrackId: state.envelopeManagerTrackId,
      showChannelStripEQ: state.showChannelStripEQ,
      closeChannelStripEQ: state.closeChannelStripEQ,
      showTrackRouting: state.showTrackRouting,
      closeTrackRouting: state.closeTrackRouting,
      tcpWidth: state.tcpWidth,
      setTcpWidth: state.setTcpWidth,
      detachedPanels: state.detachedPanels,
      showClipLauncher: state.showClipLauncher,
      showTimecodeSettings: state.showTimecodeSettings,
      showContextualHelp: state.showContextualHelp,
      showGettingStarted: state.showGettingStarted,
      showMissingMedia: state.showMissingMedia,
      missingMediaFiles: state.missingMediaFiles,
      masterAutomationLanes: state.masterAutomationLanes,
      showMasterAutomation: state.showMasterAutomation,
      showStemSeparation: state.showStemSeparation,
      showAiToolsSetup: state.showAiToolsSetup,
    }))
  );

  // Compute visible tracks — hides children of collapsed folder tracks
  const visibleTracks = useMemo(() => {
    const collapsedFolderIds = new Set<string>();
    for (const t of tracks) {
      if (t.isFolder && t.folderCollapsed) collapsedFolderIds.add(t.id);
    }
    if (collapsedFolderIds.size === 0) return tracks;
    return tracks.filter((t) => {
      let current = t;
      while (current.parentFolderId) {
        if (collapsedFolderIds.has(current.parentFolderId)) return false;
        const parent = tracks.find((p) => p.id === current.parentFolderId);
        if (!parent) break;
        current = parent;
      }
      return true;
    });
  }, [tracks]);

  // Ref for workspace wheel handling
  const workspaceRef = useRef<HTMLDivElement>(null);

  // OS file drag-drop visual indicator
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragCounterRef = useRef(0);
  const hideMixerOnCloseRef = useRef(false);
  const isMixerDetached = detachedPanels.includes("mixer");

  // Project loading state (separate selector to avoid unnecessary re-renders)
  const isProjectLoading = useDAWStore((state) => state.isProjectLoading);
  const projectLoadingMessage = useDAWStore((state) => state.projectLoadingMessage);

  // Toast notification state
  const toastVisible = useDAWStore((state) => state.toastVisible);
  const toastMessage = useDAWStore((state) => state.toastMessage);
  const toastType = useDAWStore((state) => state.toastType);

  // Subscribe only to isPlaying to avoid re-rendering App on every time update
  const isPlaying = useDAWStore((state) => state.transport.isPlaying);
  const aiToolsStatus = useDAWStore((state) => state.aiToolsStatus);
  const aiToolsStatusLastUpdatedAt = useDAWStore((state) => state.aiToolsStatusLastUpdatedAt);
  const refreshAiToolsStatus = useDAWStore((state) => state.refreshAiToolsStatus);
  const applyAiToolsStatusUpdate = useDAWStore((state) => state.applyAiToolsStatusUpdate);
  const cancelAiToolsInstall = useDAWStore((state) => state.cancelAiToolsInstall);
  const openAiToolsSetup = useDAWStore((state) => state.openAiToolsSetup);
  const showToast = useDAWStore((state) => state.showToast);
  const previousAiToolsStateRef = useRef(aiToolsStatus.state);
  const previousAiToolsInstallInProgressRef = useRef(aiToolsStatus.installInProgress);
  const [showAiToolsInstallBlocker, setShowAiToolsInstallBlocker] = useState(false);

  useEffect(() => startMixerUISync(), []);

  useEffect(() => {
    void refreshAiToolsStatus(true);
  }, [refreshAiToolsStatus]);

  useEffect(() => {
    const unsubscribe = nativeBridge.onAiToolsStatusUpdate((status) => {
      applyAiToolsStatusUpdate(status);
    });

    return () => unsubscribe();
  }, [applyAiToolsStatusUpdate]);

  useEffect(() => {
    const shouldPollAiToolsStatus = aiToolsStatus.state === "checking";

    if (!shouldPollAiToolsStatus) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshAiToolsStatus();
    }, 1500);

    return () => window.clearInterval(timer);
  }, [aiToolsStatus.installInProgress, aiToolsStatus.state, refreshAiToolsStatus]);

  useEffect(() => {
    if (!aiToolsStatus.installInProgress) {
      setShowAiToolsInstallBlocker(false);
      return;
    }

    const timer = window.setInterval(() => {
      const staleMs = Date.now() - aiToolsStatusLastUpdatedAt;
      setShowAiToolsInstallBlocker(staleMs >= 8000);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [aiToolsStatus.installInProgress, aiToolsStatusLastUpdatedAt]);

  useEffect(() => {
    const previousState = previousAiToolsStateRef.current;
    const previousInstallInProgress = previousAiToolsInstallInProgressRef.current;
    const currentState = aiToolsStatus.state;
    const installAttemptStates = new Set([
      "checking",
      "fetching_runtime_manifest",
      "downloading_runtime",
      "verifying_runtime_archive",
      "extracting_runtime",
      "installing",
      "creating_venv",
      "verifying_runtime",
      "probing_runtime",
      "downloading_model",
    ]);
    const wasInstallAttempt = previousInstallInProgress || installAttemptStates.has(previousState);

    if (previousState !== currentState) {
      if (currentState === "ready") {
        showToast("AI tools are ready", "success");
      } else if (currentState === "error" && aiToolsStatus.error) {
        showToast(aiToolsStatus.error, "error");
        if (wasInstallAttempt) {
          openAiToolsSetup();
        }
      } else if (currentState === "cancelled") {
        showToast("AI tools installation cancelled", "info");
        if (wasInstallAttempt) {
          openAiToolsSetup();
        }
      } else if (currentState === "pythonMissing" && wasInstallAttempt) {
        openAiToolsSetup();
      }
    }

    previousAiToolsStateRef.current = currentState;
    previousAiToolsInstallInProgressRef.current = aiToolsStatus.installInProgress;
  }, [aiToolsStatus.error, aiToolsStatus.installInProgress, aiToolsStatus.state, openAiToolsSetup, showToast]);

  useEffect(() => {
    const unsubscribe = nativeBridge.subscribe("mixerWindowClosed", (data) => {
      const bounds = data?.bounds;
      const shouldHideMixer = hideMixerOnCloseRef.current;
      hideMixerOnCloseRef.current = false;

      useDAWStore.setState((state) => ({
        showMixer: shouldHideMixer ? false : true,
        detachedPanels: state.detachedPanels.filter((id) => id !== "mixer"),
        panelPositions: {
          ...state.panelPositions,
          mixer: bounds
            ? {
                ...state.panelPositions.mixer,
                x: typeof bounds.x === "number" ? bounds.x : state.panelPositions.mixer.x,
                y: typeof bounds.y === "number" ? bounds.y : state.panelPositions.mixer.y,
                width:
                  typeof bounds.width === "number"
                    ? bounds.width
                    : state.panelPositions.mixer.width,
                height:
                  typeof bounds.height === "number"
                    ? bounds.height
                    : state.panelPositions.mixer.height,
                visible: !shouldHideMixer,
              }
            : state.panelPositions.mixer,
        },
      }));
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = nativeBridge.onAppCloseRequested(() => {
      void useDAWStore.getState().requestQuit();
    });

    return unsubscribe;
  }, []);

  const handleDetachMixer = useCallback(async () => {
    const state = useDAWStore.getState();
    const mixerBounds = state.panelPositions.mixer;

    await publishCurrentMixerUISnapshot();
    const opened = await nativeBridge.openMixerWindow({
      x: mixerBounds.x,
      y: mixerBounds.y,
      width: mixerBounds.width,
      height: mixerBounds.height,
    });

    if (!opened) {
      state.showToast("Unable to open the detached mixer window.", "error");
      return;
    }

    useDAWStore.setState((current) => ({
      showMixer: true,
      detachedPanels: current.detachedPanels.includes("mixer")
        ? current.detachedPanels
        : [...current.detachedPanels, "mixer"],
      panelPositions: {
        ...current.panelPositions,
        mixer: {
          ...current.panelPositions.mixer,
          visible: true,
        },
      },
    }));
  }, []);

  const handleToggleMixerVisibility = useCallback(async () => {
    if (isMixerDetached) {
      hideMixerOnCloseRef.current = true;
      await nativeBridge.closeMixerWindow();
      return;
    }

    toggleMixer();
  }, [isMixerDetached, toggleMixer]);

  // Accessibility: UI font scale — apply to root element
  const uiFontScale = useDAWStore((state) => state.uiFontScale);
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * uiFontScale}px`;
  }, [uiFontScale]);

  // Playback Loop - updates time smoothly at 60fps
  // Memoization in Timeline prevents expensive recalculations
  useEffect(() => {
    if (!isPlaying) return;

    let lastTime = performance.now();
    let lastAutoUpdate = 0; // throttle automation value updates to ~30fps
    let frameId: number;

    const loop = () => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const currentState = useDAWStore.getState();
      if (currentState.transport.isPlaying) {
        let newTime = currentState.transport.currentTime + dt;

        // Loop: wrap back to loopStart when reaching loopEnd
        const { loopEnabled, loopStart, loopEnd } = currentState.transport;
        if (loopEnabled && loopEnd > loopStart && newTime >= loopEnd) {
          console.log("[App] Playback loop wrap", {
            currentTime: currentState.transport.currentTime,
            newTime,
            loopStart,
            loopEnd,
          });
          newTime = loopStart + (newTime - loopEnd);
          // Sync backend position on loop wrap
          nativeBridge.setTransportPosition(newTime);
        }

        currentState.setCurrentTime(newTime);

        // Update automation display values at ~30fps (every ~33ms)
        if (now - lastAutoUpdate > 33) {
          lastAutoUpdate = now;
          currentState.updateAutomatedValues();
        }

        // Auto-scroll is handled by Timeline.tsx's subscription-based scroll
        // (scheduleScroll + RAF batching). Do NOT also scroll here — dual
        // auto-scroll causes conflicting setScroll calls every frame, which
        // is the primary source of playback jank.
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, setCurrentTime]);

  // Sync frontend playhead from backend transport position (10Hz).
  // The RAF loop above provides smooth 60fps interpolation, but drifts over time.
  // The backend's 10Hz transportUpdate corrects that drift, keeping the visual
  // playhead within ~100ms of the true audio position at all times.
  useEffect(() => {
    const unsub = nativeBridge.onTransportUpdate((data) => {
      const state = useDAWStore.getState();
      const backendPos = data.position;
      const frontendPos = state.transport.currentTime;
      const drift = Math.abs(backendPos - frontendPos);
      const backendPlaying = !!data.isPlaying;
      const frontendPlaying = state.transport.isPlaying;

      if (backendPlaying !== frontendPlaying) {
        useDAWStore.setState((current) => ({
          transport: {
            ...current.transport,
            isPlaying: backendPlaying,
            isPaused: false,
            isRecording: backendPlaying ? current.transport.isRecording : false,
            currentTime: backendPos,
          },
        }));
        return;
      }

      if (!frontendPlaying) return;

      // Only correct if drift exceeds 30ms — avoids jitter from minor timing differences
      if (drift > 0.03) {
        state.setCurrentTime(backendPos);
      }
    });

    return unsub;
  }, []);

  // Auto-save with rotating backups (Sprint 20.8)
  useEffect(() => {
    const state = useDAWStore.getState();
    if (!state.autoBackupEnabled) return;

    const interval = setInterval(async () => {
      const s = useDAWStore.getState();
      if (s.isModified && s.projectPath) {
        try {
          const ok = await s.saveProject(false);
          if (ok) console.log("[App] Auto-save completed");
        } catch {
          // Auto-save failure is non-critical
        }
      }
    }, state.autoBackupInterval);

    return () => clearInterval(interval);
  }, []);

  // Enhanced auto-save: uses autoSaveEnabled / autoSaveIntervalMinutes from store.
  // Reactively subscribes to changes so toggling or changing interval takes effect immediately.
  useEffect(() => {
    const unsubscribe = useDAWStore.subscribe(
      (state) => ({ enabled: state.autoSaveEnabled, minutes: state.autoSaveIntervalMinutes }),
      ({ enabled, minutes }) => {
        // Clear any previous timer first (handled below via closure)
        // This subscription just triggers re-evaluation; the actual timer is managed
        // by the outer effect dependencies.
        void enabled;
        void minutes;
      },
      { equalityFn: (a, b) => a.enabled === b.enabled && a.minutes === b.minutes },
    );
    return unsubscribe;
  }, []);

  // Separate interval effect for the improved auto-save
  const autoSaveEnabled = useDAWStore((s) => s.autoSaveEnabled);
  const autoSaveIntervalMinutes = useDAWStore((s) => s.autoSaveIntervalMinutes);

  useEffect(() => {
    if (!autoSaveEnabled) return;

    const intervalMs = autoSaveIntervalMinutes * 60 * 1000;
    const timerId = setInterval(async () => {
      const s = useDAWStore.getState();
      if (s.isModified && s.projectPath) {
        try {
          const ok = await s.saveProject(false);
          if (ok) console.log("[App] Auto-save completed");
        } catch {
          // Auto-save failure is non-critical
        }
      }
    }, intervalMs);

    return () => clearInterval(timerId);
  }, [autoSaveEnabled, autoSaveIntervalMinutes]);

  // Event-based metering — single batched store update for all tracks + master
  useEffect(() => {
    nativeBridge.onMeterUpdate((data) => {
      const trackLevels: Record<string, number> = data.trackLevels && typeof data.trackLevels === "object" && !Array.isArray(data.trackLevels)
        ? data.trackLevels
        : {};
      const trackClipping: Record<string, boolean> = data.trackClipping && typeof data.trackClipping === "object" && !Array.isArray(data.trackClipping)
        ? data.trackClipping
        : {};
      const masterLevel = typeof data.masterLevel === "number" ? data.masterLevel : 0;
      const masterClipping = data.masterClipping === true;
      batchUpdateMeterLevels(trackLevels, masterLevel, trackClipping, masterClipping);
    });
  }, [batchUpdateMeterLevels]);

  useEffect(() => {
    const conflicts = getGlobalShortcutConflicts();
    if (conflicts.length > 0) {
      console.warn("[shortcuts] conflicting global shortcuts detected", conflicts);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const openLaunchProject = async () => {
      const pendingProjectPath = await nativeBridge.consumePendingLaunchProjectPath();
      if (!pendingProjectPath || cancelled) return;

      const lowerPath = pendingProjectPath.toLowerCase();
      if (!lowerPath.endsWith(".osproj") && !lowerPath.endsWith(".s13")) return;

      try {
        const success = await useDAWStore.getState().requestOpenProject(pendingProjectPath);
        if (!success) {
          console.error("[App] Failed to open launch project:", pendingProjectPath);
        }
      } catch (error) {
        console.error("[App] Failed to consume launch project path:", error);
      }
    };

    void openLaunchProject();

    return () => {
      cancelled = true;
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      void dispatchGlobalShortcut({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        source: "browser",
        targetIsEditable:
          !!target &&
          (target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target.isContentEditable),
        preventDefault: () => e.preventDefault(),
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    const unsubscribeNativeShortcuts = nativeBridge.onNativeGlobalShortcut(
      (event: NativeGlobalShortcutEvent) => {
        void dispatchGlobalShortcut({ ...event, source: "pluginWindow" });
      },
    );

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      unsubscribeNativeShortcuts();
    };
  }, []);

  // Handle audio files dropped from OS file explorer via HTML5 drag-and-drop.
  // WebView2 intercepts OLE drag-drop before JUCE can see it, so we handle it
  // entirely in JS: read file data → send to C++ to save to disk → import.
  useEffect(() => {
    const MEDIA_EXTENSIONS = new Set([
      // Audio
      ".wav", ".mp3", ".flac", ".ogg", ".aiff", ".aif", ".wma", ".m4a", ".aac",
      // MIDI
      ".mid", ".midi",
      // Video (audio will be extracted via FFmpeg)
      ".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".m4v",
    ]);
    const MIDI_EXTENSIONS = new Set([".mid", ".midi"]);
    const MAX_DROP_SIZE = 500 * 1024 * 1024; // 500MB limit for base64 transfer

    const handleDragOver = (e: DragEvent) => {
      // Must preventDefault on dragover to allow the drop event to fire
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };

    // Use dragenter/dragleave counter to reliably track drag state across child elements
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) {
        // Only show overlay for external file drags (not internal Konva/dnd-kit drags)
        if (e.dataTransfer?.types?.includes("Files")) {
          setIsDraggingFiles(true);
        }
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current === 0) {
        setIsDraggingFiles(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Reset drag indicator
      dragCounterRef.current = 0;
      setIsDraggingFiles(false);

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      // Filter to supported media files
      const mediaFiles: File[] = [];
      for (const file of files) {
        const ext = "." + file.name.split(".").pop()?.toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) {
          if (file.size > MAX_DROP_SIZE) {
            console.warn(`[App] Skipping "${file.name}" — too large (${Math.round(file.size / 1024 / 1024)}MB, max ${MAX_DROP_SIZE / 1024 / 1024}MB)`);
            continue;
          }
          mediaFiles.push(file);
        }
      }

      if (mediaFiles.length === 0) return;
      console.log(`[App] ${mediaFiles.length} media file(s) dropped from OS`);

      for (const file of mediaFiles) {
        try {
          const ext = "." + file.name.split(".").pop()?.toLowerCase();
          const isMidi = MIDI_EXTENSIONS.has(ext);

          // Read file data and convert to base64 (chunked for performance)
          const arrayBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          const CHUNK = 0x8000; // 32KB chunks
          const chunks: string[] = [];
          for (let i = 0; i < bytes.length; i += CHUNK) {
            chunks.push(String.fromCodePoint(...bytes.subarray(i, i + CHUNK)));
          }
          const base64 = btoa(chunks.join(""));

          // Save to disk via C++ backend
          const savedPath = await nativeBridge.saveDroppedFile(file.name, base64);
          if (!savedPath) {
            console.error(`[App] Failed to save dropped file: ${file.name}`);
            continue;
          }

          // Create a new track for this file (MIDI track for .mid/.midi, audio track otherwise)
          const { tracks, transport, importMedia } = useDAWStore.getState();
          const result = await nativeBridge.addTrack();
          const trackId = typeof result === "string" ? result : `${Date.now()}`;
          const trackName = file.name.replace(/\.[^.]+$/, "");

          addTrack({
            id: trackId,
            name: trackName,
            type: isMidi ? "midi" : "audio",
            color: `hsl(${(tracks.length * 60) % 360}, 60%, 50%)`,
          } as any);

          // Import from the saved path
          await importMedia(savedPath, trackId, transport.currentTime);
          console.log(`[App] Imported dropped file: ${file.name} → track ${trackId} (${isMidi ? "MIDI" : "audio"})`);
        } catch (error) {
          console.error(`[App] Failed to import dropped file: ${file.name}`, error);
        }
      }
    };

    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("drop", handleDrop);
    };
  }, [addTrack]);

  // Track workspace bounds so the fixed-position tcp-master-overlay stays pinned
  // to the bottom of the visible TCP area regardless of scroll position.
  const [tcpOverlayBottom, setTcpOverlayBottom] = useState(0);
  const [tcpOverlayLeft, setTcpOverlayLeft] = useState(0);
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const updateOverlayPos = () => {
      const rect = workspace.getBoundingClientRect();
      setTcpOverlayBottom(window.innerHeight - rect.bottom);
      setTcpOverlayLeft(rect.left);
    };
    updateOverlayPos();
    const ro = new ResizeObserver(updateOverlayPos);
    ro.observe(workspace);
    return () => ro.disconnect();
  }, []);

  // Workspace wheel handler — only prevents browser default zoom (Ctrl+scroll).
  // Actual zoom logic is handled by Timeline's RAF-batched handler.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // Prevent browser zoom / native scroll — let Timeline handle the rest
        e.preventDefault();
      }
    };

    workspace.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => workspace.removeEventListener("wheel", handleWheel, { capture: true });
  }, []);

  const [showAddMultipleTracksModal, setShowAddMultipleTracksModal] =
    useState(false);
  const [addMultipleTracksType, setAddMultipleTracksType] =
    useState<InsertableTrackType>("audio");
  const [tcpContextMenu, setTcpContextMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);

  const visibleMasterLaneCount = useMemo(
    () =>
      showMasterAutomation
        ? masterAutomationLanes.filter((lane) => lane.visible).length
        : 0,
    [masterAutomationLanes, showMasterAutomation],
  );
  const masterFooterHeight = showMasterTrackInTCP
    ? getMasterTrackHeaderHeight(visibleMasterLaneCount)
    : DEFAULT_HORIZONTAL_SCROLLBAR_HEIGHT;
  const tcpBottomSpacerHeight =
    masterFooterHeight + BOTTOM_INTERACTION_BUFFER;

  const handleAddTrack = async () => {
    await createTrackOfType("audio");
  };

  const openAddMultipleTracksModal = (type: InsertableTrackType = "audio") => {
    setAddMultipleTracksType(type);
    setShowAddMultipleTracksModal(true);
  };

  const handleAddMultipleTracks = async (config: {
    count: number;
    trackType: InsertableTrackType;
    namingPrefix: string;
  }) => {
    await createMultipleTracks(
      config.count,
      config.trackType,
      config.namingPrefix,
    );
  };

  const openTcpContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setTcpContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: "Add Track",
          onClick: () => {
            void createTrackOfType("audio");
          },
        },
        {
          label: "Add Multiple Tracks...",
          onClick: () => openAddMultipleTracksModal("audio"),
        },
        { divider: true, label: "" },
        {
          label: "Add Instrument Track",
          onClick: () => {
            void createTrackOfType("instrument");
          },
        },
        {
          label: "Add MIDI Track",
          onClick: () => {
            void createTrackOfType("midi");
          },
        },
        { divider: true, label: "" },
        {
          label: showMasterTrackInTCP
            ? "Hide Master Track in TCP"
            : "Show Master Track in TCP",
          onClick: () => toggleMasterTrackInTCP(),
        },
      ],
    });
  };

  // Drag and Drop Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement to start drag (prevents accidental drags on clicks)
      },
    }),
  );

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const handleDragStart = (event: any) => {
    setActiveDragId(event.active.id.toString());
  };

  const handleDragEnd = (event: any) => {
    setActiveDragId(null);
    const { active, over } = event;

    if (active && over && active.id !== over.id) {
      const { selectedTrackIds, reorderMultipleTracks } = useDAWStore.getState();
      // If multiple tracks are selected and the dragged one is among them, move all together
      if (selectedTrackIds.length > 1 && selectedTrackIds.includes(active.id.toString())) {
        reorderMultipleTracks(selectedTrackIds, over.id.toString());
      } else {
        reorderTrack(active.id, over.id);
      }
    }
  };

  return (
    <div className="app-container">
      {/* Project Tab Bar (Phase 15C) */}
      <ProjectTabBar />
      {/* Menu Bar */}
      <div role="banner">
        <MenuBar />
      </div>
      {/* Main Toolbar with Mixer Toggle */}
      <MainToolbar
        onOpenSettings={openSettings}
        onToggleMixer={() => { void handleToggleMixerVisibility(); }}
        showMixer={showMixer || isMixerDetached}
      />

      {/* Custom Toolbars (Phase 15D) */}
      <CustomToolbarStrip />

      {/* Media Explorer (left panel) + Main Workspace */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {showMediaExplorer && (
        <Suspense fallback={null}>
          <MediaExplorer
            isVisible={showMediaExplorer}
            onClose={() => useDAWStore.getState().toggleMediaExplorer()}
          />
        </Suspense>
      )}
      <div ref={workspaceRef} className="workspace relative flex-1" role="main" aria-label="Main workspace">
        <EssentialControlsCard />
        <div className="workspace-sticky-header">
          <div className="workspace-sticky-tcp-header" style={{ width: tcpWidth }}>
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddTrack}
              className="add-track-btn"
              aria-label="Add new audio track"
            >
              + Add Track
            </Button>
          </div>
          <div className="workspace-sticky-resize-spacer" aria-hidden="true" />
          <TimelineRuler />
        </div>
        <div className="workspace-main-row">

        {/* Track Control Panel (Left Sidebar) */}
        <div className="track-control-panel" role="region" aria-label="Track control panel" style={{ width: tcpWidth }} onClick={(e) => {
          // Click on empty space (not a track header) → deselect all
          if (e.target === e.currentTarget) {
            useDAWStore.getState().deselectAllTracks();
          }
        }} onWheel={(e) => {
          // Alt+scroll to resize track height (mirrors Timeline behavior)
          if (e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            const store = useDAWStore.getState();
            const curHeight = store.trackHeight;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            store.setTrackHeight(curHeight * delta);
          }
        }}>
          <div className="tcp-tracks z-20 min-h-0" onClick={(e) => {
            if (e.target === e.currentTarget) {
              useDAWStore.getState().deselectAllTracks();
            }
          }} onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
              openTcpContextMenu(e);
            }
          }}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={visibleTracks.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {visibleTracks.map((track) => {
                  const spacer = useDAWStore.getState().spacers.find(
                    (s) => s.afterTrackId === track.id
                  );
                  return (
                    <div key={track.id}>
                      <SortableTrackHeader track={track} />
                      {spacer && (
                        <div
                          className="bg-daw-darker border-b border-daw-border cursor-row-resize group relative"
                          style={{ height: spacer.height }}
                          onDoubleClick={() =>
                            useDAWStore.getState().removeSpacer(spacer.id)
                          }
                          onMouseDown={(e) => {
                            const startY = e.clientY;
                            const startHeight = spacer.height;
                            const onMove = (me: MouseEvent) => {
                              const delta = me.clientY - startY;
                              useDAWStore
                                .getState()
                                .setSpacerHeight(spacer.id, startHeight + delta);
                            };
                            const onUp = () => {
                              window.removeEventListener("mousemove", onMove);
                              window.removeEventListener("mouseup", onUp);
                            };
                            window.addEventListener("mousemove", onMove);
                            window.addEventListener("mouseup", onUp);
                          }}
                          title="Drag to resize, double-click to remove"
                        >
                          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-daw-border group-hover:bg-daw-accent transition-colors" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {activeDragId && (() => {
                  const { selectedTrackIds } = useDAWStore.getState();
                  const isMulti = selectedTrackIds.length > 1 && selectedTrackIds.includes(activeDragId);
                  const dragTracks = isMulti
                    ? tracks.filter((t) => selectedTrackIds.includes(t.id))
                    : tracks.filter((t) => t.id === activeDragId);
                  const trackHeight = useDAWStore.getState().trackHeight;
                  return (
                    <div className="opacity-80 shadow-xl rounded overflow-hidden" style={{ width: '100%' }}>
                      {dragTracks.map((t) => (
                        <div
                          key={t.id}
                          className="border-b border-neutral-900 bg-neutral-800 flex items-center px-2"
                          style={{ height: getEffectiveTrackHeight(t, trackHeight) }}
                        >
                          <div className="w-2 h-full shrink-0" style={{ background: t.color || '#666' }} />
                          <span className="ml-2 text-xs text-neutral-200 truncate">{t.name}</span>
                        </div>
                      ))}
                      {isMulti && (
                        <div className="bg-blue-600/80 text-white text-[10px] text-center py-0.5">
                          {dragTracks.length} tracks
                        </div>
                      )}
                    </div>
                  );
                })()}
              </DragOverlay>
            </DndContext>

            {/* Empty state prompt in TCP when no tracks */}
            {tracks.length === 0 && (
              <div className="flex flex-col items-center justify-center px-3 py-6 text-center">
                <div className="text-daw-text-muted text-xs mb-2 opacity-60">
                  No tracks in project
                </div>
                <div className="text-neutral-600 text-[11px] leading-relaxed">
                  Click <span className="text-daw-accent font-medium">+ Add Track</span> above,
                  press <kbd className="px-1 py-0.5 rounded bg-neutral-700/80 text-neutral-300 text-[10px] font-mono border border-daw-border">Ctrl+T</kbd>,
                  or drop audio files into the timeline
                </div>
              </div>
            )}
            <div
              className="shrink-0"
              style={{ height: tcpBottomSpacerHeight }}
              onContextMenu={openTcpContextMenu}
            />
          </div>

        </div>

        {/* Draggable resize handle between TCP and Timeline */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize track panel"
          className="w-1.5 shrink-0 self-stretch cursor-col-resize group/resize z-50"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = tcpWidth;
            document.body.style.cursor = "col-resize";
            const onMove = (me: MouseEvent) => {
              setTcpWidth(startWidth + (me.clientX - startX));
            };
            const onUp = () => {
              document.body.style.cursor = "";
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          title="Drag to resize track panel"
        >
          <div className="w-full h-full bg-neutral-900 group-hover/resize:bg-daw-accent/50 group-active/resize:bg-daw-accent transition-colors" />
        </div>

        {showMasterTrackInTCP && (
          <div className="tcp-master-overlay" style={{ width: tcpWidth, bottom: tcpOverlayBottom, left: tcpOverlayLeft }}>
            <div className="pointer-events-auto">
              <MasterTrackHeader />
            </div>
          </div>
        )}

        {/* Timeline (Canvas-based) */}
        <Timeline
          tracks={visibleTracks}
          footerHeight={masterFooterHeight}
          masterAutomation={showMasterTrackInTCP ? {
            lanes: masterAutomationLanes,
            showAutomation: showMasterAutomation,
          } : undefined}
          onOpenAddMultipleTracksModal={openAddMultipleTracksModal}
          showRuler={false}
        />
      </div>
      </div>
      </div>{/* Close Media Explorer + Workspace wrapper */}

      {/* Pitch Editor Lower Zone (between workspace and transport) */}
      {showPitchEditor && pitchEditorTrackId && pitchEditorClipId && (
        <Suspense fallback={<div className="h-[280px] bg-daw-panel border-t border-daw-border flex items-center justify-center text-neutral-500 text-sm">Loading pitch editor...</div>}>
          <PitchEditorLowerZone />
        </Suspense>
      )}

      <UnsavedChangesDialog />

      {/* Transport Bar (above Mixer like Reaper) */}
      <div role="contentinfo" aria-label="Transport controls">
        <BottomTransportBar />
      </div>

      {/* Virtual MIDI Keyboard */}
      {showVirtualKeyboard && (
        <Suspense fallback={null}>
          <VirtualPianoKeyboard />
        </Suspense>
      )}

      {/* Piano Roll Editor Modal */}
      {showPianoRoll && pianoRollTrackId && pianoRollClipId && (
        <div className="fixed inset-0 z-2000 flex items-center justify-center bg-black/60">
          <div className="relative w-[90vw] h-[80vh] bg-neutral-900 rounded-lg shadow-2xl border border-neutral-700 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 bg-neutral-800 border-b border-neutral-700">
              <h2 className="text-sm font-semibold text-white">Piano Roll Editor</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={closePianoRoll}
                title="Close (Esc)"
                aria-label="Close Piano Roll editor"
              >
                <X size={16} />
              </Button>
            </div>
            {/* Piano Roll Content */}
            <div className="flex-1 overflow-hidden">
              <Suspense fallback={<div className="flex items-center justify-center h-full text-neutral-500 text-sm">Loading...</div>}>
                <PianoRoll
                  trackId={pianoRollTrackId}
                  clipId={pianoRollClipId}
                  additionalClipIds={
                    selectedClipIds.length > 1
                      ? (() => {
                          const prTrack = tracks.find((t) => t.id === pianoRollTrackId);
                          if (!prTrack) return [];
                          const midiClipIdSet = new Set(prTrack.midiClips.map((c) => c.id));
                          return selectedClipIds.filter(
                            (id) => id !== pianoRollClipId && midiClipIdSet.has(id),
                          );
                        })()
                      : []
                  }
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {/* Pitch editor kept for standalone/modal use if needed in future */}

      {/* Undo History Panel */}
      {showUndoHistory && (
        <div className="fixed right-2 top-20 z-1000">
          <Suspense fallback={null}>
            <UndoHistoryPanel />
          </Suspense>
        </div>
      )}

      {/* Big Clock */}
      {showBigClock && (
        <div className="fixed left-1/2 top-16 -translate-x-1/2 z-1000">
          <Suspense fallback={null}>
            <BigClock />
          </Suspense>
        </div>
      )}

      {/* Clip Properties Panel */}
      {showClipProperties && (
        <div className="fixed left-2 top-20 z-1000">
          <Suspense fallback={null}>
            <ClipPropertiesPanel />
          </Suspense>
        </div>
      )}

      {/* Region/Marker Manager */}
      {showRegionMarkerManager && (
        <div className="fixed right-2 top-20 z-1000 w-72 h-96 rounded border border-daw-border shadow-lg overflow-hidden">
          <Suspense fallback={null}>
            <RegionMarkerManager />
          </Suspense>
        </div>
      )}

      {/* Render Queue Panel */}
      {showRenderQueue && (
        <div className="fixed right-2 bottom-16 z-1000">
          <Suspense fallback={null}>
            <RenderQueuePanel />
          </Suspense>
        </div>
      )}

      {/* Preferences Modal */}
      {showPreferences && (
        <Suspense fallback={null}>
          <PreferencesModal
            isOpen={showPreferences}
            onClose={() => useDAWStore.getState().togglePreferences()}
          />
        </Suspense>
      )}

      {/* Keyboard Shortcuts Modal */}
      {showKeyboardShortcuts && (
        <Suspense fallback={null}>
          <KeyboardShortcutsModal
            isOpen={showKeyboardShortcuts}
            onClose={() => useDAWStore.getState().toggleKeyboardShortcuts()}
          />
        </Suspense>
      )}

      {/* Command Palette */}
      {showCommandPalette && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={showCommandPalette}
            onClose={() => useDAWStore.getState().toggleCommandPalette()}
          />
        </Suspense>
      )}

      {/* Dynamic Split Modal (Phase 9B) */}
      {showDynamicSplit && (
        <Suspense fallback={null}>
          <DynamicSplitModal
            isOpen={showDynamicSplit}
            onClose={() => useDAWStore.getState().closeDynamicSplit()}
          />
        </Suspense>
      )}

      {/* Clip Launcher / Session View */}
      {showClipLauncher && (
        <Suspense fallback={null}>
          <div className="h-64 border-t border-neutral-700">
            <ClipLauncherView />
          </div>
        </Suspense>
      )}

      {/* Mixer Panel */}
      <div role="complementary" aria-label="Mixer panel">
      <MixerPanel
        isVisible={showMixer && !isMixerDetached}
        isDetached={false}
        onDetach={() => { void handleDetachMixer(); }}
        onAttach={() => { void nativeBridge.closeMixerWindow(); }}
        onClose={() => { void handleToggleMixerVisibility(); }}
      />
      </div>

      <AddMultipleTracksModal
        isOpen={showAddMultipleTracksModal}
        initialType={addMultipleTracksType}
        onClose={() => setShowAddMultipleTracksModal(false)}
        onSubmit={handleAddMultipleTracks}
      />

      {tcpContextMenu && (
        <ContextMenu
          x={tcpContextMenu.x}
          y={tcpContextMenu.y}
          items={tcpContextMenu.items}
          onClose={() => setTcpContextMenu(null)}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal isOpen={showSettings} onClose={closeSettings} />
        </Suspense>
      )}

      {/* Project Settings Modal */}
      {showProjectSettings && (
        <Suspense fallback={null}>
          <ProjectSettingsModal
            isOpen={showProjectSettings}
            onClose={closeProjectSettings}
          />
        </Suspense>
      )}

      {/* Project Compare Modal */}
      {showProjectCompare && (
        <Suspense fallback={null}>
          <ProjectCompareModal
            isOpen={showProjectCompare}
            onClose={() => useDAWStore.getState().toggleProjectCompare()}
          />
        </Suspense>
      )}

      {/* Render Modal */}
      {showRenderModal && (
        <Suspense fallback={null}>
          <RenderModal isOpen={showRenderModal} onClose={closeRenderModal} />
        </Suspense>
      )}

      {/* Routing Matrix (Phase 11B) */}
      {showRoutingMatrix && (
        <Suspense fallback={null}>
          <RoutingMatrix
            isOpen={showRoutingMatrix}
            onClose={() => useDAWStore.getState().toggleRoutingMatrix()}
          />
        </Suspense>
      )}

      {/* Region Render Matrix (Phase 10A) */}
      {showRegionRenderMatrix && (
        <Suspense fallback={null}>
          <RegionRenderMatrix
            isOpen={showRegionRenderMatrix}
            onClose={() => useDAWStore.getState().toggleRegionRenderMatrix()}
          />
        </Suspense>
      )}

      {/* Clean Project Directory (Phase 12B) */}
      {showCleanProject && (
        <Suspense fallback={null}>
          <CleanProjectModal
            isOpen={showCleanProject}
            onClose={() => useDAWStore.getState().toggleCleanProject()}
          />
        </Suspense>
      )}

      {/* Batch File Converter (Phase 12E) */}
      {showBatchConverter && (
        <Suspense fallback={null}>
          <BatchConverterModal
            isOpen={showBatchConverter}
            onClose={() => useDAWStore.getState().toggleBatchConverter()}
          />
        </Suspense>
      )}

      {/* Crossfade Editor (Phase 13A) */}
      {showCrossfadeEditor && (
        <Suspense fallback={null}>
          <CrossfadeEditor
            isOpen={showCrossfadeEditor}
            onClose={() => useDAWStore.getState().closeCrossfadeEditor()}
          />
        </Suspense>
      )}

      {/* Theme Editor (Phase 14A+B) */}
      {showThemeEditor && (
        <Suspense fallback={null}>
          <ThemeEditor
            isOpen={showThemeEditor}
            onClose={() => useDAWStore.getState().toggleThemeEditor()}
          />
        </Suspense>
      )}

      {/* Video Window (Phase 15A) */}
      <Suspense fallback={null}>
        <VideoWindow />
      </Suspense>

      {/* Script Editor (Phase 15B) */}
      {showScriptEditor && (
        <Suspense fallback={null}>
          <ScriptEditor />
        </Suspense>
      )}

      {/* Toolbar Editor (Phase 15D) */}
      {showToolbarEditor && (
        <Suspense fallback={null}>
          <ToolbarEditor
            isOpen={showToolbarEditor}
            onClose={() => useDAWStore.getState().toggleToolbarEditor()}
          />
        </Suspense>
      )}

      {/* DDP Export (Phase 16C) */}
      {showDDPExport && (
        <Suspense fallback={null}>
          <DDPExportModal
            isOpen={showDDPExport}
            onClose={() => useDAWStore.getState().toggleDDPExport()}
          />
        </Suspense>
      )}

      {/* Timecode Sync Settings */}
      {showTimecodeSettings && (
        <Suspense fallback={null}>
          <TimecodeSettingsPanel
            isOpen={showTimecodeSettings}
            onClose={() => useDAWStore.getState().toggleTimecodeSettings()}
          />
        </Suspense>
      )}

      {/* Envelope Manager Modal */}
      {showEnvelopeManager && envelopeManagerTrackId && (
        <Suspense fallback={null}>
          <EnvelopeManagerModal />
        </Suspense>
      )}

      {/* AI Tools Setup Modal */}
      {showAiToolsSetup && (
        <Suspense fallback={null}>
          <AiToolsSetupModal />
        </Suspense>
      )}

      {/* Stem Separation Modal */}
      {showStemSeparation && (
        <Suspense fallback={null}>
          <StemSeparationModal />
        </Suspense>
      )}

      {/* Channel Strip EQ Modal */}
      {showChannelStripEQ && (
        <Suspense fallback={null}>
          <ChannelStripEQModal isOpen={showChannelStripEQ} onClose={closeChannelStripEQ} />
        </Suspense>
      )}

      {/* Track Routing Modal (IO) */}
      {showTrackRouting && (
        <Suspense fallback={null}>
          <TrackRoutingModal isOpen={showTrackRouting} onClose={closeTrackRouting} />
        </Suspense>
      )}

      {/* Plugin Browser (from action registry — instrument track creation) */}
      {showPluginBrowser && pluginBrowserTrackId && (
        <Suspense fallback={null}>
          <PluginBrowser
            trackId={pluginBrowserTrackId}
            targetChain={
              tracks.find((t) => t.id === pluginBrowserTrackId)?.type === "instrument"
                ? "instrument"
                : "track"
            }
            trackType={tracks.find((t) => t.id === pluginBrowserTrackId)?.type}
            onClose={() => useDAWStore.getState().closePluginBrowser()}
          />
        </Suspense>
      )}

      {/* Missing Media Resolver */}
      {showMissingMedia && missingMediaFiles.length > 0 && (
        <Suspense fallback={null}>
          <MissingMediaResolver
            isOpen={showMissingMedia}
            onClose={() => useDAWStore.getState().closeMissingMedia()}
            missingFiles={missingMediaFiles}
            onResolve={(originalPath, newPath) =>
              useDAWStore.getState().resolveMissingMedia(originalPath, newPath)
            }
            onResolveAll={() => useDAWStore.getState().closeMissingMedia()}
          />
        </Suspense>
      )}

      {/* Contextual Help Overlay (F1) */}
      {showContextualHelp && (
        <Suspense fallback={null}>
          <HelpOverlay />
        </Suspense>
      )}

      {/* Getting Started Guide */}
      {showGettingStarted && (
        <Suspense fallback={null}>
          <GettingStartedGuide />
        </Suspense>
      )}

      {/* Project Loading Overlay */}
      {isProjectLoading && (
        <div className="fixed inset-0 z-10000 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 border-3 border-daw-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-neutral-300 font-medium">
              {projectLoadingMessage || "Loading project..."}
            </p>
          </div>
        </div>
      )}

      {/* File Drop Overlay — shown when dragging files from OS file explorer */}
      {showAiToolsInstallBlocker && (
        <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="w-[min(52rem,calc(100vw-2rem))] rounded-2xl border border-daw-accent/30 bg-neutral-950 shadow-2xl">
            <div className="border-b border-neutral-800 px-5 py-4">
              <p className="text-base font-semibold text-white">Installing AI Tools</p>
              <p className="mt-1 text-sm text-neutral-300">
                OpenStudio is still preparing large AI components. Progress is being monitored in the background.
              </p>
            </div>
            <div className="space-y-4 p-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-200">{aiToolsStatus.stepLabel || aiToolsStatus.message || "Installing AI Tools..."}</span>
                  <span className="text-neutral-400">
                    {Math.max(0, Math.round((aiToolsStatus.progress ?? 0) * 100))}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-daw-accent transition-all duration-300"
                    style={{ width: `${Math.max(6, Math.min((aiToolsStatus.progress ?? 0) * 100, 100))}%` }}
                  />
                </div>
              </div>
              <div className="grid gap-2 text-xs text-neutral-400 sm:grid-cols-3">
                <span>Phase: <span className="text-neutral-200">{aiToolsStatus.lastPhase || aiToolsStatus.state}</span></span>
                <span>Elapsed: <span className="text-neutral-200">{Math.max(0, Math.round((aiToolsStatus.elapsedMs ?? 0) / 1000))}s</span></span>
                <span>Session: <span className="text-neutral-200">{aiToolsStatus.installSessionId || "n/a"}</span></span>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-black px-4 py-3 font-mono text-xs text-green-300">
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {(aiToolsStatus.activityLines?.length ? aiToolsStatus.activityLines : [aiToolsStatus.message || "Installing AI Tools..."]).map((line, index) => (
                    <div key={`${index}-${line}`} className="break-words">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isDraggingFiles && (
        <div className="fixed inset-0 z-9999 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-xl border-2 border-dashed border-daw-accent bg-neutral-900/90 shadow-2xl">
            <svg
              className="text-daw-accent"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span className="text-white text-base font-medium">Drop files here</span>
            <span className="text-neutral-400 text-xs">Audio, MIDI, or video files</span>
          </div>
        </div>
      )}

      {/* AI Tools Background Install Popup */}
      {!showStemSeparation &&
        (aiToolsStatus.installInProgress || aiToolsStatus.state === "checking") && (
          <div className="fixed bottom-32 right-6 z-[10001] w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-daw-accent/40 bg-neutral-950/95 p-4 shadow-2xl backdrop-blur-md">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">
                  {aiToolsStatus.buildRuntimeMode === "downloaded-runtime"
                    ? "AI tools are downloading"
                    : "AI tools are installing"}
                </p>
                <p className="mt-1 text-xs text-neutral-300">
                  {aiToolsStatus.downloadHint
                    ? aiToolsStatus.downloadHint
                    : aiToolsStatus.buildRuntimeMode === "downloaded-runtime"
                      ? "OpenStudio is downloading and preparing its AI runtime in the background. This is a one-time setup and the app will stay usable while it runs."
                      : "OpenStudio is preparing optional AI tooling in the background. You can keep working while this finishes."}
                </p>
              </div>
              <div className="h-3 w-3 rounded-full bg-daw-accent shadow-[0_0_16px_rgba(59,130,246,0.9)] animate-pulse" />
            </div>

            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full rounded-full bg-daw-accent transition-all duration-300"
                  style={{ width: `${Math.max(6, Math.min((aiToolsStatus.progress ?? 0) * 100, 100))}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-400">
                <span>{aiToolsStatus.stepLabel || aiToolsStatus.message || "Preparing optional AI tools..."}</span>
                <span>{Math.round((aiToolsStatus.progress ?? 0) * 100)}%</span>
              </div>
              {aiToolsStatus.statusWarning ? (
                <p className="mt-2 text-[11px] text-yellow-300">{aiToolsStatus.statusWarning}</p>
              ) : null}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  openAiToolsSetup();
                }}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-800"
              >
                Open progress
              </button>
              {aiToolsStatus.installInProgress && (
                <button
                  type="button"
                  onClick={() => {
                    void cancelAiToolsInstall();
                  }}
                  className="rounded-lg bg-daw-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-daw-accent/90"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

      {/* Toast Notification */}
      {toastVisible && (
        <div className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-10000 px-4 py-2 rounded-lg shadow-lg text-sm font-medium transition-all animate-in fade-in slide-in-from-bottom-2 duration-200 ${
          toastType === "success" ? "bg-green-600 text-white" :
          toastType === "error" ? "bg-red-600 text-white" :
          "bg-neutral-700 text-white"
        }`}>
          {toastMessage}
        </div>
      )}
    </div>
  );
}

export default App;
