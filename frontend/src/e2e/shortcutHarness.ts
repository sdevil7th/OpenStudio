import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProfiledRangeInput } from "../components/ui/ProfiledRangeInput";
import { PeakMeter } from "../components/PeakMeter";
import { registerScopedActionExecutor } from "../store/actionRegistry";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  resolveRegistryShortcutAction,
} from "../utils/globalShortcutDispatcher";
import { installBrowserZoomWheelGuard } from "../utils/browserWheelGuard";
import { applyInputProfileWindowSnapshot } from "../utils/inputProfileWindowSync";
import {
  getMouseBehaviorProfile,
  MOUSE_BEHAVIOR_PROFILE_OPTIONS,
  toMouseBehaviorPlatform,
} from "../utils/mouseBehaviorProfiles";
import {
  KEYBOARD_SHORTCUT_PROFILES,
  type KeyboardShortcutProfileId,
} from "../utils/shortcutProfiles";
import {
  resolveMouseModifier,
  type MouseModifierContext,
} from "../utils/mouseModifierResolver";
import {
  activateShortcutContext,
  getActiveShortcutContext,
  isEditableShortcutTarget,
  isNonTextControlShortcutTarget,
  registerShortcutSurface,
  shortcutContextKey,
  shortcutExactlyMatchesForPlatform,
  subscribeShortcutContext,
  type EditShortcutContext,
  type ShortcutEventLike,
  type ShortcutHandlerResult,
} from "../utils/shortcutContext";
import type { ShortcutPlatform } from "../utils/platform";
import { resolveTrackMeterPresentation } from "../utils/trackMeterPresentation";
import {
  resolveWheelGesture,
  type WheelPlatform,
  type WheelSurface,
  type WheelSubtarget,
} from "../utils/wheelGestureResolver";

interface KeyboardDispatchOptions {
  key: string;
  code?: string;
  location?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

interface WheelDispatchOptions {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
}

interface PointerDispatchOptions {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
}

interface HarnessDispatchResult {
  dispatchReturned: boolean;
  defaultPrevented: boolean;
}

interface HarnessMeterState {
  audioLevel: number;
  midiInputLevel: number;
  armed: boolean;
  trackType: string;
}

declare global {
  interface Window {
    dispatchHarnessKey: (
      targetId: string,
      options: KeyboardDispatchOptions,
    ) => HarnessDispatchResult;
    dispatchHarnessWheel: (
      targetId: string,
      options: WheelDispatchOptions,
    ) => HarnessDispatchResult;
    dispatchHarnessPointer: (
      targetId: string,
      options: PointerDispatchOptions,
    ) => HarnessDispatchResult;
    applyHarnessInputProfileSnapshot: (value: unknown) => {
      applied: boolean;
      keyboardShortcutProfileId: string;
      mouseBehaviorProfileId: string;
    };
    setHarnessMeterState: (value: HarnessMeterState) => void;
  }
}

let updateHarnessMeter: ((value: HarnessMeterState) => void) | null = null;

function MeterHarness() {
  const [state, setState] = useState<HarnessMeterState>({
    audioLevel: 0,
    midiInputLevel: 0,
    armed: true,
    trackType: "midi",
  });
  updateHarnessMeter = setState;
  const presentation = resolveTrackMeterPresentation(
    state.audioLevel,
    state.midiInputLevel,
    state.armed,
    state.trackType,
  );
  return createElement(PeakMeter, {
    level: state.audioLevel,
    midiInputLevel: presentation.normalizedLevel,
    meterSource: presentation.source,
    ariaLabel: "Harness track meter",
    height: 120,
    width: 16,
    stereo: true,
  });
}

createRoot(requiredElement("midi-meter-root")).render(createElement(MeterHarness));
window.setHarnessMeterState = (value) => updateHarnessMeter?.(value);

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing E2E harness element #${id}`);
  }
  return element as T;
}

