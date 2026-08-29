import { useEffect, useId, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import { getRegisteredActions } from "../store/actionRegistry";
import { useDAWStore } from "../store/useDAWStore";
import { MAX_CUSTOM_KEYBOARD_PROFILES } from "../utils/customShortcutProfiles";
import { Button, Input } from "./ui";

export function CustomKeyboardProfileManager() {
  const fileInputId = useId();
  const [profileName, setProfileName] = useState("");
  const [status, setStatus] = useState("");
  const {
    customKeyboardProfiles,
    activeCustomKeyboardProfileId,
    createCustomKeyboardProfile,
    duplicateKeyboardProfile,
    renameCustomKeyboardProfile,
    deleteCustomKeyboardProfile,
    exportActiveCustomKeyboardProfile,
    importCustomKeyboardProfile,
  } = useDAWStore(useShallow((state) => ({
    customKeyboardProfiles: state.customKeyboardProfiles,
    activeCustomKeyboardProfileId: state.activeCustomKeyboardProfileId,
    createCustomKeyboardProfile: state.createCustomKeyboardProfile,
    duplicateKeyboardProfile: state.duplicateKeyboardProfile,
    renameCustomKeyboardProfile: state.renameCustomKeyboardProfile,
    deleteCustomKeyboardProfile: state.deleteCustomKeyboardProfile,
    exportActiveCustomKeyboardProfile: state.exportActiveCustomKeyboardProfile,
    importCustomKeyboardProfile: state.importCustomKeyboardProfile,
  })));
  const activeProfile = customKeyboardProfiles.find(
    (profile) => profile.id === activeCustomKeyboardProfileId,
  );
  const profileCapacityReached = customKeyboardProfiles.length >= MAX_CUSTOM_KEYBOARD_PROFILES;
  const knownActionIds = useMemo(
    () => getRegisteredActions().map((action) => action.id),
    [],
  );

  useEffect(() => {
    setProfileName(activeProfile?.name ?? "");
  }, [activeProfile?.id, activeProfile?.name]);

  const createProfile = () => {
    const name = profileName.trim() || "Custom Shortcuts";
    const id = createCustomKeyboardProfile(name);
    const savedName = id
      ? useDAWStore.getState().customKeyboardProfiles.find((profile) => profile.id === id)?.name
      : null;
    setStatus(id
      ? `Created ${savedName ?? name}.`
      : `The profile could not be created. Check the ${MAX_CUSTOM_KEYBOARD_PROFILES}-profile limit and local storage.`);
  };

  const duplicateProfile = () => {
    const requestedName = profileName.trim() || undefined;
    const id = duplicateKeyboardProfile(requestedName);
    const savedName = id
      ? useDAWStore.getState().customKeyboardProfiles.find((profile) => profile.id === id)?.name
      : null;
    setStatus(id
      ? `Created and selected ${savedName ?? "a profile copy"}.`
      : `The profile copy could not be created. Check the ${MAX_CUSTOM_KEYBOARD_PROFILES}-profile limit and local storage.`);
  };

  const renameProfile = () => {
    if (!activeProfile || !profileName.trim()) return;
    if (renameCustomKeyboardProfile(activeProfile.id, profileName)) {
      setStatus("Profile renamed.");
    } else {
      setStatus("The profile could not be renamed or saved.");
    }
  };

  const deleteProfile = () => {
    if (!activeProfile) return;
    if (!window.confirm(`Delete the custom profile “${activeProfile.name}”?`)) return;
    if (deleteCustomKeyboardProfile(activeProfile.id)) {
      setStatus("Custom profile deleted. Its built-in base profile is now active.");
    } else {
      setStatus("The profile could not be deleted or saved.");
    }
  };

  const exportProfile = () => {
    if (!activeProfile) return;
    const serialized = exportActiveCustomKeyboardProfile();
    if (!serialized) return;
    const blob = new Blob([serialized], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeProfile.name.replace(/[^A-Za-z0-9_-]+/g, "-") || "openstudio-shortcuts"}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatus("Profile exported.");
  };

  const importProfile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      setStatus("The selected profile is larger than 1 MB.");
      return;
    }
    try {
      const serialized = await file.text();
      const result = importCustomKeyboardProfile(serialized, knownActionIds);
      setStatus(result.success
        ? `Imported and selected ${result.profile.name}.`
        : result.error);
    } catch {
      setStatus("OpenStudio could not read the selected profile file.");
    }
  };

  return (
    <section
      className="rounded-lg border border-daw-border bg-daw-dark/40 p-3"
      aria-label="Manage custom shortcuts"
    >
      <div className="flex flex-col gap-2">
        <div>
          <h3 id="custom-keyboard-profile-heading" className="text-xs font-semibold text-daw-text">
            Custom keyboard profiles
          </h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
            Named profiles keep multiple bindings and separate macOS, Windows, Linux, and fallback overrides.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
          <Input
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            placeholder={activeProfile ? activeProfile.name : "Profile name"}
            aria-label="Profile name"
            maxLength={64}
            size="sm"
            fullWidth
            className="min-w-0 flex-1"
          />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="default" onClick={createProfile} disabled={profileCapacityReached}>
              New
            </Button>
            <Button size="sm" variant="default" onClick={duplicateProfile} disabled={profileCapacityReached}>
              Duplicate
            </Button>
            <Button size="sm" variant="default" onClick={renameProfile} disabled={!activeProfile || !profileName.trim()}>
              Rename
            </Button>
            <Button size="sm" variant="default" onClick={exportProfile} disabled={!activeProfile}>
              Export
            </Button>
            <label
              htmlFor={fileInputId}
              className={`inline-flex items-center justify-center rounded border border-daw-border bg-neutral-800 px-2.5 py-1 text-xs font-bold text-daw-text transition-colors focus-within:ring-2 focus-within:ring-daw-accent ${profileCapacityReached ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-neutral-700"}`}
              aria-disabled={profileCapacityReached}
            >
              Import
              <input
                id={fileInputId}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                disabled={profileCapacityReached}
                onChange={(event) => {
                  void importProfile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            <Button
              size="sm"
              variant="ghost"
              className="text-orange-400 hover:text-orange-300"
              onClick={deleteProfile}
              disabled={!activeProfile}
            >
              Delete
            </Button>
          </div>
        </div>
        <p className="min-h-4 text-[11px] text-neutral-400" role="status" aria-live="polite">
          {status}
        </p>
      </div>
    </section>
  );
}
