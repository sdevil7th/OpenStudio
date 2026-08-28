import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActionShortcutScopes,
  getRegisteredAction,
  getRegisteredActions,
  type ActionDef,
  type ActionShortcutScope,
} from "../store/actionRegistry";
import { createDefaultTrack, useDAWStore } from "../store/useDAWStore";
import {
  dispatchGlobalShortcut,
  getEffectiveActionShortcuts,
  resolveRegistryShortcutAction,
  type GlobalShortcutPayload,
} from "../utils/globalShortcutDispatcher";
import {
  MOUSE_MODIFIER_CONTEXTS,
  resolveMouseModifier,
  type MouseModifierCombination,
  type PointerModifierEventLike,
} from "../utils/mouseModifierResolver";
import { getMouseBehaviorProfile } from "../utils/mouseBehaviorProfiles";
import {
  normalizeShortcutBinding,
  shortcutMatchesEvent,
  type ShortcutPlatform,
} from "../utils/platform";
import {
  KEYBOARD_SHORTCUT_PROFILES,
  getProfileActionBindings,
} from "../utils/shortcutProfiles";
import {
  activateShortcutContext,
  registerShortcutSurface,
  resetShortcutContextForTests,
  type EditShortcutContext,
} from "../utils/shortcutContext";
import {
  resolveWheelGesture,
  type WheelBehaviorRule,
  type WheelEventLike,
  type WheelInputDevice,
  type WheelPlatform,
  type WheelSubtarget,
  type WheelSurface,
} from "../utils/wheelGestureResolver";

const TEST_PLATFORMS = ["macos", "windows"] as const satisfies readonly ShortcutPlatform[];

const WHEEL_SURFACES = [
  "timeline",
  "tcp",
  "piano_roll",
  "pitch_editor",
  "browser",
  "parameter",
] as const satisfies readonly WheelSurface[];

const WHEEL_SUBTARGETS = [
  "content",
  "ruler",
  "track",
  "clip",
  "empty",
  "grid",
  "note",
  "sidebar",
  "keyboard",
  "controller_lane",
  "waveform_scale",
  "spectrogram_scale",
  "automation_lane",
  "fade_handle",
  "event_volume",
  "list",
  "tree",
  "preview",
  "control",
  "graph",
  "console_fader",
] as const satisfies readonly WheelSubtarget[];

const WHEEL_DEVICES = ["mouse", "trackpad", "unknown"] as const satisfies readonly WheelInputDevice[];

interface ParsedBinding {
  modifiers: readonly string[];
  key: string;
}

type SyntheticGlobalShortcutPayload = GlobalShortcutPayload & {
  location?: number;
  getModifierState?: (key: string) => boolean;
};

function parseNormalizedBinding(binding: string): ParsedBinding {
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized) throw new Error(`Invalid shortcut binding: ${binding}`);
  const segments = normalized.split("+");
  const modifierNames = new Set([
    "Ctrl",
    "Control",
    "Command",
    "Alt",
    "Option",
    "Meta",
    "AltGraph",
    "Shift",
  ]);
  const modifiers: string[] = [];
  let index = 0;
  while (index < segments.length && modifierNames.has(segments[index])) {
    modifiers.push(segments[index]);
    index += 1;
  }
  const key = segments.slice(index).join("+");
  if (!key) throw new Error(`Binding has no key: ${binding}`);
  return { modifiers, key };
}

