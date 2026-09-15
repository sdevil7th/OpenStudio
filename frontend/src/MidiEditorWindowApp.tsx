import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import { Dock, X } from "lucide-react";
import { Button } from "./components/ui";
import { PianoRoll } from "./components/PianoRoll";
import { nativeBridge } from "./services/NativeBridge";
import { useDAWStore } from "./store/useDAWStore";
import { dispatchGlobalShortcut } from "./utils/globalShortcutDispatcher";
import {
  browserShortcutWindowIsActive,
  toGlobalShortcutPayload,
} from "./utils/domShortcutEvent";
import { installModalContextMenuLeakGuard } from "./utils/modalEventGuards";
import { windowSessionId } from "./utils/windowEnvironment";
import {
  hydrateMidiEditorUISnapshotFromNative,
  requestMidiEditorDock,
  startMidiEditorUISync,
} from "./utils/midiEditorWindowSync";
import { startSharedTransportSync } from "./utils/sharedTransportSync";
import { installBrowserZoomWheelGuard } from "./utils/browserWheelGuard";
import { startDetachedInputProfileSync } from "./utils/inputProfileWindowSync";

export default function MidiEditorWindowApp() {
  const [hydrated, setHydrated] = useState(false);
  const windowFocusedRef = useRef(document.hasFocus());
  useEffect(() => installBrowserZoomWheelGuard(document), []);
  useEffect(() => startDetachedInputProfileSync(), []);
  const {
    tracks,
    pianoRollTrackId,
    pianoRollClipId,
    activeMidiEditorSessionId,
    selectedClipIds,
  } = useDAWStore(
    useShallow((state) => ({
      tracks: state.tracks,
      pianoRollTrackId: state.pianoRollTrackId,
      pianoRollClipId: state.pianoRollClipId,
      activeMidiEditorSessionId: state.activeMidiEditorSessionId,
      selectedClipIds: state.selectedClipIds,
    })),
  );
  const sessionId = windowSessionId || activeMidiEditorSessionId || "";

  useEffect(() => {
    let cancelled = false;
    let stopSync: (() => void) | undefined;

    void (async () => {
      await hydrateMidiEditorUISnapshotFromNative(windowSessionId || undefined);
      if (cancelled) return;
      stopSync = startMidiEditorUISync(windowSessionId || undefined);
      if (!cancelled) {
        useDAWStore.setState((state) => ({
          detachedPanels: state.detachedPanels.includes("midiEditor")
            ? state.detachedPanels
            : [...state.detachedPanels, "midiEditor"],
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

  const additionalClipIds = useMemo(() => {
    if (!pianoRollTrackId || !pianoRollClipId || selectedClipIds.length <= 1) return [];
    const pianoTrack = tracks.find((track) => track.id === pianoRollTrackId);
    if (!pianoTrack) return [];
    const midiClipIds = new Set(pianoTrack.midiClips.map((clip) => clip.id));
    return selectedClipIds.filter((id) => id !== pianoRollClipId && midiClipIds.has(id));
  }, [pianoRollClipId, pianoRollTrackId, selectedClipIds, tracks]);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.id === pianoRollTrackId) ?? null,
    [pianoRollTrackId, tracks],
  );
  const activeClip = useMemo(
    () => activeTrack?.midiClips.find((clip) => clip.id === pianoRollClipId) ?? null,
    [activeTrack, pianoRollClipId],
  );
  const title = activeTrack && activeClip
    ? `${activeTrack.name || "Track"} - ${activeClip.name || "MIDI Clip"}`
    : "MIDI Editor";

  const [docking, setDocking] = useState(false);
  const handleDock = useCallback(async () => {
    const targetSessionId = sessionId || useDAWStore.getState().activeMidiEditorSessionId;
    if (!targetSessionId) return;
    if (docking) return;
    setDocking(true);
    try { await requestMidiEditorDock(targetSessionId); }
    catch (error) { useDAWStore.getState().showToast(String(error), "error"); }
    finally { setDocking(false); }
  }, [sessionId, docking]);

  const handleClose = useCallback(async () => {
    const targetSessionId = sessionId || useDAWStore.getState().activeMidiEditorSessionId;
    await nativeBridge.closeMidiEditorWindow(targetSessionId || undefined, "close");
  }, [sessionId]);

  if (!hydrated) {
    return (
      <div className="h-screen w-screen bg-neutral-950 text-neutral-400 flex items-center justify-center text-sm">
        Loading MIDI editor...
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-neutral-950 flex flex-col">
      <div className="h-9 shrink-0 flex items-center justify-between px-3 bg-neutral-850 border-b border-neutral-700">
        <h1 className="text-xs font-semibold text-neutral-100 truncate">{title}</h1>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void handleDock(); }}
            title="Dock MIDI editor"
            aria-label="Dock MIDI editor"
          >
            <Dock size={14} />
            Dock
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => { void handleClose(); }}
            title="Close MIDI editor window"
            aria-label="Close MIDI editor window"
          >
            <X size={16} />
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {pianoRollTrackId && pianoRollClipId ? (
          <Suspense fallback={<div className="flex items-center justify-center h-full text-neutral-500 text-sm">Loading...</div>}>
            <PianoRoll
              sessionId={sessionId || activeMidiEditorSessionId || undefined}
              trackId={pianoRollTrackId}
              clipId={pianoRollClipId}
              additionalClipIds={additionalClipIds}
              isDetached={true}
            />
          </Suspense>
        ) : (
          <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
            No MIDI clip selected
          </div>
        )}
      </div>
    </div>
  );
}
