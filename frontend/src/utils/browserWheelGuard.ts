import { useDAWStore } from "../store/useDAWStore";
import { getMouseBehaviorProfile, toMouseBehaviorPlatform } from "./mouseBehaviorProfiles";
import { getShortcutPlatform } from "./platform";
import { resolveWheelGesture, type ResolvedWheelGesture, type WheelEventLike } from "./wheelGestureResolver";

/**
 * Browser/WebView zoom can be triggered by either physical Control or Meta.
 * This deliberately uses raw modifiers instead of the DAW profile's portable
 * primary modifier: macOS pinch gestures commonly arrive as Ctrl+wheel, while
 * Command+wheel must be protected as well.
 */
export function shouldSuppressBrowserZoomWheel(event: WheelEventLike): boolean {
  return Boolean(event.ctrlKey || event.metaKey);
}

export function resolveBrowserWheelGesture(event: WheelEventLike): ResolvedWheelGesture {
  const shortcutPlatform = getShortcutPlatform();
  const behaviorProfile = getMouseBehaviorProfile(
    useDAWStore.getState().mouseBehaviorProfileId,
    shortcutPlatform,
  );
  const resolved = resolveWheelGesture(event, {
    surface: "browser",
    subtarget: "content",
    platform: toMouseBehaviorPlatform(shortcutPlatform),
  }, behaviorProfile.wheel);
  if (!shouldSuppressBrowserZoomWheel(event)) return resolved;

  return {
    ...resolved,
    ruleId: "browser.suppress-browser-zoom",
    matched: true,
    operation: "suppress",
    target: "native",
    preventDefault: true,
    // Capture-phase prevention must not block a child DAW wheel handler.
    stopPropagation: false,
  };
}

export function installBrowserZoomWheelGuard(target: Document | HTMLElement): () => void {
  let physicalControl = false;
  let gestureScale = 1;
  let gestureActive = false;
  const keyDown = (event: KeyboardEvent) => { physicalControl = event.ctrlKey; };
  const keyUp = (event: KeyboardEvent) => { physicalControl = event.ctrlKey; };
  const reset = () => { physicalControl = false; gestureActive = false; };
  const handleWheel = (event: WheelEvent) => {
    const adapted = event as WheelEvent & WheelEventLike;
    if (gestureActive && !adapted.openStudioPinch && event.ctrlKey && !physicalControl) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    // A missing DOM keydown is not sufficient evidence of a pinch (Control
    // may already be held when a native WebView gains focus). Wheel notches,
    // line/page events and modified chords must still use the chosen profile.
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !physicalControl
      && event.deltaMode === 0 && event.deltaX === 0 && Math.abs(event.deltaY) < 50)
      adapted.openStudioPinch = true;
    const gesture = resolveBrowserWheelGesture(event);
    if (gesture.preventDefault) event.preventDefault();
  };
  // WKWebView/Safari exposes magnification as GestureEvents instead of wheel.
  const handleGesture = (event: Event) => {
    const gesture = event as Event & { scale: number; clientX: number; clientY: number };
    if (!(gesture.target instanceof Element)) return;
    const surface = gesture.target.closest('[data-shortcut-context], .workspace');
    if (!surface) return;
    event.preventDefault();
    if (event.type === "gestureend") { gestureActive = false; return; }
    if (event.type === "gesturestart") { gestureActive = true; gestureScale = gesture.scale || 1; return; }
    const scale = gesture.scale;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const deltaY = -Math.log(scale / gestureScale) / 0.002;
    gestureScale = scale;
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY,
      clientX: gesture.clientX, clientY: gesture.clientY });
    (wheel as WheelEvent & WheelEventLike).openStudioPinch = true;
    gesture.target.dispatchEvent(wheel);
  };
  target.addEventListener("wheel", handleWheel as EventListener, { passive: false, capture: true });
  target.addEventListener("keydown", keyDown as EventListener, true);
  target.addEventListener("keyup", keyUp as EventListener, true);
  const view = target.ownerDocument?.defaultView ?? (target as Document).defaultView;
  view?.addEventListener("blur", reset);
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) target.addEventListener(name, handleGesture, { passive: false, capture: true });
  return () => {
    target.removeEventListener("wheel", handleWheel as EventListener, { capture: true });
    target.removeEventListener("keydown", keyDown as EventListener, true);
    target.removeEventListener("keyup", keyUp as EventListener, true);
    view?.removeEventListener("blur", reset);
    for (const name of ["gesturestart", "gesturechange", "gestureend"]) target.removeEventListener(name, handleGesture, true);
  };
}