function keyEventIdentity(rawKey: string): Pick<SyntheticGlobalShortcutPayload, "key" | "code" | "location"> {
  if (rawKey.startsWith("Code:")) {
    const code = rawKey.slice(5);
    return keyEventIdentityFromCode(code);
  }
  const key = rawKey.startsWith("Key:") ? rawKey.slice(4) : rawKey;
  if (/^Numpad/.test(key)) return keyEventIdentityFromCode(key);
  if (/^[A-Z]$/.test(key)) return { key: key.toLowerCase(), code: `Key${key}` };
  if (/^\d$/.test(key)) return { key, code: `Digit${key}` };
  if (/^F\d{1,2}$/.test(key)) return { key, code: key };

  const named: Readonly<Record<string, Pick<SyntheticGlobalShortcutPayload, "key" | "code">>> = {
    Space: { key: " ", code: "Space" },
    Enter: { key: "Enter", code: "Enter" },
    Esc: { key: "Escape", code: "Escape" },
    Tab: { key: "Tab", code: "Tab" },
    Backspace: { key: "Backspace", code: "Backspace" },
    Delete: { key: "Delete", code: "Delete" },
    Insert: { key: "Insert", code: "Insert" },
    Home: { key: "Home", code: "Home" },
    End: { key: "End", code: "End" },
    PageUp: { key: "PageUp", code: "PageUp" },
    PageDown: { key: "PageDown", code: "PageDown" },
    Up: { key: "ArrowUp", code: "ArrowUp" },
    Down: { key: "ArrowDown", code: "ArrowDown" },
    Left: { key: "ArrowLeft", code: "ArrowLeft" },
    Right: { key: "ArrowRight", code: "ArrowRight" },
    Pause: { key: "Pause", code: "Pause" },
    Equal: { key: "=", code: "Equal" },
    Minus: { key: "-", code: "Minus" },
    "=": { key: "=", code: "Equal" },
    "+": { key: "+", code: "Equal" },
    "-": { key: "-", code: "Minus" },
    "[": { key: "[", code: "BracketLeft" },
    "]": { key: "]", code: "BracketRight" },
    ";": { key: ";", code: "Semicolon" },
    "'": { key: "'", code: "Quote" },
    ",": { key: ",", code: "Comma" },
    ".": { key: ".", code: "Period" },
    "/": { key: "/", code: "Slash" },
    "\\": { key: "\\", code: "Backslash" },
    "`": { key: "`", code: "Backquote" },
  };
  const identity = named[key];
  if (!identity) throw new Error(`No synthetic KeyboardEvent mapping for ${rawKey}`);
  return identity;
}

function keyEventIdentityFromCode(code: string): Pick<SyntheticGlobalShortcutPayload, "key" | "code" | "location"> {
  if (/^Key[A-Z]$/.test(code)) return { key: code.slice(-1).toLowerCase(), code };
  if (/^Digit\d$/.test(code)) return { key: code.slice(-1), code };
  if (/^Numpad\d$/.test(code)) return { key: code.slice(-1), code, location: 3 };
  const numpadKeys: Readonly<Record<string, string>> = {
    NumpadAdd: "+",
    NumpadComma: ",",
    NumpadDecimal: ".",
    NumpadDivide: "/",
    NumpadEnter: "Enter",
    NumpadEqual: "=",
    NumpadMultiply: "*",
    NumpadSubtract: "-",
  };
  if (code in numpadKeys) return { key: numpadKeys[code], code, location: 3 };
  const codeKeys: Readonly<Record<string, string>> = {
    Space: "Space",
    Enter: "Enter",
    Escape: "Esc",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Equal: "=",
    Minus: "-",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Backquote: "`",
  };
  if (code in codeKeys) {
    return { ...keyEventIdentity(codeKeys[code]), code };
  }
  return keyEventIdentity(code);
}

function eventForBinding(binding: string, platform: ShortcutPlatform): SyntheticGlobalShortcutPayload {
  const parsed = parseNormalizedBinding(binding);
  const event: SyntheticGlobalShortcutPayload = {
    ...keyEventIdentity(parsed.key),
    source: "exhaustive-profile-test",
  };
  for (const modifier of parsed.modifiers) {
    if (platform === "macos") {
      if (modifier === "Ctrl" || modifier === "Command") event.metaKey = true;
      else if (modifier === "Alt" || modifier === "Control") event.ctrlKey = true;
      else if (modifier === "Option") event.altKey = true;
      else if (modifier === "Shift") event.shiftKey = true;
      else if (modifier === "AltGraph") {
        event.altKey = true;
        event.ctrlKey = true;
        event.getModifierState = (name) => name === "AltGraph";
      } else throw new Error(`${modifier} is not reachable on macOS`);
    } else {
      if (modifier === "Ctrl" || modifier === "Control") event.ctrlKey = true;
      else if (modifier === "Alt") event.altKey = true;
      else if (modifier === "Meta") event.metaKey = true;
      else if (modifier === "Shift") event.shiftKey = true;
      else if (modifier === "AltGraph") {
        event.altKey = true;
        event.ctrlKey = true;
        event.getModifierState = (name) => name === "AltGraph";
      } else throw new Error(`${modifier} is not reachable on Windows`);
    }
  }
  return event;
}

