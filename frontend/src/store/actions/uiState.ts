/**
 * UI State actions — modal toggles, panel visibility, display settings.
 * These are pure state setters with no backend interaction.
 */

// Zustand's `set` accepts partial state or updater functions. We type it loosely here
// because the extracted actions are spread into the store, which enforces the real types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;

export const uiStateActions = (set: SetFn) => ({
  toggleMixer: () => set((state: any) => ({ showMixer: !state.showMixer })),
  toggleMasterTrackInTCP: () => set((state: any) => ({ showMasterTrackInTCP: !state.showMasterTrackInTCP })),
  openSettings: () => set({ showSettings: true }),
  closeSettings: () => set({ showSettings: false }),
  openProjectSettings: () => set({ showProjectSettings: true }),
  closeProjectSettings: () => set({ showProjectSettings: false }),
  openRenderModal: () => set({ showRenderModal: true }),
  closeRenderModal: () => set({ showRenderModal: false }),
  openPluginBrowser: (trackId: string) =>
    set({ showPluginBrowser: true, pluginBrowserTrackId: trackId }),
  closePluginBrowser: () =>
    set({ showPluginBrowser: false, pluginBrowserTrackId: null }),
  openEnvelopeManager: (trackId: string) =>
    set({ showEnvelopeManager: true, envelopeManagerTrackId: trackId }),
  closeEnvelopeManager: () =>
    set({ showEnvelopeManager: false, envelopeManagerTrackId: null }),
  openChannelStripEQ: (trackId: string) =>
    set({ showChannelStripEQ: true, channelStripEQTrackId: trackId }),
  closeChannelStripEQ: () =>
    set({ showChannelStripEQ: false, channelStripEQTrackId: null }),
  openTrackRouting: (trackId: string) =>
    set({ showTrackRouting: true, trackRoutingTrackId: trackId }),
  closeTrackRouting: () =>
    set({ showTrackRouting: false, trackRoutingTrackId: null }),
  toggleVirtualKeyboard: () =>
    set((state: any) => ({ showVirtualKeyboard: !state.showVirtualKeyboard })),
  toggleUndoHistory: () =>
    set((state: any) => ({ showUndoHistory: !state.showUndoHistory })),
  toggleCommandPalette: () =>
    set((state: any) => ({ showCommandPalette: !state.showCommandPalette })),
  toggleRegionMarkerManager: () =>
    set((state: any) => ({ showRegionMarkerManager: !state.showRegionMarkerManager })),
  toggleClipProperties: () =>
    set((state: any) => ({ showClipProperties: !state.showClipProperties })),
  toggleBigClock: () =>
    set((state: any) => ({ showBigClock: !state.showBigClock })),
  toggleBigClockFormat: () =>
    set((state: any) => ({ bigClockFormat: state.bigClockFormat === "time" ? "beats" : "time" })),
  toggleKeyboardShortcuts: () =>
    set((state: any) => ({ showKeyboardShortcuts: !state.showKeyboardShortcuts })),
  toggleContextualHelp: () =>
    set((state: any) => ({ showContextualHelp: !state.showContextualHelp })),
  toggleGettingStarted: () =>
    set((state: any) => ({ showGettingStarted: !state.showGettingStarted })),
  togglePreferences: () =>
    set((state: any) => ({ showPreferences: !state.showPreferences })),
  toggleScriptConsole: () =>
    set((state: any) => ({ showScriptConsole: !state.showScriptConsole })),
  openStemSeparation: (trackId: string, clipId: string, name: string, duration: number) =>
    set({ showStemSeparation: true, stemSepTrackId: trackId, stemSepClipId: clipId, stemSepClipName: name, stemSepClipDuration: duration }),
  closeStemSeparation: () =>
    set({ showStemSeparation: false }),
  reopenStemSeparation: () =>
    set((state: any) =>
      state.stemSepTrackId && state.stemSepClipId
        ? { showStemSeparation: true }
        : {}
    ),
  toggleMediaExplorer: () =>
    set((state: any) => ({ showMediaExplorer: !state.showMediaExplorer })),
  toggleCleanProject: () =>
    set((state: any) => ({ showCleanProject: !state.showCleanProject })),
  toggleBatchConverter: () =>
    set((state: any) => ({ showBatchConverter: !state.showBatchConverter })),
  toggleCrossfadeEditor: () =>
    set((state: any) => ({ showCrossfadeEditor: !state.showCrossfadeEditor })),
  toggleThemeEditor: () =>
    set((state: any) => ({ showThemeEditor: !state.showThemeEditor })),
  toggleVideoWindow: () =>
    set((state: any) => ({ showVideoWindow: !state.showVideoWindow })),
  toggleScriptEditor: () =>
    set((state: any) => ({ showScriptEditor: !state.showScriptEditor })),
  toggleToolbarEditor: () =>
    set((state: any) => ({ showToolbarEditor: !state.showToolbarEditor })),
  toggleDDPExport: () =>
    set((state: any) => ({ showDDPExport: !state.showDDPExport })),
  toggleStepSequencer: () =>
    set((state: any) => ({ showStepSequencer: !state.showStepSequencer })),
  toggleClipLauncher: () =>
    set((state: any) => ({ showClipLauncher: !state.showClipLauncher })),
  toggleTimecodeSettings: () =>
    set((state: any) => ({ showTimecodeSettings: !state.showTimecodeSettings })),
  toggleMissingMedia: () =>
    set((state: any) => ({ showMissingMedia: !state.showMissingMedia })),
  toggleProjectCompare: () =>
    set((state: any) => ({ showProjectCompare: !state.showProjectCompare })),
  toggleCrosshair: () =>
    set((state: any) => ({ showCrosshair: !state.showCrosshair })),
  toggleLoudnessMeter: () =>
    set((state: any) => ({ showLoudnessMeter: !state.showLoudnessMeter })),
  togglePhaseCorrelation: () =>
    set((state: any) => ({ showPhaseCorrelation: !state.showPhaseCorrelation })),
  toggleProjectTemplates: () =>
    set((state: any) => ({ showProjectTemplates: !state.showProjectTemplates })),
  toggleRegionRenderMatrix: () =>
    set((state: any) => ({ showRegionRenderMatrix: !state.showRegionRenderMatrix })),
  toggleDrumEditor: () =>
    set((state: any) => ({ showDrumEditor: !state.showDrumEditor })),
  toggleMediaPool: () =>
    set((state: any) => ({ showMediaPool: !state.showMediaPool })),
  toggleLinked: () =>
    set((state: any) => ({ showLinked: !state.showLinked })),
  toggleRenderQueue: () =>
    set((state: any) => ({ showRenderQueue: !state.showRenderQueue })),
  setTimecodeMode: (mode: "time" | "beats" | "smpte") =>
    set({ timecodeMode: mode }),
  setSmpteFrameRate: (fps: 24 | 25 | 29.97 | 30) =>
    set({ smpteFrameRate: fps }),
  setUIFontScale: (scale: number) =>
    set({ uiFontScale: Math.max(0.75, Math.min(1.5, scale)) }),
});
