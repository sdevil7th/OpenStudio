import { useState, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { X, Search, Keyboard, HelpCircle } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { getAllHelpTexts, type HelpEntry } from "../utils/helpTexts";
import { Button } from "./ui";

/**
 * HelpOverlay — Contextual Help Panel (F1)
 *
 * Shows a floating panel with all help entries from helpTexts.ts,
 * organized by category with search/filter capability.
 */

// Categorize help entries by their key prefix
function categorizeEntries(entries: Record<string, HelpEntry>): Record<string, Array<{ id: string } & HelpEntry>> {
  const categories: Record<string, Array<{ id: string } & HelpEntry>> = {};
  const categoryNames: Record<string, string> = {
    timeline: "Timeline",
    transport: "Transport",
    mixer: "Mixer",
    track: "Track",
    fx: "Effects (FX)",
    pianoroll: "Piano Roll",
    toolbar: "Toolbar",
    meter: "Metering",
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

export function HelpOverlay() {
  const { showContextualHelp, toggleContextualHelp } = useDAWStore(
    useShallow((s) => ({
      showContextualHelp: s.showContextualHelp,
      toggleContextualHelp: s.toggleContextualHelp,
    }))
  );

  const [searchQuery, setSearchQuery] = useState("");

  const allEntries = useMemo(() => getAllHelpTexts(), []);

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

  if (!showContextualHelp) return null;

  return (
    <div className="fixed inset-0 z-2000 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={toggleContextualHelp}
      />

      {/* Panel */}
      <div className="relative w-[700px] max-h-[80vh] bg-daw-panel border border-daw-border rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-daw-border shrink-0">
          <div className="flex items-center gap-2">
            <HelpCircle size={18} className="text-daw-accent" />
            <h2 className="text-lg font-semibold text-daw-text">Help Reference</h2>
            <span className="text-xs text-neutral-500 ml-2">F1</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleContextualHelp}
            title="Close help"
            aria-label="Close help"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-daw-border shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              placeholder="Search help topics..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-daw-dark border border-daw-border rounded text-sm text-daw-text placeholder-neutral-500 focus:outline-none focus:border-daw-accent"
              autoFocus
            />
          </div>
          {searchQuery && (
            <p className="mt-1.5 text-xs text-neutral-500">
              {totalResults} result{totalResults !== 1 ? "s" : ""} found
            </p>
          )}
        </div>

        {/* Content — scrollable */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {Object.keys(filteredCategories).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-neutral-500">
              <Search size={32} className="mb-3 opacity-50" />
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
                            <Keyboard size={12} className="text-neutral-500" />
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
        <div className="px-4 py-2.5 border-t border-daw-border text-xs text-neutral-500 flex items-center justify-between shrink-0">
          <span>Press F1 to close</span>
          <span>{Object.values(allEntries).length} topics available</span>
        </div>
      </div>
    </div>
  );
}
