import { useEffect, useMemo, useRef } from "react";
import {
  BuiltInPluginPanel,
  isBuiltInPluginParamShortcutTarget,
} from "./components/BuiltInPluginPanel";
import {
  nativeBridge,
  type BuiltInPluginAddress,
} from "./services/NativeBridge";
import { bootstrapTONE3000Session } from "./services/tone3000Session";
import {
  dispatchGlobalShortcut,
  matchesActionShortcut,
} from "./utils/globalShortcutDispatcher";
import {
  browserShortcutWindowIsActive,
  toGlobalShortcutPayload,
  type BrowserShortcutFocusSnapshot,
} from "./utils/domShortcutEvent";
import { installModalContextMenuLeakGuard } from "./utils/modalEventGuards";
import { startSharedTransportSync } from "./utils/sharedTransportSync";
import { windowSessionId } from "./utils/windowEnvironment";
import { installBrowserZoomWheelGuard } from "./utils/browserWheelGuard";
import { startDetachedInputProfileSync } from "./utils/inputProfileWindowSync";
import "./components/FXChainPanel.css";

type BuiltInPluginEditorSession = {
  address?: BuiltInPluginAddress;
  title?: string;
  fallbackName?: string;
};

export function pluginEditorBrowserShortcutIsActive({
  documentFocused,
  visibilityState,
  windowFocused,
}: BrowserShortcutFocusSnapshot): boolean {
  return browserShortcutWindowIsActive({
    documentFocused,
    visibilityState,
    windowFocused,
  });
}

function parseSession(): BuiltInPluginEditorSession | null {
  if (!windowSessionId) return null;
  const candidates = [windowSessionId];
  try {
    const decoded = decodeURIComponent(windowSessionId);
    if (decoded !== windowSessionId) candidates.push(decoded);
  } catch {
    // Keep the raw session candidate.
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as BuiltInPluginEditorSession;
      if (!parsed.address || !parsed.address.chain) continue;
      return parsed;
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

export default function PluginEditorWindowApp() {
  useEffect(() => installBrowserZoomWheelGuard(document), []);
  useEffect(() => startDetachedInputProfileSync(), []);
  const session = useMemo(parseSession, []);
  const title = session?.fallbackName || session?.title || "OpenStudio Plugin";
  const windowFocusedRef = useRef(document.hasFocus());

  useEffect(() => {
    return startSharedTransportSync();
  }, []);

  useEffect(() => {
    void bootstrapTONE3000Session().catch((error) => {
      console.warn("[pluginEditor] TONE3000 silent auth bootstrap failed:", error);
    });
  }, []);

  useEffect(() => installModalContextMenuLeakGuard(), []);

  useEffect(() => {
    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
    };
    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!pluginEditorBrowserShortcutIsActive({
        documentFocused: document.hasFocus(),
        visibilityState: document.visibilityState,
        windowFocused: windowFocusedRef.current,
      })) return;
      const shortcutEvent = toGlobalShortcutPayload(e);
      const isPluginHistoryShortcut = isBuiltInPluginParamShortcutTarget(e.target)
        && (
          matchesActionShortcut(shortcutEvent, "edit.undo")
          || matchesActionShortcut(shortcutEvent, "edit.redo")
        );
      void dispatchGlobalShortcut({
        ...shortcutEvent,
        // A focused parameter select/number field owns plugin history, while
        // ordinary text fields retain their native editing Undo/Redo.
        targetIsEditable: shortcutEvent.targetIsEditable && !isPluginHistoryShortcut,
      });
    };

    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  if (!session?.address) {
    return (
      <div className="plugin-editor-window-app">
        <div className="plugin-editor-empty">
          <div>
            <strong>OpenStudio plugin editor unavailable</strong>
            <span>The editor window did not receive a valid plugin session.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-editor-window-app">
      <BuiltInPluginPanel
        address={session.address}
        fallbackName={title}
        shortcutSessionId={windowSessionId}
        onClose={() => {
          void nativeBridge.closeBuiltInPluginEditorWindow(
            windowSessionId,
            "close",
          );
        }}
      />
    </div>
  );
}
