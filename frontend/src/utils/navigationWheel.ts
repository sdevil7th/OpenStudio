import { useDAWStore } from "../store/useDAWStore";
import { getMouseBehaviorProfile, toMouseBehaviorPlatform } from "./mouseBehaviorProfiles";
import { getShortcutPlatform } from "./platform";
import { resolveWheelGesture, type WheelEventLike, type ResolvedWheelGesture } from "./wheelGestureResolver";

/** A viewport pan control follows the profile's horizontal navigation gesture. */
export function resolveProfiledNavigationWheel(event: WheelEventLike): ResolvedWheelGesture {
  const platform = getShortcutPlatform();
  const profile = getMouseBehaviorProfile(useDAWStore.getState().mouseBehaviorProfileId, platform);
  const gesture = resolveWheelGesture(event, { surface: "timeline", subtarget: "content", platform: toMouseBehaviorPlatform(platform) }, profile.wheel);
  if ((gesture.operation === "scroll" || gesture.operation === "pan") && gesture.axis === "horizontal") {
    // The range adjustment helper increases on a negative delta; navigation
    // increases its viewport center when moving right instead.
    return { ...gesture, operation: "adjust", target: "viewport", amount: -gesture.amount };
  }
  // Leave vertical scrolling and other navigation to the enclosing viewport.
  // In particular, a parameter-adjust gesture must not move this view.
  return { ...gesture, operation: "native-scroll", amount: 0, preventDefault: false, stopPropagation: false };
}