const keyboardPlatform = requiredElement<HTMLSelectElement>("keyboard-platform");
const keyboardProfile = requiredElement<HTMLSelectElement>("keyboard-profile");
const shortcutBinding = requiredElement<HTMLSelectElement>("shortcut-binding");
const activeContextOutput = requiredElement<HTMLOutputElement>("active-context");
const shortcutResult = requiredElement<HTMLOutputElement>("shortcut-result");
const contextHitCountsOutput = requiredElement<HTMLPreElement>("context-hit-counts");
const wheelPlatform = requiredElement<HTMLSelectElement>("wheel-platform");
const mouseProfile = requiredElement<HTMLSelectElement>("mouse-profile");
const wheelResult = requiredElement<HTMLPreElement>("wheel-result");
const viewportHitCountsOutput = requiredElement<HTMLPreElement>("viewport-hit-counts");
const profileSnapshotResult = requiredElement<HTMLOutputElement>("profile-snapshot-result");
const pointerResult = requiredElement<HTMLPreElement>("pointer-result");
const nativeButton = requiredElement<HTMLButtonElement>("native-button");
const buttonClickCount = requiredElement<HTMLSpanElement>("button-click-count");

// Give availability-aware timeline commands a real, editable target. The
// exhaustive browser matrix must exercise production canHandle predicates, not
// bypass them with synthetic action callbacks.
const harnessTrack = createDefaultTrack("e2e-track", "E2E Track", "#4361ee", "audio", []);
harnessTrack.clips = [{
  id: "e2e-clip",
  name: "E2E Clip",
  filePath: "C:/e2e.wav",
  startTime: 0,
  duration: 4,
  offset: 0,
  color: "#4361ee",
  volumeDB: 0,
  fadeIn: 0,
  fadeOut: 0,
}];
useDAWStore.setState((state) => ({
  tracks: [harnessTrack],
  selectedTrackId: harnessTrack.id,
  selectedTrackIds: [harnessTrack.id],
  selectedClipId: "e2e-clip",
  selectedClipIds: ["e2e-clip"],
  timeSelection: { start: 0.5, end: 2.5 },
  transport: { ...state.transport, currentTime: 1 },
}));

const hitCounts = {
  timeline: 0,
  piano_roll: 0,
  pitch_editor: 0,
};

const viewportHitCounts = {
  timeline: 0,
  piano_roll: 0,
};

function selectedKeyboardPlatform(): ShortcutPlatform {
  return keyboardPlatform.value as ShortcutPlatform;
}

function updateHitCounts(): void {
  contextHitCountsOutput.textContent = JSON.stringify(hitCounts);
}

function contextHandler(
  name: keyof typeof hitCounts,
): (event: ShortcutEventLike) => ShortcutHandlerResult {
  return (event) => {
    const binding = shortcutBinding.value;
    if (!shortcutExactlyMatchesForPlatform(
      event,
      selectedKeyboardPlatform(),
      binding,
    )) {
      return "unmatched";
    }

    hitCounts[name] += 1;
    updateHitCounts();
    shortcutResult.textContent = JSON.stringify({
      handled: true,
      owner: name,
      binding,
      key: event.key,
      code: event.code,
      platform: selectedKeyboardPlatform(),
    });
    return "handled";
  };
}

for (const option of MOUSE_BEHAVIOR_PROFILE_OPTIONS) {
  mouseProfile.add(new Option(option.label, option.value));
}
for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
  keyboardProfile.add(new Option(profile.name, profile.id));
}
keyboardProfile.value = useDAWStore.getState().keyboardShortcutProfileId;
keyboardProfile.addEventListener("change", () => {
  useDAWStore.getState().setKeyboardShortcutProfile(
    keyboardProfile.value as KeyboardShortcutProfileId,
  );
});
mouseProfile.value = useDAWStore.getState().mouseBehaviorProfileId;
mouseProfile.addEventListener("change", () => {
  useDAWStore.getState().setMouseBehaviorProfile(
    mouseProfile.value as KeyboardShortcutProfileId,
  );
});

