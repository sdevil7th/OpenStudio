/**
 * Centralized error handler for NativeBridge calls.
 * Replaces silent .catch(() => {}) patterns with proper logging
 * and optional user-facing toast notifications.
 */

type ShowToastFn = (message: string, type: "error" | "info" | "success") => void;

let _showToast: ShowToastFn | null = null;

/** Call once from App.tsx or store init to wire up the toast function. */
export function initBridgeErrorHandler(showToast: ShowToastFn) {
  _showToast = showToast;
}

/**
 * Handle a bridge call error.
 * @param operation  Short description of what failed (e.g. "addTrack", "setAutomationPoints")
 * @param error      The caught error
 * @param options    Whether to show a toast to the user
 */
export function handleBridgeError(
  operation: string,
  error: unknown,
  options?: { showToast?: boolean; toastMessage?: string }
) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[Bridge] ${operation} failed:`, msg);

  if (options?.showToast && _showToast) {
    _showToast(options.toastMessage || `${operation} failed`, "error");
  }
}

/**
 * Convenience: returns a .catch() handler that logs silently.
 * Usage: nativeBridge.foo().catch(logBridgeError("foo"))
 */
export const logBridgeError = (operation: string) => (error: unknown) =>
  handleBridgeError(operation, error);

/**
 * Convenience: returns a .catch() handler that logs AND shows a toast.
 * Usage: nativeBridge.foo().catch(toastBridgeError("foo"))
 */
export const toastBridgeError = (operation: string, toastMessage?: string) => (error: unknown) =>
  handleBridgeError(operation, error, { showToast: true, toastMessage });