function contextForScope(scope: ActionShortcutScope): EditShortcutContext {
  switch (scope) {
    case "global": return { kind: "application" };
    case "timeline": return { kind: "timeline" };
    case "timeline_ruler": return { kind: "timeline_ruler" };
    case "track_control_panel": return { kind: "track_control_panel" };
    case "mixer": return { kind: "mixer" };
    case "pitch_editor": return { kind: "pitch_editor" };
    case "piano_roll": return { kind: "piano_roll", sessionId: "exhaustive-profile" };
    case "automation": return { kind: "automation" };
    case "browser": return { kind: "browser" };
    case "plugin": return { kind: "plugin", sessionId: "exhaustive-profile" };
    case "modal": return { kind: "modal" };
    // Contextual commands are tried whenever a concrete editor context is active.
    case "contextual": return { kind: "timeline" };
  }
}

function activateCondition(action: ActionDef): void {
  const state = useDAWStore.getState();
  const transport = {
    ...state.transport,
    isPlaying: action.shortcutWhen === "transport_running",
    isRecording: false,
  };
  useDAWStore.setState({
    transport,
    stepInputEnabled: action.shortcutWhen === "step_input_enabled",
  });
}

function pointerModifierCombinations(): Array<{
  combination: MouseModifierCombination;
  event: PointerModifierEventLike;
}> {
  const logical = ["primary", "secondary", "alt", "shift"] as const;
  return Array.from({ length: 16 }, (_, bits) => {
    const active = logical.filter((_, index) => Boolean(bits & (1 << index)));
    return {
      combination: (active.length === 0 ? "none" : active.join("+")) as MouseModifierCombination,
      event: {},
    };
  });
}

function rawPointerEvent(
  combination: MouseModifierCombination,
  platform: ShortcutPlatform,
): PointerModifierEventLike {
  const modifiers = new Set(combination === "none" ? [] : combination.split("+"));
  return {
    ctrlKey: platform === "macos" ? modifiers.has("secondary") : modifiers.has("primary"),
    metaKey: platform === "macos" ? modifiers.has("primary") : modifiers.has("secondary"),
    altKey: modifiers.has("alt"),
    shiftKey: modifiers.has("shift"),
  };
}

function rawWheelModifierCombinations(platform: ShortcutPlatform): WheelEventLike[] {
  return Array.from({ length: 16 }, (_, bits) => {
    const primary = Boolean(bits & 1);
    const secondary = Boolean(bits & 2);
    return {
      deltaX: 30,
      deltaY: 120,
      ctrlKey: platform === "macos" ? secondary : primary,
      metaKey: platform === "macos" ? primary : secondary,
      altKey: Boolean(bits & 4),
      shiftKey: Boolean(bits & 8),
      clientX: 41,
      clientY: 73,
    };
  });
}

function ruleMatches(
  rule: WheelBehaviorRule,
  surface: WheelSurface,
  subtarget: WheelSubtarget,
  event: WheelEventLike,
  platform: WheelPlatform,
  device: WheelInputDevice,
): boolean {
  if (rule.surface !== surface) return false;
  if (rule.subtargets && !rule.subtargets.includes(subtarget)) return false;
  if (rule.devices && !rule.devices.includes(device)) return false;
  const normalized = {
    primary: platform === "macos" ? Boolean(event.metaKey) : Boolean(event.ctrlKey),
    secondary: platform === "macos" ? Boolean(event.ctrlKey) : Boolean(event.metaKey),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
  };
  return Object.entries(rule.modifiers ?? {}).every(
    ([name, expected]) => normalized[name as keyof typeof normalized] === expected,
  );
}