function renderViewportHitCounts(): void {
  viewportHitCountsOutput.textContent = JSON.stringify(viewportHitCounts);
}

function ProfiledRangeHarness({ id, label }: { id: string; label: string }) {
  const [value, setValue] = useState(0.5);
  const [beginCount, setBeginCount] = useState(0);
  const [commitCount, setCommitCount] = useState(0);
  return createElement(
    "div",
    null,
    createElement(ProfiledRangeInput, {
      id,
      "aria-label": label,
      min: 0,
      max: 1,
      step: 0.1,
      value,
      onValueChange: setValue,
      onBeginEdit: () => setBeginCount((count) => count + 1),
      onCommitEdit: () => setCommitCount((count) => count + 1),
    }),
    createElement("output", {
      "aria-label": `${label} value`,
      children: value.toFixed(3),
    }),
    createElement("output", {
      "aria-label": `${label} begin count`,
      children: String(beginCount),
    }),
    createElement("output", {
      "aria-label": `${label} commit count`,
      children: String(commitCount),
    }),
  );
}

createRoot(requiredElement("timeline-profiled-range-root")).render(
  createElement(ProfiledRangeHarness, {
    id: "timeline-profiled-range",
    label: "Timeline nested profiled range",
  }),
);
createRoot(requiredElement("piano-profiled-range-root")).render(
  createElement(ProfiledRangeHarness, {
    id: "piano-profiled-range",
    label: "Piano roll nested profiled range",
  }),
);

const contextByElementId: Readonly<Record<string, EditShortcutContext>> = {
  "application-surface": { kind: "application" },
  "timeline-surface": { kind: "timeline" },
  "piano-surface": { kind: "piano_roll", sessionId: "e2e-piano" },
  "pitch-surface": { kind: "pitch_editor" },
  "automation-surface": { kind: "automation" },
};

registerShortcutSurface({ kind: "timeline" }, contextHandler("timeline"));
registerScopedActionExecutor(
  { kind: "timeline" },
  (actionId) => (
    actionId === "view.zoomToSelection" || actionId === "view.zoomToFit"
      ? "handled"
      : "unmatched"
  ),
  ["view.zoomToSelection", "view.zoomToFit"],
);
registerShortcutSurface(
  { kind: "piano_roll", sessionId: "e2e-piano" },
  contextHandler("piano_roll"),
);
registerShortcutSurface({ kind: "pitch_editor" }, contextHandler("pitch_editor"));

for (const [elementId, context] of Object.entries(contextByElementId)) {
  const element = requiredElement(elementId);
  const activate = () => activateShortcutContext(context);
  element.addEventListener("focus", activate);
  element.addEventListener("pointerdown", activate);
}

function renderActiveContext(): void {
  activeContextOutput.textContent = shortcutContextKey(getActiveShortcutContext());
}

subscribeShortcutContext(renderActiveContext);
renderActiveContext();

let clicks = 0;
nativeButton.addEventListener("click", () => {
  clicks += 1;
  buttonClickCount.textContent = String(clicks);
});

window.addEventListener("keydown", (event) => {
  const payload = {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    source: "e2e-dom",
    targetIsEditable: isEditableShortcutTarget(event.target),
    targetIsNonTextControl: isNonTextControlShortcutTarget(event.target),
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    stopImmediatePropagation: () => event.stopImmediatePropagation(),
  };
  const previousResult = shortcutResult.textContent;
  const resolution = resolveRegistryShortcutAction(payload, selectedKeyboardPlatform());
  const handled = dispatchGlobalShortcut(payload, selectedKeyboardPlatform());

  if (handled && shortcutResult.textContent === previousResult) {
    shortcutResult.textContent = JSON.stringify({
      handled: true,
      owner: "registry",
      actionId: resolution?.action.id ?? null,
      route: resolution?.route ?? null,
      scope: resolution?.scope ?? null,
      context: shortcutContextKey(getActiveShortcutContext()),
      platform: selectedKeyboardPlatform(),
    });
  }

  if (!handled) {
    shortcutResult.textContent = JSON.stringify({
      handled: false,
      owner: "native",
      key: event.key,
      code: event.code,
      target: event.target instanceof HTMLElement ? event.target.id : "",
      defaultPrevented: event.defaultPrevented,
    });
  }
}, true);

