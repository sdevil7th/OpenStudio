import {
  getActionShortcutScopes,
  getRegisteredActions,
  type ActionDef,
  type ActionShortcutWhen,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import {
  getShortcutPlatform,
  normalizeShortcutBindings,
  shortcutBindingEventSignature,
  type ShortcutPlatform,
} from "./platform";
import { getProfileActionBindings } from "./shortcutProfiles";
import {
  getCustomShortcutTargetBindings,
  resolveCustomShortcutBindings,
  type CustomShortcutTarget,
} from "./customShortcutProfiles";

export interface ShortcutAssignmentConflict {
  actionId: string;
  actionName: string;
  shortcut: string;
  sharedScopes: readonly string[];
  platforms: readonly ShortcutPlatform[];
}

function conditionsOverlap(a?: ActionShortcutWhen, b?: ActionShortcutWhen): boolean {
  if (!a || a === "always" || !b || b === "always" || a === b) return true;
  return !new Set([
    "step_input_disabled|step_input_enabled",
    "step_input_enabled|step_input_disabled",
    "transport_running|transport_stopped",
    "transport_stopped|transport_running",
  ]).has(`${a}|${b}`);
}

function effectiveBindings(action: ActionDef, platform: ShortcutPlatform): readonly string[] {
  const state = useDAWStore.getState();
  const custom = resolveCustomShortcutBindings(state.customShortcuts, action.id, platform);
  if (custom !== undefined) return normalizeShortcutBindings(custom);
  const profile = getProfileActionBindings(
    state.keyboardShortcutProfileId,
    action.id,
    platform,
  );
  if (profile !== undefined) return normalizeShortcutBindings(profile);
  return normalizeShortcutBindings([
    action.shortcut,
    ...(action.shortcutAliases ?? []),
  ].filter((binding): binding is string => typeof binding === "string" && !binding.includes("(")));
}

function comparableBinding(binding: string, platform: ShortcutPlatform): string {
  return shortcutBindingEventSignature(binding, platform) ?? "";
}

function platformsForTarget(target: CustomShortcutTarget | undefined): readonly ShortcutPlatform[] {
  if (!target) return [getShortcutPlatform()];
  if (target === "common") return ["macos", "windows", "linux", "other"];
  return [target];
}

function commonBindingWouldApply(
  actionId: string,
  platform: ShortcutPlatform,
): boolean {
  const value = useDAWStore.getState().customShortcuts[actionId];
  if (getCustomShortcutTargetBindings(value, platform) !== undefined) return false;
  // `other` intentionally falls back to a Windows-specific override before
  // common, mirroring resolveCustomShortcutBindings().
  return platform !== "other"
    || getCustomShortcutTargetBindings(value, "windows") === undefined;
}

export function findShortcutAssignmentConflicts(
  targetActionId: string,
  proposedShortcut: string,
  bindingTarget?: CustomShortcutTarget,
): ShortcutAssignmentConflict[] {
  const actions = getRegisteredActions();
  const targetAction = actions.find((action) => action.id === targetActionId);
  if (!targetAction) return [];
  const profileId = useDAWStore.getState().keyboardShortcutProfileId;

  const conflicts = new Map<string, ShortcutAssignmentConflict>();
  for (const platform of platformsForTarget(bindingTarget)) {
    if (bindingTarget === "common" && !commonBindingWouldApply(targetActionId, platform)) continue;
    const candidate = comparableBinding(proposedShortcut, platform);
    if (!candidate) continue;

    for (const action of actions) {
      if (action.id === targetAction.id || !conditionsOverlap(targetAction.shortcutWhen, action.shortcutWhen)) continue;
      const sharedScopes = getActionShortcutScopes(targetAction, profileId)
        .filter((scope) => getActionShortcutScopes(action, profileId).includes(scope));
      if (sharedScopes.length === 0) continue;
      const conflict = effectiveBindings(action, platform)
        .find((binding) => comparableBinding(binding, platform) === candidate);
      if (!conflict) continue;
      const key = `${action.id}|${sharedScopes.join(",")}`;
      const existing = conflicts.get(key);
      if (existing) {
        if (!existing.platforms.includes(platform)) {
          conflicts.set(key, { ...existing, platforms: [...existing.platforms, platform] });
        }
      } else {
        conflicts.set(key, {
          actionId: action.id,
          actionName: action.name,
          shortcut: conflict,
          sharedScopes,
          platforms: [platform],
        });
      }
    }
  }
  return [...conflicts.values()];
}
