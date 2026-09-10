import { nativeBridge } from "../../services/NativeBridge";

interface PracticeState {
  metronomeEnabled: boolean;
  metronomeVolume: number;
  metronomePracticeEnabled: boolean;
  metronomePracticePending: boolean;
  metronomePracticeError: string;
}

export function metronomePracticeActions(
  set: (state: Partial<PracticeState>) => void,
  get: () => PracticeState & { showToast?: (message: string, type: "error") => void },
) {
  let queue = Promise.resolve(false);
  let request = 0;
  let confirmedPractice = false;
  const requestChange = (practiceEnabled: boolean, transportEnabled?: boolean): Promise<boolean> => {
    if (!get().metronomePracticePending) confirmedPractice = get().metronomePracticeEnabled;
    const token = ++request;
    set({ metronomePracticePending: true, metronomePracticeError: "" });
    queue = queue.then(async () => {
      // A project reset/rapid newer request supersedes work not yet sent.
      if (token !== request) return false;
      try {
        const accepted = await nativeBridge.setMetronomePracticeEnabled(practiceEnabled);
        if (!accepted) throw new Error("Click-only playback could not change. Check that an audio device is running.");
        confirmedPractice = practiceEnabled;
        if (token === request) set({ metronomePracticeEnabled: practiceEnabled });
        if (transportEnabled !== undefined) {
          if (transportEnabled && !await nativeBridge.setMetronomeVolume(get().metronomeVolume))
            throw new Error("Could not set the metronome volume.");
          if (!await nativeBridge.setMetronomeEnabled(transportEnabled))
            throw new Error("Could not change the metronome enable setting.");
          // Preserve confirmed preference updates even when a newer practice
          // request is queued: that request changes only the practice latch.
          set({ metronomeEnabled: transportEnabled });
        }
        return true;
      } catch (error) {
        if (token === request) {
          // A superseded start may have reached native code before this stop
          // failed. Restore its confirmed state instead of claiming silence.
          set({ metronomePracticeEnabled: confirmedPractice,
            metronomePracticeError: error instanceof Error ? error.message : "Could not change the metronome." });
        }
        return false;
      } finally {
        if (token === request) set({ metronomePracticePending: false });
      }
    });
    return queue;
  };
  return {
    setMetronomePracticeEnabled: (enabled: boolean) => requestChange(enabled),
    async toggleMetronome(): Promise<void> {
      const state = get();
      // The icon represents either enabled mode. Turning it off must stop
      // both, including a practice start that has not reached native code yet.
      const active = state.metronomeEnabled || state.metronomePracticeEnabled || state.metronomePracticePending;
      const accepted = await requestChange(false, !active);
      if (!accepted && get().metronomePracticeError)
        get().showToast?.(get().metronomePracticeError, "error");
    },
  };
}
