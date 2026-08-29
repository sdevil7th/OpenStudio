import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useShallow } from "zustand/shallow";
import { X, Search, Keyboard, HelpCircle } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { getAllHelpTexts, type HelpEntry } from "../utils/helpTexts";
import { getEffectiveShortcutLabel } from "../utils/inputProfileHelp";
import { getKeyboardShortcutProfile } from "../utils/shortcutProfiles";
import { getMouseBehaviorProfile } from "../utils/mouseBehaviorProfiles";
import { getShortcutPlatform } from "../utils/platform";
import { Button } from "./ui";
import { guardModalContextMenu } from "../utils/modalEventGuards";
import {
  routeModalShortcutEvent,
  useModalShortcutScope,
} from "../utils/modalShortcutScope";
import { activateShortcutContext } from "../utils/shortcutContext";

/**
 * HelpOverlay - Contextual Help Panel (F1)
 *
 * Shows a floating panel with all help entries from helpTexts.ts,
 * organized by category with search/filter capability.
 */

// Categorize help entries by their key prefix
function categorizeEntries(entries: Record<string, HelpEntry>): Record<string, Array<{ id: string } & HelpEntry>> {
  const categories: Record<string, Array<{ id: string } & HelpEntry>> = {};
  const categoryNames: Record<string, string> = {
    navigation: "Navigation",
    timeline: "Timeline",
    transport: "Transport",
    mixer: "Mixer",
    tracks: "Tracks",
    midi: "MIDI & Instruments",
    fx: "Effects (FX)",
    automation: "Automation",
    pitch: "Pitch",
    ai: "AI Music",
    stem: "Stem Separation",
    routing: "Routing",
    render: "Render & Export",
    media: "Media",
    markers: "Markers & Regions",
    metering: "Metering",
    project: "Project",
    session: "Session View",
    scripting: "Scripting",
    customization: "Customization",
    video: "Video",
    shortcuts: "Keyboard Shortcuts",
    settings: "Settings",
  };

  for (const [key, entry] of Object.entries(entries)) {
    const prefix = key.split(".")[0];
    const catName = categoryNames[prefix] || "Other";
    if (!categories[catName]) {
      categories[catName] = [];
    }
    categories[catName].push({ id: key, ...entry });
  }

  return categories;
}

const HELP_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function HelpOverlay() {
  const {
    showContextualHelp,
    toggleContextualHelp,
    customShortcuts,
    keyboardShortcutProfileId,
    mouseBehaviorProfileId,
  } = useDAWStore(
    useShallow((s) => ({
      showContextualHelp: s.showContextualHelp,
      toggleContextualHelp: s.toggleContextualHelp,
      customShortcuts: s.customShortcuts,
      keyboardShortcutProfileId: s.keyboardShortcutProfileId,
      mouseBehaviorProfileId: s.mouseBehaviorProfileId,
    }))
  );

  const [searchQuery, setSearchQuery] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const allEntries = useMemo(
    () => getAllHelpTexts(),
    [customShortcuts, keyboardShortcutProfileId, mouseBehaviorProfileId],
  );
  const helpShortcut = useMemo(
    () => getEffectiveShortcutLabel("help.contextualHelp", "F1"),
    [customShortcuts, keyboardShortcutProfileId],
  );
  const keyboardProfile = getKeyboardShortcutProfile(keyboardShortcutProfileId);
  const mouseProfile = getMouseBehaviorProfile(
    mouseBehaviorProfileId,
    getShortcutPlatform(),
  );

  useModalShortcutScope(showContextualHelp, toggleContextualHelp);

  const filteredCategories = useMemo(() => {
    const categorized = categorizeEntries(allEntries);

    if (!searchQuery.trim()) return categorized;

    const query = searchQuery.toLowerCase();
    const filtered: Record<string, Array<{ id: string } & HelpEntry>> = {};

    for (const [category, entries] of Object.entries(categorized)) {
      const matching = entries.filter(
        (e) =>
          e.title.toLowerCase().includes(query) ||
          e.description.toLowerCase().includes(query) ||
          (e.shortcut && e.shortcut.toLowerCase().includes(query))
      );
      if (matching.length > 0) {
        filtered[category] = matching;
      }
    }

    return filtered;
  }, [allEntries, searchQuery]);

  const totalResults = useMemo(
    () => Object.values(filteredCategories).reduce((sum, arr) => sum + arr.length, 0),
    [filteredCategories]
  );

  useEffect(() => {
    if (!showContextualHelp) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, [showContextualHelp]);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const modalRoute = routeModalShortcutEvent(event.nativeEvent);
    if (modalRoute.result !== "unmatched" || modalRoute.suppressedHeadlessEscape) {
      if (modalRoute.result !== "unmatched") event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(HELP_FOCUSABLE_SELECTOR),
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!showContextualHelp) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      data-modal-root="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-reference-title"
      onKeyDown={handleDialogKeyDown}
      onContextMenu={guardModalContextMenu}
      onPointerDownCapture={() => activateShortcutContext({ kind: "modal" })}
      onFocusCapture={() => activateShortcutContext({ kind: "modal" })}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={toggleContextualHelp}
        onContextMenu={guardModalContextMenu}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-[700px] flex-col overflow-hidden rounded-lg border border-daw-border bg-daw-panel shadow-2xl outline-none"
        onContextMenu={guardModalContextMenu}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-daw-border shrink-0">
          <div className="flex items-center gap-2">
            <HelpCircle size={18} className="text-daw-accent" aria-hidden="true" />
            <h2 id="help-reference-title" className="text-lg font-semibold text-daw-text">Help Reference</h2>
            <span className="text-xs text-neutral-500 ml-2">{helpShortcut}</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleContextualHelp}
            title="Close help"
            aria-label="Close help"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-daw-border shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search help topics..."
              aria-label="Search help topics"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-daw-dark border border-daw-border rounded text-sm text-daw-text placeholder-neutral-500 focus:outline-none focus:border-daw-accent"
            />
          </div>
          {searchQuery && (
            <p className="mt-1.5 text-xs text-neutral-500" aria-live="polite">
              {totalResults} result{totalResults !== 1 ? "s" : ""} found
            </p>
          )}
        </div>

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {Object.keys(filteredCategories).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-neutral-500">
              <Search size={32} className="mb-3 opacity-50" aria-hidden="true" />
              <p className="text-sm">No help topics match your search.</p>
              <p className="text-xs mt-1">Try a different keyword.</p>
            </div>
          ) : (
            Object.entries(filteredCategories).map(([category, entries]) => (
              <div key={category}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
                  {category}
                </h3>
                <div className="space-y-2">
                  {entries.map((entry) => (
                    <div
                      key={entry.id}
                      className="p-3 bg-daw-dark/50 border border-daw-border/50 rounded-md hover:border-daw-border transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="text-sm font-medium text-daw-text">
                          {entry.title}
                        </h4>
                        {entry.shortcut && (
                          <div className="flex items-center gap-1 shrink-0">
                            <Keyboard size={12} className="text-neutral-500" aria-hidden="true" />
                            <span className="text-xs text-daw-accent font-mono whitespace-nowrap">
                              {entry.shortcut}
                            </span>
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                        {entry.description}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t border-daw-border px-4 py-2.5 text-xs text-neutral-500">
          <span>Press {helpShortcut} to close</span>
          <span>{keyboardProfile.shortName} keys | {mouseProfile.name} mouse | {Object.values(allEntries).length} topics</span>
        </div>
      </div>
    </div>
  );
}
