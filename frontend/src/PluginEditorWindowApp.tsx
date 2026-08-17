import { useEffect, useMemo } from "react";
import { BuiltInPluginPanel } from "./components/BuiltInPluginPanel";
import {
  nativeBridge,
  type BuiltInPluginAddress,
  type NativeGlobalShortcutEvent,
} from "./services/NativeBridge";
import { bootstrapTONE3000Session } from "./services/tone3000Session";
import { dispatchGlobalShortcut } from "./utils/globalShortcutDispatcher";
import { installModalContextMenuLeakGuard } from "./utils/modalEventGuards";
import { isEditableShortcutTarget } from "./utils/shortcutContext";
import { startSharedTransportSync } from "./utils/sharedTransportSync";
import { windowSessionId } from "./utils/windowEnvironment";
import "./components/FXChainPanel.css";
import "./components/NAMRackPanel.css";

type BuiltInPluginEditorSession = {
  address?: BuiltInPluginAddress;
  title?: string;
  fallbackName?: string;
};

const NON_TEXT_PLUGIN_CONTROL_SELECTOR = [
  "button",
  "select",
  "[role='button']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='combobox']",
  "input[type='button']",
  "input[type='checkbox']",
  "input[type='color']",
  "input[type='file']",
  "input[type='radio']",
  "input[type='range']",
  "input[type='reset']",
  "input[type='submit']",
].join(", ");

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
  const session = useMemo(parseSession, []);
  const title = session?.fallbackName || session?.title || "OpenStudio Plugin";

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
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const targetIsNonTextControl = Boolean(
        target?.closest(NON_TEXT_PLUGIN_CONTROL_SELECTOR),
      );
      void dispatchGlobalShortcut({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        source: "browser",
        targetIsEditable: !targetIsNonTextControl && isEditableShortcutTarget(e.target),
        targetIsNonTextControl,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
        stopImmediatePropagation: () => e.stopImmediatePropagation(),
      });
    };

    window.addEventListener("keydown", handleKeyDown, true);
    const unsubscribeNativeShortcuts = nativeBridge.onNativeGlobalShortcut(
      (event: NativeGlobalShortcutEvent) => {
        void dispatchGlobalShortcut({ ...event, source: "pluginWindow" });
      },
    );

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      unsubscribeNativeShortcuts();
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
