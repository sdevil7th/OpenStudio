import { nativeBridge, type NativeGlobalShortcutEvent } from "../services/NativeBridge";
import {
  getRegisteredAction,
  getRegisteredActions,
  getActionShortcutScopes,
  type ActionDef,
  type ActionShortcutScope,
} from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import {
  dispatchActiveShortcut,
  getActiveShortcutContext,
  shouldPreserveEditableShortcut,
  shouldPreserveNonTextControlShortcut,
  shortcutExactlyMatches,
  shortcutExactlyMatchesForPlatform,
  type ShortcutEventLike,
} from "./shortcutContext";
import {
  getShortcutPlatform,
  normalizeShortcutBindings,
  type ShortcutPlatform,
} from "./platform";
import { getProfileActionBindings } from "./shortcutProfiles";
import { resolveCustomShortcutBindings } from "./customShortcutProfiles";
import { windowRole, windowSessionId } from "./windowEnvironment";
import {
  canRouteDetachedMainAction,
  isDetachedMainActionId,
  publishDetachedMainAction,
} from "./detachedMainActionRouting";

let _lastSpacebarMs = 0;
let _lastRecordShortcutMs = 0;

const REPEATABLE_ACTION_IDS = new Set([
  "navigate.nextTransient",
  "navigate.prevTransient",
  "edit.nudgeLeft",
  "edit.nudgeRight",
  "edit.nudgeLeftFine",
  "edit.nudgeRightFine",
  "view.zoomIn",
  "view.zoomOut",
]);

export interface GlobalShortcutPayload extends NativeGlobalShortcutEvent {
  targetIsEditable?: boolean;
  targetIsNonTextControl?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  stopImmediatePropagation?: () => void;
}

export interface GlobalShortcutDispatchOptions {
  /**
   * Optional host/test execution adapter. Resolution, native-event ownership,
   * repeat guards, and canHandle checks remain production-identical; only the
   * final action body is replaced.
   */
  executeAction?: (action: ActionDef) => void;
  /** Uses the same controlled availability semantics as the pure resolver. */
  canHandleAction?: (action: ActionDef) => boolean;
  /** Test/host seam; production defaults to the current WebView role. */
  role?: string;
}

function markHandled(payload: GlobalShortcutPayload): true {
  payload.preventDefault?.();
  if (payload.stopImmediatePropagation) payload.stopImmediatePropagation();
  else payload.stopPropagation?.();
  return true;
}

function isPlainSpacebar(payload: ShortcutEventLike): boolean {
  return (payload.key === " " || payload.code === "Space")
    && !payload.ctrlKey
    && !payload.metaKey
    && !payload.altKey
    && !payload.shiftKey;
}

/**
 * Return the exact bindings the dispatcher will consider for one action.
 *
 * Keeping this public lets diagnostics and exhaustive profile verification use
 * the same custom-profile -> built-in-profile -> factory fallback precedence as
 * production dispatch. An explicit empty override intentionally returns [].
 */
export function getEffectiveActionShortcuts(
  action: ActionDef,
  platform: ShortcutPlatform = getShortcutPlatform(),
): string[] {
  const state = useDAWStore.getState();
  const custom = resolveCustomShortcutBindings(state.customShortcuts, action.id, platform);
  if (custom !== undefined) return normalizeShortcutBindings(custom);

  const profileBindings = getProfileActionBindings(
    state.keyboardShortcutProfileId,
    action.id,
    platform,
  );
  if (profileBindings !== undefined) {
    return normalizeShortcutBindings(profileBindings);
  }

  return normalizeShortcutBindings(
    [action.shortcut, ...(action.shortcutAliases ?? [])].filter(
      (shortcut): shortcut is string => typeof shortcut === "string" && !shortcut.includes("("),
    ),
  );
}

function actionMatchesEvent(
  action: ActionDef,
  event: ShortcutEventLike,
  platform: ShortcutPlatform = getShortcutPlatform(),
): boolean {
  return shortcutExactlyMatchesForPlatform(
    event,
    platform,
    ...getEffectiveActionShortcuts(action, platform),
  );
}

export function matchesActionShortcut(
  event: ShortcutEventLike,
  actionId: string,
  platform: ShortcutPlatform = getShortcutPlatform(),
): boolean {
  const action = getRegisteredAction(actionId);
  return Boolean(action && actionMatchesEvent(action, event, platform));
}

