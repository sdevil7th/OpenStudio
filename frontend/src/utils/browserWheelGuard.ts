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
  const handleWheel = (event: WheelEvent) => {
    const gesture = resolveBrowserWheelGesture(event);
    if (gesture.preventDefault) event.preventDefault();
  };
  target.addEventListener("wheel", handleWheel as EventListener, { passive: false, capture: true });
  return () => target.removeEventListener("wheel", handleWheel as EventListener, { capture: true });
}
