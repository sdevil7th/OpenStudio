import { useDAWStore } from "../store/useDAWStore";
import { getMouseBehaviorProfile, toMouseBehaviorPlatform } from "./mouseBehaviorProfiles";
import { getShortcutPlatform } from "./platform";
import {
  resolveWheelGesture,
  type ResolvedWheelGesture,
  type WheelEventLike,
  type WheelSubtarget,
} from "./wheelGestureResolver";
import type { WheelDeltaAccumulator } from "./wheelDeltaAccumulator";

export interface ParameterWheelValueOptions {
  min: number;
  max: number;
  value: number;
  step?: number;
}

export interface ParameterWheelStepCountOptions {
  normal?: number;
  fine?: number;
}

/** Stable per-control key used to isolate fractional wheel residue. */
export function getParameterWheelAccumulatorKey(
  gesture: Pick<ResolvedWheelGesture, "profileId" | "ruleId" | "target" | "precision">,
  controlKey: string,
): string {
  return [
    controlKey,
    gesture.profileId,
    gesture.ruleId ?? "fallback",
    gesture.target,
    gesture.precision,
  ].join(":");
}

/**
 * Returns an adjustment gesture only when enough high-resolution delta has
 * accumulated to make a representable change. Non-adjustment gestures end any
 * pending adjustment burst.
 */
export function accumulateParameterWheelGesture(
  accumulator: WheelDeltaAccumulator,
  gesture: ResolvedWheelGesture,
  controlKey: string,
): ResolvedWheelGesture | null {
  if (gesture.operation !== "adjust") {
    accumulator.reset();
    return null;
  }
  const amount = accumulator.consume(
    getParameterWheelAccumulatorKey(gesture, controlKey),
    gesture.amount,
  );
  return amount === 0 ? null : { ...gesture, amount };
}

export function resolveProfiledParameterWheel(
  event: WheelEventLike,
  subtarget: WheelSubtarget = "control",
): ResolvedWheelGesture {
  const shortcutPlatform = getShortcutPlatform();
  const behaviorProfile = getMouseBehaviorProfile(
    useDAWStore.getState().mouseBehaviorProfileId,
    shortcutPlatform,
  );
  return resolveWheelGesture(event, {
    surface: "parameter",
    subtarget,
    platform: toMouseBehaviorPlatform(shortcutPlatform),
  }, behaviorProfile.wheel);
}

export function getParameterWheelValue(
  gesture: Pick<ResolvedWheelGesture, "amount" | "precision" | "operation">,
  options: ParameterWheelValueOptions,
): number {
  const { min, max, value } = options;
  if (gesture.operation !== "adjust" || gesture.amount === 0 || !Number.isFinite(value)) {
    return Math.max(min, Math.min(max, value));
  }
  const range = Math.max(0, max - min);
  const baseStep = options.step && options.step > 0
    ? options.step
    : range / 100;
  const precisionScale = gesture.precision === "fine" ? 0.1 : 1;
  // A 100px mouse notch is one full step. High-resolution packets retain
  // their fractional weight instead of each being amplified to a full step.
  const wheelSteps = Math.abs(gesture.amount) / 100;
  const direction = gesture.amount < 0 ? 1 : -1;
  const next = value + direction * baseStep * precisionScale * wheelSteps;
  const clamped = Math.max(min, Math.min(max, next));
  return Number(clamped.toPrecision(12));
}

/**
 * Converts a resolved parameter gesture into signed parameter-step units.
 * Consumers with non-linear parameter scales can feed the result into their
 * own offset helper without re-reading raw keyboard modifiers.
 */
export function getParameterWheelStepCount(
  gesture: Pick<ResolvedWheelGesture, "amount" | "precision" | "operation">,
  options: ParameterWheelStepCountOptions = {},
): number {
  if (
    gesture.operation !== "adjust"
    || !Number.isFinite(gesture.amount)
    || gesture.amount === 0
  ) return 0;

  const configuredStepCount = gesture.precision === "fine"
    ? options.fine ?? 1
    : options.normal ?? 4;
  if (!Number.isFinite(configuredStepCount) || configuredStepCount <= 0) return 0;

  const wheelSteps = Math.abs(gesture.amount) / 100;
  return (gesture.amount < 0 ? 1 : -1) * configuredStepCount * wheelSteps;
}
