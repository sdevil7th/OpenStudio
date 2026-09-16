import {
  getActionShortcutScopes,
  getRegisteredActions,
  type ActionDef,
  type ActionShortcutScope,
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
  type CustomKeyboardShortcutProfile,
  type CustomShortcutMap,
  type CustomShortcutTarget,
} from "./customShortcutProfiles";

export type ShortcutConflictPrecedence =
  | "same_precedence"
  | "target_precedes"
  | "existing_precedes"
  | "mixed";

export interface ShortcutAssignmentConflict {
  actionId: string;
  actionName: string;
  shortcut: string;
  sharedScopes: readonly string[];
  platforms: readonly ShortcutPlatform[];
  /** Which command wins in the resolver tiers represented by sharedScopes. */
  precedence: ShortcutConflictPrecedence;
}

export interface ShortcutProfileConflict extends ShortcutAssignmentConflict {
  targetActionId: string;
  targetActionName: string;
}

interface ShortcutResolutionState {
  profileId: unknown;
  customShortcuts: CustomShortcutMap;
}

interface ShortcutScopeOverlap {
  scopes: readonly ActionShortcutScope[];
  precedence: ShortcutConflictPrecedence;
}

const CONCRETE_SHORTCUT_SCOPES: readonly ActionShortcutScope[] = [
  "timeline",
  "timeline_ruler",
  "track_control_panel",
  "mixer",
  "pitch_editor",
  "piano_roll",
  "automation",
  "browser",
  "plugin",
  "modal",
];

function conditionsOverlap(a?: ActionShortcutWhen, b?: ActionShortcutWhen): boolean {
  if (!a || a === "always" || !b || b === "always" || a === b) return true;
  return !new Set([
    "step_input_disabled|step_input_enabled",
    "step_input_enabled|step_input_disabled",
    "transport_running|transport_stopped",
    "transport_stopped|transport_running",
  ]).has(`${a}|${b}`);
}