function findMatchingAction(
  event: ShortcutEventLike,
  scope: ActionShortcutScope,
  platform: ShortcutPlatform = getShortcutPlatform(),
  canHandleAction?: (action: ActionDef) => boolean,
  role: string = windowRole,
): ActionDef | undefined {
  const profileId = useDAWStore.getState().keyboardShortcutProfileId;
  const isAvailable = (action: ActionDef) => {
    const locallyAvailable = canHandleAction
      ? canHandleAction(action)
      : !action.canHandleShortcut || action.canHandleShortcut();
    return role !== "main" && isDetachedMainActionId(action.id)
      ? canRouteDetachedMainAction(action.id, locallyAvailable, role)
      : locallyAvailable;
  };
  return getRegisteredActions().find((action) => (
    getActionShortcutScopes(action, profileId).includes(scope)
    && actionShortcutConditionIsActive(action)
    && actionMatchesEvent(action, event, platform)
    // An unavailable command must not consume a chord that another action in
    // the same precedence tier can currently handle.
    && isAvailable(action)
  ));
}

function actionShortcutConditionIsActive(action: ActionDef): boolean {
  const state = useDAWStore.getState();
  switch (action.shortcutWhen) {
    case "transport_running":
      return state.transport.isPlaying || state.transport.isRecording;
    case "transport_stopped":
      return !state.transport.isPlaying && !state.transport.isRecording;
    case "step_input_enabled":
      return state.stepInputEnabled;
    case "step_input_disabled":
      return !state.stepInputEnabled;
    case "always":
    case undefined:
      return true;
  }
}

function activeRegistryScope(): ActionShortcutScope | null {
  const context = getActiveShortcutContext();
  if (context.kind === "timeline") return "timeline";
  if (context.kind === "timeline_ruler") return "timeline_ruler";
  if (context.kind === "track_control_panel") return "track_control_panel";
  if (context.kind === "mixer") return "mixer";
  if (context.kind === "pitch_editor") return "pitch_editor";
  if (context.kind === "piano_roll") return "piano_roll";
  if (context.kind === "automation") return "automation";
  if (context.kind === "browser") return "browser";
  if (context.kind === "plugin") return "plugin";
  if (context.kind === "modal") return "modal";
  return null;
}

export type RegistryShortcutResolutionRoute = "scope" | "contextual" | "global";

export interface RegistryShortcutResolution {
  action: ActionDef;
  route: RegistryShortcutResolutionRoute;
  /** The concrete active scope for a scoped match; otherwise the route scope. */
  scope: ActionShortcutScope;
}

export interface ResolveRegistryShortcutOptions {
  /** Editable controls and native plugin windows only permit global actions. */
  applicationOnly?: boolean;
  /**
   * Controlled availability hook for diagnostics/alternate hosts. Production
   * dispatch omits this and always honors ActionDef.canHandleShortcut.
   */
  canHandleAction?: (action: ActionDef) => boolean;
  role?: string;
}

/**
 * Resolve registry ownership without running the action.
 *
 * Active component handlers still run before this resolver in production and
 * can claim a gesture. Once they return `unmatched`, this function is the
 * single source of truth for scoped -> contextual -> global precedence.
 */
export function resolveRegistryShortcutAction(
  event: ShortcutEventLike,
  platform: ShortcutPlatform = getShortcutPlatform(),
  options: ResolveRegistryShortcutOptions = {},
): RegistryShortcutResolution | null {
  const canHandleAction = options.canHandleAction;
  if (!options.applicationOnly) {
    const scope = activeRegistryScope();
    if (scope) {
      const scopedAction = findMatchingAction(event, scope, platform, canHandleAction, options.role);
      if (scopedAction) return { action: scopedAction, route: "scope", scope };

      const contextualAction = findMatchingAction(event, "contextual", platform, canHandleAction, options.role);
      if (contextualAction) {
        return { action: contextualAction, route: "contextual", scope: "contextual" };
      }
    }
  }

  const globalAction = findMatchingAction(event, "global", platform, canHandleAction, options.role);
  return globalAction
    ? { action: globalAction, route: "global", scope: "global" }
    : null;
}

function publishDetachedCommand(command: string, payload: Record<string, unknown> = {}): void {
  void nativeBridge.publishAppCommand({
    command,
    sessionId: windowSessionId || useDAWStore.getState().activeMidiEditorSessionId || undefined,
    ...payload,
  });
}

function shouldDebounceRecordShortcut(): boolean {
  const now = Date.now();
  if (now - _lastRecordShortcutMs < 150) return true;
  _lastRecordShortcutMs = now;
  return false;
}

