export type NAMStoredPresetMutationMode = "duplicate" | "rename";

export type NAMStoredPresetMutationFailure = "copy-failed" | "delete-failed";

export type NAMStoredPresetMutationResult =
  | {
      success: true;
      copied: true;
      sourceDeleted: boolean;
    }
  | {
      success: false;
      copied: boolean;
      sourceDeleted: false;
      failure: NAMStoredPresetMutationFailure;
    };

export type NAMStoredPresetMutationBridge = {
  copyBuiltInFXPreset: (
    pluginName: string,
    sourcePresetName: string,
    targetPresetName: string,
  ) => Promise<boolean>;
  deleteBuiltInFXPreset: (
    pluginName: string,
    presetName: string,
  ) => Promise<boolean>;
};

/**
 * Copies a stored preset payload without ever loading it into the live rack.
 * Rename is deliberately two-phase: the source is deleted only after the new
 * payload has been persisted successfully.
 */
export async function mutateStoredNAMPreset(
  bridge: NAMStoredPresetMutationBridge,
  pluginName: string,
  sourcePresetName: string,
  targetPresetName: string,
  mode: NAMStoredPresetMutationMode,
): Promise<NAMStoredPresetMutationResult> {
  let copied = false;
  try {
    copied = await bridge.copyBuiltInFXPreset(pluginName, sourcePresetName, targetPresetName);
  } catch {
    copied = false;
  }

  if (!copied) {
    return {
      success: false,
      copied: false,
      sourceDeleted: false,
      failure: "copy-failed",
    };
  }

  if (mode === "duplicate") {
    return {
      success: true,
      copied: true,
      sourceDeleted: false,
    };
  }

  let sourceDeleted = false;
  try {
    sourceDeleted = await bridge.deleteBuiltInFXPreset(pluginName, sourcePresetName);
  } catch {
    sourceDeleted = false;
  }

  if (!sourceDeleted) {
    return {
      success: false,
      copied: true,
      sourceDeleted: false,
      failure: "delete-failed",
    };
  }

  return {
    success: true,
    copied: true,
    sourceDeleted: true,
  };
}