function effectiveBindings(
  action: ActionDef,
  platform: ShortcutPlatform,
  state: ShortcutResolutionState,
): readonly string[] {
  const custom = resolveCustomShortcutBindings(state.customShortcuts, action.id, platform);
  if (custom !== undefined) return normalizeShortcutBindings(custom);
  const profile = getProfileActionBindings(
    state.profileId,
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
  customShortcuts: CustomShortcutMap,
): boolean {
  const value = customShortcuts[actionId];
  if (getCustomShortcutTargetBindings(value, platform) !== undefined) return false;
  // `other` intentionally falls back to a Windows-specific override before
  // common, mirroring resolveCustomShortcutBindings().
  return platform !== "other"
    || getCustomShortcutTargetBindings(value, "windows") === undefined;
}

function scopeTier(
  scopes: readonly ActionShortcutScope[],
  concreteScope: ActionShortcutScope,
): number | null {
  if (scopes.includes(concreteScope)) return 3;
  if (scopes.includes("contextual")) return 2;
  if (scopes.includes("global")) return 1;
  return null;
}

function precedenceFromTiers(
  targetTier: number,
  existingTier: number,
): Exclude<ShortcutConflictPrecedence, "mixed"> {
  if (targetTier === existingTier) return "same_precedence";
  return targetTier > existingTier ? "target_precedes" : "existing_precedes";
}

/**
 * Model the registry's concrete -> contextual -> global lookup order.
 *
 * Merely intersecting literal scope names misses real collisions such as a
 * Timeline action shadowing a Global action while Timeline has focus. At the
 * same time, two unrelated concrete editors are independent and remain safe to
 * bind alike.
 */
function findScopeOverlap(
  targetScopes: readonly ActionShortcutScope[],
  existingScopes: readonly ActionShortcutScope[],
): ShortcutScopeOverlap | null {
  const overlaps: Array<{
    scope: ActionShortcutScope;
    precedence: Exclude<ShortcutConflictPrecedence, "mixed">;
  }> = [];

  if (targetScopes.includes("global") && existingScopes.includes("global")) {
    overlaps.push({ scope: "global", precedence: "same_precedence" });
  }

  const concreteOverlaps = CONCRETE_SHORTCUT_SCOPES.flatMap((scope) => {
    const targetTier = scopeTier(targetScopes, scope);
    const existingTier = scopeTier(existingScopes, scope);
    if (targetTier === null || existingTier === null) return [];
    // A pair of global-only actions is already represented by the application
    // overlap above; repeating it for every editor would make diagnostics noisy.
    if (targetTier === 1 && existingTier === 1) return [];
    return [{
      scope,
      precedence: precedenceFromTiers(targetTier, existingTier),
    }];
  });

  const hasExplicitConcreteScope = [...targetScopes, ...existingScopes]
    .some((scope) => CONCRETE_SHORTCUT_SCOPES.includes(scope));
  const concretePrecedences = new Set(concreteOverlaps.map((entry) => entry.precedence));
  if (
    !hasExplicitConcreteScope
    && concreteOverlaps.length === CONCRETE_SHORTCUT_SCOPES.length
    && concretePrecedences.size === 1
  ) {
    overlaps.push({
      scope: "contextual",
      precedence: concreteOverlaps[0].precedence,
    });
  } else {
    overlaps.push(...concreteOverlaps);
  }

  if (overlaps.length === 0) return null;
  const precedences = new Set(overlaps.map((entry) => entry.precedence));
  return {
    scopes: [...new Set(overlaps.map((entry) => entry.scope))],
    precedence: precedences.size === 1 ? overlaps[0].precedence : "mixed",
  };
}

function currentResolutionState(): ShortcutResolutionState {
  const state = useDAWStore.getState();
  return {
    profileId: state.keyboardShortcutProfileId,
    customShortcuts: state.customShortcuts,
  };
}

function findConflictsForCandidate(
  targetAction: ActionDef,
  proposedShortcut: string,
  platform: ShortcutPlatform,
  state: ShortcutResolutionState,
): Array<Omit<ShortcutAssignmentConflict, "platforms">> {
  const actions = getRegisteredActions();
  const candidate = comparableBinding(proposedShortcut, platform);
  if (!candidate) return [];

  const targetScopes = getActionShortcutScopes(targetAction, state.profileId);
  return actions.flatMap((action) => {
    if (
      action.id === targetAction.id
      || !conditionsOverlap(targetAction.shortcutWhen, action.shortcutWhen)
    ) return [];
    const overlap = findScopeOverlap(
      targetScopes,
      getActionShortcutScopes(action, state.profileId),
    );
    if (!overlap) return [];
    const conflict = effectiveBindings(action, platform, state)
      .find((binding) => comparableBinding(binding, platform) === candidate);
    if (!conflict) return [];
    return [{
      actionId: action.id,
      actionName: action.name,
      shortcut: conflict,
      sharedScopes: overlap.scopes,
      precedence: overlap.precedence,
    }];
  });
}

export function findShortcutAssignmentConflicts(
  targetActionId: string,
  proposedShortcut: string,
  bindingTarget?: CustomShortcutTarget,
): ShortcutAssignmentConflict[] {
  const actions = getRegisteredActions();
  const targetAction = actions.find((action) => action.id === targetActionId);
  if (!targetAction) return [];
  const state = currentResolutionState();

  const conflicts = new Map<string, ShortcutAssignmentConflict>();
  for (const platform of platformsForTarget(bindingTarget)) {
    if (
      bindingTarget === "common"
      && !commonBindingWouldApply(targetActionId, platform, state.customShortcuts)
    ) continue;

    for (const conflict of findConflictsForCandidate(
      targetAction,
      proposedShortcut,
      platform,
      state,
    )) {
      const key = `${conflict.actionId}|${conflict.sharedScopes.join(",")}|${conflict.precedence}`;
      const existing = conflicts.get(key);
      if (existing) {
        if (!existing.platforms.includes(platform)) {
          conflicts.set(key, { ...existing, platforms: [...existing.platforms, platform] });
        }
      } else {
        conflicts.set(key, {
          ...conflict,
          platforms: [platform],
        });
      }
    }
  }
  return [...conflicts.values()];
}

/**
 * Inspect every effective custom binding in an imported profile before that
 * profile becomes active. Base-profile bindings and scope additions are
 * resolved exactly as they will be at runtime, but pre-existing collisions in
 * the untouched base profile are not re-reported as import problems.
 */
export function findCustomKeyboardProfileConflicts(
  profile: Pick<CustomKeyboardShortcutProfile, "baseProfileId" | "bindings">,
): ShortcutProfileConflict[] {
  const actions = getRegisteredActions();
  const state: ShortcutResolutionState = {
    profileId: profile.baseProfileId,
    customShortcuts: profile.bindings,
  };
  const conflicts = new Map<string, ShortcutProfileConflict>();

  for (const platform of platformsForTarget("common")) {
    for (const targetAction of actions) {
      const importedBindings = resolveCustomShortcutBindings(
        profile.bindings,
        targetAction.id,
        platform,
      );
      if (importedBindings === undefined) continue;

      for (const proposedShortcut of importedBindings) {
        for (const conflict of findConflictsForCandidate(
          targetAction,
          proposedShortcut,
          platform,
          state,
        )) {
          const pair = [targetAction.id, conflict.actionId].sort().join("|");
          const signature = comparableBinding(proposedShortcut, platform);
          const key = `${pair}|${signature}|${conflict.sharedScopes.join(",")}`;
          const existing = conflicts.get(key);
          if (existing) {
            if (!existing.platforms.includes(platform)) {
              conflicts.set(key, {
                ...existing,
                platforms: [...existing.platforms, platform],
              });
            }
            continue;
          }
          conflicts.set(key, {
            ...conflict,
            targetActionId: targetAction.id,
            targetActionName: targetAction.name,
            platforms: [platform],
          });
        }
      }
    }
  }

  return [...conflicts.values()];
}
