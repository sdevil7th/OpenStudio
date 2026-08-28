import { useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import { BookOpen, HelpCircle, MousePointer2, X } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import {
  getEffectiveShortcutLabel,
  getTimelineWheelHelp,
} from "../utils/inputProfileHelp";
import { getShortcutPlatform } from "../utils/platform";
import { Button } from "./ui";

const LS_KEY = "openstudio_essentialControlsDismissed";

export function EssentialControlsCard() {
  const {
    showContextualHelp,
    showGettingStarted,
    inputProfileOnboardingSeen,
    toggleContextualHelp,
    toggleGettingStarted,
    customShortcuts,
    keyboardShortcutProfileId,
    mouseBehaviorProfileId,
  } = useDAWStore(
    useShallow((state) => ({
      showContextualHelp: state.showContextualHelp,
      showGettingStarted: state.showGettingStarted,
      inputProfileOnboardingSeen: state.inputProfileOnboardingSeen,
      toggleContextualHelp: state.toggleContextualHelp,
      toggleGettingStarted: state.toggleGettingStarted,
      customShortcuts: state.customShortcuts,
      keyboardShortcutProfileId: state.keyboardShortcutProfileId,
      mouseBehaviorProfileId: state.mouseBehaviorProfileId,
    })),
  );

  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(LS_KEY) === "true",
  );

  const shortcuts = useMemo(() => ({
    help: getEffectiveShortcutLabel("help.contextualHelp", "F1"),
    play: getEffectiveShortcutLabel("transport.play", "Space"),
    record: getEffectiveShortcutLabel("transport.record", "Ctrl+R"),
    addTrack: getEffectiveShortcutLabel("insert.audioTrack", "Ctrl+T"),
    mixer: getEffectiveShortcutLabel("view.toggleMixer", "Ctrl+M"),
  }), [customShortcuts, keyboardShortcutProfileId]);
  const wheelHelp = useMemo(
    () => getTimelineWheelHelp(mouseBehaviorProfileId, getShortcutPlatform(), 4),
    [mouseBehaviorProfileId],
  );

  if (!inputProfileOnboardingSeen || dismissed || showContextualHelp || showGettingStarted) {
    return null;
  }

  const handleDismiss = () => {
    localStorage.setItem(LS_KEY, "true");
    setDismissed(true);
  };

  return (
    <aside
      aria-labelledby="essential-controls-title"
      className="fixed bottom-3 right-3 z-[120] max-h-[calc(100vh-1.5rem)] w-[min(21rem,calc(100%-1.5rem))] overflow-y-auto rounded-xl border border-daw-border bg-daw-panel/95 shadow-2xl backdrop-blur sm:bottom-4 sm:right-4"
    >
      <div className="flex items-start justify-between gap-3 border-b border-daw-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-daw-accent">
            Essential Controls
          </p>
          <h3 id="essential-controls-title" className="mt-1 text-sm font-semibold text-daw-text">
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
          <X size={14} aria-hidden="true" />
        </Button>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs text-neutral-300">
          <MousePointer2 size={14} aria-hidden="true" className="mt-0.5 text-daw-accent" />
          <div>
            <p className="mb-1 font-medium text-daw-text">{wheelHelp.profileName} mouse profile</p>
            <ul className="space-y-1">
              {wheelHelp.items.map((item) => (
                <li key={`${item.gesture}:${item.action}`}>
                  <span className="font-medium text-daw-text">{item.gesture}</span>: {item.action}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="rounded-lg border border-daw-border/70 bg-daw-dark/60 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-neutral-500">
            Core Hotkeys
          </p>
          <p className="mt-1 text-xs text-neutral-300 leading-relaxed">
            {shortcuts.play}: Play, {shortcuts.record}: Record, {shortcuts.addTrack}: New audio
            track, {shortcuts.mixer}: Mixer, {shortcuts.help}: Help Reference
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            className="gap-1.5"
            onClick={toggleContextualHelp}
          >
            <HelpCircle size={14} aria-hidden="true" />
            Open Help
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={toggleGettingStarted}
          >
            <BookOpen size={14} aria-hidden="true" />
            Guide
          </Button>
        </div>
      </div>
    </aside>
  );
}
