import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBridge, type AppUpdateStatus } from "../services/NativeBridge";
import { useAppUpdateStore } from "../store/appUpdateStore";
import { useDAWStore } from "../store/useDAWStore";
import { advanceProjectEpoch } from "../utils/projectLifetime";

const initial = useAppUpdateStore.getState();
const dawInitial = useDAWStore.getState();
const offer: AppUpdateStatus = { status: "update-available", message: "Version 2 available", version: "2.0.0", platform: "windows" };
describe("in-app update workflow", () => {
  it("Store installations keep in-app checks, downloads and installation without EXE quit handoff", async () => {
    const storeOffer = { ...offer, updateSource: "microsoft-store", version: undefined };
    vi.mocked(nativeBridge.checkForUpdates).mockResolvedValue(storeOffer);
    vi.mocked(nativeBridge.downloadUpdate).mockResolvedValue({ ...storeOffer, status: "download-ready" });
    vi.mocked(nativeBridge.installDownloadedUpdate).mockResolvedValue({ ...storeOffer, status: "install-started" });
    useAppUpdateStore.getState().acceptStatus({ status: "idle", message: "Check Microsoft Store", updateSource: "microsoft-store" });
    await useAppUpdateStore.getState().check(false);
    await useAppUpdateStore.getState().check(true);
    await useAppUpdateStore.getState().download();
    expect(useAppUpdateStore.getState().downloaded).toBe(true);
    await useAppUpdateStore.getState().install();
    expect(nativeBridge.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(nativeBridge.downloadUpdate).toHaveBeenCalledOnce();
    expect(nativeBridge.installDownloadedUpdate).toHaveBeenCalledOnce();
    expect(useDAWStore.getState().requestQuit).not.toHaveBeenCalled();
    expect(useAppUpdateStore.getState()).toMatchObject({ offer: null, downloaded: false });
    expect(useAppUpdateStore.getState().open).toBe(true);
  });
  it("a declined Store install allows download retry and never quits", async () => {
    const storeOffer = { ...offer, updateSource: "microsoft-store" };
    useAppUpdateStore.getState().acceptStatus({ ...storeOffer, status: "download-ready" });
    vi.mocked(nativeBridge.installDownloadedUpdate).mockResolvedValue({ ...storeOffer, status: "cancelled", message: "Postponed" });
    await useAppUpdateStore.getState().install();
    expect(useAppUpdateStore.getState()).toMatchObject({ downloaded: false, pending: false, offer: { updateSource: "microsoft-store" } });
    expect(useDAWStore.getState().requestQuit).not.toHaveBeenCalled();
    await useAppUpdateStore.getState().download();
    expect(nativeBridge.downloadUpdate).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    useAppUpdateStore.setState({ ...initial, automatic: true });
    useDAWStore.setState({ ...dawInitial, isModified: false,
      transport: { ...dawInitial.transport, isPlaying: false, isRecording: false } });
    vi.spyOn(nativeBridge, "supportsAppUpdates").mockReturnValue(true);
    vi.spyOn(nativeBridge, "checkForUpdates").mockResolvedValue(offer);
    vi.spyOn(nativeBridge, "downloadUpdate").mockResolvedValue({ ...offer, status: "download-ready" });
    vi.spyOn(nativeBridge, "installDownloadedUpdate").mockResolvedValue({ ...offer, status: "install-started" });
    useDAWStore.setState({ requestQuit: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => { vi.restoreAllMocks(); useAppUpdateStore.setState(initial); useDAWStore.setState(dawInitial); });
  it("clears stale offers and skips automatic checks in development builds", async () => {
    useAppUpdateStore.getState().acceptStatus(offer);
    useAppUpdateStore.getState().acceptStatus({ status: "development", message: "Development build", currentVersion: "0.0.1" });
    await useAppUpdateStore.getState().check(false);
    expect(useAppUpdateStore.getState()).toMatchObject({ offer: null, downloaded: false });
    expect(nativeBridge.checkForUpdates).not.toHaveBeenCalled();
  });
  it("removes the update action when the running release is already current", () => {
    useAppUpdateStore.getState().acceptStatus(offer);
    useAppUpdateStore.getState().acceptStatus({ status: "up-to-date", message: "Already current", currentVersion: "0.1.01", version: "0.1.01" });
    expect(useAppUpdateStore.getState()).toMatchObject({ offer: null, downloaded: false });
  });
  it("background checks notify without opening a modal; manual checks open it", async () => {
    await useAppUpdateStore.getState().check(false);
    expect(useAppUpdateStore.getState()).toMatchObject({ open: false, offer });
    await useAppUpdateStore.getState().check(true);
    expect(useAppUpdateStore.getState().open).toBe(true);
  });
  it("honors automatic-check opt-out while allowing manual checks", async () => {
    useAppUpdateStore.getState().setAutomatic(false);
    await useAppUpdateStore.getState().check(false);
    expect(nativeBridge.checkForUpdates).not.toHaveBeenCalled();
    await useAppUpdateStore.getState().check(true);
    expect(nativeBridge.checkForUpdates).toHaveBeenCalledOnce();
  });
  it("downloads without launching an installer or closing the session", async () => {
    useAppUpdateStore.getState().acceptStatus(offer);
    await useAppUpdateStore.getState().download();
    expect(useAppUpdateStore.getState().downloaded).toBe(true);
    expect(nativeBridge.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(useDAWStore.getState().requestQuit).not.toHaveBeenCalled();
  });
  it("deduplicates in-flight downloads and keeps progress after closing the panel", async () => {
    let done!: (status: AppUpdateStatus) => void;
    vi.mocked(nativeBridge.downloadUpdate).mockReturnValue(new Promise(resolve => { done = resolve; }));
    useAppUpdateStore.getState().acceptStatus(offer);
    const first = useAppUpdateStore.getState().download();
    await useAppUpdateStore.getState().download();
    useAppUpdateStore.getState().acceptStatus({ ...offer, status: "downloading", progress: 0.4 });
    useAppUpdateStore.getState().setOpen(false);
    expect(nativeBridge.downloadUpdate).toHaveBeenCalledOnce();
    expect(useAppUpdateStore.getState().status.progress).toBe(0.4);
    done({ ...offer, status: "download-ready" });
    await first;
  });
  it("failed transfers can be retried", async () => {
    vi.mocked(nativeBridge.downloadUpdate).mockRejectedValueOnce(new Error("Network disconnected"));
    useAppUpdateStore.getState().acceptStatus(offer);
    await useAppUpdateStore.getState().download();
    expect(useAppUpdateStore.getState()).toMatchObject({ pending: false, status: { status: "error" } });
    await useAppUpdateStore.getState().download();
    expect(useAppUpdateStore.getState().downloaded).toBe(true);
  });
  it("cancelled or failed saves never launch the installer", async () => {
    const save = vi.fn().mockResolvedValue(false);
    useDAWStore.setState({ isModified: true, saveProject: save });
    useAppUpdateStore.getState().acceptStatus({ ...offer, status: "download-ready" });
    await useAppUpdateStore.getState().install();
    expect(save).toHaveBeenCalledOnce();
    expect(nativeBridge.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(useAppUpdateStore.getState().downloaded).toBe(true);
  });
  it("saves successfully before opening the installer, then uses normal quit", async () => {
    const save = vi.fn(async () => { useDAWStore.setState({ isModified: false }); return true; });
    useDAWStore.setState({ isModified: true, saveProject: save });
    useAppUpdateStore.getState().acceptStatus({ ...offer, status: "download-ready" });
    await useAppUpdateStore.getState().install();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(nativeBridge.installDownloadedUpdate).mock.invocationCallOrder[0]);
    expect(useDAWStore.getState().requestQuit).toHaveBeenCalledOnce();
  });
  it("blocks recording and project replacement during a save", async () => {
    useAppUpdateStore.getState().acceptStatus({ ...offer, status: "download-ready" });
    useDAWStore.setState({ transport: { ...dawInitial.transport, isRecording: true } });
    await useAppUpdateStore.getState().install();
    expect(nativeBridge.installDownloadedUpdate).not.toHaveBeenCalled();
    useDAWStore.setState({ transport: { ...dawInitial.transport, isRecording: false, isPlaying: false }, isModified: true,
      saveProject: vi.fn(async () => { advanceProjectEpoch(); useDAWStore.setState({ isModified: false }); return true; }) });
    await useAppUpdateStore.getState().install();
    expect(nativeBridge.installDownloadedUpdate).not.toHaveBeenCalled();
  });
  it("never quits on installer failure or the macOS/Linux package handoff", async () => {
    for (const result of [{ ...offer, status: "error" as const, message: "Launch cancelled" },
      { ...offer, status: "install-started" as const, platform: "macos" as const },
      { ...offer, status: "install-started" as const, platform: "linux" as const }]) {
      useAppUpdateStore.getState().acceptStatus({ ...offer, status: "download-ready" });
      vi.mocked(nativeBridge.installDownloadedUpdate).mockResolvedValueOnce(result);
      await useAppUpdateStore.getState().install();
    }
    expect(useDAWStore.getState().requestQuit).not.toHaveBeenCalled();
  });
});
