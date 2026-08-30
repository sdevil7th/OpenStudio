import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultTrack,
  useDAWStore,
} from "../store/useDAWStore";
import {
  getActionShortcutScopes,
  getRegisteredActions,
  registerScopedActionExecutor,
} from "../store/actionRegistry";
import {
  dispatchGlobalShortcut,
  getEffectiveActionShortcuts,
  resolveRegistryShortcutAction,
  type GlobalShortcutPayload,
} from "../utils/globalShortcutDispatcher";
import {
  shortcutBindingEventSignature,
  type ShortcutPlatform,
} from "../utils/platform";
import {
  KEYBOARD_SHORTCUT_PROFILES,
  getProfileActionBindings,
  type KeyboardShortcutProfileId,
} from "../utils/shortcutProfiles";
import {
  activateShortcutContext,
  resetShortcutContextForTests,
  type EditShortcutContext,
} from "../utils/shortcutContext";

const TEST_PLATFORMS = ["macos", "windows"] as const satisfies readonly ShortcutPlatform[];

function dispatchAction(
  profileId: KeyboardShortcutProfileId,
  platform: ShortcutPlatform,
  context: EditShortcutContext,
  event: GlobalShortcutPayload,
): { handled: boolean; actionIds: string[]; prevented: boolean } {
  useDAWStore.setState({ keyboardShortcutProfileId: profileId, customShortcuts: {} });
  resetShortcutContextForTests();
  activateShortcutContext(context);
  const actionIds: string[] = [];
  const preventDefault = vi.fn();
  const handled = dispatchGlobalShortcut(
    { ...event, preventDefault },
    platform,
    { executeAction: (action) => actionIds.push(action.id) },
  );
  return { handled, actionIds, prevented: preventDefault.mock.calls.length > 0 };
}

