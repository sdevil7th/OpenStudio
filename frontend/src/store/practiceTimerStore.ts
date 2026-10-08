import { create } from "zustand";
import { nativeBridge, type PracticeTimerState } from "../services/NativeBridge";

let revision = 0;
export const usePracticeTimerStore = create<PracticeTimerState & {
  pending: boolean; error: string;
  refresh: () => Promise<void>;
  control: (action: "start" | "pause" | "resume" | "reset", duration?: number) => Promise<void>;
}>((set, get) => ({
  status: "idle", duration: 0, elapsed: 0, pending: false, error: "",
  refresh: async () => {
    if (get().pending) return;
    const request = ++revision;
    try {
      const state = await nativeBridge.getPracticeTimer();
      if (!get().pending && request === revision) {
        // Unchanged polls must not interrupt concurrent mounts elsewhere in the UI.
        set(current => current.status === state.status && current.duration === state.duration && current.elapsed === state.elapsed
          ? current : state);
      }
    }
    catch { /* A temporary UI disconnect must not invent timer progress. */ }
  },
  control: async (action, duration = 0) => {
    if (get().pending) return;
    ++revision;
    set({ pending: true, error: "" });
    try {
      if (!await nativeBridge.controlPracticeTimer(action, duration)) throw new Error("Practice timer unavailable. Stop transport and check the audio device.");
      set(await nativeBridge.getPracticeTimer());
    } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
    finally { set({ pending: false }); }
  },
}));

export function formatPracticeTime(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
