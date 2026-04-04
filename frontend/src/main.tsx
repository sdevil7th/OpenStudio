import React, { useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

const searchParams = new URLSearchParams(window.location.search);
const windowRole = searchParams.get("window");
const startupMode = searchParams.get("startup") ?? "normal";
const isSafeStartup = startupMode === "safe";
const isPackagedResourceProviderOrigin =
  window.location.origin === "https://juce.backend" || window.location.protocol === "juce:";

let bootTerminalStateSent = false;

async function waitForNativeBackend(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const backend = window.__JUCE__?.backend;
    if (backend?.emitEvent && backend?.addEventListener) {
      return backend;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }

  return undefined;
}

async function invokeNativeFunction<T>(name: string, ...args: unknown[]): Promise<T | undefined> {
  const backend = await waitForNativeBackend();
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

    token = addEventListener("__juce__complete", (data: { promiseId?: number; result?: T }) => {
      if (data?.promiseId !== resultId) {
        return;
      }

      window.clearTimeout(timeout);
      removeEventListener?.(token);
      resolve(data.result);
    });

    emitEvent("__juce__invoke", {
      name,
      params: args,
      resultId,
    });
  });
}

function createBootOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "openstudio-boot-overlay";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "2147483647";
  overlay.style.display = "flex";
  overlay.style.flexDirection = "column";
  overlay.style.justifyContent = "center";
  overlay.style.alignItems = "center";
  overlay.style.gap = "12px";
  overlay.style.background = "#121212";
  overlay.style.color = "#e5e7eb";
  overlay.style.fontFamily = "'Segoe UI', Inter, system-ui, sans-serif";
  overlay.style.transition = "opacity 140ms ease";
  overlay.innerHTML = `
    <div style="font-size: 18px; font-weight: 600;">${isSafeStartup ? "Starting OpenStudio Safe Mode..." : "Starting OpenStudio..."}</div>
    <div style="font-size: 13px; color: #9ca3af;">Preparing the embedded interface</div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

const bootOverlay = createBootOverlay();

function removeBootOverlay() {
  if (!bootOverlay.isConnected) {
    return;
  }

  bootOverlay.style.opacity = "0";
  window.setTimeout(() => {
    bootOverlay.remove();
  }, 160);
}

async function reportFrontendStartupState(state: string, detail: string) {
  if (isPackagedResourceProviderOrigin) {
    try {
      const url = new URL("./__openstudio__/startup", window.location.href);
      url.searchParams.set("state", state);
      url.searchParams.set("detail", detail);
      await fetch(url.toString(), {
        method: "GET",
        cache: "no-store",
      });
      return;
    } catch (error) {
      console.error("[Startup] Failed to report startup state through resource provider:", error);
    }
  }

  try {
    await invokeNativeFunction("reportFrontendStartupState", state, detail);
  } catch (error) {
    console.error("[Startup] Failed to report startup state:", error);
  }
}

function finishStartup(state: "boot-ready" | "boot-failed", detail: string) {
  if (bootTerminalStateSent) {
    return;
  }

  bootTerminalStateSent = true;
  removeBootOverlay();
  void reportFrontendStartupState(state, detail);
}

void reportFrontendStartupState(
  "boot-started",
  `window=${windowRole ?? "main"} startup=${startupMode}`,
);

window.addEventListener("error", (event) => {
  const detail = event.error?.stack || event.message || "Unknown window error";
  finishStartup("boot-failed", `window.onerror: ${detail}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
  finishStartup("boot-failed", `unhandledrejection: ${detail}`);
});

function StartupReadySentinel() {
  const hasReportedReady = useRef(false);

  useEffect(() => {
    if (hasReportedReady.current) {
      return;
    }

    hasReportedReady.current = true;
    const frame = window.requestAnimationFrame(() => {
      finishStartup(
        "boot-ready",
        isSafeStartup ? "safe-startup-ui-mounted" : "root-mounted",
      );
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  finishStartup("boot-failed", "The #root element was not found in index.html.");
  throw new Error("Root element not found");
}
const appRoot = rootElement;

function renderBootstrapFailure(error: unknown) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  const escapedMessage = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  appRoot.innerHTML = `
    <div style="min-height:100vh;width:100vw;display:flex;align-items:center;justify-content:center;background:#111827;color:#f3f4f6;font-family:'Segoe UI',Inter,system-ui,sans-serif;padding:32px;box-sizing:border-box;">
      <div style="max-width:760px;width:100%;background:#0f172a;border:1px solid #334155;border-radius:16px;padding:24px;box-shadow:0 18px 60px rgba(0,0,0,0.45);">
        <div style="font-size:24px;font-weight:700;margin-bottom:12px;">OpenStudio could not start the embedded interface</div>
        <div style="font-size:14px;line-height:1.6;color:#cbd5e1;margin-bottom:16px;">
          The frontend failed before it could finish booting. Check the startup log for more details, or relaunch with
          <code style="margin-left:6px;background:#020617;padding:2px 6px;border-radius:6px;">--ui-safe-mode</code>.
        </div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid #1e293b;border-radius:12px;padding:16px;color:#fca5a5;font-size:12px;max-height:320px;overflow:auto;">${escapedMessage}</pre>
      </div>
    </div>
  `;
}

async function bootstrap() {
  const { ErrorBoundary } = await import("./components/ErrorBoundary.tsx");
  let RootComponent: React.ComponentType;

  if (isSafeStartup) {
    const rootModule = await import("./components/StartupRecoveryApp.tsx");
    RootComponent = rootModule.StartupRecoveryApp;
  } else if (windowRole === "mixer") {
    const rootModule = await import("./MixerWindowApp.tsx");
    RootComponent = rootModule.default;
  } else {
    const rootModule = await import("./App.tsx");
    RootComponent = rootModule.default;
  }

  ReactDOM.createRoot(appRoot).render(
    <React.StrictMode>
      <ErrorBoundary
        onError={(error, info) => {
          finishStartup(
            "boot-failed",
            `[ErrorBoundary] ${error.stack || error.message}\n${info.componentStack}`,
          );
        }}
      >
        <RootComponent />
        <StartupReadySentinel />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap().catch((error) => {
  finishStartup(
    "boot-failed",
    `[bootstrap] ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  renderBootstrapFailure(error);
});
