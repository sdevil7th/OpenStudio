import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { getRegisteredActions, ActionDef } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const actions = useMemo(() => getRegisteredActions(), []);
  const recentActionIds = useDAWStore((state) => state.recentActions);

  const filtered = useMemo(() => {
    if (!query.trim()) {
      // Show recent actions first, then all actions
      if (recentActionIds.length > 0) {
        const recentActions = recentActionIds
          .map((id) => actions.find((a) => a.id === id))
          .filter(Boolean) as ActionDef[];
        const rest = actions.filter((a) => !recentActionIds.includes(a.id));
        return [...recentActions, ...rest];
      }
      return actions;
    }
    const lower = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.name.toLowerCase().includes(lower) ||
        a.category.toLowerCase().includes(lower) ||
        a.shortcut?.toLowerCase().includes(lower)
    );
  }, [query, actions, recentActionIds]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement;
      if (selected) {
        selected.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  const executeAction = (action: ActionDef) => {
    onClose();
    // Track as recent action
    useDAWStore.getState().trackRecentAction(action.id);
    // Small delay to let modal close before executing
    setTimeout(() => action.execute(), 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      executeAction(filtered[selectedIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  // Group by category for display
  const grouped: Map<string, ActionDef[]> = new Map();
  const showRecent = !query.trim() && recentActionIds.length > 0;
  for (let i = 0; i < filtered.length; i++) {
    const action = filtered[i];
    // First N items are recent actions when no query
    const category = showRecent && i < recentActionIds.length ? "Recent" : action.category;
    const existing = grouped.get(category) || [];
    existing.push(action);
    grouped.set(category, existing);
  }

  // Build flat list for indexing
  let flatIndex = 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Palette */}
      <div
        className="relative w-[520px] max-h-[60vh] bg-neutral-900 border border-neutral-600 rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="p-3 border-b border-neutral-700">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="w-full bg-neutral-800 border border-neutral-600 rounded px-3 py-2 text-sm text-white placeholder-neutral-500 outline-none focus:border-blue-500"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-sm text-neutral-500 text-center">
              No matching commands
            </div>
          ) : (
            Array.from(grouped.entries()).map(([category, categoryActions]) => (
              <div key={category}>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-850 sticky top-0">
                  {category}
                </div>
                {categoryActions.map((action) => {
                  const thisIndex = flatIndex++;
                  const isSelected = thisIndex === selectedIndex;
                  return (
                    <div
                      key={action.id}
                      className={`px-3 py-1.5 flex items-center justify-between cursor-pointer text-sm ${
                        isSelected
                          ? "bg-blue-600 text-white"
                          : "text-neutral-300 hover:bg-neutral-800"
                      }`}
                      onClick={() => executeAction(action)}
                      onMouseEnter={() => setSelectedIndex(thisIndex)}
                    >
                      <span>{action.name}</span>
                      {action.shortcut && (
                        <span
                          className={`text-xs ${
                            isSelected ? "text-blue-200" : "text-neutral-500"
                          }`}
                        >
                          {action.shortcut}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-neutral-700 text-[10px] text-neutral-500 flex gap-4">
          <span>
            <kbd className="bg-neutral-800 px-1 rounded">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="bg-neutral-800 px-1 rounded">Enter</kbd> execute
          </span>
          <span>
            <kbd className="bg-neutral-800 px-1 rounded">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
