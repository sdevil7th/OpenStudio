import { useState, useMemo } from "react";
import { Search } from "lucide-react";
import { getRegisteredActions } from "../store/actionRegistry";
import { Button, Input } from "./ui";
import { Modal } from "./ui/Modal/Modal";

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * KeyboardShortcutsModal - Searchable, categorized keyboard shortcuts reference
 */
export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  const [search, setSearch] = useState("");

  const actions = useMemo(() => getRegisteredActions(), []);

  const filtered = useMemo(() => {
    if (!search) return actions;
    const q = search.toLowerCase();
    return actions.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (a.shortcut && a.shortcut.toLowerCase().includes(q)),
    );
  }, [actions, search]);

  // Group by category
  const grouped = useMemo(() => {
    const groups: Record<string, typeof filtered> = {};
    for (const action of filtered) {
      if (!groups[action.category]) groups[action.category] = [];
      groups[action.category].push(action);
    }
    return groups;
  }, [filtered]);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard Shortcuts" size="lg">
      <div className="flex flex-col gap-3 max-h-[70vh]">
        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shortcuts..."
            className="pl-7"
            autoFocus
          />
        </div>

        {/* Shortcuts List */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {Object.entries(grouped).map(([category, categoryActions]) => (
            <div key={category} className="mb-3">
              <h3 className="text-xs font-semibold uppercase text-daw-text-muted px-2 py-1 bg-neutral-800 rounded sticky top-0">
                {category} ({categoryActions.length})
              </h3>
              <div className="mt-1">
                {categoryActions.map((action) => (
                  <div
                    key={action.id}
                    className="flex items-center justify-between px-2 py-1 text-sm hover:bg-neutral-800 rounded cursor-pointer"
                    onClick={() => {
                      action.execute();
                      onClose();
                    }}
                  >
                    <span className="text-daw-text">{action.name}</span>
                    {action.shortcut ? (
                      <span className="text-xs text-daw-text-muted bg-neutral-700 px-1.5 py-0.5 rounded font-mono">
                        {action.shortcut}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-600">—</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(grouped).length === 0 && (
            <div className="text-center text-daw-text-muted text-sm py-4">
              No shortcuts found for "{search}"
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center pt-2 border-t border-daw-border">
          <span className="text-xs text-neutral-500">
            {filtered.length} action{filtered.length !== 1 ? "s" : ""}
          </span>
          <Button variant="default" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
