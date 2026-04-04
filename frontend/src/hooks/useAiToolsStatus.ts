import { useEffect } from "react";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";

export function useAiToolsStatus() {
  const status = useDAWStore((state) => state.aiToolsStatus);
  const loading = useDAWStore((state) => state.aiToolsStatusLoading);
  const refresh = useDAWStore((state) => state.refreshAiToolsStatus);
  const install = useDAWStore((state) => state.installAiTools);
  const cancel = useDAWStore((state) => state.cancelAiToolsInstall);

  useEffect(() => {
    if (loading) {
      void refresh(true);
    }
  }, [loading, refresh]);

  const openHelp = async () => {
    if (status.helpUrl) {
      await nativeBridge.openExternalURL(status.helpUrl);
    }
  };

  return {
    status,
    loading,
    refresh,
    install,
    cancel,
    openHelp,
  };
}
