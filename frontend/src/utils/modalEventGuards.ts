import type React from "react";

const MODAL_LAYER_SELECTOR = [
  "[data-modal-root='true']",
  "[data-modal-overlay='true']",
  ".fx-chain-overlay",
  ".piano-roll-modal-backdrop",
  "[role='dialog']",
].join(",");

const CONTEXT_MENU_SELECTOR = "[data-context-menu='true']";

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

export function installModalContextMenuLeakGuard(): () => void {
  const handleContextMenu = (event: MouseEvent) => {
    if (!shouldSuppressWorkspaceContextMenu(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  window.addEventListener("contextmenu", handleContextMenu, true);
  return () => {
    window.removeEventListener("contextmenu", handleContextMenu, true);
  };
}
