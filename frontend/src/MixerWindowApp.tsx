import { useEffect, useState } from "react";
import { MixerPanel } from "./components/MixerPanel";
import { nativeBridge, type NativeGlobalShortcutEvent } from "./services/NativeBridge";
import { useDAWStore } from "./store/useDAWStore";
import { dispatchGlobalShortcut } from "./utils/globalShortcutDispatcher";
import {
  hydrateMixerUISnapshotFromNative,
  startMixerUISync,
} from "./utils/mixerWindowSync";

export default function MixerWindowApp() {
  const batchUpdateMeterLevels = useDAWStore((state) => state.batchUpdateMeterLevels);
  const setCurrentTime = useDAWStore((state) => state.setCurrentTime);
  const [hydrated, setHydrated] = useState(false);

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
    const unsubscribe = nativeBridge.onTransportUpdate((data) => {
      const state = useDAWStore.getState();
      const backendPos = data.position;
      const frontendPos = state.transport.currentTime;
      const drift = Math.abs(backendPos - frontendPos);
      const backendPlaying = !!data.isPlaying;
      const frontendPlaying = state.transport.isPlaying;

      if (backendPlaying !== frontendPlaying) {
        useDAWStore.setState((current) => ({
          transport: {
            ...current.transport,
            isPlaying: backendPlaying,
            isPaused: false,
            isRecording: backendPlaying ? current.transport.isRecording : false,
            currentTime: backendPos,
          },
        }));
        return;
      }

      if (!frontendPlaying) {
        return;
      }

      if (drift > 0.03) {
        setCurrentTime(backendPos);
      }
    });

    return unsubscribe;
  }, [setCurrentTime]);

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
      const masterLevel = typeof data.masterLevel === "number" ? data.masterLevel : 0;
      const masterClipping = data.masterClipping === true;
      batchUpdateMeterLevels(trackLevels, masterLevel, trackClipping, masterClipping);
    });
  }, [batchUpdateMeterLevels]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      void dispatchGlobalShortcut({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        source: "browser",
        targetIsEditable:
          !!target &&
          (target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target.isContentEditable),
        preventDefault: () => e.preventDefault(),
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    const unsubscribeNativeShortcuts = nativeBridge.onNativeGlobalShortcut(
      (event: NativeGlobalShortcutEvent) => {
        void dispatchGlobalShortcut({ ...event, source: "pluginWindow" });
      },
    );

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      unsubscribeNativeShortcuts();
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
