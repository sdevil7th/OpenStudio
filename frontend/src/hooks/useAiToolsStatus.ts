import { useCallback, useEffect, useState } from "react";
import {
  nativeBridge,
  type AiToolsStatus,
  type InstallAiToolsResponse,
} from "../services/NativeBridge";

const DEFAULT_STATUS: AiToolsStatus = {
  state: "runtimeMissing",
  progress: 0,
  available: false,
  pythonDetected: false,
  scriptAvailable: false,
  runtimeInstalled: false,
  modelInstalled: false,
  installInProgress: false,
  message: "Install AI Tools to enable stem separation.",
  helpUrl: "https://www.python.org/downloads/",
};

export function useAiToolsStatus() {
  const [status, setStatus] = useState<AiToolsStatus>(DEFAULT_STATUS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const nextStatus = await nativeBridge.getAiToolsStatus();
    setStatus(nextStatus);
    setLoading(false);
    return nextStatus;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status.installInProgress) return;

    const timer = window.setInterval(() => {
      void refresh();
    }, 1000);

    return () => window.clearInterval(timer);
  }, [refresh, status.installInProgress]);

  const install = useCallback(async (): Promise<InstallAiToolsResponse> => {
    const result = await nativeBridge.installAiTools();
    if (result.status) {
      setStatus(result.status);
      setLoading(false);
    } else {
      await refresh();
    }
    return result;
  }, [refresh]);

  const cancel = useCallback(async () => {
    await nativeBridge.cancelAiToolsInstall();
    await refresh();
  }, [refresh]);

  const openHelp = useCallback(async () => {
    if (status.helpUrl) {
      await nativeBridge.openExternalURL(status.helpUrl);
    }
  }, [status.helpUrl]);

  return {
    status,
    loading,
    refresh,
    install,
    cancel,
    openHelp,
  };
}
