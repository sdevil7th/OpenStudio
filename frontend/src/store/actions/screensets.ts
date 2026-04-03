// @ts-nocheck
// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const screensetActions = (set: SetFn, get: GetFn) => ({
    saveScreenset: (slotIndex, name) => {
      const state = get();
      const layout = {
        showMixer: state.showMixer,
        showPianoRoll: state.showPianoRoll,
        showBigClock: state.showBigClock,
        showClipProperties: state.showClipProperties,
        showUndoHistory: state.showUndoHistory,
        showRegionMarkerManager: state.showRegionMarkerManager,
        showScriptConsole: state.showScriptConsole,
        pixelsPerSecond: state.pixelsPerSecond,
        trackHeight: state.trackHeight,
        tcpWidth: state.tcpWidth,
      };
      set((s) => {
        const screensets = [...s.screensets];
        const existing = screensets.findIndex((ss) => ss.id === `screenset_${slotIndex}`);
        const entry = {
          id: `screenset_${slotIndex}`,
          name: name || `Screenset ${slotIndex + 1}`,
          layout,
        };
        if (existing >= 0) {
          screensets[existing] = entry;
        } else {
          screensets.push(entry);
        }
        localStorage.setItem("s13_screensets", JSON.stringify(screensets));
        return { screensets };
      });
    },
    loadScreenset: (slotIndex) => {
      const state = get();
      const screenset = state.screensets.find((ss) => ss.id === `screenset_${slotIndex}`);
      if (!screenset) return;
      set({
        showMixer: screenset.layout.showMixer,
        showPianoRoll: screenset.layout.showPianoRoll,
        showBigClock: screenset.layout.showBigClock,
        showClipProperties: screenset.layout.showClipProperties,
        showUndoHistory: screenset.layout.showUndoHistory,
        showRegionMarkerManager: screenset.layout.showRegionMarkerManager,
        showScriptConsole: screenset.layout.showScriptConsole ?? false,
        pixelsPerSecond: screenset.layout.pixelsPerSecond,
        trackHeight: screenset.layout.trackHeight,
        tcpWidth: screenset.layout.tcpWidth ?? 310,
      });
    },
    deleteScreenset: (slotIndex) => {
      set((s) => {
        const screensets = s.screensets.filter((ss) => ss.id !== `screenset_${slotIndex}`);
        localStorage.setItem("s13_screensets", JSON.stringify(screensets));
        return { screensets };
      });
    },

});
