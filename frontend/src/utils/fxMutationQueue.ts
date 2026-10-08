// Resource-backed FX history must finish one native mutation before the next
// replay starts. Recovery shares this queue so rapid Undo/Redo cannot race it.
let pending: Promise<unknown> = Promise.resolve();
export function enqueueFXMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => undefined);
  return result;
}