describe("profile shortcut collision dispatch", () => {
  const scopedCleanups: Array<() => void> = [];
  const original = {
    keyboardShortcutProfileId: useDAWStore.getState().keyboardShortcutProfileId,
    customShortcuts: useDAWStore.getState().customShortcuts,
    tracks: useDAWStore.getState().tracks,
    selectedTrackId: useDAWStore.getState().selectedTrackId,
    selectedTrackIds: useDAWStore.getState().selectedTrackIds,
    selectedClipId: useDAWStore.getState().selectedClipId,
    selectedClipIds: useDAWStore.getState().selectedClipIds,
    transport: useDAWStore.getState().transport,
    stepInputEnabled: useDAWStore.getState().stepInputEnabled,
  };

  beforeEach(() => {
    const track = createDefaultTrack("profile-dispatch-track", "Profile Dispatch", "#14b8a6", "audio", []);
    track.clips = [{
      id: "profile-crossing-clip",
      filePath: "C:/profile/crossing.wav",
      name: "Crossing",
      startTime: 0,
      duration: 2,
      offset: 0,
      color: "#14b8a6",
      volumeDB: 0,
      fadeIn: 0,
      fadeOut: 0,
    }];
    useDAWStore.setState((state) => ({
      tracks: [track],
      selectedTrackId: track.id,
      selectedTrackIds: [track.id],
      selectedClipId: "profile-crossing-clip",
      selectedClipIds: ["profile-crossing-clip"],
      transport: { ...state.transport, currentTime: 1 },
      stepInputEnabled: false,
      customShortcuts: {},
    }));
    resetShortcutContextForTests();
  });

  afterEach(() => {
    scopedCleanups.splice(0).forEach((cleanup) => cleanup());
    resetShortcutContextForTests();
    useDAWStore.setState(original);
    vi.restoreAllMocks();
  });

  it.each(TEST_PLATFORMS)(
    "keeps FL Studio Backspace snap reachable above Piano Roll deletion on %s",
    (platform) => {
      scopedCleanups.push(registerScopedActionExecutor(
        { kind: "piano_roll", sessionId: "fl-collision" },
        (actionId) => actionId === "midi.deleteSelection" ? "handled" : "unmatched",
        ["midi.deleteSelection"],
      ));
      const backspace = dispatchAction(
        "fl_studio",
        platform,
        { kind: "piano_roll", sessionId: "fl-collision" },
        { key: "Backspace", code: "Backspace", source: "profile-collision-test" },
      );
      expect(getEffectiveActionShortcuts(
        getRegisteredActions().find((action) => action.id === "view.toggleSnap")!,
        platform,
      )).toEqual(["Backspace"]);
      expect(resolveRegistryShortcutAction(
        { key: "Backspace", code: "Backspace" },
        platform,
      )?.action.id).toBe("view.toggleSnap");
      expect(backspace).toEqual({
        handled: true,
        actionIds: ["view.toggleSnap"],
        prevented: true,
      });

      const deleteKey = dispatchAction(
        "fl_studio",
        platform,
        { kind: "piano_roll", sessionId: "fl-collision" },
        { key: "Delete", code: "Delete", source: "profile-collision-test" },
      );
      expect(deleteKey).toEqual({
        handled: true,
        actionIds: ["midi.deleteSelection"],
        prevented: true,
      });

      const automationBackspace = dispatchAction(
        "fl_studio",
        platform,
        { kind: "automation" },
        { key: "Backspace", code: "Backspace", source: "profile-collision-test" },
      );
      expect(automationBackspace.actionIds).toEqual(["view.toggleSnap"]);
    },
  );

  it.each([
    ["logic_pro", "macos"],
    ["logic_pro", "windows"],
    ["garageband", "macos"],
    ["garageband", "windows"],
    ["ableton_live", "macos"],
    ["ableton_live", "windows"],
  ] as const)("dispatches %s A to arrangement automation on %s", (profileId, platform) => {
    expect(dispatchAction(
      profileId,
      platform,
      { kind: "timeline" },
      { key: "a", code: "KeyA", source: "profile-collision-test" },
    )).toEqual({
      handled: true,
      actionIds: ["automation.toggleArrangementView"],
      prevented: true,
    });
  });

  it.each(TEST_PLATFORMS)(
    "does not let GarageBand's inherited timeline tools steal A/C/B/Y on %s",
    (platform) => {
      const modifier = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
      expect(dispatchAction(
        "garageband",
        platform,
        { kind: "timeline" },
        { key: "c", code: "KeyC", source: "profile-collision-test" },
      ).actionIds).toEqual(["transport.loop"]);
      expect(dispatchAction(
        "garageband",
        platform,
        { kind: "timeline" },
        { key: "b", code: "KeyB", source: "profile-collision-test" },
      ).actionIds).toEqual([]);
      expect(dispatchAction(
        "garageband",
        platform,
        { kind: "timeline" },
        { key: "y", code: "KeyY", source: "profile-collision-test" },
      ).actionIds).toEqual([]);

      // The explicit unbinds do not affect GarageBand's real split command.
      expect(dispatchAction(
        "garageband",
        platform,
        { kind: "timeline" },
        {
          key: "t",
          code: "KeyT",
          ...modifier,
          source: "profile-collision-test",
        },
      ).actionIds).toEqual(["edit.splitAtCursor"]);
    },
  );

  it.each([
    ["macos", { ctrlKey: true, metaKey: true }, "Control+Command"],
    ["windows", { ctrlKey: true, metaKey: true }, "Control+Meta"],
  ] as const)("dispatches Logic's exact automation modes on %s", (platform, modifiers, _bindingStyle) => {
    const selected = [
      ["o", "automation.selectedTracks.toggleOffRead"],
      ["a", "automation.selectedTracks.toggleLatchRead"],
    ] as const;
    for (const [key, actionId] of selected) {
      expect(dispatchAction(
        "logic_pro",
        platform,
        { kind: "automation" },
        {
          key,
          code: `Key${key.toUpperCase()}`,
          ...modifiers,
          source: "profile-collision-test",
        },
      ).actionIds).toEqual([actionId]);
    }

    const allTracks = [
      ["o", "automation.allTracks.mode.off"],
      ["r", "automation.allTracks.mode.read"],
      ["t", "automation.allTracks.mode.touch"],
      ["l", "automation.allTracks.mode.latch"],
    ] as const;
    for (const [key, actionId] of allTracks) {
      expect(dispatchAction(
        "logic_pro",
        platform,
        { kind: "automation" },
        {
          key,
          code: `Key${key.toUpperCase()}`,
          ...modifiers,
          shiftKey: true,
          source: "profile-collision-test",
        },
      ).actionIds).toEqual([actionId]);
    }
  });

  it.each(TEST_PLATFORMS)(
    "dispatches Cakewalk all-track automation safety commands on %s",
    (platform) => {
      expect(dispatchAction(
        "cakewalk_sonar",
        platform,
        { kind: "automation" },
        { key: "F12", code: "F12", source: "profile-collision-test" },
      ).actionIds).toEqual(["automation.allTracks.writeOff"]);
      expect(dispatchAction(
        "cakewalk_sonar",
        platform,
        { kind: "automation" },
        {
          key: "F12",
          code: "F12",
          ctrlKey: platform === "windows",
          metaKey: platform === "macos",
          source: "profile-collision-test",
        },
      ).actionIds).toEqual(["automation.allTracks.toggleRead"]);
    },
  );

  it("has no undocumented inherited editor action shadowing an explicit global profile chord", () => {
    const semanticallyEquivalent = new Set([
      "edit.copy->midi.copySelection",
      "edit.cut->midi.cutSelection",
      "edit.paste->midi.pasteSelection",
      "edit.delete->midi.deleteSelection",
    ]);
    const collisions: string[] = [];

    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const platform of TEST_PLATFORMS) {
        for (const globalAction of getRegisteredActions()) {
          const globalBindings = getProfileActionBindings(profile.id, globalAction.id, platform);
          if (!globalBindings?.length) continue;
          if (!getActionShortcutScopes(globalAction, profile.id).includes("global")) continue;

          for (const editorAction of getRegisteredActions()) {
            if (getProfileActionBindings(profile.id, editorAction.id, platform) !== undefined) continue;
            const editorScopes = getActionShortcutScopes(editorAction, profile.id)
              .filter((scope) => scope !== "global");
            if (editorScopes.length === 0) continue;
            if (semanticallyEquivalent.has(`${globalAction.id}->${editorAction.id}`)) continue;

            const inheritedBindings = [
              editorAction.shortcut,
              ...(editorAction.shortcutAliases ?? []),
            ].filter((binding): binding is string => Boolean(binding) && !binding!.includes("("));
            for (const globalBinding of globalBindings) {
              const globalSignature = shortcutBindingEventSignature(globalBinding, platform);
              if (!globalSignature) continue;
              for (const inheritedBinding of inheritedBindings) {
                if (shortcutBindingEventSignature(inheritedBinding, platform) !== globalSignature) continue;
                collisions.push(
                  `${profile.id}/${platform}: ${globalAction.id} (${globalBinding}) `
                  + `is shadowed by inherited ${editorAction.id} (${inheritedBinding}) `
                  + `in ${editorScopes.join(",")}`,
                );
              }
            }
          }
        }
      }
    }

    expect(collisions).toEqual([]);
  });
});
