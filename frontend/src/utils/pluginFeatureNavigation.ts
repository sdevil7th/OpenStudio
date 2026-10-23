import { useEffect, useRef, type RefObject } from "react";

export const pluginFeatureRevealEvent = "openstudio:reveal-plugin-feature";
export interface PluginFeatureRevealRequest {
  pluginId: string;
  parameterId?: string;
  workflowId?: string;
  ownerId?: string;
}

/** Navigation only: revealing a control must never change a processing mode or parameter. */
export function usePluginFeatureReveal<T extends HTMLElement>(root: RefObject<T | null>, pluginId: string,
  reveal: (request: PluginFeatureRevealRequest) => void) {
  const latest = useRef(reveal);
  latest.current = reveal;
  useEffect(() => {
    const element = root.current?.closest<HTMLElement>(".approved-effect-editor, [data-suite-kind], .eq-editor") ?? root.current;
    if (!element) return;
    const listener = (event: Event) => {
      const request = (event as CustomEvent<PluginFeatureRevealRequest>).detail;
      if (request?.pluginId === pluginId) latest.current(request);
    };
    element.addEventListener(pluginFeatureRevealEvent, listener);
    return () => element.removeEventListener(pluginFeatureRevealEvent, listener);
  }, [root, pluginId]);
}

export function dispatchPluginFeatureReveal(root: HTMLElement, request: PluginFeatureRevealRequest) {
  root.dispatchEvent(new CustomEvent(pluginFeatureRevealEvent, { detail: request }));
}

/** Open native HTML disclosures, then find the visible control without activating it. */
export function locatePluginFeature(root: HTMLElement, request: PluginFeatureRevealRequest): HTMLElement | undefined {
  const attribute = request.parameterId ? "data-param" : "data-feature";
  const value = request.parameterId ?? request.workflowId;
  const scopes = [root, ...(request.ownerId ? Array.from(document.querySelectorAll<HTMLElement>("[data-feature-owner]"))
    .filter(element => element.dataset.featureOwner === request.ownerId && element !== root) : [])];
  const candidates = scopes.flatMap(scope => Array.from(scope.querySelectorAll<HTMLElement>(`[${attribute}]`)))
    .filter(element => element.getAttribute(attribute) === value);
  for (const candidate of candidates) {
    for (let parent = candidate.parentElement; parent && parent !== root; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    if (candidate.getClientRects().length && getComputedStyle(candidate).visibility !== "hidden") return candidate;
  }
}
