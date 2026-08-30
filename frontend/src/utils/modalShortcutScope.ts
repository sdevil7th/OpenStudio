import { useEffect, useRef } from "react";
import {
  executeActiveScopedAction,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  isEditableShortcutTarget,
  registerShortcutSurface,
  shouldPreserveEditableShortcut,
  type ShortcutEventLike,
  type ShortcutHandlerResult,
} from "./shortcutContext";
import { matchesActionShortcut } from "./globalShortcutDispatcher";
import type { ShortcutPlatform } from "./platform";

export const MODAL_CLOSE_ACTION_ID = "modal.close";

export interface ModalShortcutScopeOptions {
  canClose?: () => boolean;
}

export interface TransientOverlayShortcutScopeOptions extends ModalShortcutScopeOptions {
  /** Test seam; production overlays listen at the document bubble phase. */
  eventTarget?: EventTarget | null;
}

export interface ModalShortcutEventLike extends ShortcutEventLike {
  target?: EventTarget | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  stopImmediatePropagation?: () => void;
}

export interface ModalShortcutRouteResult {
  matched: boolean;
  preservedEditableCommand: boolean;
  result: ShortcutHandlerResult;
  suppressedHeadlessEscape: boolean;
}

/**
 * Route a key from inside a dialog through the effective profile/custom
 * binding instead of treating raw Escape as an immutable close command.
 *
 * The global dispatcher deliberately preserves editable controls. This local
 * route is therefore the authoritative fallback for a focused input. A native
 * editing chord still wins (for example, a user should not lose Ctrl/Cmd+C
 * merely because it was accidentally assigned to Close Dialog).
 */
export function routeModalShortcutEvent(
  event: ModalShortcutEventLike,
  platform?: ShortcutPlatform,
): ModalShortcutRouteResult {
  const matched = matchesActionShortcut(event, MODAL_CLOSE_ACTION_ID, platform);
  const preservedEditableCommand = matched
    && isEditableShortcutTarget(event.target ?? null)
    // Escape has no text-editing default; once it is the user's effective
    // Close Dialog binding, the modal owns it even while an input is focused.
    && event.key !== "Escape"
    && shouldPreserveEditableShortcut(event, true, platform);

  if (matched && !preservedEditableCommand) {
    event.preventDefault?.();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    else event.stopPropagation?.();
    return {
      matched: true,
      preservedEditableCommand: false,
      result: executeActiveScopedAction(MODAL_CLOSE_ACTION_ID),
      suppressedHeadlessEscape: event.key === "Escape",
    };
  }

  if (event.key === "Escape") {
    // Headless UI owns raw Escape at window bubble phase. Stop only that raw
    // key here (after the focused control has seen it) when the effective
    // Close Dialog command is unassigned or intentionally preserved.
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    else event.stopPropagation?.();
    return {
      matched,
      preservedEditableCommand,
      result: "unmatched",
      suppressedHeadlessEscape: true,
    };
  }

  return {
    matched,
    preservedEditableCommand,
    result: "unmatched",
    suppressedHeadlessEscape: false,
  };
}

/**
 * Register one modal as the current keyboard owner.
 *
 * Registrations are stack-based, so a nested dialog receives Close first and
 * removing it restores the exact surface that owned shortcuts beforehand.
 */
export function registerModalShortcutScope(
  onClose: () => void,
  options: ModalShortcutScopeOptions = {},
): () => void {
  const context = { kind: "modal" } as const;
  const fallback = getActiveShortcutContext();
  const unregisterSurface = registerShortcutSurface(
    context,
    () => "unmatched",
    fallback,
  );
  const unregisterActions = registerScopedActionExecutor(
    context,
    (actionId) => {
      if (actionId !== MODAL_CLOSE_ACTION_ID) return "unmatched";
      if (options.canClose && !options.canClose()) return "claimed_noop";
      onClose();
      return "handled";
    },
    [MODAL_CLOSE_ACTION_ID],
  );
  activateShortcutContext(context);

  return () => {
    // Remove the action owner first so a concurrently delivered command can
    // never escape to a dialog underneath while this modal is unmounting.
    unregisterActions();
    unregisterSurface();
  };
}

/**
 * Register a popover/menu as the top dialog-style shortcut owner.
 *
 * Unlike a focus-trapping Modal, a transient overlay can leave focus on its
 * trigger or on an editable control. The window capture dispatcher preserves
 * those editable keystrokes, so this document-bubble listener is the local
 * fallback that still honors the effective modal.close binding. Raw Escape is
 * suppressed when Close Dialog is unassigned instead of becoming a hidden,
 * hard-coded bypass.
 */
export function registerTransientOverlayShortcutScope(
  onClose: () => void,
  options: TransientOverlayShortcutScopeOptions = {},
): () => void {
  const unregisterScope = registerModalShortcutScope(onClose, options);
  const eventTarget = options.eventTarget
    ?? (typeof document !== "undefined" ? document : null);
  const handleKeyDown = (event: Event) => {
    routeModalShortcutEvent(event as KeyboardEvent);
  };
  eventTarget?.addEventListener("keydown", handleKeyDown);

  return () => {
    eventTarget?.removeEventListener("keydown", handleKeyDown);
    unregisterScope();
  };
}

/** React lifecycle wrapper which keeps callback identity out of registration. */
export function useModalShortcutScope(
  isOpen: boolean,
  onClose: () => void,
  canClose = true,
): void {
  const closeRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  closeRef.current = onClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    if (!isOpen) return undefined;
    return registerModalShortcutScope(
      () => closeRef.current(),
      { canClose: () => canCloseRef.current },
    );
  }, [isOpen]);
}

/** React lifecycle wrapper for transient popovers and menus. */
export function useTransientOverlayShortcutScope(
  isOpen: boolean,
  onClose: () => void,
  canClose = true,
): void {
  const closeRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  closeRef.current = onClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    if (!isOpen) return undefined;
    return registerTransientOverlayShortcutScope(
      () => closeRef.current(),
      { canClose: () => canCloseRef.current },
    );
  }, [isOpen]);
}
