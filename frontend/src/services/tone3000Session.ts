import { useSyncExternalStore } from "react";
import {
  nativeBridge,
  type TONE3000AuthFlowOptions,
  type TONE3000AuthFlowResult,
  type TONE3000AuthResult,
  type TONE3000AuthStatus,
} from "./NativeBridge";

export type TONE3000SessionState = {
  status: TONE3000AuthStatus | null;
  busy: boolean;
  bootstrapped: boolean;
  lastError: string;
  lastUpdatedAt: number;
};

type EnsureResult = {
  ok: boolean;
  status: TONE3000AuthStatus | null;
  message?: string;
};

const listeners = new Set<() => void>();

let state: TONE3000SessionState = {
  status: null,
  busy: false,
  bootstrapped: false,
  lastError: "",
  lastUpdatedAt: 0,
};

let bootstrapPromise: Promise<TONE3000AuthStatus | null> | null = null;
let refreshPromise: Promise<TONE3000AuthResult> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<TONE3000SessionState>) {
  state = { ...state, ...patch, lastUpdatedAt: Date.now() };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

async function fetchStatus() {
  const status = await nativeBridge.getTONE3000AuthStatus();
  setState({ status, lastError: status.error || "" });
  return status;
}

async function refreshStoredSession(clientId = "") {
  if (!refreshPromise) {
    refreshPromise = nativeBridge.refreshTONE3000Auth(clientId).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export function useTONE3000Session() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getTONE3000SessionSnapshot() {
  return state;
}

export function resetTONE3000SessionForTests() {
  bootstrapPromise = null;
  refreshPromise = null;
  state = {
    status: null,
    busy: false,
    bootstrapped: false,
    lastError: "",
    lastUpdatedAt: 0,
  };
  emit();
}

export async function refreshTONE3000SessionStatus() {
  try {
    return await fetchStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read TONE3000 auth status.";
    setState({ lastError: message });
    throw error;
  }
}

export async function bootstrapTONE3000Session() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    setState({ busy: true });
    try {
      const status = await fetchStatus();
      if (status.hasRefreshToken && (!status.authenticated || status.expired)) {
        const refreshed = await refreshStoredSession(status.clientId || "");
        if (!refreshed.success) {
          const latest = await fetchStatus().catch(() => status);
          setState({
            status: latest,
            bootstrapped: true,
            lastError: refreshed.error || String(refreshed.oauthError || ""),
          });
          return latest;
        }

        const latest = await fetchStatus();
        setState({ status: latest, bootstrapped: true, lastError: "" });
        return latest;
      }

      setState({ status, bootstrapped: true, lastError: "" });
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : "TONE3000 session bootstrap failed.";
      setState({ bootstrapped: true, lastError: message });
      return state.status;
    } finally {
      setState({ busy: false });
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

export async function refreshTONE3000Session(clientId = "") {
  setState({ busy: true, lastError: "" });
  try {
    const result = await refreshStoredSession(clientId);
    const latest = await fetchStatus().catch(() => state.status);
    if (!result.success) {
      setState({
        status: latest,
        bootstrapped: true,
        lastError: result.error || String(result.oauthError || ""),
      });
      return result;
    }

    setState({ status: latest, bootstrapped: true, lastError: "" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "TONE3000 token refresh failed.";
    setState({ lastError: message });
    throw error;
  } finally {
    setState({ busy: false });
  }
}

export async function startTONE3000InteractiveAuth(options: TONE3000AuthFlowOptions | string = {}) {
  setState({ busy: true, lastError: "" });
  try {
    const result: TONE3000AuthFlowResult = await nativeBridge.startTONE3000AuthFlow(options);
    if (result.success || result.status === "connected") {
      await fetchStatus().catch(() => null);
    } else {
      setState({ lastError: result.error || "" });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "TONE3000 sign-in could not start.";
    setState({ lastError: message });
    throw error;
  } finally {
    setState({ busy: false });
  }
}

export async function completeTONE3000ManualAuth(code: string, stateValue = "", clientId = "", redirectUri = "") {
  setState({ busy: true, lastError: "" });
  try {
    const result = await nativeBridge.exchangeTONE3000OAuthCode(code, stateValue, clientId, redirectUri);
    if (result.success) {
      await fetchStatus().catch(() => null);
    } else {
      setState({ lastError: result.error || "" });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "TONE3000 authorization could not be completed.";
    setState({ lastError: message });
    throw error;
  } finally {
    setState({ busy: false });
  }
}

export async function clearTONE3000Session() {
  setState({ busy: true, lastError: "" });
  try {
    const status = await nativeBridge.clearTONE3000Auth();
    setState({ status, bootstrapped: true, lastError: status.error || "" });
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : "TONE3000 session could not be cleared.";
    setState({ lastError: message });
    throw error;
  } finally {
    setState({ busy: false });
  }
}

export async function ensureTONE3000Session(actionLabel: string, clientId = ""): Promise<EnsureResult> {
  let status = state.status ?? await bootstrapTONE3000Session();
  if (!status) {
    return { ok: false, status: null, message: `TONE3000 auth status is unavailable before ${actionLabel}.` };
  }

  if (status.authenticated && !status.expired) {
    return { ok: true, status };
  }

  if (!status.authenticated && !status.hasRefreshToken) {
    return { ok: false, status, message: `Connect TONE3000 before ${actionLabel}.` };
  }

  if (!status.hasRefreshToken) {
    return { ok: false, status, message: `TONE3000 token expired. Reconnect before ${actionLabel}.` };
  }

  const refreshed = await refreshTONE3000Session(status.clientId || clientId || "");
  status = state.status ?? await fetchStatus().catch(() => null);
  if (!refreshed.success) {
    const invalidGrant = refreshed.oauthError === "invalid_grant";
    return {
      ok: false,
      status,
      message: refreshed.error || (invalidGrant
        ? `Reconnect TONE3000 before ${actionLabel}.`
        : `Token refresh failed before ${actionLabel}.`),
    };
  }

  if (!status?.authenticated || status.expired) {
    return { ok: false, status, message: `TONE3000 token refresh did not complete. Reconnect before ${actionLabel}.` };
  }

  return { ok: true, status };
}
