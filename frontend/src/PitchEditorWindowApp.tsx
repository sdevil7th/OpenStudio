import { useEffect, useState } from "react";
import { PitchEditorLowerZone } from "./components/PitchEditorLowerZone";
import { connectPitchEditorView } from "./utils/pitchEditorSession";
import { startSharedTransportSync } from "./utils/sharedTransportSync";
import { startDetachedInputProfileSync } from "./utils/inputProfileWindowSync";
import { installBrowserZoomWheelGuard } from "./utils/browserWheelGuard";
import { dispatchGlobalShortcut } from "./utils/globalShortcutDispatcher";
import { toGlobalShortcutPayload } from "./utils/domShortcutEvent";

export default function PitchEditorWindowApp() {
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState("");
  const [height, setHeight] = useState(window.innerHeight - 36);
  useEffect(() => {
    let cancelled = false;
    let disconnect: (() => void) | undefined;
    void connectPitchEditorView(() => { if (!cancelled) setHydrated(true); }, setError)
      .then(stop => { if (cancelled) stop(); else disconnect = stop; }).catch(reason => setError(String(reason)));
    return () => { cancelled = true; disconnect?.(); };
  }, []);
  useEffect(() => startSharedTransportSync(), []);
  useEffect(() => startDetachedInputProfileSync(), []);
  useEffect(() => installBrowserZoomWheelGuard(document), []);
  useEffect(() => {
    const resize = () => setHeight(Math.max(1, window.innerHeight - 36));
    const key = (event: KeyboardEvent) => { if (document.hasFocus()) void dispatchGlobalShortcut(toGlobalShortcutPayload(event)); };
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("resize", resize); window.removeEventListener("keydown", key, true); };
  }, []);
  return <div className="h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-200 flex flex-col">
    <header className="h-9 shrink-0 flex items-center gap-3 px-3 border-b border-neutral-700 text-xs">
      <span className="flex-1 truncate" role={error ? "alert" : undefined}>{error || "Pitch Editor"}</span>
      <button type="button" className="rounded bg-neutral-700 px-3 py-1" disabled={!hydrated}
        onClick={() => window.dispatchEvent(new Event("openstudio:dock-pitch"))}>Dock</button>
    </header>
    {hydrated ? <PitchEditorLowerZone height={height} /> : <div className="m-auto text-sm">Loading pitch session...</div>}
  </div>;
}
