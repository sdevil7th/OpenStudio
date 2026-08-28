import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import type { CustomKeyboardShortcutProfile } from "../utils/customShortcutProfiles";
import {
  applyMixerUISnapshot,
  extractMixerUISnapshot,
} from "../utils/mixerWindowSync";
import {
  hydrateInputProfilesFromNative,
  startDetachedInputProfileSync,
} from "../utils/inputProfileWindowSync";

const originalState = useDAWStore.getState();

function customProfile(
  id: string,
  baseProfileId: "reaper" | "cubase" = "reaper",
): CustomKeyboardShortcutProfile {
  return {
    id,
    name: "Detached profile",
    baseProfileId,
    bindings: {
      "transport.playPause": { common: ["Code:KeyP"] },
    },
    createdAt: 10,
    updatedAt: 20,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  useDAWStore.setState(originalState);
});

describe("detached-window input profile synchronization", () => {
  it("carries built-in and active custom profile state in the retained mixer snapshot", () => {
    const profile = customProfile("custom-detached");
    useDAWStore.setState({
      keyboardShortcutProfileId: "reaper",
      mouseBehaviorProfileId: "ableton_live",
      customKeyboardProfiles: [profile],
      activeCustomKeyboardProfileId: profile.id,
      customShortcuts: profile.bindings,
      mouseModifiers: { clip_drag: { primary: "copy" } },
    });
    const snapshot = extractMixerUISnapshot();

    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      mouseBehaviorProfileId: "openstudio",
      customKeyboardProfiles: [],
      activeCustomKeyboardProfileId: null,
      customShortcuts: {},
      mouseModifiers: {},
    });
    applyMixerUISnapshot(snapshot);

    expect(useDAWStore.getState()).toMatchObject({
      keyboardShortcutProfileId: "reaper",
      mouseBehaviorProfileId: "ableton_live",
      activeCustomKeyboardProfileId: "custom-detached",
      customShortcuts: profile.bindings,
      mouseModifiers: { clip_drag: { primary: "copy" } },
    });
  });

  it("hydrates a reopened MIDI/plugin window from native retained state without localStorage", async () => {
    const profile = customProfile("custom-reopen", "cubase");
    const retained = {
      ...extractMixerUISnapshot(),
      keyboardShortcutProfileId: "cubase" as const,
      mouseBehaviorProfileId: "logic_pro" as const,
      customKeyboardProfiles: [profile],
      activeCustomKeyboardProfileId: profile.id,
      customShortcuts: profile.bindings,
      mouseModifiers: { timeline_click: { alt: "razor" } },
    };
    vi.spyOn(nativeBridge, "getMixerUISnapshot").mockResolvedValue({
      originWindowId: "main",
      revision: 7,
      payload: retained,
    });
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      mouseBehaviorProfileId: "openstudio",
      customKeyboardProfiles: [],
      activeCustomKeyboardProfileId: null,
      customShortcuts: {},
      mouseModifiers: {},
    });

    await expect(hydrateInputProfilesFromNative()).resolves.toBe(true);
    expect(useDAWStore.getState()).toMatchObject({
      keyboardShortcutProfileId: "cubase",
      mouseBehaviorProfileId: "logic_pro",
      activeCustomKeyboardProfileId: "custom-reopen",
      customShortcuts: profile.bindings,
      mouseModifiers: { timeline_click: { alt: "razor" } },
    });
  });

  it("applies live main-window changes and rejects a slower stale retained read", async () => {
    const listenerRef: { current?: (value: unknown) => void } = {};
    const unsubscribe = vi.fn();
    vi.spyOn(nativeBridge, "subscribe").mockImplementation((eventId, callback) => {
      expect(eventId).toBe("mixerUISync");
      listenerRef.current = callback;
      return unsubscribe;
    });

    const retainedResolverRef: { current?: (value: unknown) => void } = {};
    vi.spyOn(nativeBridge, "getMixerUISnapshot").mockImplementation(() => (
      new Promise((resolve) => { retainedResolverRef.current = resolve; })
    ));

    const stop = startDetachedInputProfileSync();
    const live = {
      ...extractMixerUISnapshot(),
      keyboardShortcutProfileId: "pro_tools" as const,
      mouseBehaviorProfileId: "cakewalk_sonar" as const,
      customKeyboardProfiles: [],
      activeCustomKeyboardProfileId: null,
      customShortcuts: {},
    };
    listenerRef.current?.({ originWindowId: "main", revision: 9, payload: live });
    expect(useDAWStore.getState()).toMatchObject({
      keyboardShortcutProfileId: "pro_tools",
      mouseBehaviorProfileId: "cakewalk_sonar",
    });

    retainedResolverRef.current?.({
      originWindowId: "main",
      revision: 8,
      payload: {
        ...live,
        keyboardShortcutProfileId: "audacity",
        mouseBehaviorProfileId: "audacity",
      },
    });
    await Promise.resolve();
    expect(useDAWStore.getState()).toMatchObject({
      keyboardShortcutProfileId: "pro_tools",
      mouseBehaviorProfileId: "cakewalk_sonar",
    });

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed remote profile and custom-binding payloads", async () => {
    vi.spyOn(nativeBridge, "getMixerUISnapshot").mockResolvedValue({
      originWindowId: "main",
      revision: 1,
      payload: {
        ...extractMixerUISnapshot(),
        keyboardShortcutProfileId: "not-a-profile",
        customKeyboardProfiles: [{ id: "broken" }],
      },
    });
    useDAWStore.setState({
      keyboardShortcutProfileId: "openstudio",
      mouseBehaviorProfileId: "openstudio",
    });

    await expect(hydrateInputProfilesFromNative()).resolves.toBe(false);
    expect(useDAWStore.getState()).toMatchObject({
      keyboardShortcutProfileId: "openstudio",
      mouseBehaviorProfileId: "openstudio",
    });
  });

  it("rejects malformed remote mouse overrides", async () => {
    vi.spyOn(nativeBridge, "getMixerUISnapshot").mockResolvedValue({
      originWindowId: "main",
      revision: 2,
      payload: {
        ...extractMixerUISnapshot(),
        mouseModifiers: { clip_drag: { primary: "delete" } },
      },
    });
    const mouseModifiers = { fade_handle: { shift: "symmetric" } };
    useDAWStore.setState({ mouseModifiers });

    await expect(hydrateInputProfilesFromNative()).resolves.toBe(false);
    expect(useDAWStore.getState().mouseModifiers).toBe(mouseModifiers);
  });
});
