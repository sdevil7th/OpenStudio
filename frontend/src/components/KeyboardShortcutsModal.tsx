import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Search, Printer } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { getActionShortcutScopeLabel, getRegisteredActions } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { Button, Input } from "./ui";
import { Modal } from "./ui/Modal/Modal";

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Convert a KeyboardEvent into a human-readable shortcut string
 * matching the format used in actionRegistry (e.g. "Ctrl+Shift+Z", "Alt+B", "F1").
 */
function keyEventToShortcutString(e: KeyboardEvent): string {
  const parts: string[] = [];

  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  // Map the key to a display name
  let key = e.key;

  // Skip standalone modifier keys
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";

  // Normalize keys
  if (key === " ") key = "Space";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "Escape") key = "Esc";
  else if (key.startsWith("F") && key.length <= 3 && /^F\d+$/.test(key)) {
    // Function keys: keep as-is (F1, F2, etc.)
  } else if (key.length === 1) {
    // Single character: uppercase it
    key = key.toUpperCase();
  }

  parts.push(key);
  return parts.join("+");
}

/**
 * KeyboardShortcutsModal - Searchable, categorized keyboard shortcuts reference
 * with rebinding support.
 */
export function KeyboardShortcutsModal({
  isOpen,
  onClose,
}: KeyboardShortcutsModalProps) {
  const [search, setSearch] = useState("");
  const [listeningActionId, setListeningActionId] = useState<string | null>(
    null
  );
  const [capturedShortcut, setCapturedShortcut] = useState<string>("");
  const listeningRef = useRef<string | null>(null);

  const { customShortcuts, setCustomShortcut, resetCustomShortcuts } =
    useDAWStore(
      useShallow((s) => ({
        customShortcuts: s.customShortcuts,
        setCustomShortcut: s.setCustomShortcut,
        resetCustomShortcuts: s.resetCustomShortcuts,
      }))
    );

  const actions = useMemo(() => getRegisteredActions(), []);

  // Compute effective shortcut for each action (custom overrides default)
  const getEffectiveShortcut = useCallback(
    (actionId: string, defaultShortcut?: string): string | undefined => {
      if (customShortcuts[actionId] !== undefined) {
        return customShortcuts[actionId];
      }
      return defaultShortcut;
    },
    [customShortcuts]
  );

  const filtered = useMemo(() => {
    if (!search) return actions;
    const q = search.toLowerCase();
    return actions.filter((a) => {
      const effectiveShortcut = getEffectiveShortcut(a.id, a.shortcut);
      return (
        a.name.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (effectiveShortcut && effectiveShortcut.toLowerCase().includes(q))
      );
    });
  }, [actions, search, getEffectiveShortcut]);

  // Group by category
  const grouped = useMemo(() => {
    const groups: Record<string, typeof filtered> = {};
    for (const action of filtered) {
      if (!groups[action.category]) groups[action.category] = [];
      groups[action.category].push(action);
    }
    return groups;
  }, [filtered]);

  // Keep ref in sync with state for the event listener
  useEffect(() => {
    listeningRef.current = listeningActionId;
  }, [listeningActionId]);

  // Listen for key events when in rebinding mode
  useEffect(() => {
    if (!listeningActionId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels rebinding
      if (e.key === "Escape") {
        setListeningActionId(null);
        setCapturedShortcut("");
        return;
      }

      const shortcut = keyEventToShortcutString(e);
      if (!shortcut) return; // Ignore standalone modifier keys

      setCapturedShortcut(shortcut);

      // Save the shortcut
      if (listeningRef.current) {
        setCustomShortcut(listeningRef.current, shortcut);
      }
      setListeningActionId(null);
      setCapturedShortcut("");
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [listeningActionId, setCustomShortcut]);

  // Cancel listening when modal closes
  useEffect(() => {
    if (!isOpen) {
      setListeningActionId(null);
      setCapturedShortcut("");
    }
  }, [isOpen]);

  const handleStartRebind = (actionId: string) => {
    setListeningActionId(actionId);
    setCapturedShortcut("");
  };

  const handleResetSingle = (actionId: string) => {
    // Remove only this action's custom shortcut
    const updated = { ...customShortcuts };
    delete updated[actionId];
    // We need to set it via the store; since there's no "remove single" action,
    // we'll just set it to the empty object minus this key
    // Actually we can overwrite by setting the full map
    useDAWStore.setState({ customShortcuts: updated });
    localStorage.setItem("s13_customShortcuts", JSON.stringify(updated));
  };

  const hasAnyCustomShortcuts = Object.keys(customShortcuts).length > 0;

  const handlePrintCheatSheet = useCallback(() => {
    // Build grouped data for the printable view using all actions (not filtered by search)
    const allActions = getRegisteredActions();
    const printGroups: Record<string, { name: string; shortcut: string }[]> = {};
    for (const action of allActions) {
      const effectiveShortcut = getEffectiveShortcut(action.id, action.shortcut);
      if (!effectiveShortcut) continue; // Only include actions that have shortcuts
      if (!printGroups[action.category]) printGroups[action.category] = [];
      printGroups[action.category].push({
        name: action.name,
        shortcut: effectiveShortcut,
      });
    }

    const categoriesHtml = Object.entries(printGroups)
      .map(
        ([category, items]) => `
        <div class="category">
          <h2>${category}</h2>
          <table>
            ${items
              .map(
                (item) => `
              <tr>
                <td class="action-name">${item.name}</td>
                <td class="shortcut"><kbd>${item.shortcut}</kbd></td>
              </tr>`
              )
              .join("")}
          </table>
        </div>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>OpenStudio - Keyboard Shortcuts</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
      color: #1a1a1a;
      max-width: 900px;
      margin: 0 auto;
    }
    h1 {
      font-size: 20px;
      margin-bottom: 4px;
      text-align: center;
    }
    .subtitle {
      text-align: center;
      font-size: 11px;
      color: #888;
      margin-bottom: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .category {
      break-inside: avoid;
      margin-bottom: 8px;
    }
    h2 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #555;
      border-bottom: 1px solid #ddd;
      padding-bottom: 3px;
      margin-bottom: 4px;
    }
    table { width: 100%; border-collapse: collapse; }
    tr { border-bottom: 1px solid #f0f0f0; }
    td { padding: 2px 4px; font-size: 11px; vertical-align: middle; }
    .action-name { color: #333; }
    .shortcut { text-align: right; white-space: nowrap; }
    kbd {
      font-family: "SF Mono", "Consolas", "Monaco", monospace;
      font-size: 10px;
      background: #f0f0f0;
      border: 1px solid #ccc;
      border-radius: 3px;
      padding: 1px 5px;
      color: #333;
    }
    @media print {
      body { padding: 12px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <h1>OpenStudio Keyboard Shortcuts</h1>
  <p class="subtitle">Generated on ${new Date().toLocaleDateString()}</p>
  <div class="no-print" style="text-align:center;margin-bottom:16px;">
    <button onclick="window.print()" style="padding:6px 20px;font-size:13px;cursor:pointer;border:1px solid #ccc;border-radius:4px;background:#f8f8f8;">
      Print / Save as PDF
    </button>
  </div>
  <div class="grid">
    ${categoriesHtml}
  </div>
</body>
</html>`;

    const printWindow = window.open("", "_blank");
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
    }
  }, [getEffectiveShortcut]);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Keyboard Shortcuts"
      size="lg"
    >
      <div className="flex flex-col gap-3 max-h-[70vh]">
        {/* Search */}
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shortcuts..."
            className="pl-7"
            autoFocus={!listeningActionId}
          />
        </div>

        {/* Listening overlay */}
        {listeningActionId && (
          <div className="bg-daw-accent/20 border border-daw-accent rounded px-3 py-2 text-sm text-center">
            <span className="text-daw-accent font-semibold">
              Press a key combination...
            </span>
            {capturedShortcut && (
              <span className="ml-2 font-mono bg-neutral-700 px-2 py-0.5 rounded text-white">
                {capturedShortcut}
              </span>
            )}
            <div className="text-xs text-neutral-400 mt-1">
              Press Esc to cancel
            </div>
          </div>
        )}

        <div className="text-xs text-neutral-500 px-1">
          Rebinding currently applies to global shortcuts. Timeline- and editor-scoped shortcuts are shown here for reference but cannot be rebound yet.
        </div>

        {/* Shortcuts List */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {Object.entries(grouped).map(([category, categoryActions]) => (
            <div key={category} className="mb-3">
              <h3 className="text-xs font-semibold uppercase text-daw-text-muted px-2 py-1 bg-neutral-800 rounded sticky top-0 z-10">
                {category} ({categoryActions.length})
              </h3>
              <div className="mt-1">
                {categoryActions.map((action) => {
                  const isCustom =
                    customShortcuts[action.id] !== undefined;
                  const effectiveShortcut = getEffectiveShortcut(
                    action.id,
                    action.shortcut
                  );
                  const shortcutScope = action.shortcutScope ?? "global";
                  const shortcutScopeLabel = getActionShortcutScopeLabel(shortcutScope);
                  const canRebind = shortcutScope === "global";
                  const isListening = listeningActionId === action.id;

                  return (
                    <div
                      key={action.id}
                      className={`flex items-center justify-between px-2 py-1 text-sm rounded group ${
                        isListening
                          ? "bg-daw-accent/10 ring-1 ring-daw-accent"
                          : "hover:bg-neutral-800"
                      }`}
                    >
                      <span
                        className="text-daw-text cursor-pointer flex-1 min-w-0 truncate"
                        onClick={() => {
                          if (!listeningActionId) {
                            action.execute();
                            onClose();
                          }
                        }}
                        title={action.name}
                      >
                        {action.name}
                      </span>

                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {/* Shortcut badge */}
                        {effectiveShortcut ? (
                          <>
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                                isCustom
                                  ? "bg-daw-accent/30 text-daw-accent font-bold border border-daw-accent/50"
                                  : "text-daw-text-muted bg-neutral-700"
                              }`}
                              title={
                                isCustom
                                  ? `Custom (default: ${action.shortcut || "none"})`
                                  : undefined
                              }
                            >
                              {effectiveShortcut}
                            </span>
                            <span className="text-[10px] uppercase tracking-wide text-daw-text-muted/70">
                              {shortcutScopeLabel}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-neutral-600 w-6 text-center">
                            —
                          </span>
                        )}

                        {/* Rebind button */}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-1.5 py-0.5 h-auto"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canRebind) return;
                            handleStartRebind(action.id);
                          }}
                          disabled={!!listeningActionId || !canRebind}
                          title={canRebind ? "Rebind" : `${shortcutScopeLabel} shortcut`}
                        >
                          Rebind
                        </Button>

                        {/* Reset button (only visible for custom shortcuts) */}
                        {isCustom && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-1.5 py-0.5 h-auto text-orange-400 hover:text-orange-300"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleResetSingle(action.id);
                            }}
                            disabled={!!listeningActionId}
                          >
                            Reset
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {Object.keys(grouped).length === 0 && (
            <div className="text-center text-daw-text-muted text-sm py-4">
              No shortcuts found for &quot;{search}&quot;
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center pt-2 border-t border-daw-border">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">
              {filtered.length} action{filtered.length !== 1 ? "s" : ""}
            </span>
            {hasAnyCustomShortcuts && (
              <Button
                variant="ghost"
                size="sm"
                className="text-[10px] text-orange-400 hover:text-orange-300"
                onClick={() => {
                  if (
                    window.confirm(
                      "Reset all custom shortcuts to defaults?"
                    )
                  ) {
                    resetCustomShortcuts();
                  }
                }}
              >
                Reset All
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="default" size="sm" onClick={handlePrintCheatSheet}>
              <Printer size={12} className="mr-1.5" />
              Print Cheat Sheet
            </Button>
            <Button variant="default" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
