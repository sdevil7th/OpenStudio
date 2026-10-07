// Share one sequence with the injected native-function wrappers. Startup and
// recovery invoke the same transport directly, including during bursty loading.
export function nextNativeRequestId(backend: object): number {
  const state = backend as { __openStudioLastNativeCallId?: number };
  const next = Math.max(Date.now() * 1000, (state.__openStudioLastNativeCallId ?? 0) + 1);
  state.__openStudioLastNativeCallId = next;
  return next;
}
