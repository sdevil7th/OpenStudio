export type NAMRackOrderPersistenceResult = {
  ok: boolean;
  errorMessage?: string;
};

type NAMRackOrderPersistenceOptions<T> = {
  previousOrder: readonly T[];
  nextOrder: readonly T[];
  applyOrder: (order: T[]) => void;
  persistOrder: (order: readonly T[]) => Promise<boolean>;
  failureMessage?: string;
};

/**
 * Keeps the rack lane responsive while ensuring the visible order never claims
 * a native mutation that failed. The caller owns concurrency; this helper owns
 * the optimistic apply/rollback pair and normalizes rejected bridge calls.
 */
export async function persistOptimisticNAMRackOrder<T>({
  previousOrder,
  nextOrder,
  applyOrder,
  persistOrder,
  failureMessage = "The post-FX order could not be saved. The previous order was restored.",
}: NAMRackOrderPersistenceOptions<T>): Promise<NAMRackOrderPersistenceResult> {
  const previous = [...previousOrder];
  const next = [...nextOrder];
  applyOrder(next);

  try {
    if (await persistOrder(next)) return { ok: true };
  } catch {
    // A rejected native bridge call has the same user-visible result as false.
  }

  applyOrder(previous);
  return { ok: false, errorMessage: failureMessage };
}
