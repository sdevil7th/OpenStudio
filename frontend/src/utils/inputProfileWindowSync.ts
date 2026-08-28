import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import {
  CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
  parsePersistedCustomKeyboardProfiles,
  type CustomKeyboardShortcutProfile,
  type CustomShortcutMap,
} from "./customShortcutProfiles";
import {
  isKeyboardShortcutProfileId,
  type KeyboardShortcutProfileId,
} from "./shortcutProfiles";
import {
  normalizeMouseModifierOverrides,
  type StoredMouseModifierOverrides,
} from "./mouseModifierPersistence";
import { setDetachedMainActionAvailability } from "./detachedMainActionRouting";

/**
 * Input-profile state that must be identical in every WebView window. The
 * active custom binding map is included explicitly so shortcut dispatch does
 * not depend on another window's localStorage lifecycle.
 */
export interface InputProfileWindowSnapshot {
  keyboardShortcutProfileId: KeyboardShortcutProfileId;
  mouseBehaviorProfileId: KeyboardShortcutProfileId;
  customKeyboardProfiles: readonly CustomKeyboardShortcutProfile[];
  activeCustomKeyboardProfileId: string | null;
  customShortcuts: CustomShortcutMap;
  mouseModifiers: StoredMouseModifierOverrides;
}

interface InputProfileSnapshotEnvelope {
  revision: number;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvelope(value: unknown): InputProfileSnapshotEnvelope | null {
  if (!isRecord(value)) return null;
  const revision = typeof value.revision === "number" && Number.isFinite(value.revision)
    ? value.revision
    : 0;
  return {
    revision,
    payload: "payload" in value ? value.payload : value,
  };
}

export function extractInputProfileWindowSnapshot(
  state = useDAWStore.getState(),
): InputProfileWindowSnapshot {
  return {
    keyboardShortcutProfileId: state.keyboardShortcutProfileId,
    mouseBehaviorProfileId: state.mouseBehaviorProfileId,
    customKeyboardProfiles: state.customKeyboardProfiles,
    activeCustomKeyboardProfileId: state.activeCustomKeyboardProfileId,
    customShortcuts: state.customShortcuts,
    mouseModifiers: state.mouseModifiers,
  };
}

/** Validate a retained/live native snapshot before allowing it into a store. */
export function parseInputProfileWindowSnapshot(
  value: unknown,
): InputProfileWindowSnapshot | null {
  if (!isRecord(value)
    || !isKeyboardShortcutProfileId(value.keyboardShortcutProfileId)
    || !isKeyboardShortcutProfileId(value.mouseBehaviorProfileId)) {
    return null;
  }

  const parsedCustomProfiles = parsePersistedCustomKeyboardProfiles({
    schemaVersion: CUSTOM_KEYBOARD_PROFILE_SCHEMA_VERSION,
    activeProfileId: value.activeCustomKeyboardProfileId,
    profiles: value.customKeyboardProfiles,
  });
  if (!parsedCustomProfiles) return null;

  const activeProfile = parsedCustomProfiles.profiles.find(
    (profile) => profile.id === parsedCustomProfiles.activeProfileId,
  );
  const keyboardShortcutProfileId = activeProfile?.baseProfileId
    ?? value.keyboardShortcutProfileId;
  // Snapshots from older builds did not include overrides. Treat absence as
  // an empty overlay while rejecting malformed data from newer snapshots.
  const mouseModifiers = value.mouseModifiers === undefined
    ? {}
    : normalizeMouseModifierOverrides(value.mouseModifiers);
  if (!mouseModifiers) return null;

  return {
    keyboardShortcutProfileId,
    mouseBehaviorProfileId: value.mouseBehaviorProfileId,
    customKeyboardProfiles: parsedCustomProfiles.profiles,
    activeCustomKeyboardProfileId: parsedCustomProfiles.activeProfileId,
    // Derive the dispatch map from the validated active profile. A missing
    // active profile always means no custom overlay.
    customShortcuts: activeProfile?.bindings ?? {},
    mouseModifiers,
  };
}

export function applyInputProfileWindowSnapshot(value: unknown): boolean {
  if (isRecord(value)) {
    setDetachedMainActionAvailability(value.availableDetachedMainActionIds);
  }
  const snapshot = parseInputProfileWindowSnapshot(value);
  if (!snapshot) return false;
  useDAWStore.setState(snapshot);
  return true;
}

function applyEnvelopeIfCurrent(
  value: unknown,
  latestRevision: { current: number },
): boolean {
  const envelope = readEnvelope(value);
  if (!envelope || envelope.revision < latestRevision.current) return false;
  if (isRecord(envelope.payload)) {
    setDetachedMainActionAvailability(envelope.payload.availableDetachedMainActionIds);
  }
  const snapshot = parseInputProfileWindowSnapshot(envelope.payload);
  if (!snapshot) return false;
  latestRevision.current = envelope.revision;
  useDAWStore.setState(snapshot);
  return true;
}

/**
 * Hydrates input profiles from the native retained mixer snapshot. The mixer
 * sync channel is already broadcast to every WebView, so it also provides a
 * single live profile source without adding another C++ bridge surface.
 */
export async function hydrateInputProfilesFromNative(): Promise<boolean> {
  const retained = await nativeBridge.getMixerUISnapshot<unknown>();
  const envelope = readEnvelope(retained);
  return envelope ? applyInputProfileWindowSnapshot(envelope.payload) : false;
}

export function startDetachedInputProfileSync(): () => void {
  const latestRevision = { current: -1 };
  let disposed = false;
  const unsubscribe = nativeBridge.subscribe("mixerUISync", (value) => {
    if (!disposed) applyEnvelopeIfCurrent(value, latestRevision);
  });

  // Subscribe before reading the retained snapshot. The revision guard keeps a
  // slower retained read from overwriting a newer live update.
  void nativeBridge.getMixerUISnapshot<unknown>().then((value) => {
    if (!disposed) applyEnvelopeIfCurrent(value, latestRevision);
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}