describe("exhaustive keyboard, wheel, and pointer profiles", () => {
  const original = {
    keyboardShortcutProfileId: useDAWStore.getState().keyboardShortcutProfileId,
    customShortcuts: useDAWStore.getState().customShortcuts,
    tracks: useDAWStore.getState().tracks,
    selectedClipId: useDAWStore.getState().selectedClipId,
    selectedClipIds: useDAWStore.getState().selectedClipIds,
    globalLocked: useDAWStore.getState().globalLocked,
    lockSettings: useDAWStore.getState().lockSettings,
    transport: useDAWStore.getState().transport,
    stepInputEnabled: useDAWStore.getState().stepInputEnabled,
  };

  beforeEach(() => {
    resetShortcutContextForTests();
    useDAWStore.setState({ customShortcuts: {} });
  });

  afterEach(() => {
    resetShortcutContextForTests();
    useDAWStore.setState(original);
    vi.restoreAllMocks();
  });

  it("dispatches every effective built-in binding to its intended action on macOS and Windows", () => {
    const registeredIds = new Set(getRegisteredActions().map((action) => action.id));
    let verifiedBindings = 0;

    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const configuredActionId of Object.keys(profile.bindings)) {
        expect(
          registeredIds.has(configuredActionId),
          `${profile.id} binds missing action ${configuredActionId}`,
        ).toBe(true);
      }

      for (const platform of TEST_PLATFORMS) {
        useDAWStore.setState({
          keyboardShortcutProfileId: profile.id,
          customShortcuts: {},
        });
        const actions = getRegisteredActions();
        for (const action of actions) {
          const bindings = getEffectiveActionShortcuts(action, platform);
          for (const binding of bindings) {
            const event = eventForBinding(binding, platform);
            expect(
              shortcutMatchesEvent(event, binding, platform),
              `${profile.id}/${platform}/${action.id}: ${binding} is not physically synthesizable`,
            ).toBe(true);
            activateCondition(action);
            const canHandle = !action.canHandleShortcut || action.canHandleShortcut();

            for (const scope of getActionShortcutScopes(action, profile.id)) {
              resetShortcutContextForTests();
              activateShortcutContext(contextForScope(scope));
              const controlled = resolveRegistryShortcutAction(event, platform, {
                canHandleAction: (candidate) => candidate.id === action.id,
              });
              expect(
                controlled?.action.id,
                `${profile.id}/${platform}/${scope}/${binding}: controlled availability`,
              ).toBe(action.id);
              const resolved = resolveRegistryShortcutAction(event, platform);
              if (canHandle) {
                expect(
                  resolved?.action.id,
                  `${profile.id}/${platform}/${scope}/${binding}`,
                ).toBe(action.id);
              } else {
                expect(
                  resolved?.action.id,
                  `${profile.id}/${platform}/${scope}/${binding}: unavailable action consumed chord`,
                ).not.toBe(action.id);
              }

              const preventDefault = vi.fn();
              const executed: string[] = [];
              const handled = dispatchGlobalShortcut(
                { ...event, preventDefault },
                platform,
                { executeAction: (matched) => executed.push(matched.id) },
              );
              if (canHandle) {
                expect(handled, `${profile.id}/${platform}/${scope}/${binding}`).toBe(true);
                expect(preventDefault, `${profile.id}/${platform}/${scope}/${binding}`).toHaveBeenCalled();
              }
              // canHandle/repeat/debounce guards may deliberately suppress the
              // body, but they must never execute a different action.
              expect(executed, `${profile.id}/${platform}/${scope}/${binding}`).toSatisfy(
                (ids: string[]) => ids.length === 0
                  || (ids.length === 1 && ids[0] === resolved?.action.id),
              );
              verifiedBindings += 1;
            }
          }
        }
      }
    }

    expect(verifiedBindings).toBeGreaterThan(2_000);
  }, 120_000);

  it("keeps explicit profile unbinds unassigned and unable to reclaim their factory key", () => {
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const platform of TEST_PLATFORMS) {
        useDAWStore.setState({ keyboardShortcutProfileId: profile.id, customShortcuts: {} });
        for (const [actionId] of Object.entries(profile.bindings)) {
          const configured = getProfileActionBindings(profile.id, actionId, platform);
          if (configured === undefined || configured.length > 0) continue;
          const action = getRegisteredAction(actionId);
          expect(action, `${profile.id}: missing ${actionId}`).toBeDefined();
          if (!action) continue;
          expect(getEffectiveActionShortcuts(action, platform), `${profile.id}/${platform}/${actionId}`).toEqual([]);
          for (const factoryBinding of [action.shortcut, ...(action.shortcutAliases ?? [])]) {
            if (!factoryBinding || factoryBinding.includes("(")) continue;
            let event: SyntheticGlobalShortcutPayload;
            try {
              event = eventForBinding(factoryBinding, platform);
            } catch {
              continue;
            }
            for (const scope of getActionShortcutScopes(action, profile.id)) {
              resetShortcutContextForTests();
              activateShortcutContext(contextForScope(scope));
              const resolved = resolveRegistryShortcutAction(event, platform);
              expect(
                resolved?.action.id,
                `${profile.id}/${platform}/${scope}: ${actionId} leaked through ${factoryBinding}`,
              ).not.toBe(actionId);
              const executed: string[] = [];
              dispatchGlobalShortcut(event, platform, {
                executeAction: (matched) => executed.push(matched.id),
              });
              expect(
                executed,
                `${profile.id}/${platform}/${scope}: dispatched unbound ${actionId}`,
              ).not.toContain(actionId);
            }
          }
        }
      }
    }
  }, 30_000);

  it("makes every registered action custom-bindable in every declared scope on both platforms", () => {
    let verifiedRoutes = 0;
    for (const platform of TEST_PLATFORMS) {
      const binding = platform === "macos"
        ? "Command+Shift+F11"
        : "Control+Shift+F11";
      const event: SyntheticGlobalShortcutPayload = {
        key: "F11",
        code: "F11",
        shiftKey: true,
        metaKey: platform === "macos",
        ctrlKey: platform === "windows",
        source: "custom-bindability-matrix",
      };

      for (const action of getRegisteredActions()) {
        useDAWStore.setState({
          keyboardShortcutProfileId: "openstudio",
          customShortcuts: { [action.id]: binding },
        });
        activateCondition(action);
        expect(getEffectiveActionShortcuts(action, platform), `${platform}/${action.id}`)
          .toEqual([binding]);

        for (const scope of getActionShortcutScopes(action)) {
          resetShortcutContextForTests();
          activateShortcutContext(contextForScope(scope));
          const controlledAvailability = (candidate: ActionDef) => candidate.id === action.id;
          expect(resolveRegistryShortcutAction(event, platform, {
            canHandleAction: controlledAvailability,
          })?.action.id, `${platform}/${scope}/${action.id}`).toBe(action.id);

          const executed: string[] = [];
          const preventDefault = vi.fn();
          expect(dispatchGlobalShortcut(
            { ...event, preventDefault },
            platform,
            {
              canHandleAction: controlledAvailability,
              executeAction: (candidate) => executed.push(candidate.id),
            },
          ), `${platform}/${scope}/${action.id}`).toBe(true);
          expect(preventDefault, `${platform}/${scope}/${action.id}`).toHaveBeenCalled();
          expect(executed, `${platform}/${scope}/${action.id}`).toSatisfy(
            (ids: string[]) => ids.length === 0
              || (ids.length === 1 && ids[0] === action.id),
          );
          verifiedRoutes += 1;
        }
      }
    }

    expect(verifiedRoutes).toBeGreaterThan(700);
  }, 120_000);

  it("gives an active surface action precedence over a same-key global action", () => {
    const split = getRegisteredAction("edit.splitAtCursor");
    const play = getRegisteredAction("transport.play");
    expect(split).toBeDefined();
    expect(play).toBeDefined();
    const track = createDefaultTrack("precedence-track", "Precedence", "#123456", "audio", []);
    track.clips = [{
      id: "precedence-clip",
      filePath: "C:/precedence.wav",
      name: "Precedence",
      startTime: 0,
      duration: 2,
      offset: 0,
      color: "#123456",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
    }];
    useDAWStore.setState((state) => ({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {
        "edit.splitAtCursor": "Code:KeyK",
        "transport.play": "Code:KeyK",
      },
      tracks: [track],
      selectedClipId: "precedence-clip",
      selectedClipIds: ["precedence-clip"],
      globalLocked: false,
      lockSettings: { ...state.lockSettings, items: false },
      transport: { ...state.transport, currentTime: 1 },
    }));
    const event = { key: "k", code: "KeyK", source: "precedence-test" };

    activateShortcutContext({ kind: "timeline" });
    expect(resolveRegistryShortcutAction(event, "windows")?.action.id).toBe("edit.splitAtCursor");

    activateShortcutContext({ kind: "application" });
    expect(resolveRegistryShortcutAction(event, "windows")?.action.id).toBe("transport.play");
  });

  it("skips an unavailable same-scope owner and dispatches the next valid match", () => {
    const track = createDefaultTrack("fallback-track", "Fallback", "#654321", "audio", []);
    track.clips = [{
      id: "fallback-clip",
      filePath: "C:/fallback.wav",
      name: "Fallback",
      startTime: 0,
      duration: 2,
      offset: 0,
      color: "#654321",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
    }];
    useDAWStore.setState((state) => ({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: {
        "edit.cut": "Code:KeyK",
        "edit.splitAtCursor": "Code:KeyK",
      },
      tracks: [track],
      selectedClipId: null,
      selectedClipIds: [],
      globalLocked: false,
      lockSettings: { ...state.lockSettings, items: false },
      transport: { ...state.transport, currentTime: 1 },
    }));
    activateShortcutContext({ kind: "timeline" });
    const event = { key: "k", code: "KeyK", source: "can-handle-fallback" };
    expect(resolveRegistryShortcutAction(event, "windows")?.action.id).toBe("edit.splitAtCursor");

    const executed: string[] = [];
    expect(dispatchGlobalShortcut(event, "windows", {
      executeAction: (action) => executed.push(action.id),
    })).toBe(true);
    expect(executed).toEqual(["edit.splitAtCursor"]);
  });

  it("retains active component-handler precedence over registry actions", () => {
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      customShortcuts: { "edit.splitAtCursor": "Code:KeyK" },
    });
    const surfaceHandler = vi.fn(() => "handled" as const);
    registerShortcutSurface({ kind: "timeline" }, surfaceHandler);
    activateShortcutContext({ kind: "timeline" });
    const executed: string[] = [];

    expect(dispatchGlobalShortcut(
      { key: "k", code: "KeyK", source: "component-precedence" },
      "windows",
      { executeAction: (action) => executed.push(action.id) },
    )).toBe(true);
    expect(surfaceHandler).toHaveBeenCalledOnce();
    expect(executed).toEqual([]);
  });

  it("reaches every wheel rule and checks every surface, subtarget, device, modifier, and platform", () => {
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const platform of TEST_PLATFORMS) {
        const behavior = getMouseBehaviorProfile(profile.id, platform);
        const rules = behavior.wheel.rules;
        const ids = rules.map((rule) => rule.id);
        expect(new Set(ids).size, `${profile.id}/${platform}: duplicate wheel rule ID`).toBe(ids.length);
        const reached = new Set<string>();

        for (const surface of WHEEL_SURFACES) {
          for (const subtarget of WHEEL_SUBTARGETS) {
            for (const device of WHEEL_DEVICES) {
              for (const event of rawWheelModifierCombinations(platform)) {
                const matches = rules.filter((rule) => ruleMatches(
                  rule,
                  surface,
                  subtarget,
                  event,
                  platform,
                  device,
                ));
                const expected = matches[0];
                const resolved = resolveWheelGesture(event, {
                  surface,
                  subtarget,
                  platform,
                  deviceHint: device,
                  hoveredTargetId: "exhaustive-target",
                }, behavior.wheel);

                expect(
                  resolved.ruleId,
                  `${profile.id}/${platform}/${surface}/${subtarget}/${device}`,
                ).toBe(expected?.id ?? null);
                if (!expected) {
                  expect(resolved).toMatchObject({
                    matched: false,
                    operation: "native-scroll",
                    target: "native",
                    preventDefault: false,
                    stopPropagation: false,
                  });
                  continue;
                }

                reached.add(expected.id);
                expect(resolved).toMatchObject({
                  profileId: behavior.wheel.id,
                  matched: true,
                  operation: expected.operation,
                  target: expected.target,
                  preventDefault: expected.preventDefault,
                  stopPropagation: expected.stopPropagation,
                  precision: expected.precision ?? "normal",
                  anchor: {
                    kind: expected.anchor ?? "none",
                  },
                });
              }
            }
          }
        }

        expect(
          [...reached].sort(),
          `${profile.id}/${platform}: shadowed or unreachable wheel rule`,
        ).toEqual([...ids].sort());
      }
    }
  }, 120_000);

  it("resolves all 16 pointer combinations in every context without vendor fallthrough", () => {
    const combinations = pointerModifierCombinations();
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const platform of TEST_PLATFORMS) {
        const behavior = getMouseBehaviorProfile(profile.id, platform);
        for (const context of MOUSE_MODIFIER_CONTEXTS) {
          const mapping = behavior.modifiers.mappings[context] as Readonly<Record<string, unknown>>;
          for (const { combination } of combinations) {
            const resolved = resolveMouseModifier(
              rawPointerEvent(combination, platform),
              context,
              { platform, profile: behavior.modifiers },
            );
            expect(resolved.profileId).toBe(profile.id);
            expect(resolved.context).toBe(context);
            expect(resolved.modifiers.combination).toBe(combination);
            expect(resolved.isNoop).toBe(resolved.action === "none");
            if (profile.id !== "openstudio") {
              expect(
                Object.prototype.hasOwnProperty.call(mapping, combination),
                `${profile.id}/${platform}/${context}/${combination}: implicit vendor fallback`,
              ).toBe(true);
              expect(resolved).toMatchObject({
                source: "profile",
                matchKind: "exact",
                matchedCombination: combination,
                matched: true,
              });
            }
          }
        }
      }
    }
  });
});
