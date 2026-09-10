import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { MixerPanel } from "./components/MixerPanel";
import { nativeBridge } from "./services/NativeBridge";
import { useDAWStore } from "./store/useDAWStore";
import { dispatchGlobalShortcut } from "./utils/globalShortcutDispatcher";
import {
  browserShortcutWindowIsActive,
  toGlobalShortcutPayload,
} from "./utils/domShortcutEvent";
import { installModalContextMenuLeakGuard } from "./utils/modalEventGuards";
import {
  hydrateMixerUISnapshotFromNative,
  startMixerUISync,
} from "./utils/mixerWindowSync";
import { startSharedTransportSync } from "./utils/sharedTransportSync";
import { installBrowserZoomWheelGuard } from "./utils/browserWheelGuard";

export default function MixerWindowApp() {
  const { batchUpdateMeterLevels } = useDAWStore(useShallow((state) => ({
    batchUpdateMeterLevels: state.batchUpdateMeterLevels,
  })));
  const [hydrated, setHydrated] = useState(false);
  const windowFocusedRef = useRef(document.hasFocus());
  useEffect(() => installBrowserZoomWheelGuard(document), []);

  useEffect(() => {
    let cancelled = false;
    let stopSync: (() => void) | undefined;

    void (async () => {
      await hydrateMixerUISnapshotFromNative();
      if (cancelled) {
        return;
      }

      stopSync = startMixerUISync();
      if (!cancelled) {
        useDAWStore.setState((state) => ({
          showMixer: true,
          detachedPanels: state.detachedPanels.includes("mixer")
            ? state.detachedPanels
            : [...state.detachedPanels, "mixer"],
        }));
        setHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
      stopSync?.();
    };
  }, []);

  useEffect(() => {
    return startSharedTransportSync();
  }, []);

  useEffect(() => installModalContextMenuLeakGuard(), []);

  useEffect(() => {
    nativeBridge.onMeterUpdate((data) => {
      const trackLevels: Record<string, number> =
        data.trackLevels &&
        typeof data.trackLevels === "object" &&
        !Array.isArray(data.trackLevels)
          ? data.trackLevels
          : {};
      const trackClipping: Record<string, boolean> =
        data.trackClipping &&
        typeof data.trackClipping === "object" &&
        !Array.isArray(data.trackClipping)
          ? data.trackClipping
          : {};
      const midiInputLevels: Record<string, number> =
        data.midiInputLevels &&
        typeof data.midiInputLevels === "object" &&
        !Array.isArray(data.midiInputLevels)
          ? data.midiInputLevels
          : {};
      const masterLevel = typeof data.masterLevel === "number" ? data.masterLevel : 0;
      const masterClipping = data.masterClipping === true;
      batchUpdateMeterLevels(trackLevels, masterLevel, trackClipping, masterClipping, midiInputLevels);
    });
  }, [batchUpdateMeterLevels]);

  useEffect(() => {
    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
    };
    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!browserShortcutWindowIsActive({
        documentFocused: document.hasFocus(),
        visibilityState: document.visibilityState,
        windowFocused: windowFocusedRef.current,
      })) return;
      void dispatchGlobalShortcut(toGlobalShortcutPayload(e));
    };

    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  if (!hydrated) {
    return (
      <div className="h-screen w-screen bg-neutral-950 text-neutral-400 flex items-center justify-center text-sm">
        Loading mixer...
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-neutral-950">
      <MixerPanel
        isVisible={true}
        isDetached={true}
        renderInOwnWindow={true}
        onAttach={() => { void nativeBridge.closeMixerWindow(); }}
      />
    </div>
  );
}
