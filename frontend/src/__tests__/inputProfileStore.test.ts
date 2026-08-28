import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDAWStore } from "../store/useDAWStore";
import {
  MOUSE_MODIFIER_OVERRIDES_STORAGE_KEY,
  loadStoredMouseModifierOverrides,
  parsePersistedMouseModifierOverrides,
} from "../utils/mouseModifierPersistence";

const SETTINGS_KEY = "openstudio.inputProfiles.v1";

describe("input profile persistence", () => {
  let storage: Storage;
  let previousState: Pick<
    ReturnType<typeof useDAWStore.getState>,
    | "keyboardShortcutProfileId"
    | "mouseBehaviorProfileId"
    | "inputProfileOnboardingSeen"
    | "mouseModifiers"
  >;

  beforeEach(() => {
    const values = new Map<string, string>();
    storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    vi.stubGlobal("localStorage", storage);
    const state = useDAWStore.getState();
    previousState = {
      keyboardShortcutProfileId: state.keyboardShortcutProfileId,
      mouseBehaviorProfileId: state.mouseBehaviorProfileId,
      inputProfileOnboardingSeen: state.inputProfileOnboardingSeen,
      mouseModifiers: state.mouseModifiers,
    };
    storage.removeItem(SETTINGS_KEY);
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      mouseBehaviorProfileId: "openstudio",
      inputProfileOnboardingSeen: false,
      mouseModifiers: {},
    });
  });

  afterEach(() => {
    useDAWStore.setState(previousState);
    storage.removeItem(SETTINGS_KEY);
    vi.unstubAllGlobals();
  });

  it("persists keyboard and mouse profiles independently with a schema version", () => {
    useDAWStore.getState().setKeyboardShortcutProfile("reaper");
    useDAWStore.getState().setMouseBehaviorProfile("logic_pro");

    expect(useDAWStore.getState().keyboardShortcutProfileId).toBe("reaper");
    expect(useDAWStore.getState().mouseBehaviorProfileId).toBe("logic_pro");
    expect(JSON.parse(storage.getItem(SETTINGS_KEY) ?? "{}")).toMatchObject({
      schemaVersion: 1,
      keyboardProfileId: "reaper",
      mouseProfileId: "logic_pro",
      onboardingSeen: false,
    });
  });

  it("records completion of the first-run profile prompt", () => {
    useDAWStore.getState().markInputProfileOnboardingSeen();
    expect(useDAWStore.getState().inputProfileOnboardingSeen).toBe(true);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY) ?? "{}").onboardingSeen).toBe(true);
  });

  it("rejects invalid profile IDs received from untrusted persisted/UI data", () => {
    useDAWStore.getState().setKeyboardShortcutProfile("deleted-profile" as never);
    useDAWStore.getState().setMouseBehaviorProfile("deleted-profile" as never);
    expect(useDAWStore.getState().keyboardShortcutProfileId).toBe("openstudio");
    expect(useDAWStore.getState().mouseBehaviorProfileId).toBe("openstudio");
  });

  it("persists validated mouse overrides and resets them durably", () => {
    useDAWStore.getState().setMouseModifier("clip_drag", "ctrl", "copy");
    useDAWStore.getState().setMouseModifier("timeline_click", "alt", "razor");

    expect(useDAWStore.getState().mouseModifiers).toEqual({
      clip_drag: { primary: "copy" },
      timeline_click: { alt: "razor" },
    });
    const persisted = JSON.parse(
      storage.getItem(MOUSE_MODIFIER_OVERRIDES_STORAGE_KEY) ?? "null",
    );
    expect(parsePersistedMouseModifierOverrides(persisted)?.overrides)
      .toEqual(useDAWStore.getState().mouseModifiers);
    expect(loadStoredMouseModifierOverrides(storage))
      .toEqual(useDAWStore.getState().mouseModifiers);

    useDAWStore.getState().resetMouseModifiers();
    expect(useDAWStore.getState().mouseModifiers).toEqual({});
    expect(loadStoredMouseModifierOverrides(storage)).toEqual({});
  });

  it("rejects malformed mouse overrides and keeps state atomic on storage failure", () => {
    useDAWStore.getState().setMouseModifier("clip_drag", "primary", "copy");
    const overridesBefore = useDAWStore.getState().mouseModifiers;
    const persistedBefore = storage.getItem(MOUSE_MODIFIER_OVERRIDES_STORAGE_KEY);

    useDAWStore.getState().setMouseModifier("clip_drag", "primary", "not-an-action");
    expect(useDAWStore.getState().mouseModifiers).toBe(overridesBefore);

    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    useDAWStore.getState().setMouseModifier("clip_drag", "shift", "constrain");
    useDAWStore.getState().resetMouseModifiers();

    expect(useDAWStore.getState().mouseModifiers).toBe(overridesBefore);
    expect(storage.getItem(MOUSE_MODIFIER_OVERRIDES_STORAGE_KEY)).toBe(persistedBefore);
    expect(loadStoredMouseModifierOverrides({
      getItem: () => JSON.stringify({
        schemaVersion: 1,
        overrides: { clip_drag: { primary: "delete" } },
      }),
    })).toEqual({});
  });
});
