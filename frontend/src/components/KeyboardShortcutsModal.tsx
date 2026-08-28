import { useState, useMemo, useEffect, useCallback } from "react";
import { Search, Printer } from "lucide-react";
import { useShallow } from "zustand/shallow";
import {
  getActionShortcutScopeLabel,
  getActionShortcutScopes,
  getRegisteredActions,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { Button, Input, NativeSelect } from "./ui";
import { InputProfileSelectors } from "./InputProfileSelectors";
import { CustomKeyboardProfileManager } from "./CustomKeyboardProfileManager";
import { Modal } from "./ui/Modal/Modal";
import { formatShortcut, getShortcutPlatform } from "../utils/platform";
import {
  getKeyboardShortcutProfilePresentation,
  getProfileActionBindings,
} from "../utils/shortcutProfiles";
import { findShortcutAssignmentConflicts } from "../utils/shortcutAssignmentConflicts";
import {
  MAX_CUSTOM_KEYBOARD_PROFILES,
  MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET,
  getCustomShortcutTargetBindings,
  hasCustomShortcutOverride,
  resolveCustomShortcutBindings,
  type CustomShortcutTarget,
} from "../utils/customShortcutProfiles";
import keyboardShortcutsPrintCssUrl from "./KeyboardShortcutsPrint.css?url";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  registerShortcutSurface,
  shortcutExactlyMatches,
  toPressedShortcut,
} from "../utils/shortcutContext";

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function escapePrintHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const [bindingTarget, setBindingTarget] = useState<CustomShortcutTarget>("common");

  const {
    customShortcuts,
    customKeyboardProfiles,
    activeCustomKeyboardProfileId,
    keyboardShortcutProfileId,
    addCustomShortcutBinding,
    removeCustomShortcutBinding,
    setCustomShortcutBindings,
    removeCustomShortcut,
    resetCustomShortcuts,
  } =
    useDAWStore(
      useShallow((s) => ({
        customShortcuts: s.customShortcuts,
        customKeyboardProfiles: s.customKeyboardProfiles,
        activeCustomKeyboardProfileId: s.activeCustomKeyboardProfileId,
        keyboardShortcutProfileId: s.keyboardShortcutProfileId,
        addCustomShortcutBinding: s.addCustomShortcutBinding,
        removeCustomShortcutBinding: s.removeCustomShortcutBinding,
        setCustomShortcutBindings: s.setCustomShortcutBindings,
        removeCustomShortcut: s.removeCustomShortcut,
        resetCustomShortcuts: s.resetCustomShortcuts,
      }))
    );

  const actions = useMemo(() => getRegisteredActions(), []);
  const implicitProfileCreationBlocked = activeCustomKeyboardProfileId === null
    && customKeyboardProfiles.length >= MAX_CUSTOM_KEYBOARD_PROFILES;

  // Compute every effective binding in dispatch precedence order.
  const getEffectiveShortcuts = useCallback(
    (actionId: string, defaultShortcut?: string, shortcutAliases: readonly string[] = []): string[] => {
      const platform = getShortcutPlatform();
      const custom = resolveCustomShortcutBindings(customShortcuts, actionId, platform);
      if (custom !== undefined) return [...custom];
      const profileBindings = getProfileActionBindings(
        keyboardShortcutProfileId,
        actionId,
        platform,
      );
      if (profileBindings !== undefined) return [...profileBindings];
      return [defaultShortcut, ...shortcutAliases].filter(
        (shortcut): shortcut is string => typeof shortcut === "string" && Boolean(shortcut) && !shortcut.includes("("),
      );
    },
    [customShortcuts, keyboardShortcutProfileId]
  );

  const filtered = useMemo(() => {
    if (!search) return actions;
    const q = search.toLowerCase();
    return actions.filter((a) => {
      const effectiveShortcuts = getEffectiveShortcuts(a.id, a.shortcut, a.shortcutAliases);
      return (
        a.name.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        effectiveShortcuts.some((shortcut) => shortcut.toLowerCase().includes(q))
      );
    });
  }, [actions, search, getEffectiveShortcuts]);

  // Group by category
  const grouped = useMemo(() => {
    const groups: Record<string, typeof filtered> = {};
    for (const action of filtered) {
      if (!groups[action.category]) groups[action.category] = [];
      groups[action.category].push(action);
    }
    return groups;
  }, [filtered]);

  // Rebinding temporarily owns the shared shortcut router, so capturing a new
  // binding cannot also execute the action currently assigned to that key.
  useEffect(() => {
    if (!listeningActionId) return;
    const previousContext = getActiveShortcutContext();
    const unregister = registerShortcutSurface(
      { kind: "application" },
      (event) => {
        if (shortcutExactlyMatches(event, "Esc")) {
          setListeningActionId(null);
          setCapturedShortcut("");
          return "handled";
        }

        const shortcut = toPressedShortcut(event);
        if (!shortcut) return "claimed_noop";
        setCapturedShortcut(shortcut);
        const conflicts = findShortcutAssignmentConflicts(
          listeningActionId,
          shortcut,
          bindingTarget,
        );
        if (conflicts.length > 0) {
          const conflictSummary = conflicts
            .map((conflict) => (
              `${conflict.actionName} (${conflict.sharedScopes.join(", ")}; ${conflict.platforms.join(", ")})`
            ))
            .join("\n");
          const confirmed = window.confirm(
            `${formatShortcut(shortcut)} is already used by:\n\n${conflictSummary}\n\nAssign it anyway?`,
          );
          if (!confirmed) return "handled";
        }
        addCustomShortcutBinding(listeningActionId, shortcut, bindingTarget);
        setListeningActionId(null);
        setCapturedShortcut("");
        return "handled";
      },
      previousContext,
    );
    activateShortcutContext({ kind: "application" });
    return unregister;
  }, [addCustomShortcutBinding, bindingTarget, listeningActionId]);

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
    removeCustomShortcut(actionId, bindingTarget);
  };

  const hasAnyCustomShortcuts = Object.keys(customShortcuts).length > 0;

  const handlePrintCheatSheet = useCallback(() => {
    // Build grouped data for the printable view using all actions (not filtered by search)
    const allActions = getRegisteredActions();
    const platform = getShortcutPlatform();
    const profilePresentation = getKeyboardShortcutProfilePresentation(
      keyboardShortcutProfileId,
      platform,
    );
    const activeCustomProfile = customKeyboardProfiles.find(
      (profile) => profile.id === activeCustomKeyboardProfileId,
    );
    const printedProfileName = activeCustomProfile?.name ?? profilePresentation.profile.name;
    const printGroups: Record<string, { name: string; shortcut: string }[]> = {};
    for (const action of allActions) {
      const effectiveShortcuts = getEffectiveShortcuts(action.id, action.shortcut, action.shortcutAliases);
      if (effectiveShortcuts.length === 0) continue; // Only include actions that have shortcuts
      if (!printGroups[action.category]) printGroups[action.category] = [];
      printGroups[action.category].push({
        name: action.name,
        shortcut: effectiveShortcuts.map((shortcut) => formatShortcut(shortcut)).join(" / "),
      });
    }

    const categoriesHtml = Object.entries(printGroups)
      .map(
        ([category, items]) => `
        <div class="category">
          <h2>${escapePrintHtml(category)}</h2>
          <table>
            ${items
              .map(
                (item) => `
              <tr>
                <td class="action-name">${escapePrintHtml(item.name)}</td>
                <td class="shortcut"><kbd>${escapePrintHtml(item.shortcut)}</kbd></td>
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
  <link rel="stylesheet" href="${escapePrintHtml(keyboardShortcutsPrintCssUrl)}">
</head>
<body>
  <h1>OpenStudio Keyboard Shortcuts</h1>
  <p class="subtitle">${escapePrintHtml(printedProfileName)} &middot; ${escapePrintHtml(profilePresentation.policyLabel)} &middot; ${escapePrintHtml(profilePresentation.availabilityLabel)}</p>
  <p class="subtitle">Generated on ${escapePrintHtml(new Date().toLocaleDateString())}</p>
  <div class="no-print print-actions">
    <button class="print-button" onclick="window.print()">
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
      printWindow.opener = null;
      printWindow.document.write(html);
      printWindow.document.close();
    }
  }, [
    activeCustomKeyboardProfileId,
    customKeyboardProfiles,
    getEffectiveShortcuts,
    keyboardShortcutProfileId,
  ]);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Keyboard Shortcuts"
      size="lg"
      className="!w-[calc(100vw-2rem)] max-w-[700px]"
    >
      <div className="flex max-h-[calc(100vh-8rem)] min-w-0 flex-col gap-3 overflow-y-auto pr-1">
        {/* Search */}
        <div className="rounded-lg border border-daw-border bg-daw-dark/40 p-3">
          <InputProfileSelectors compact />
        </div>
        <CustomKeyboardProfileManager />

        <div className="grid gap-2 rounded-lg border border-daw-border bg-daw-dark/40 p-3 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-end">
          <NativeSelect
            label="Edit overrides for"
            options={[
              { value: "common", label: "All platforms" },
              { value: "macos", label: "macOS" },
              { value: "windows", label: "Windows" },
              { value: "linux", label: "Linux" },
              { value: "other", label: "Other / fallback" },
            ]}
            value={bindingTarget}
            onChange={(value) => {
              if (["common", "macos", "windows", "linux", "other"].includes(String(value))) {
                setBindingTarget(String(value) as CustomShortcutTarget);
              }
            }}
            size="sm"
            fullWidth
            showPlaceholder={false}
          />
          <p className="text-[11px] leading-relaxed text-neutral-500">
            A platform-specific list replaces All platforms on that platform. An empty list intentionally disables the action there.
          </p>
        </div>

        <div className="relative">
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shortcuts..."
            aria-label="Search keyboard shortcuts"
            className="pl-7"
            autoFocus={!listeningActionId}
          />
        </div>

        {/* Listening overlay */}
        {listeningActionId && (
          <div
            className="bg-daw-accent/20 border border-daw-accent rounded px-3 py-2 text-sm text-center"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
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
          Select an action name to run it, or add one or more keys for the selected platform target. Scoped bindings apply only in their named editors; a custom list overrides the selected base profile.
        </div>

        {/* Shortcuts List */}
        <div className="min-w-0 flex-none">
          {Object.entries(grouped).map(([category, categoryActions]) => (
            <div key={category} className="mb-3">
              <h3 className="pointer-events-none sticky top-0 z-10 rounded bg-neutral-800 px-2 py-1 text-xs font-semibold uppercase text-daw-text-muted">
                {category} ({categoryActions.length})
              </h3>
              <div className="mt-1">
                {categoryActions.map((action) => {
                  const currentPlatform = getShortcutPlatform();
                  const isCustom = hasCustomShortcutOverride(
                    customShortcuts,
                    action.id,
                    currentPlatform,
                  );
                  const targetBindings = getCustomShortcutTargetBindings(
                    customShortcuts[action.id],
                    bindingTarget,
                  );
                  const hasTargetOverride = targetBindings !== undefined;
                  const targetBindingList = targetBindings ?? [];
                  const targetBindingCapacityReached =
                    targetBindingList.length >= MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET;
                  const effectiveShortcuts = getEffectiveShortcuts(
                    action.id,
                    action.shortcut,
                    action.shortcutAliases,
                  );
                  const profileShortcuts = getProfileActionBindings(
                    keyboardShortcutProfileId,
                    action.id,
                    getShortcutPlatform(),
                  ) ?? [action.shortcut, ...(action.shortcutAliases ?? [])].filter(
                    (shortcut): shortcut is string => typeof shortcut === "string" && Boolean(shortcut) && !shortcut.includes("("),
                  );
                  const shortcutScopeLabels = getActionShortcutScopes(action, keyboardShortcutProfileId).map(
                    (scope) => getActionShortcutScopeLabel(scope),
                  );
                  const shortcutScopeLabel = shortcutScopeLabels.join(", ");
                  const canRebind = true;
                  const isListening = listeningActionId === action.id;

                  return (
                    <div
                      key={action.id}
                      className={`group flex flex-col items-stretch gap-1 rounded px-2 py-1 text-sm sm:flex-row sm:items-center sm:justify-between ${
                        isListening
                          ? "bg-daw-accent/10 ring-1 ring-daw-accent"
                          : "hover:bg-neutral-800"
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate rounded text-left text-daw-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daw-accent disabled:cursor-default"
                        onClick={() => {
                          if (!listeningActionId) {
                            action.execute();
                            onClose();
                          }
                        }}
                        disabled={Boolean(listeningActionId)}
                        title={action.name}
                      >
                        {action.name}
                      </button>

                      <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:ml-2 sm:shrink-0 sm:justify-end">
                        {/* Shortcut badge */}
                        {effectiveShortcuts.length > 0 ? (
                          <>
                            <span className="flex items-center gap-1">
                              {effectiveShortcuts.map((shortcut, index) => (
                                <span
                                  key={`${shortcut}-${index}`}
                                  className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                                    isCustom
                                      ? "bg-daw-accent/30 text-daw-accent font-bold border border-daw-accent/50"
                                      : "text-daw-text-muted bg-neutral-700"
                                  }`}
                                  title={
                                    isCustom
                                      ? `Custom (profile: ${profileShortcuts.map((binding) => formatShortcut(binding)).join(" / ") || "none"})`
                                      : undefined
                                  }
                                >
                                  {formatShortcut(shortcut)}
                                </span>
                              ))}
                            </span>
                          </>
                        ) : (
                          <span
                            className={`text-xs ${isCustom ? "text-orange-300" : "text-neutral-500"}`}
                            title={isCustom ? "Intentionally unassigned by custom binding" : "Unassigned in the selected profile"}
                          >
                            {isCustom ? "Unassigned (custom)" : "Unassigned"}
                          </span>
                        )}
                        <span className="text-[10px] uppercase tracking-wide text-daw-text-muted/70">
                          {shortcutScopeLabel}
                        </span>

                        {hasTargetOverride && (
                          <span className="flex flex-wrap items-center gap-1" aria-label={`${bindingTarget} custom bindings`}>
                            <span className="text-[10px] uppercase text-daw-accent/80">
                              {bindingTarget === "common" ? "All" : bindingTarget}
                            </span>
                            {targetBindingList.length > 0 ? targetBindingList.map((shortcut) => (
                              <button
                                key={shortcut}
                                type="button"
                                className="rounded border border-daw-accent/50 bg-daw-accent/20 px-1.5 py-0.5 font-mono text-[10px] text-daw-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daw-accent"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeCustomShortcutBinding(action.id, shortcut, bindingTarget);
                                }}
                                disabled={Boolean(listeningActionId)}
                                aria-label={`Remove ${formatShortcut(shortcut)} from ${action.name} for ${bindingTarget}`}
                                title="Remove this binding"
                              >
                                {formatShortcut(shortcut)} ×
                              </button>
                            )) : (
                              <span className="text-[10px] text-orange-300">Disabled here</span>
                            )}
                          </span>
                        )}

                        {/* Add another binding */}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto px-1.5 py-0.5 text-[10px] opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canRebind) return;
                            handleStartRebind(action.id);
                          }}
                          disabled={!!listeningActionId
                            || !canRebind
                            || targetBindingCapacityReached
                            || implicitProfileCreationBlocked}
                          title={implicitProfileCreationBlocked
                            ? `Delete a custom profile before adding bindings (limit ${MAX_CUSTOM_KEYBOARD_PROFILES})`
                            : targetBindingCapacityReached
                            ? `Maximum of ${MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET} bindings for this target`
                            : canRebind
                              ? `Add a ${bindingTarget} binding`
                              : `${shortcutScopeLabel} shortcut`}
                          aria-label={`Rebind ${action.name}`}
                        >
                          Add key
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto px-1.5 py-0.5 text-[10px] text-orange-300 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                          onClick={(event) => {
                            event.stopPropagation();
                            setCustomShortcutBindings(action.id, [], bindingTarget);
                          }}
                          disabled={Boolean(listeningActionId) || implicitProfileCreationBlocked}
                          aria-label={`Disable ${action.name} for ${bindingTarget}`}
                          title={`Intentionally unassign for ${bindingTarget}`}
                        >
                          Disable
                        </Button>

                        {/* Inherit button (only visible for the selected target override) */}
                        {hasTargetOverride && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-auto px-1.5 py-0.5 text-[10px] text-orange-400 opacity-70 transition-opacity hover:text-orange-300 hover:opacity-100 focus-visible:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleResetSingle(action.id);
                            }}
                            disabled={!!listeningActionId}
                            aria-label={`Remove ${bindingTarget} override for ${action.name}`}
                          >
                            Inherit
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
        <div className="flex flex-col gap-2 border-t border-daw-border pt-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
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
                      "Reset all custom shortcuts to the selected profile?"
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="default" size="sm" onClick={handlePrintCheatSheet}>
              <Printer size={12} className="mr-1.5" aria-hidden="true" />
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
