import type { BuiltInParamDescriptor } from "../services/NativeBridge";
import { clampNumber, offsetParamValue } from "./builtInParamValue";
import { accumulateParameterWheelGesture, getParameterWheelStepCount, resolveProfiledParameterWheel } from "./parameterWheel";
import { createWheelDeltaAccumulator } from "./wheelDeltaAccumulator";
import type { WheelEventLike } from "./wheelGestureResolver";
import { beginEditTransaction, commitEditTransaction, createEditTransactionLifecycle } from "../components/ui/editTransactionLifecycle";

/** Knobs use the same profile, fractional delta and transaction policy as ranges. */
export function createSuiteParameterWheel(callbacks: {
  parameter: () => BuiltInParamDescriptor;
  change: (value: number) => void;
  begin?: () => void;
  commit?: () => void;
}) {
  const edit = createEditTransactionLifecycle();
  const accumulator = createWheelDeltaAccumulator({
    quantum: 1,
    idleMs: 180,
    onReset: () => commitEditTransaction(edit),
  });
  return {
    wheel(event: WheelEventLike) {
      const gesture = resolveProfiledParameterWheel(event, "control");
      const parameter = callbacks.parameter();
      const accumulated = accumulateParameterWheelGesture(accumulator, gesture, parameter.id);
      if (parameter.type !== "continuous" || !accumulated) return gesture;
      const next = clampNumber(offsetParamValue(parameter, parameter.value, getParameterWheelStepCount(accumulated)), parameter.min, parameter.max);
      if (next !== parameter.value) {
        beginEditTransaction(edit, callbacks.begin, callbacks.commit);
        callbacks.change(next);
      }
      return gesture;
    },
    reset: () => accumulator.reset(),
    dispose: () => accumulator.dispose(),
  };
}

/** Empty, cancelled and invalid drafts never turn into a zero-valued edit. */
export function parseSuiteParameterDraft(draft: string, factor: number, parameter: Pick<BuiltInParamDescriptor, "min" | "max">): number | null {
  if (!draft.trim()) return null;
  const value = Number(draft) / factor;
  return Number.isFinite(value) ? clampNumber(value, parameter.min, parameter.max) : null;
}
