import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { Download, RefreshCw } from "lucide-react";
import { useAppUpdateStore } from "../store/appUpdateStore";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { Button, Modal } from "./ui";

export function AppUpdatePanel() {
  const update = useAppUpdateStore(useShallow((s) => ({
    open: s.open, automatic: s.automatic, status: s.status, offer: s.offer,
    downloaded: s.downloaded, pending: s.pending, error: s.error,
    setOpen: s.setOpen, setAutomatic: s.setAutomatic, check: s.check,
    download: s.download, cancel: s.cancel, install: s.install,
  })));
  const { modified, playing } = useDAWStore(useShallow((s) => ({
    modified: s.isModified, playing: s.transport.isPlaying || s.transport.isRecording,
  })));
  useEffect(() => {
    let disposed = false;
    const unsubscribe = nativeBridge.onUpdateStatusChanged((status) => useAppUpdateStore.getState().acceptStatus(status));
    void nativeBridge.getUpdateStatus().then((status) => {
      if (!disposed && useAppUpdateStore.getState().status.status === "idle")
        useAppUpdateStore.getState().acceptStatus(status);
    }).catch(() => {});
    const scheduledCheck = () => {
      const { transport } = useDAWStore.getState();
      if (!transport.isPlaying && !transport.isRecording) void useAppUpdateStore.getState().check(false);
    };
    const initial = window.setTimeout(scheduledCheck, 5000);
    const timer = window.setInterval(scheduledCheck, 60 * 60 * 1000);
    return () => { disposed = true; unsubscribe(); window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);

  const downloading = update.status.status === "downloading";
  const storeManaged = (update.status.updateSource || update.offer?.updateSource) === "microsoft-store";
  const installing = update.status.status === "installing";
  const progress = Math.max(0, Math.min(100, Math.round((update.status.progress ?? 0) * 100)));
  const platform = update.offer?.platform || update.status.platform;
  const installLabel = storeManaged ? "Install update" : platform === "macos" || platform === "linux" ? "Install update & restart" : "Install update & close";
  const updateName = update.offer?.version ? `OpenStudio ${update.offer.version}` : "An OpenStudio update";
  const notes = update.offer?.notes?.trim();
  const actions = <div className="flex w-full flex-wrap justify-end gap-2">
    <Button disabled={installing} onClick={() => update.setOpen(false)}>{downloading ? "Keep working" : "Later"}</Button>
    {downloading ? <Button onClick={() => { void update.cancel(); }}>Cancel download</Button>
      : update.downloaded ? <Button variant="primary" disabled={update.pending || playing} onClick={() => { void update.install(); }}>{update.pending ? "Preparing update…" : modified ? "Save & prepare update" : installLabel}</Button>
      : update.offer ? <Button variant="primary" disabled={update.pending} onClick={() => { void update.download(); }}>Download update</Button>
      : <Button variant="primary" disabled={update.pending} onClick={() => { void update.check(true); }}><RefreshCw size={14} aria-hidden="true" />{update.pending ? "Checking…" : "Check for updates"}</Button>}
  </div>;

  return <>
    {update.offer && !update.open && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-daw-border bg-daw-panel px-3 py-2 text-sm" role="status" aria-label="App update available">
      <span className="flex min-w-0 items-center gap-2"><Download size={16} aria-hidden="true" />
        {downloading ? `Downloading ${updateName}: ${progress}%` : update.downloaded ? `${updateName} is ready to install` : `${updateName} is available`}
      </span>
      <Button size="sm" onClick={() => update.setOpen(true)}>View update</Button>
    </div>}
    <Modal isOpen={update.open} onClose={() => { if (!installing) update.setOpen(false); }} title="OpenStudio updates" size="md"
      closeOnEscape={!installing} closeOnOverlayClick={!installing} showCloseButton={!installing} footer={actions}>
      <div className="flex flex-col gap-4 text-sm text-daw-text">
        <p className="text-daw-text-muted">Running version: {update.status.currentVersion || "—"}{update.status.status === "development" ? " (development)" : ""}</p>
        {update.status.message !== update.error && <p role="status" aria-live="polite" className="break-words font-medium">{update.status.message}</p>}
        {update.error && <p role="alert" className="break-words text-red-400">{update.error}</p>}
        {update.status.downloadPath && <p className="break-all text-daw-text-muted">Downloaded package: {update.status.downloadPath}</p>}
        {downloading && <div className="flex flex-col gap-2">
          <progress className="h-3 w-full accent-daw-accent" aria-label="Update download progress" max={100} value={progress} />
          <span className="text-daw-text-muted">{progress}% · You can keep working while the update downloads.</span>
        </div>}
        {notes && <section aria-label="Release notes" className="max-h-44 overflow-y-auto rounded border border-daw-border p-3">
          <h3 className="mb-2 font-semibold">What’s new in {update.offer?.version}</h3>
          <p className="whitespace-pre-wrap break-words">{notes}</p>
        </section>}
        {update.offer?.releasePageUrl && <Button variant="ghost" onClick={() => { void nativeBridge.openExternalURL(update.offer!.releasePageUrl!); }}>Full release details</Button>}
        {update.downloaded && <p className="text-daw-text-muted">
          {storeManaged ? "Save your work before installing. Microsoft Store installs the update and may close OpenStudio to finish."
            : platform === "macos" ? "OpenStudio will close, install the verified update and restart. The previous version is kept for recovery. macOS may require approval to open an unsigned app."
            : platform === "linux" ? "OpenStudio will close, replace its AppImage and restart. The previous version is kept for recovery. Package-managed and protected installations require a manual update."
              : "Save your work, then follow the Windows installer. OpenStudio will close after the installer opens."}
        </p>}
        {update.downloaded && playing && <p role="alert" className="text-amber-400">Stop playback and recording to install.</p>}
        <label className="flex min-h-9 cursor-pointer items-center gap-2">
          <input type="checkbox" checked={update.automatic} onChange={(e) => update.setAutomatic(e.target.checked)} className="size-4 accent-daw-accent" />
          Check for updates automatically
        </label>
        {storeManaged && <p className="text-daw-text-muted">Updates are delivered through Microsoft Store. Windows also follows your Microsoft Store automatic-update settings.</p>}
      </div>
    </Modal>
  </>;
}
