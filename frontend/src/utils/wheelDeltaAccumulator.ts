export type WheelDeltaAccumulatorResetReason =
  | "direction-change"
  | "target-change"
  | "idle"
  | "manual"
  | "dispose";

export interface WheelDeltaAccumulatorReset {
  reason: WheelDeltaAccumulatorResetReason;
  targetKey: string;
  remainder: number;
  hadOutput: boolean;
}

export interface WheelDeltaAccumulatorOptions {
  /** Smallest signed delta emitted to the consumer. */
  quantum?: number;
  /** Pending residue and the owning edit burst expire after this delay. */
  idleMs?: number;
  /** Lets controls commit their edit transaction whenever a burst ends. */
  onReset?: (reset: WheelDeltaAccumulatorReset) => void;
}

export interface WheelDeltaAccumulatorState {
  targetKey: string | null;
  direction: -1 | 0 | 1;
  remainder: number;
  hadOutput: boolean;
  disposed: boolean;
}

export interface WheelDeltaAccumulator {
  /**
   * Adds a normalized wheel delta and returns only complete signed quanta.
   * Residue is private to one target and one direction.
   */
  consume: (targetKey: string, amount: number) => number;
  reset: () => void;
  dispose: () => void;
  getState: () => WheelDeltaAccumulatorState;
}

const DEFAULT_QUANTUM = 1;
const DEFAULT_IDLE_MS = 180;

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Accumulates sub-pixel/high-resolution wheel packets without sharing residue
 * between controls. A direction reversal intentionally drops old momentum, so
 * a small move one way cannot make a later move the other way feel delayed.
 */
export function createWheelDeltaAccumulator({
  quantum: requestedQuantum,
  idleMs: requestedIdleMs,
  onReset,
}: WheelDeltaAccumulatorOptions = {}): WheelDeltaAccumulator {
  const quantum = positiveFiniteOr(requestedQuantum, DEFAULT_QUANTUM);
  const idleMs = Math.max(0, positiveFiniteOr(requestedIdleMs, DEFAULT_IDLE_MS));
  let targetKey: string | null = null;
  let direction: -1 | 0 | 1 = 0;
  let remainder = 0;
  let hadOutput = false;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = () => {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const finish = (reason: WheelDeltaAccumulatorResetReason) => {
    clearIdleTimer();
    const completedTargetKey = targetKey;
    const completedRemainder = remainder;
    const completedHadOutput = hadOutput;
    targetKey = null;
    direction = 0;
    remainder = 0;
    hadOutput = false;
    if (completedTargetKey !== null) {
      onReset?.({
        reason,
        targetKey: completedTargetKey,
        remainder: completedRemainder,
        hadOutput: completedHadOutput,
      });
    }
  };

  const scheduleIdleReset = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => finish("idle"), idleMs);
  };

  const consume = (nextTargetKey: string, amount: number): number => {
    if (disposed || !Number.isFinite(amount) || amount === 0 || nextTargetKey.length === 0) {
      return 0;
    }

    const nextDirection: -1 | 1 = amount < 0 ? -1 : 1;
    if (targetKey !== null && targetKey !== nextTargetKey) finish("target-change");
    if (targetKey !== null && direction !== 0 && direction !== nextDirection) {
      finish("direction-change");
    }
    if (targetKey === null) {
      targetKey = nextTargetKey;
      direction = nextDirection;
    }

    remainder += amount;
    // The tolerance avoids losing a complete quantum to ordinary FP drift
    // (for example ten 0.1px packets producing 0.9999999999999999).
    const completeQuanta = Math.floor(
      (Math.abs(remainder) + quantum * 1e-9) / quantum,
    );
    let emitted = 0;
    if (completeQuanta > 0) {
      emitted = (remainder < 0 ? -1 : 1) * completeQuanta * quantum;
      remainder -= emitted;
      if (Math.abs(remainder) < quantum * 1e-9) remainder = 0;
      hadOutput = true;
    }

    scheduleIdleReset();
    return emitted;
  };

  return {
    consume,
    reset: () => finish("manual"),
    dispose: () => {
      if (disposed) return;
      finish("dispose");
      disposed = true;
    },
    getState: () => ({
      targetKey,
      direction,
      remainder,
      hadOutput,
      disposed,
    }),
  };
}
