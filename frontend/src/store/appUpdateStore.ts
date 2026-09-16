import { create } from "zustand";
import { nativeBridge, type AppUpdateStatus } from "../services/NativeBridge";
import { getProjectEpoch } from "../utils/projectLifetime";

const preferenceKey = "openstudio.checkForAppUpdates";
function readPreference() {
  try { return localStorage.getItem(preferenceKey) !== "false"; } catch { return true; }
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The update could not be completed. Try again.";

interface AppUpdateState {
  open: boolean;
  automatic: boolean;
  status: AppUpdateStatus;
  offer: AppUpdateStatus | null;
  downloaded: boolean;
  pending: boolean;
  error: string | null;
  setOpen: (open: boolean) => void;
  setAutomatic: (enabled: boolean) => void;
  acceptStatus: (status: AppUpdateStatus) => void;
  check: (manual: boolean) => Promise<void>;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
  install: () => Promise<void>;
}

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  open: false,
  automatic: readPreference(),
  status: { status: "idle", message: "Check for the latest version of OpenStudio." },
  offer: null,
  downloaded: false,
  pending: false,
  error: null,
  setOpen: (open) => set({ open }),
  setAutomatic: (automatic) => {
    set({ automatic });
    try { localStorage.setItem(preferenceKey, String(automatic)); } catch { /* Session preference still applies. */ }
  },
  acceptStatus: (status) => {
    if (status.status === "busy" || status.status === "skipped") return;
    set({ status, error: status.status === "error" ? status.message : null });
    if (status.status === "update-available") set({ offer: status, downloaded: false });
    if (status.status === "download-ready") set({ offer: status, downloaded: true });
    if (status.status === "up-to-date" || status.status === "development" || status.status === "install-started" || status.status === "incompatible") set({ offer: null, downloaded: false });
    if (status.status === "cancelled") set({ downloaded: false });
  },
  check: async (manual) => {
    if (manual) set({ open: true });
    if (get().pending || get().downloaded) return;
    if (!manual && (!get().automatic || get().status.status === "development" || !nativeBridge.supportsAppUpdates())) return;
    set({ pending: true, error: null });
    try {
      const status = await nativeBridge.checkForUpdates(manual);
      get().acceptStatus(status);
      if (status.status === "error") set({ offer: null });
    }
    catch (error) { get().acceptStatus({ status: "error", message: errorMessage(error) }); set({ offer: null }); }
    finally { set({ pending: false }); }
  },
  download: async () => {
    if (get().pending || !get().offer) return;
    set({ pending: true, downloaded: false, error: null });
    try { get().acceptStatus(await nativeBridge.downloadUpdate()); }
    catch (error) { get().acceptStatus({ status: "error", message: errorMessage(error) }); }
    finally { set({ pending: false }); }
  },
  cancel: async () => {
    try { await nativeBridge.cancelUpdateDownload(); }
    catch (error) { set({ error: errorMessage(error) }); }
  },
  install: async () => {
    if (get().pending || !get().downloaded) return;
    const downloadedOffer = get().offer;
    let installAttempted = false;
    set({ pending: true, error: null });
    try {
      const { useDAWStore } = await import("./useDAWStore");
      const epoch = getProjectEpoch();
      const state = useDAWStore.getState();
      if (state.transport.isPlaying || state.transport.isRecording)
        throw new Error("Stop playback and recording before installing the update.");
      if (state.isModified && !await state.saveProject()) {
        set({ error: "Installation postponed. Your project must be saved first." });
        return;
      }
      const current = useDAWStore.getState();
      if (epoch !== getProjectEpoch() || current.isModified || current.transport.isPlaying || current.transport.isRecording)
        throw new Error("The session changed while saving. Review and save it before installing.");
      installAttempted = true;
      const result = await nativeBridge.installDownloadedUpdate();
      get().acceptStatus(result);
      if (result.status === "error") set({ downloaded: false });
      if (result.status === "install-started" && result.updateSource !== "microsoft-store") {
        if (result.platform === "macos" || result.platform === "linux") {
          const latest = useDAWStore.getState();
          if (epoch !== getProjectEpoch() || latest.isModified || latest.transport.isPlaying || latest.transport.isRecording) {
            await nativeBridge.cancelUpdateDownload();
            get().acceptStatus({ ...result, status: "download-ready", message: "Installation postponed because the session changed. Save your work and try again." });
            return;
          }
        }
        const preparedUpdate = result.platform === "macos" || result.platform === "linux";
        const quit = useDAWStore.getState().requestQuit;
        if (!await (preparedUpdate ? quit(true) : quit())) {
          await nativeBridge.cancelUpdateDownload();
          if (preparedUpdate)
            get().acceptStatus({ ...result, status: "download-ready", message: "Installation postponed. Save your work and try again." });
        }
      }
    } catch (error) {
      if (installAttempted) {
        // A bridge failure does not imply that the native worker has stopped.
        await nativeBridge.cancelUpdateDownload().catch(() => undefined);
        if (downloadedOffer)
          get().acceptStatus({ ...downloadedOffer, status: "download-ready" });
      }
      set({ error: errorMessage(error) });
    }
    finally { set({ pending: false }); }
  },
}));
