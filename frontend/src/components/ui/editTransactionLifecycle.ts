export interface EditTransactionLifecycle {
  active: boolean;
  commit?: () => void;
}

export function createEditTransactionLifecycle(): EditTransactionLifecycle {
  return { active: false };
}

/** Starts one edit and captures the commit callback used when it began. */
export function beginEditTransaction(
  lifecycle: EditTransactionLifecycle,
  onBegin?: () => void,
  onCommit?: () => void,
): boolean {
  if (lifecycle.active) return false;
  lifecycle.active = true;
  lifecycle.commit = onCommit;
  onBegin?.();
  return true;
}

/** Commits at most once even if pointer-up, cancel, lost-capture and cleanup race. */
export function commitEditTransaction(
  lifecycle: EditTransactionLifecycle,
): boolean {
  if (!lifecycle.active) return false;
  lifecycle.active = false;
  const commit = lifecycle.commit;
  lifecycle.commit = undefined;
  commit?.();
  return true;
}
