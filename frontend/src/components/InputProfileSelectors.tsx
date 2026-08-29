import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import {
  getKeyboardShortcutProfile,
  getKeyboardShortcutProfilePresentation,
  isKeyboardShortcutProfileId,
  KEYBOARD_SHORTCUT_PROFILES,
} from "../utils/shortcutProfiles";
import { getMouseBehaviorProfile } from "../utils/mouseBehaviorProfiles";
import { getShortcutPlatform } from "../utils/platform";
import { NativeSelect } from "./ui";

interface InputProfileSelectorsProps {
  compact?: boolean;
  showDescriptions?: boolean;
  className?: string;
}

export function InputProfileSelectors({
  compact = false,
  showDescriptions = true,
  className = "",
}: InputProfileSelectorsProps) {
  const {
    keyboardShortcutProfileId,
    customKeyboardProfiles,
    activeCustomKeyboardProfileId,
    mouseBehaviorProfileId,
    setKeyboardShortcutProfile,
    activateCustomKeyboardProfile,
    setMouseBehaviorProfile,
  } = useDAWStore(useShallow((state) => ({
    keyboardShortcutProfileId: state.keyboardShortcutProfileId,
    customKeyboardProfiles: state.customKeyboardProfiles,
    activeCustomKeyboardProfileId: state.activeCustomKeyboardProfileId,
    mouseBehaviorProfileId: state.mouseBehaviorProfileId,
    setKeyboardShortcutProfile: state.setKeyboardShortcutProfile,
    activateCustomKeyboardProfile: state.activateCustomKeyboardProfile,
    setMouseBehaviorProfile: state.setMouseBehaviorProfile,
  })));

  const currentPlatform = getShortcutPlatform();
  const builtInOptions = useMemo(
    () => KEYBOARD_SHORTCUT_PROFILES.map((profile) => {
      const presentation = getKeyboardShortcutProfilePresentation(profile.id, currentPlatform);
      return { value: profile.id, label: presentation.optionLabel };
    }),
    [currentPlatform],
  );
  const keyboardOptions = useMemo(() => [
    ...builtInOptions,
    ...customKeyboardProfiles.map((profile) => ({
      value: `custom:${profile.id}`,
      label: `Custom - ${profile.name}`,
    })),
  ], [builtInOptions, customKeyboardProfiles]);
  const keyboardProfile = getKeyboardShortcutProfile(keyboardShortcutProfileId);
  const keyboardPresentation = getKeyboardShortcutProfilePresentation(
    keyboardShortcutProfileId,
    currentPlatform,
  );
  const mousePresentation = getKeyboardShortcutProfilePresentation(
    mouseBehaviorProfileId,
    currentPlatform,
  );
  const mouseProfile = getMouseBehaviorProfile(
    mouseBehaviorProfileId,
    currentPlatform,
  );

  const chooseKeyboardProfile = (value: string | number) => {
    if (typeof value === "string" && value.startsWith("custom:")) {
      activateCustomKeyboardProfile(value.slice("custom:".length));
      return;
    }
    if (isKeyboardShortcutProfileId(value)) {
      setKeyboardShortcutProfile(value);
    }
  };
  const chooseMouseProfile = (value: string | number) => {
    if (isKeyboardShortcutProfileId(value)) setMouseBehaviorProfile(value);
  };

  return (
    <div className={`grid gap-3 ${compact ? "sm:grid-cols-2" : "md:grid-cols-2"} ${className}`}>
      <div className="min-w-0">
        <NativeSelect
          label="Keyboard profile"
          options={keyboardOptions}
          value={activeCustomKeyboardProfileId
            ? `custom:${activeCustomKeyboardProfileId}`
            : keyboardShortcutProfileId}
          onChange={chooseKeyboardProfile}
          size={compact ? "sm" : "md"}
          fullWidth
          showPlaceholder={false}
          title="Choose familiar keyboard shortcuts"
        />
        {showDescriptions && (
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
            {activeCustomKeyboardProfileId
              ? `Your named overrides on top of ${keyboardProfile.name}. ${keyboardPresentation.policyLabel}. ${keyboardPresentation.availabilityLabel}.`
              : `${keyboardPresentation.description} ${keyboardPresentation.policyLabel}.`}
          </p>
        )}
      </div>
      <div className="min-w-0">
        <NativeSelect
          label="Mouse & scroll profile"
          options={builtInOptions}
          value={mouseBehaviorProfileId}
          onChange={chooseMouseProfile}
          size={compact ? "sm" : "md"}
          fullWidth
          showPlaceholder={false}
          title="Choose familiar mouse and wheel behavior"
        />
        {showDescriptions && (
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
            {mouseProfile.name} documented gestures are applied independently from the keyboard map. {mousePresentation.availabilityLabel}. Unsupported parameter-wheel gestures are suppressed; app-wide browser zoom protection remains active.
          </p>
        )}
      </div>
    </div>
  );
}
