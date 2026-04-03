import { useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import { BookOpen, HelpCircle, MousePointer2, X } from "lucide-react";
import { getEffectiveActionShortcut } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { Button } from "./ui";

const LS_KEY = "openstudio_essentialControlsDismissed";

export function EssentialControlsCard() {
  const {
    showContextualHelp,
    showGettingStarted,
    toggleContextualHelp,
    toggleGettingStarted,
  } = useDAWStore(
    useShallow((state) => ({
      showContextualHelp: state.showContextualHelp,
      showGettingStarted: state.showGettingStarted,
      toggleContextualHelp: state.toggleContextualHelp,
      toggleGettingStarted: state.toggleGettingStarted,
    })),
  );
  const customShortcuts = useDAWStore((state) => state.customShortcuts);

  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(LS_KEY) === "true",
  );

  const helpShortcut = useMemo(
    () => getEffectiveActionShortcut("help.contextualHelp") ?? "F1",
    [customShortcuts],
  );
  const playShortcut = useMemo(
    () => getEffectiveActionShortcut("transport.play") ?? "Space",
    [customShortcuts],
  );
  const recordShortcut = useMemo(
    () => getEffectiveActionShortcut("transport.record") ?? "Ctrl+R",
    [customShortcuts],
  );
  const addTrackShortcut = useMemo(
    () => getEffectiveActionShortcut("insert.audioTrack") ?? "Ctrl+T",
    [customShortcuts],
  );
  const mixerShortcut = useMemo(
    () => getEffectiveActionShortcut("view.toggleMixer") ?? "Ctrl+M",
    [customShortcuts],
  );

  if (dismissed || showContextualHelp || showGettingStarted) {
    return null;
  }

  const handleDismiss = () => {
    localStorage.setItem(LS_KEY, "true");
    setDismissed(true);
  };

  return (
    <div className="absolute bottom-4 right-4 z-[120] w-[min(21rem,calc(100%-1.5rem))] rounded-xl border border-daw-border bg-daw-panel/95 shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between gap-3 border-b border-daw-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-daw-accent">
            Essential Controls
          </p>
          <h3 className="mt-1 text-sm font-semibold text-daw-text">
            Navigate the timeline quickly
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleDismiss}
          title="Hide essential controls"
          aria-label="Hide essential controls"
        >
          <X size={14} />
        </Button>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs text-neutral-300">
          <MousePointer2 size={14} className="mt-0.5 text-daw-accent" />
          <div className="space-y-1">
            <div>
              <span className="font-medium text-daw-text">Scroll</span>: move vertically
            </div>
            <div>
              <span className="font-medium text-daw-text">Ctrl+Scroll</span>: zoom the timeline
            </div>
            <div>
              <span className="font-medium text-daw-text">Shift+Scroll</span>: move horizontally
            </div>
            <div>
              <span className="font-medium text-daw-text">Alt+Scroll</span>: resize track height
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-daw-border/70 bg-daw-dark/60 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-neutral-500">
            Core Hotkeys
          </p>
          <p className="mt-1 text-xs text-neutral-300 leading-relaxed">
            {playShortcut}: Play, {recordShortcut}: Record, {addTrackShortcut}: New audio
            track, {mixerShortcut}: Mixer, {helpShortcut}: Help Reference
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            className="gap-1.5"
            onClick={toggleContextualHelp}
          >
            <HelpCircle size={14} />
            Open Help
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={toggleGettingStarted}
          >
            <BookOpen size={14} />
            Guide
          </Button>
        </div>
      </div>
    </div>
  );
}
