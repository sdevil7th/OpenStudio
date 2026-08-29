import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDAWStore } from "../store/useDAWStore";
import {
  CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY,
  MAX_CUSTOM_KEYBOARD_PROFILES,
  MAX_CUSTOM_SHORTCUT_ACTIONS_PER_PROFILE,
  MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET,
  parsePersistedCustomKeyboardProfiles,
  type CustomKeyboardShortcutProfile,
  type CustomShortcutMap,
} from "../utils/customShortcutProfiles";

const INPUT_PROFILE_SETTINGS_KEY = "openstudio.inputProfiles.v1";

describe("custom keyboard profile store", () => {
  let storage: Storage;
  let previousState: Pick<
    ReturnType<typeof useDAWStore.getState>,
    | "customShortcuts"
    | "customKeyboardProfiles"
    | "activeCustomKeyboardProfileId"
    | "keyboardShortcutProfileId"
    | "mouseBehaviorProfileId"
    | "inputProfileOnboardingSeen"
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
      customShortcuts: state.customShortcuts,
      customKeyboardProfiles: state.customKeyboardProfiles,
      activeCustomKeyboardProfileId: state.activeCustomKeyboardProfileId,
      keyboardShortcutProfileId: state.keyboardShortcutProfileId,
      mouseBehaviorProfileId: state.mouseBehaviorProfileId,
      inputProfileOnboardingSeen: state.inputProfileOnboardingSeen,
    };
    useDAWStore.setState({
      customShortcuts: {},
      customKeyboardProfiles: [],
      activeCustomKeyboardProfileId: null,
      keyboardShortcutProfileId: "reaper",
      mouseBehaviorProfileId: "logic_pro",
      inputProfileOnboardingSeen: true,
    });
  });

  afterEach(() => {
    useDAWStore.setState(previousState);
    vi.unstubAllGlobals();
  });

  it("creates a named overlay automatically and persists multi-platform binding lists", () => {
    const state = useDAWStore.getState();
    state.setCustomShortcutBindings("transport.record", ["Ctrl+R", "F12"], "common");
    useDAWStore.getState().setCustomShortcutBindings("transport.record", [], "windows");

    const updated = useDAWStore.getState();
    expect(updated.activeCustomKeyboardProfileId).toBeTruthy();
    expect(updated.customShortcuts["transport.record"]).toEqual({
      common: ["Ctrl+R", "F12"],
      windows: [],
    });
    const persisted = JSON.parse(storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY) ?? "{}");
    expect(persisted).toMatchObject({
      schemaVersion: 2,
      activeProfileId: updated.activeCustomKeyboardProfileId,
      profiles: [{
        baseProfileId: "reaper",
        bindings: updated.customShortcuts,
      }],
    });
  });

  it("creates, duplicates independently, renames uniquely, activates, and deletes profiles", () => {
    const firstId = useDAWStore.getState().createCustomKeyboardProfile("Editing");
    useDAWStore.getState().addCustomShortcutBinding("edit.copy", "Ctrl+C");
    const copyId = useDAWStore.getState().duplicateKeyboardProfile("Editing");
    expect(firstId).toBeTruthy();
    expect(copyId).toBeTruthy();
    if (!firstId || !copyId) return;
    useDAWStore.getState().addCustomShortcutBinding("edit.copy", "F8");

    const profiles = useDAWStore.getState().customKeyboardProfiles;
    expect(profiles.find((profile) => profile.id === firstId)?.name).toBe("Editing");
    expect(profiles.find((profile) => profile.id === copyId)?.name).toBe("Editing 2");
    expect(profiles.find((profile) => profile.id === firstId)?.bindings["edit.copy"])
      .toEqual({ common: ["Ctrl+C"] });
    expect(profiles.find((profile) => profile.id === copyId)?.bindings["edit.copy"])
      .toEqual({ common: ["Ctrl+C", "F8"] });

    expect(useDAWStore.getState().renameCustomKeyboardProfile(copyId, "Keys")).toBe(true);
    expect(useDAWStore.getState().activateCustomKeyboardProfile(firstId)).toBe(true);
    expect(useDAWStore.getState().customShortcuts["edit.copy"]).toEqual({ common: ["Ctrl+C"] });
    expect(useDAWStore.getState().deleteCustomKeyboardProfile(firstId)).toBe(true);
    expect(useDAWStore.getState().activeCustomKeyboardProfileId).toBeNull();
    expect(useDAWStore.getState().customShortcuts).toEqual({});
  });

  it("switches from a custom overlay to a built-in keyboard profile as one transaction", () => {
    const profileId = useDAWStore.getState().createCustomKeyboardProfile("Editing", "cubase");
    expect(profileId).toBeTruthy();
    useDAWStore.getState().addCustomShortcutBinding("edit.copy", "F8");

    useDAWStore.getState().setKeyboardShortcutProfile("pro_tools");

    expect(useDAWStore.getState()).toMatchObject({
      keyboardShortcutProfileId: "pro_tools",
      activeCustomKeyboardProfileId: null,
      customShortcuts: {},
    });
    expect(JSON.parse(storage.getItem(INPUT_PROFILE_SETTINGS_KEY) ?? "{}")).toMatchObject({
      schemaVersion: 1,
      keyboardProfileId: "pro_tools",
    });
    expect(JSON.parse(storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY) ?? "{}")).toMatchObject({
      schemaVersion: 2,
      activeProfileId: null,
    });
  });

  it("exports and imports a validated profile with a fresh ID and preserves independent mouse choice", () => {
    const originalId = useDAWStore.getState().createCustomKeyboardProfile("Portable", "cubase");
    useDAWStore.getState().setCustomShortcutBindings("edit.copy", ["Ctrl+C", "F6"], "macos");
    const serialized = useDAWStore.getState().exportActiveCustomKeyboardProfile();
    expect(serialized).toContain("openstudio-keyboard-profile");

    const result = useDAWStore.getState().importCustomKeyboardProfile(
      serialized ?? "",
      ["edit.copy"],
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.profile.id).not.toBe(originalId);
    expect(useDAWStore.getState()).toMatchObject({
      activeCustomKeyboardProfileId: result.profile.id,
      keyboardShortcutProfileId: "cubase",
      mouseBehaviorProfileId: "logic_pro",
    });
  });

  it("keeps explicit unbind compatibility for the legacy setter", () => {
    useDAWStore.getState().setCustomShortcut("transport.loop", "");
    expect(useDAWStore.getState().customShortcuts["transport.loop"])
      .toEqual({ common: [] });
  });

  it("keeps deduplicated profile names unique at the 64-character boundary", () => {
    const longName = "A".repeat(64);
    const firstId = useDAWStore.getState().createCustomKeyboardProfile(longName);
    const secondId = useDAWStore.getState().createCustomKeyboardProfile(longName);
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    const names = useDAWStore.getState().customKeyboardProfiles.map((profile) => profile.name);
    expect(names).toEqual([longName, `${"A".repeat(62)} 2`]);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name.length <= 64)).toBe(true);
  });

  it("keeps profile growth within the persisted collection limit", () => {
    const profiles: CustomKeyboardShortcutProfile[] = Array.from(
      { length: MAX_CUSTOM_KEYBOARD_PROFILES },
      (_, index) => ({
        id: `custom-cap-${index}`,
        name: `Profile ${index}`,
        baseProfileId: "reaper",
        bindings: {},
        createdAt: index,
        updatedAt: index,
      }),
    );
    useDAWStore.setState({
      customKeyboardProfiles: profiles,
      activeCustomKeyboardProfileId: null,
      customShortcuts: {},
    });
    storage.setItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY, JSON.stringify({
      schemaVersion: 2,
      activeProfileId: null,
      profiles,
    }));
    const rawBeforeRejectedGrowth = storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY);

    expect(useDAWStore.getState().createCustomKeyboardProfile("Too many")).toBeNull();
    expect(useDAWStore.getState().duplicateKeyboardProfile()).toBeNull();
    useDAWStore.getState().addCustomShortcutBinding("edit.copy", "F1");
    expect(useDAWStore.getState().customKeyboardProfiles).toHaveLength(MAX_CUSTOM_KEYBOARD_PROFILES);
    expect(useDAWStore.getState().customShortcuts).toEqual({});

    const imported = useDAWStore.getState().importCustomKeyboardProfile(JSON.stringify({
      schemaVersion: 2,
      type: "openstudio-keyboard-profile",
      profile: {
        ...profiles[0],
        id: "custom-import-source",
        name: "Import source",
      },
    }));
    expect(imported).toMatchObject({ success: false });
    expect(useDAWStore.getState()).toMatchObject({
      keyboardShortcutProfileId: "reaper",
      mouseBehaviorProfileId: "logic_pro",
      activeCustomKeyboardProfileId: null,
    });
    expect(storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY)).toBe(rawBeforeRejectedGrowth);

    expect(useDAWStore.getState().deleteCustomKeyboardProfile(profiles[0].id)).toBe(true);
    expect(useDAWStore.getState().createCustomKeyboardProfile("Allowed again")).toBeTruthy();
    expect(useDAWStore.getState().customKeyboardProfiles).toHaveLength(MAX_CUSTOM_KEYBOARD_PROFILES);
  });

  it("rejects binding and action growth that could not be loaded next launch", () => {
    const profileId = useDAWStore.getState().createCustomKeyboardProfile("Bounded");
    expect(profileId).toBeTruthy();
    const bindingsAtLimit = Array.from(
      { length: MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET },
      (_, index) => `F${index + 1}`,
    );
    useDAWStore.getState().setCustomShortcutBindings("edit.copy", bindingsAtLimit);
    useDAWStore.getState().addCustomShortcutBinding("edit.copy", "F13");
    expect(useDAWStore.getState().customShortcuts["edit.copy"])
      .toEqual({ common: bindingsAtLimit });
    useDAWStore.getState().addCustomShortcutBinding("edit.copy", "F1");
    expect(useDAWStore.getState().customShortcuts["edit.copy"])
      .toEqual({ common: bindingsAtLimit });
    useDAWStore.getState().setCustomShortcutBindings("edit.copy", ["F13"], "windows");
    expect(useDAWStore.getState().customShortcuts["edit.copy"])
      .toEqual({ common: bindingsAtLimit, windows: ["F13"] });
    useDAWStore.getState().setCustomShortcutBindings(
      "edit.copy",
      [...bindingsAtLimit, "F13"],
    );
    expect(useDAWStore.getState().customShortcuts["edit.copy"])
      .toEqual({ common: bindingsAtLimit, windows: ["F13"] });

    const actionsAtLimit = Object.fromEntries(Array.from(
      { length: MAX_CUSTOM_SHORTCUT_ACTIONS_PER_PROFILE },
      (_, index) => [`custom.action.${index}`, { common: ["F1"] }],
    )) as CustomShortcutMap;
    const active = useDAWStore.getState().customKeyboardProfiles.find(
      (profile) => profile.id === profileId,
    );
    expect(active).toBeTruthy();
    useDAWStore.setState({
      customShortcuts: actionsAtLimit,
      customKeyboardProfiles: useDAWStore.getState().customKeyboardProfiles.map((profile) => (
        profile.id === profileId ? { ...profile, bindings: actionsAtLimit } : profile
      )),
    });
    useDAWStore.getState().setCustomShortcut("custom.action.0", "F2");
    useDAWStore.getState().setCustomShortcut("custom.action.overflow", "F2");
    expect(Object.keys(useDAWStore.getState().customShortcuts))
      .toHaveLength(MAX_CUSTOM_SHORTCUT_ACTIONS_PER_PROFILE);

    const persisted = JSON.parse(storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY) ?? "null");
    expect(parsePersistedCustomKeyboardProfiles(persisted)).not.toBeNull();
  });

  it("keeps profile state atomic when local storage rejects a write", () => {
    const profileId = useDAWStore.getState().createCustomKeyboardProfile("Durable");
    expect(profileId).toBeTruthy();
    useDAWStore.getState().setCustomShortcutBindings("edit.copy", ["Ctrl+C"]);
    const serialized = useDAWStore.getState().exportActiveCustomKeyboardProfile();
    expect(serialized).toBeTruthy();

    const before = useDAWStore.getState();
    const profilesBefore = before.customKeyboardProfiles;
    const shortcutsBefore = before.customShortcuts;
    const activeBefore = before.activeCustomKeyboardProfileId;
    const keyboardBefore = before.keyboardShortcutProfileId;
    const persistedInputBefore = storage.getItem(INPUT_PROFILE_SETTINGS_KEY);
    const persistedBefore = storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    useDAWStore.getState().addCustomShortcutBinding("edit.paste", "F9");
    expect(useDAWStore.getState().createCustomKeyboardProfile("Rejected")).toBeNull();
    expect(useDAWStore.getState().duplicateKeyboardProfile("Rejected copy")).toBeNull();
    expect(useDAWStore.getState().renameCustomKeyboardProfile(profileId!, "Rejected rename")).toBe(false);
    expect(useDAWStore.getState().deleteCustomKeyboardProfile(profileId!)).toBe(false);
    expect(useDAWStore.getState().activateCustomKeyboardProfile(null)).toBe(false);
    const imported = useDAWStore.getState().importCustomKeyboardProfile(serialized ?? "");

    expect(imported).toMatchObject({ success: false });
    expect(useDAWStore.getState()).toMatchObject({
      customKeyboardProfiles: profilesBefore,
      customShortcuts: shortcutsBefore,
      activeCustomKeyboardProfileId: activeBefore,
      keyboardShortcutProfileId: keyboardBefore,
    });
    expect(useDAWStore.getState().customKeyboardProfiles).toBe(profilesBefore);
    expect(useDAWStore.getState().customShortcuts).toBe(shortcutsBefore);
    expect(storage.getItem(INPUT_PROFILE_SETTINGS_KEY)).toBe(persistedInputBefore);
    expect(storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY)).toBe(persistedBefore);
  });

  it("rolls back both persistence records when the second profile write exceeds quota", () => {
    const firstId = useDAWStore.getState().createCustomKeyboardProfile("First", "cubase");
    const secondId = useDAWStore.getState().createCustomKeyboardProfile("Second", "reaper");
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    if (!firstId || !secondId) return;
    expect(useDAWStore.getState().activateCustomKeyboardProfile(firstId)).toBe(true);
    const serialized = useDAWStore.getState().exportActiveCustomKeyboardProfile();
    expect(serialized).toBeTruthy();

    const attempts: Array<{
      name: string;
      invoke: () => unknown;
      assertRejected: (result: unknown) => void;
    }> = [
      {
        name: "create",
        invoke: () => useDAWStore.getState().createCustomKeyboardProfile("Rejected create"),
        assertRejected: (result) => expect(result).toBeNull(),
      },
      {
        name: "duplicate",
        invoke: () => useDAWStore.getState().duplicateKeyboardProfile("Rejected duplicate"),
        assertRejected: (result) => expect(result).toBeNull(),
      },
      {
        name: "activate",
        invoke: () => useDAWStore.getState().activateCustomKeyboardProfile(secondId),
        assertRejected: (result) => expect(result).toBe(false),
      },
      {
        name: "deactivate",
        invoke: () => useDAWStore.getState().activateCustomKeyboardProfile(null),
        assertRejected: (result) => expect(result).toBe(false),
      },
      {
        name: "select built-in",
        invoke: () => useDAWStore.getState().setKeyboardShortcutProfile("pro_tools"),
        assertRejected: (result) => expect(result).toBeUndefined(),
      },
      {
        name: "delete active",
        invoke: () => useDAWStore.getState().deleteCustomKeyboardProfile(firstId),
        assertRejected: (result) => expect(result).toBe(false),
      },
      {
        name: "import",
        invoke: () => useDAWStore.getState().importCustomKeyboardProfile(serialized ?? ""),
        assertRejected: (result) => expect(result).toMatchObject({ success: false }),
      },
    ];

    for (const attempt of attempts) {
      const before = useDAWStore.getState();
      const profilesBefore = before.customKeyboardProfiles;
      const shortcutsBefore = before.customShortcuts;
      const activeBefore = before.activeCustomKeyboardProfileId;
      const keyboardBefore = before.keyboardShortcutProfileId;
      const persistedInputBefore = storage.getItem(INPUT_PROFILE_SETTINGS_KEY);
      const persistedProfilesBefore = storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY);
      const realSetItem = storage.setItem.bind(storage);
      const setItemSpy = vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
        if (key === CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY) {
          throw new DOMException(`${attempt.name} quota exceeded`, "QuotaExceededError");
        }
        realSetItem(key, value);
      });

      const result = attempt.invoke();
      attempt.assertRejected(result);
      setItemSpy.mockRestore();

      expect(useDAWStore.getState().customKeyboardProfiles).toBe(profilesBefore);
      expect(useDAWStore.getState().customShortcuts).toBe(shortcutsBefore);
      expect(useDAWStore.getState()).toMatchObject({
        activeCustomKeyboardProfileId: activeBefore,
        keyboardShortcutProfileId: keyboardBefore,
      });
      expect(storage.getItem(INPUT_PROFILE_SETTINGS_KEY)).toBe(persistedInputBefore);
      expect(storage.getItem(CUSTOM_KEYBOARD_PROFILE_STORAGE_KEY)).toBe(persistedProfilesBefore);
    }
  });
});