function executeMatchedAction(
  action: ActionDef,
  payload: GlobalShortcutPayload,
  options: GlobalShortcutDispatchOptions,
): true {
  const role = options.role ?? windowRole;
  markHandled(payload);
  if (payload.repeat && !REPEATABLE_ACTION_IDS.has(action.id)) return true;
  const locallyAvailable = options.canHandleAction
    ? options.canHandleAction(action)
    : !action.canHandleShortcut || action.canHandleShortcut();
  const canHandle = !options.executeAction
    && role !== "main"
    && isDetachedMainActionId(action.id)
    ? canRouteDetachedMainAction(action.id, locallyAvailable, role)
    : locallyAvailable;
  if (!canHandle) return true;
  if (action.id === "transport.record" && shouldDebounceRecordShortcut()) return true;
  if (options.executeAction) options.executeAction(action);
  else if (role !== "main" && publishDetachedMainAction(action.id, role)) return true;
  else action.execute();
  return true;
}

function dispatchApplicationShortcut(
  payload: GlobalShortcutPayload,
  platform: ShortcutPlatform,
  options: GlobalShortcutDispatchOptions,
): boolean {
  const state = useDAWStore.getState();
  const role = options.role ?? windowRole;

  if (isPlainSpacebar(payload) && matchesActionShortcut(payload, "transport.play", platform)) {
    markHandled(payload);
    if (payload.repeat) return true;
    const playAction = getRegisteredAction("transport.play");
    if (options.executeAction && playAction) {
      options.executeAction(playAction);
      return true;
    }
    const now = Date.now();
    if (now - _lastSpacebarMs < 150) return true;
    _lastSpacebarMs = now;
    if (role !== "main") publishDetachedCommand("transport.toggle");
    else if (state.transport.isRecording || state.transport.isPlaying) state.stop();
    else state.play();
    return true;
  }

  const action = resolveRegistryShortcutAction(
    payload,
    platform,
    {
      applicationOnly: true,
      canHandleAction: options.canHandleAction,
      role,
    },
  )?.action;
  if (role !== "main" && action?.id === "transport.play") {
    markHandled(payload);
    if (options.executeAction) {
      options.executeAction(action);
      return true;
    }
    if (!payload.repeat) publishDetachedCommand("transport.toggle");
    return true;
  }
  if (role !== "main" && action?.id === "transport.record") {
    markHandled(payload);
    if (payload.repeat || shouldDebounceRecordShortcut()) return true;
    if (options.executeAction) {
      options.executeAction(action);
      return true;
    }
    publishDetachedCommand("transport.record");
    return true;
  }
  return action ? executeMatchedAction(action, payload, options) : false;
}

export function dispatchGlobalShortcut(
  payload: GlobalShortcutPayload,
  platform: ShortcutPlatform = getShortcutPlatform(),
  options: GlobalShortcutDispatchOptions = {},
): boolean {
  const state = useDAWStore.getState();
  const role = options.role ?? windowRole;
  const registeredApplicationAction = findMatchingAction(
    payload,
    "global",
    platform,
    options.canHandleAction,
    role,
  );

  if (payload.targetIsNonTextControl && shouldPreserveNonTextControlShortcut(payload)) {
    return false;
  }

  if (payload.targetIsEditable) {
    if (isPlainSpacebar(payload) && (state.transport.isRecording || state.transport.isPlaying)) {
      markHandled(payload);
      if (payload.repeat) return true;
      const now = Date.now();
      if (now - _lastSpacebarMs < 150) return true;
      _lastSpacebarMs = now;
      if (role !== "main") publishDetachedCommand("transport.stop");
      else state.stop();
      return true;
    }

    if (shouldPreserveEditableShortcut(
      payload,
      Boolean(registeredApplicationAction),
      platform,
    )) return false;
    return dispatchApplicationShortcut(payload, platform, options);
  }

  // Space is the transport Play/Stop gesture, even while an editor surface is
  // active. Resolve it before scoped/profile actions so an active Timeline,
  // Piano Roll, or automation lane cannot route it through the generic
  // Play/Pause action and leave an in-progress recording unfinalized.
  if (isPlainSpacebar(payload) && matchesActionShortcut(payload, "transport.play", platform)) {
    return dispatchApplicationShortcut(payload, platform, options);
  }

  // Native plugin-window payloads have no trustworthy DOM edit owner.
  if (payload.source !== "pluginWindow") {
    const result = dispatchActiveShortcut(payload);
    if (result !== "unmatched") return markHandled(payload);

    const resolution = resolveRegistryShortcutAction(payload, platform, {
      canHandleAction: options.canHandleAction,
      role,
    });
    if (resolution) return executeMatchedAction(resolution.action, payload, options);
  }

  return dispatchApplicationShortcut(payload, platform, options);
}

export function isExactShortcut(
  payload: ShortcutEventLike,
  ...shortcuts: readonly string[]
): boolean {
  return shortcutExactlyMatches(payload, ...shortcuts);
}
