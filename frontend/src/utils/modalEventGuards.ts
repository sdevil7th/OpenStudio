import type React from "react";
import { nativeBridge } from "../services/NativeBridge";
import { usesNativeWindowChrome } from "./windowEnvironment";

const MODAL_LAYER_SELECTOR = [
  "[data-modal-root='true']",
  "[data-modal-overlay='true']",
  ".fx-chain-overlay",
  ".piano-roll-modal-backdrop",
  "[role='dialog']",
].join(",");

const CONTEXT_MENU_SELECTOR = "[data-context-menu='true']";
const WINDOW_DRAG_ZONE_HEIGHT = 32;
let lastWindowDragRequestAt = 0;
const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a",
  "[role='button']",
  "[data-no-drag]",
].join(",");

const EDITABLE_TEXT_SELECTOR = [
  "textarea",
  "input:not([type='button']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='reset']):not([type='submit'])",
  "[contenteditable='true']",
  "[contenteditable='']",
].join(",");

function targetElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

export function hasOpenModalLayer(): boolean {
  return document.querySelector(MODAL_LAYER_SELECTOR) !== null;
}

export function isInsideModalLayer(target: EventTarget | null): boolean {
  return Boolean(targetElement(target)?.closest(MODAL_LAYER_SELECTOR));
}

export function shouldSuppressWorkspaceContextMenu(target: EventTarget | null): boolean {
  const element = targetElement(target);
  if (!element || !hasOpenModalLayer()) return false;
  if (element.closest(CONTEXT_MENU_SELECTOR)) return false;
  return !isInsideModalLayer(element);
}

export function guardModalContextMenu(event: React.MouseEvent | MouseEvent): void {
  event.stopPropagation();
  if (!event.defaultPrevented) {
    event.preventDefault();
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return Boolean(targetElement(target)?.closest(INTERACTIVE_SELECTOR));
}

export function isEditableTextTarget(target: EventTarget | null): boolean {
  return Boolean(targetElement(target)?.closest(EDITABLE_TEXT_SELECTOR));
}

export function guardModalPointerEvent(
  event: React.MouseEvent | React.PointerEvent,
): void {
  event.stopPropagation();
}

function isTopWindowDragRequest(event: MouseEvent | PointerEvent): boolean {
  if (usesNativeWindowChrome || event.button !== 0 || event.clientY > WINDOW_DRAG_ZONE_HEIGHT) {
    return false;
  }

  const element = targetElement(event.target);
  if (
    !element
    || element.closest("[data-modal-panel='true']")
    || isInteractiveTarget(event.target)
    || isEditableTextTarget(event.target)
  ) {
    return false;
  }

  return hasOpenModalLayer();
}

function guardModalPointerLeak(event: MouseEvent | PointerEvent): void {
  if (isTopWindowDragRequest(event)) {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - lastWindowDragRequestAt > 120) {
      lastWindowDragRequestAt = now;
      void nativeBridge.startWindowDrag();
    }
    return;
  }

  if (!shouldSuppressWorkspaceContextMenu(event.target)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
}

function stopModalPointerBubble(event: MouseEvent | PointerEvent): void {
  if (!isInsideModalLayer(event.target)) {
    return;
  }

  event.stopPropagation();
}

export function installModalContextMenuLeakGuard(): () => void {
  const handleContextMenu = (event: MouseEvent) => {
    if (!shouldSuppressWorkspaceContextMenu(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  window.addEventListener("contextmenu", handleContextMenu, true);
  window.addEventListener("mousedown", guardModalPointerLeak, true);
  window.addEventListener("pointerdown", guardModalPointerLeak, true);
  document.addEventListener("mousedown", stopModalPointerBubble, false);
  document.addEventListener("mousemove", stopModalPointerBubble, false);
  document.addEventListener("mouseup", stopModalPointerBubble, false);
  document.addEventListener("pointerdown", stopModalPointerBubble, false);
  document.addEventListener("pointermove", stopModalPointerBubble, false);
  document.addEventListener("pointerup", stopModalPointerBubble, false);
  return () => {
    window.removeEventListener("contextmenu", handleContextMenu, true);
    window.removeEventListener("mousedown", guardModalPointerLeak, true);
    window.removeEventListener("pointerdown", guardModalPointerLeak, true);
    document.removeEventListener("mousedown", stopModalPointerBubble, false);
    document.removeEventListener("mousemove", stopModalPointerBubble, false);
    document.removeEventListener("mouseup", stopModalPointerBubble, false);
    document.removeEventListener("pointerdown", stopModalPointerBubble, false);
    document.removeEventListener("pointermove", stopModalPointerBubble, false);
    document.removeEventListener("pointerup", stopModalPointerBubble, false);
  };
}