window.dispatchHarnessKey = (targetId, options) => {
  const target = requiredElement(targetId);
  target.focus();
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  const dispatchReturned = target.dispatchEvent(event);
  return { dispatchReturned, defaultPrevented: event.defaultPrevented };
};

for (const target of document.querySelectorAll<HTMLElement>("[data-wheel-surface]")) {
  target.addEventListener("wheel", (event) => {
    const counter = target.dataset.viewportCounter as keyof typeof viewportHitCounts | undefined;
    if (counter) {
      viewportHitCounts[counter] += 1;
      renderViewportHitCounts();
    }
    const shortcutPlatform = wheelPlatform.value === "macos"
      ? "macos"
      : wheelPlatform.value === "windows"
        ? "windows"
        : "other";
    const profile = getMouseBehaviorProfile(
      useDAWStore.getState().mouseBehaviorProfileId,
      shortcutPlatform,
    );
    const resolved = resolveWheelGesture(event, {
      surface: target.dataset.wheelSurface as WheelSurface,
      subtarget: (target.dataset.wheelSubtarget ?? "content") as WheelSubtarget,
      platform: toMouseBehaviorPlatform(shortcutPlatform) as WheelPlatform,
      hoveredTargetId: target.dataset.hoveredTargetId ?? target.id,
    }, profile.wheel);

    if (resolved.preventDefault) event.preventDefault();
    if (resolved.stopPropagation) event.stopPropagation();

    const result = {
      ...resolved,
      eventDefaultPrevented: event.defaultPrevented,
    };
    target.dataset.lastWheelResult = JSON.stringify(result);
    wheelResult.textContent = JSON.stringify(result, null, 2);
  }, { passive: false });
}

window.dispatchHarnessWheel = (targetId, options) => {
  const target = requiredElement(targetId);
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  const dispatchReturned = target.dispatchEvent(event);
  return { dispatchReturned, defaultPrevented: event.defaultPrevented };
};

for (const target of document.querySelectorAll<HTMLElement>("[data-pointer-context]")) {
  target.addEventListener("pointerdown", (event) => {
    const shortcutPlatform = selectedKeyboardPlatform();
    const profile = getMouseBehaviorProfile(
      useDAWStore.getState().mouseBehaviorProfileId,
      shortcutPlatform,
    );
    const resolved = resolveMouseModifier(
      event,
      target.dataset.pointerContext as MouseModifierContext,
      {
        platform: toMouseBehaviorPlatform(shortcutPlatform),
        profile: profile.modifiers,
      },
    );
    target.dataset.lastPointerResult = JSON.stringify(resolved);
    pointerResult.textContent = JSON.stringify(resolved, null, 2);
    if (resolved.matched && !resolved.isNoop) event.preventDefault();
  });
}

window.dispatchHarnessPointer = (targetId, options) => {
  const target = requiredElement(targetId);
  const event = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  const dispatchReturned = target.dispatchEvent(event);
  return { dispatchReturned, defaultPrevented: event.defaultPrevented };
};

window.applyHarnessInputProfileSnapshot = (value) => {
  const applied = applyInputProfileWindowSnapshot(value);
  const state = useDAWStore.getState();
  keyboardProfile.value = state.keyboardShortcutProfileId;
  mouseProfile.value = state.mouseBehaviorProfileId;
  const result = {
    applied,
    keyboardShortcutProfileId: state.keyboardShortcutProfileId,
    mouseBehaviorProfileId: state.mouseBehaviorProfileId,
  };
  profileSnapshotResult.textContent = JSON.stringify(result);
  return result;
};

installBrowserZoomWheelGuard(requiredElement("wheel-browser-guard-zone"));
