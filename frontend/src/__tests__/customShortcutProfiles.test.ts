import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
  MAX_CUSTOM_KEYBOARD_PROFILES,
  MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET,
  exportCustomKeyboardProfile,
  getCustomShortcutTargetBindings,
  hasCustomShortcutOverride,
  migrateLegacyCustomShortcuts,
  parseImportedCustomKeyboardProfile,
  parsePersistedCustomKeyboardProfiles,
  removeCustomShortcutTarget,
  resolveCustomShortcutBindings,
  setCustomShortcutTargetBindings,
  type CustomKeyboardShortcutProfile,
  type CustomShortcutMap,
} from "../utils/customShortcutProfiles";

describe("custom keyboard shortcut profiles", () => {
  it("migrates legacy single-string bindings and preserves explicit unbinds", () => {
    const migrated = migrateLegacyCustomShortcuts({
      "transport.record": "Ctrl+R",
      "transport.loop": "",
      "invalid action id!": "Ctrl+X",
    }, "reaper", 123);

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      activeProfileId: "custom-migrated-shortcuts",
      profiles: [{
        name: "My Shortcuts",
        baseProfileId: "reaper",
        createdAt: 123,
        bindings: {
          "transport.record": { common: ["Ctrl+R"] },
          "transport.loop": { common: [] },
        },
      }],
    });
  });

  it("resolves platform lists before common and distinguishes missing from empty", () => {
    const bindings: CustomShortcutMap = {
      "transport.record": {
        common: ["Ctrl+R", "F12"],
        macos: ["Command+Code:KeyR"],
        windows: [],
      },
      "transport.loop": { macos: [] },
    };

    expect(resolveCustomShortcutBindings(bindings, "transport.record", "macos"))
      .toEqual(["Command+Code:KeyR"]);
    expect(resolveCustomShortcutBindings(bindings, "transport.record", "windows")).toEqual([]);
    expect(resolveCustomShortcutBindings(bindings, "transport.record", "linux"))
      .toEqual(["Ctrl+R", "F12"]);
    expect(resolveCustomShortcutBindings(bindings, "transport.record", "other"))
      .toEqual(["Ctrl+R", "F12"]);
    expect(resolveCustomShortcutBindings(bindings, "transport.loop", "windows")).toBeUndefined();
    expect(resolveCustomShortcutBindings(bindings, "transport.loop", "macos")).toEqual([]);
    expect(hasCustomShortcutOverride(bindings, "transport.loop", "windows")).toBe(false);
    expect(hasCustomShortcutOverride(bindings, "transport.loop", "macos")).toBe(true);
  });

  it("adds, normalizes, removes, and explicitly empties one target without disturbing others", () => {
    let bindings = setCustomShortcutTargetBindings({}, "edit.copy", "common", ["ctrl+c", "Ctrl+C"]);
    bindings = setCustomShortcutTargetBindings(bindings, "edit.copy", "macos", ["Command+Code:KeyC"]);
    expect(getCustomShortcutTargetBindings(bindings["edit.copy"], "common")).toEqual(["Ctrl+C"]);
    expect(getCustomShortcutTargetBindings(bindings["edit.copy"], "macos"))
      .toEqual(["Command+Code:KeyC"]);

    bindings = setCustomShortcutTargetBindings(bindings, "edit.copy", "macos", []);
    expect(resolveCustomShortcutBindings(bindings, "edit.copy", "macos")).toEqual([]);
    bindings = removeCustomShortcutTarget(bindings, "edit.copy", "macos");
    expect(resolveCustomShortcutBindings(bindings, "edit.copy", "macos")).toEqual(["Ctrl+C"]);
    bindings = removeCustomShortcutTarget(bindings, "edit.copy");
    expect(bindings).toEqual({});
  });

  it("round-trips a versioned export and assigns imports a new local identity", () => {
    vi.spyOn(Date, "now").mockReturnValue(999);
    const profile: CustomKeyboardShortcutProfile = {
      id: "custom-source",
      name: "Editing Keys",
      baseProfileId: "cubase",
      bindings: {
        "edit.splitAtCursor": {
          common: ["Ctrl+E", "Code:KeyS"],
          windows: [],
        },
      },
      createdAt: 10,
      updatedAt: 20,
    };
    const parsed = parseImportedCustomKeyboardProfile(
      exportCustomKeyboardProfile(profile),
      new Set(["edit.splitAtCursor"]),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.profile.id).not.toBe(profile.id);
    expect(parsed.profile).toMatchObject({
      name: "Editing Keys",
      baseProfileId: "cubase",
      createdAt: 999,
      updatedAt: 999,
      bindings: profile.bindings,
    });
    vi.restoreAllMocks();
  });

  it("rejects malformed, unsupported, unknown-action, and invalid-key imports", () => {
    const envelope = (bindings: unknown) => JSON.stringify({
      schemaVersion: CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
      type: "openstudio-keyboard-profile",
      profile: {
        id: "custom-import",
        name: "Imported",
        baseProfileId: "openstudio",
        bindings,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    expect(parseImportedCustomKeyboardProfile("not json")).toMatchObject({ success: false });
    expect(parseImportedCustomKeyboardProfile(JSON.stringify({ schemaVersion: 1 })))
      .toMatchObject({ success: false });
    expect(parseImportedCustomKeyboardProfile(
      envelope({ "unknown.action": { common: ["Ctrl+K"] } }),
      new Set(["known.action"]),
    )).toMatchObject({ success: false });
    expect(parseImportedCustomKeyboardProfile(
      envelope({ "known.action": { common: ["Ctrl+"] } }),
      new Set(["known.action"]),
    )).toMatchObject({ success: false });
  });

  it("rejects corrupted persisted collections without selecting dangling IDs", () => {
    expect(parsePersistedCustomKeyboardProfiles({
      schemaVersion: 2,
      activeProfileId: "missing",
      profiles: [],
    })).toEqual({
      schemaVersion: 2,
      activeProfileId: null,
      profiles: [],
    });
    expect(parsePersistedCustomKeyboardProfiles({
      schemaVersion: 2,
      activeProfileId: null,
      profiles: [{ id: "bad id with spaces" }],
    })).toBeNull();
  });

  it("accepts persisted collections at their limits and rejects values beyond them", () => {
    const profile = (index: number, bindings: CustomShortcutMap = {}): CustomKeyboardShortcutProfile => ({
      id: `custom-limit-${index}`,
      name: `Profile ${index}`,
      baseProfileId: "openstudio",
      bindings,
      createdAt: index,
      updatedAt: index,
    });
    const profiles = Array.from(
      { length: MAX_CUSTOM_KEYBOARD_PROFILES },
      (_, index) => profile(index),
    );
    expect(parsePersistedCustomKeyboardProfiles({
      schemaVersion: 2,
      activeProfileId: profiles[0].id,
      profiles,
    })?.profiles).toHaveLength(MAX_CUSTOM_KEYBOARD_PROFILES);
    expect(parsePersistedCustomKeyboardProfiles({
      schemaVersion: 2,
      activeProfileId: null,
      profiles: [...profiles, profile(MAX_CUSTOM_KEYBOARD_PROFILES)],
    })).toBeNull();

    const atLimit = Array.from(
      { length: MAX_CUSTOM_SHORTCUT_BINDINGS_PER_TARGET },
      (_, index) => `F${index + 1}`,
    );
    expect(parsePersistedCustomKeyboardProfiles({
      schemaVersion: 2,
      activeProfileId: "custom-bindings",
      profiles: [profile(0, { "edit.copy": { common: atLimit } })],
    })).not.toBeNull();
    expect(parsePersistedCustomKeyboardProfiles({
      schemaVersion: 2,
      activeProfileId: "custom-bindings",
      profiles: [profile(0, { "edit.copy": { common: [...atLimit, "F13"] } })],
    })).toBeNull();
  });
});
