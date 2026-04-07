import React, { useEffect, useState } from "react";
import { usesNativeWindowChrome } from "../utils/windowEnvironment";

type StartupDiagnostics = {
  windowRole?: string;
  startupMode?: string;
  browserBackend?: string;
  startupState?: string;
  targetUrl?: string;
  detail?: string;
  startupLogPath?: string;
  packagedFrontendPath?: string;
  packagedFrontendCandidates?: string;
  webView2UserDataPath?: string;
  webView2RuntimeVersion?: string;
};

export function StartupRecoveryApp() {
  const [diagnostics, setDiagnostics] = useState<StartupDiagnostics | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    const invokeNativeFunction = async <T,>(
      name: string,
      ...args: unknown[]
    ): Promise<T | undefined> => {
      const backend = window.__JUCE__?.backend;
      if (!backend?.emitEvent || !backend?.addEventListener) {
        return undefined;
      }
      const emitEvent = backend.emitEvent;
      const addEventListener = backend.addEventListener;
      const removeEventListener = backend.removeEventListener;

      const resultId = Date.now() * 1000 + Math.floor(Math.random() * 1000);

      return await new Promise<T | undefined>((resolve, reject) => {
        let token = "";
        const timeout = window.setTimeout(() => {
          if (token && removeEventListener) {
            removeEventListener(token);
          }
          reject(new Error(`Native function call timed out: ${name}`));
        }, 5000);

        token = addEventListener(
          "__juce__complete",
          (data: { promiseId?: number; result?: T }) => {
            if (data?.promiseId !== resultId) {
              return;
            }

            window.clearTimeout(timeout);
            removeEventListener?.(token);
            resolve(data.result);
          },
        );

        emitEvent("__juce__invoke", {
          name,
          params: args,
          resultId,
        });
      });
    };

    const loadDiagnostics = async () => {
      try {
        const result = await invokeNativeFunction<StartupDiagnostics>(
          "getStartupDiagnostics",
        );
        if (!cancelled && result && typeof result === "object") {
          setDiagnostics(result);
        }
      } catch (error) {
        console.error(
          "[StartupRecoveryApp] Failed to load startup diagnostics:",
          error,
        );
      }
    };

    void loadDiagnostics();
    return () => {
      cancelled = true;
    };
  }, []);

  const invokeNativeFunction = async <T,>(
    name: string,
    ...args: unknown[]
  ): Promise<T | undefined> => {
    const backend = window.__JUCE__?.backend;
    if (!backend?.emitEvent || !backend?.addEventListener) {
      return undefined;
    }

    const emitEvent = backend.emitEvent;
    const addEventListener = backend.addEventListener;
    const removeEventListener = backend.removeEventListener;
    const resultId = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    return await new Promise<T | undefined>((resolve, reject) => {
      let token = "";
      const timeout = window.setTimeout(() => {
        if (token && removeEventListener) {
          removeEventListener(token);
        }
        reject(new Error(`Native function call timed out: ${name}`));
      }, 5000);

      token = addEventListener(
        "__juce__complete",
        (data: { promiseId?: number; result?: T }) => {
          if (data?.promiseId !== resultId) {
            return;
          }

          window.clearTimeout(timeout);
          removeEventListener?.(token);
          resolve(data.result);
        },
      );

      emitEvent("__juce__invoke", {
        name,
        params: args,
        resultId,
      });
    });
  };

  const invokeWindowControl = async (name: string) => {
    try {
      await invokeNativeFunction(name);
    } catch (error) {
      console.error(`[StartupRecoveryApp] Failed to invoke ${name}:`, error);
    }
  };

  return (
    <div className="min-h-screen w-screen bg-daw-dark text-white flex flex-col">
      <div
        className="flex items-center justify-between h-9 bg-neutral-900 border-b border-neutral-700 shrink-0 select-none"
        style={
          usesNativeWindowChrome
            ? undefined
            : ({ WebkitAppRegion: "drag" } as React.CSSProperties)
        }
      >
        <div className="px-3 text-xs text-neutral-400">
          OpenStudio - Safe Startup
        </div>
        {!usesNativeWindowChrome && (
          <div
            className="flex items-center h-full"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={() => void invokeWindowControl("minimizeWindow")}
              className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-neutral-700/60 hover:text-white transition-colors"
              title="Minimize"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={() => void invokeWindowControl("closeWindow")}
              className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-red-600 hover:text-white transition-colors"
              title="Close"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-6">
          <div className="space-y-3">
            <div className="text-2xl font-semibold text-neutral-100">
              Safe startup mode
            </div>
            <div className="text-sm text-neutral-400 leading-6">
              OpenStudio is running a minimal interface so you can verify that
              the embedded browser works, inspect startup diagnostics, and
              relaunch the full app after fixing any startup issue.
            </div>
          </div>

          <div className="rounded-xl border border-neutral-700 bg-neutral-900/80 p-5 space-y-4">
            <div className="text-sm font-semibold text-neutral-200">
              Startup diagnostics
            </div>
            <div className="grid gap-3 text-sm">
              <div>
                <span className="text-neutral-500">Mode:</span>{" "}
                <span className="text-neutral-200">
                  {diagnostics?.startupMode ?? "safe"}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Backend:</span>{" "}
                <span className="text-neutral-200">
                  {diagnostics?.browserBackend ?? "unknown"}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">State:</span>{" "}
                <span className="text-neutral-200">
                  {diagnostics?.startupState ?? "loading"}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Startup log:</span>{" "}
                <span className="text-neutral-200 break-all">
                  {diagnostics?.startupLogPath ?? "loading..."}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">Frontend path:</span>{" "}
                <span className="text-neutral-200 break-all">
                  {diagnostics?.packagedFrontendPath ?? "loading..."}
                </span>
              </div>
              <div>
                <span className="text-neutral-500">WebView2 runtime:</span>{" "}
                <span className="text-neutral-200">
                  {diagnostics?.webView2RuntimeVersion ?? "n/a"}
                </span>
              </div>
              {diagnostics?.targetUrl ? (
                <div>
                  <span className="text-neutral-500">Target URL:</span>{" "}
                  <span className="text-neutral-200 break-all">
                    {diagnostics.targetUrl}
                  </span>
                </div>
              ) : null}
            </div>
            {diagnostics?.detail ? (
              <pre className="text-xs text-amber-200 bg-black/30 rounded-lg p-4 border border-neutral-800 whitespace-pre-wrap break-words">
                {diagnostics.detail}
              </pre>
            ) : (
              <div className="text-xs text-neutral-500">
                Loading more startup details...
              </div>
            )}
          </div>

          <div className="rounded-xl border border-neutral-700 bg-neutral-900/80 p-5 space-y-3">
            <div className="text-sm font-semibold text-neutral-200">
              Next steps
            </div>
            <div className="text-sm text-neutral-400 leading-6">
              Close this window and relaunch OpenStudio normally to retest the
              full interface. If startup still fails, collect the startup log
              above and run the installed-app inspection script from the repo.
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-daw-accent hover:bg-blue-600 text-white rounded text-sm font-medium transition-colors"
              >
                Reload Safe Mode
              </button>
              <button
                onClick={() => void invokeWindowControl("closeWindow")}
                className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-100 rounded text-sm font-medium transition-colors"
              >
                Close OpenStudio
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
