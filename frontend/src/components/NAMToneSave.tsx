import { type Dispatch, type SetStateAction } from "react";
import { Save } from "lucide-react";
import type {
  BuiltInPluginAddress,
  BuiltInPluginSchema,
  NAMInstalledModel,
  NAMToneSaveMetadata,
} from "../services/NativeBridge";
import { nativeBridge } from "../services/NativeBridge";
import { Button, Input, Modal, Textarea } from "./ui";
import {
  asNAMRecord as asRecord,
  firstNAMNumber as firstNumber,
  firstNAMString as firstString,
  namDisplayNameFromPath,
  resolveNAMToneIdentity,
} from "../utils/namDisplayName";
import {
  captureIncludesCab,
  captureTypeForInstalled,
  normalizeNAMCaptureType,
  type NAMCaptureType,
} from "../utils/namCaptureType";
import { buildNAMRackRollbackPatch } from "../utils/namRackPresetTransactions";

export type NAMToneSaveDraft = NAMToneSaveMetadata & { tagsText: string };

export const NAM_PRESET_SAVE_COPY = {
  title: "Save NAM Preset",
  action: "Save Preset",
  eyebrow: "Complete rack preset",
  untitled: "Untitled preset",
  description: "Save the complete rack — Captures, IR, supported effect settings, routing, and source references — as one recallable Preset.",
  nameLabel: "Preset Name",
} as const;
export type NAMToneSlot = "pedal" | "amp" | "cab";
export type NAMLibraryAction = "select" | "live-preview" | "save" | "revert";

export type NAMPreviewBaseline = {
  pedalModelPath: string;
  ampModelPath: string;
  cabIRPath: string;
  pedalDeclaredCaptureType?: NAMCaptureType;
  ampDeclaredCaptureType?: NAMCaptureType;
  cabEnabled: number;
  cabRequestedEnabled: boolean;
  pedalMix: number;
  ampEnabled: number;
  ampMix: number;
  auditionSource: number;
  pedalCalibrationMode?: number;
  pedalOverrideInputLevelDbu?: number;
  pedalOverrideOutputLevelDbu?: number;
  ampCalibrationMode?: number;
  ampOverrideInputLevelDbu?: number;
  ampOverrideOutputLevelDbu?: number;
};

export type NAMActivePreviewState = {
  schemaVersion: 1 | 2;
  key?: string;
  slot: NAMToneSlot;
  toneId?: number;
  modelId?: number;
  title?: string;
  modelName?: string;
  creator?: string;
  localPath?: string;
  previousPath?: string;
  source?: "catalog" | "installed" | "local" | string;
  previewDownload?: boolean;
  saved?: boolean;
  action?: NAMLibraryAction;
  record?: NAMInstalledModel;
  sourceUrl?: string;
  license?: string;
  checksum?: string;
  createdAt?: string;
  captureType?: NAMCaptureType;
  includesCab?: boolean;
  baseline?: NAMPreviewBaseline;
};

export type NAMSavedToneState = {
  schemaVersion: 2;
  savedAt: string;
  slot: NAMToneSlot;
  toneId: number;
  modelId: number;
  title: string;
  captureTitle?: string;
  modelName: string;
  creator: string;
  localPath: string;
  source: string;
  previewCommitted: boolean;
  metadata: NAMToneSaveMetadata;
  license: string;
  sourceUrl: string;
  checksum: string;
  captureType: NAMCaptureType;
  includesCab: boolean;
  values: Record<string, number>;
  modelState: Record<string, unknown>;
  slots: {
    pedal?: string;
    amp?: string;
    cab?: string;
  };
  rackState: Record<string, unknown>;
};

type SaveNAMToneOptions = {
  address: BuiltInPluginAddress;
  schema: BuiltInPluginSchema;
  metadata: NAMToneSaveMetadata;
  activePreview?: NAMActivePreviewState | null;
  selectedRecord?: NAMInstalledModel | null;
  slotHint?: NAMToneSlot;
  sourceIds?: {
    toneId?: number;
    modelId?: number;
  };
  titleFallback?: string;
  modelNameFallback?: string;
  creatorFallback?: string;
};

export type SaveNAMToneResult = {
  success: boolean;
  error?: string;
  savedTone?: NAMSavedToneState;
  committedRecord?: NAMInstalledModel | null;
  committed?: boolean;
};

function cleanPath(path: unknown) {
  return String(path ?? "").trim();
}

function isPreviewPath(path: unknown) {
  return cleanPath(path).replace(/\\/g, "/").toLowerCase().includes("/previews/");
}

function valuesFromState(state: unknown, fallback: BuiltInPluginSchema) {
  const stateRecord = asRecord(state);
  const rawValues = asRecord(stateRecord.values);
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (key === "calibrationReferenceDbu") continue;
    const number = Number(value);
    if (Number.isFinite(number)) values[key] = number;
  }
  if (Object.keys(values).length === 0) {
    for (const param of fallback.parameters) {
      if (param.id !== "calibrationReferenceDbu") values[param.id] = param.value;
    }
  }
  values.auditionSource = 0;
  return values;
}

function modelStateFromState(state: unknown, fallback: BuiltInPluginSchema) {
  const stateRecord = asRecord(state);
  const rawModelState = asRecord(stateRecord.modelState);
  const fallbackModelState = asRecord(fallback.modelState);
  return {
    ...fallbackModelState,
    ...rawModelState,
  };
}

function uiStateFromState(state: unknown, fallback: BuiltInPluginSchema) {
  const stateRecord = asRecord(state);
  return {
    ...asRecord(fallback.uiState),
    ...asRecord(stateRecord.uiState),
  };
}

function slotForRecord(record?: NAMInstalledModel | null, fallback: NAMToneSlot = "amp"): NAMToneSlot {
  const haystack = [
    record?.gear,
    record?.gearType,
    record?.name,
    record?.toneTitle,
    record?.localPath,
    record?.lastSeenMetadata?.gear,
    record?.lastSeenMetadata?.gearType,
    record?.lastSeenMetadata?.name,
    record?.latestMetadata?.gear,
    record?.latestMetadata?.gearType,
    record?.latestMetadata?.name,
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");

  if (/\b(ir|cab|cabinet|impulse|wav|aiff|flac)\b/.test(haystack)) return "cab";
  if (/\b(pedal|drive|distortion|fuzz|boost|overdrive|stomp)\b/.test(haystack)) return "pedal";
  return fallback;
}

function modelPathForSlot(modelState: Record<string, unknown>, slot: NAMToneSlot) {
  if (slot === "pedal") return cleanPath(modelState.pedalModelPath);
  if (slot === "cab") return cleanPath(modelState.cabIRPath);
  return cleanPath(modelState.ampModelPath);
}

function modelStatePatchForSlot(
  slot: NAMToneSlot,
  path: string,
  declaredCaptureType: NAMCaptureType = "unknown",
) {
  if (slot === "pedal") {
    return {
      pedalModelPath: path,
      pedalDeclaredCaptureType: declaredCaptureType,
    };
  }
  if (slot === "cab") return { cabIRPath: path };
  return {
    ampModelPath: path,
    ampDeclaredCaptureType: declaredCaptureType,
  };
}

export function emptyToneSaveDraft(): NAMToneSaveDraft {
  return {
    toneName: "",
    creator: "",
    songName: "",
    artistReference: "",
    genreStyle: "",
    tagsText: "",
    tags: [],
    notes: "",
    sourceUrl: "",
    license: "",
    favorite: false,
  };
}

export function saveDraftToMetadata(draft: NAMToneSaveDraft): NAMToneSaveMetadata {
  const tags = Array.from(new Map(
    draft.tagsText
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => [tag.toLocaleLowerCase(), tag] as const),
  ).values()).slice(0, 16);

  return {
    ...draft,
    tags,
  };
}

export function normalizeNAMActivePreview(raw: unknown): NAMActivePreviewState | null {
  const record = asRecord(raw);
  const slot = record.slot === "pedal" || record.slot === "cab" || record.slot === "amp" ? record.slot : "";
  if (!slot) return null;
  const installedRecord = asRecord(record.record) as NAMInstalledModel;
  const localPath = firstString(record.localPath, installedRecord.localPath);
  if (!localPath && Object.keys(installedRecord).length === 0) return null;

  const baselineRecord = asRecord(record.baseline);
  const optionalBaselineNumber = (key: string) => {
    const value = Number(baselineRecord[key]);
    return baselineRecord[key] !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const captureType = (firstString(record.captureType, installedRecord.captureType) || captureTypeForInstalled(installedRecord)) as NAMCaptureType;
  const hasBaseline = Object.keys(baselineRecord).length > 0;
  const storedAction = firstString(record.action);
  const action: NAMLibraryAction = storedAction === "select"
    || storedAction === "save"
    || storedAction === "revert"
    ? storedAction
    : "live-preview";
  return {
    schemaVersion: 2,
    key: firstString(record.key),
    slot,
    toneId: firstNumber(record.toneId, installedRecord.toneId),
    modelId: firstNumber(record.modelId, installedRecord.modelId),
    title: firstString(record.title, installedRecord.toneTitle, installedRecord.name),
    modelName: firstString(record.modelName, installedRecord.name),
    creator: firstString(record.creator, installedRecord.creator),
    localPath,
    previousPath: firstString(record.previousPath),
    source: firstString(record.source) || "catalog",
    previewDownload: Boolean(record.previewDownload || installedRecord.preview || isPreviewPath(localPath)),
    saved: Boolean(record.saved),
    action,
    record: Object.keys(installedRecord).length > 0 ? installedRecord : undefined,
    sourceUrl: firstString(record.sourceUrl, installedRecord.sourceUrl),
    license: firstString(record.license, installedRecord.license),
    checksum: firstString(record.checksum, installedRecord.checksum),
    createdAt: firstString(record.createdAt),
    captureType,
    includesCab: typeof record.includesCab === "boolean"
      ? record.includesCab
      : captureIncludesCab(captureType),
    baseline: hasBaseline ? {
      pedalModelPath: firstString(baselineRecord.pedalModelPath),
      ampModelPath: firstString(baselineRecord.ampModelPath),
      cabIRPath: firstString(baselineRecord.cabIRPath),
      pedalDeclaredCaptureType: normalizeNAMCaptureType(
        baselineRecord.pedalDeclaredCaptureType,
      ),
      ampDeclaredCaptureType: normalizeNAMCaptureType(
        baselineRecord.ampDeclaredCaptureType,
      ),
      cabEnabled: Number(baselineRecord.cabEnabled ?? 0),
      cabRequestedEnabled: typeof baselineRecord.cabRequestedEnabled === "boolean"
        ? baselineRecord.cabRequestedEnabled
        : Number(baselineRecord.cabEnabled ?? 0) >= 0.5,
      pedalMix: Number(baselineRecord.pedalMix ?? 0),
      ampEnabled: Number(baselineRecord.ampEnabled ?? 1),
      ampMix: Number(baselineRecord.ampMix ?? 1),
      auditionSource: Number(baselineRecord.auditionSource ?? 0),
      pedalCalibrationMode: optionalBaselineNumber("pedalCalibrationMode"),
      pedalOverrideInputLevelDbu: optionalBaselineNumber("pedalOverrideInputLevelDbu"),
      pedalOverrideOutputLevelDbu: optionalBaselineNumber("pedalOverrideOutputLevelDbu"),
      ampCalibrationMode: optionalBaselineNumber("ampCalibrationMode"),
      ampOverrideInputLevelDbu: optionalBaselineNumber("ampOverrideInputLevelDbu"),
      ampOverrideOutputLevelDbu: optionalBaselineNumber("ampOverrideOutputLevelDbu"),
    } : undefined,
  };
}

export function makeNAMActivePreview(record: NAMInstalledModel, preview: Omit<NAMActivePreviewState, "schemaVersion" | "record">): NAMActivePreviewState {
  return {
    schemaVersion: 2,
    ...preview,
    record,
    localPath: preview.localPath || record.localPath,
    toneId: preview.toneId || Number(record.toneId || 0),
    modelId: preview.modelId || Number(record.modelId || 0),
    title: preview.title || record.toneTitle || record.name || "NAM Rack Preset",
    modelName: preview.modelName || record.name || "NAM model",
    creator: preview.creator || record.creator || "TONE3000",
    sourceUrl: preview.sourceUrl || record.sourceUrl,
    license: preview.license || record.license,
    checksum: preview.checksum || record.checksum,
    previewDownload: Boolean(preview.previewDownload || record.preview || isPreviewPath(record.localPath)),
    saved: Boolean(preview.saved),
    createdAt: preview.createdAt || new Date().toISOString(),
  };
}

export function buildNAMToneSaveDraft(options: {
  schema?: BuiltInPluginSchema;
  activePreview?: NAMActivePreviewState | null;
  selectedRecord?: NAMInstalledModel | null;
  title?: string;
  creator?: string;
  sourceUrl?: string;
  license?: string;
  tags?: string[];
  favorite?: boolean;
}): NAMToneSaveDraft {
  const savedTone = asRecord(options.schema?.uiState?.namSavedTone);
  const savedMetadata = asRecord(savedTone.metadata);
  const activePreview = options.activePreview ?? normalizeNAMActivePreview(options.schema?.uiState?.namActivePreview);
  const selectedRecord = options.selectedRecord ?? null;
  const identity = resolveNAMToneIdentity({
    activePreview,
    savedTone,
    installedRecord: selectedRecord,
    titleFallback: options.title,
    creatorFallback: options.creator,
  });
  const rawTags = options.tags && options.tags.length > 0
    ? options.tags
    : Array.isArray(savedMetadata.tags)
      ? savedMetadata.tags.map((tag) => String(tag)).filter(Boolean)
      : [];
  const tags = Array.from(new Map(
    rawTags
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => [tag.toLocaleLowerCase(), tag] as const),
  ).values());

  return {
    ...emptyToneSaveDraft(),
    toneName: firstString(options.title, identity.title, "NAM Rack Preset"),
    creator: firstString(options.creator, identity.creator, "OpenStudio"),
    songName: firstString(savedMetadata.songName),
    artistReference: firstString(savedMetadata.artistReference),
    genreStyle: firstString(savedMetadata.genreStyle),
    tags,
    tagsText: tags.slice(0, 16).join(", "),
    notes: firstString(savedMetadata.notes),
    sourceUrl: firstString(options.sourceUrl, identity.sourceUrl),
    license: firstString(options.license, identity.license),
    favorite: Boolean(options.favorite ?? savedMetadata.favorite ?? selectedRecord?.favorite),
  };
}

export async function clearNAMActivePreview(address: BuiltInPluginAddress, schema: BuiltInPluginSchema) {
  const state = await nativeBridge.getBuiltInPluginState(address).catch(() => null);
  const uiState = uiStateFromState(state, schema);
  return await nativeBridge.setBuiltInPluginState(address, {
    uiState: {
      ...uiState,
      namActivePreview: null,
    },
  });
}

export async function saveNAMTone(options: SaveNAMToneOptions): Promise<SaveNAMToneResult> {
  const metadata = {
    ...options.metadata,
    toneName: options.metadata.toneName.trim(),
  };
  if (!metadata.toneName) return { success: false, error: "Name the Preset first." };

  const originalState = await nativeBridge.getBuiltInPluginState(options.address).catch(() => null);
  const rollbackPatch = buildNAMRackRollbackPatch(originalState);
  if (!rollbackPatch) {
    return { success: false, error: "The current rack could not be captured, so the Preset was not changed." };
  }

  let rackMutationStarted = false;
  const failWithRollback = async (message: string): Promise<SaveNAMToneResult> => {
    if (!rackMutationStarted) return { success: false, error: message };
    const restored = await nativeBridge.setBuiltInPluginState(options.address, rollbackPatch).catch(() => false);
    return {
      success: false,
      error: restored
        ? `${message} The previous rack was restored.`
        : `${message} The previous rack could not be restored; reload the last Preset before continuing.`,
    };
  };

  try {
    rackMutationStarted = true;
    const liveInputRestored = await nativeBridge.setBuiltInPluginParam(options.address, "auditionSource", 0);
    if (!liveInputRestored) {
      return await failWithRollback("Live guitar input could not be restored, so the Preset was not saved.");
    }

    const state = await nativeBridge.getBuiltInPluginState(options.address);
    const uiState = uiStateFromState(state, options.schema);
    const activePreview = options.activePreview ?? normalizeNAMActivePreview(uiState.namActivePreview);
    if (activePreview?.includesCab) {
      const currentValues = asRecord(asRecord(state).values);
      if (Number(currentValues.cabEnabled ?? 0) >= 0.5) {
        return await failWithRollback("The external IR is still active, so this full-rig Preset was not saved.");
      }
    }
    const selectedRecord = options.selectedRecord ?? activePreview?.record ?? null;
    const slot = activePreview?.slot ?? options.slotHint ?? slotForRecord(selectedRecord, "amp");
    const values = valuesFromState(state, options.schema);
    const modelState = modelStateFromState(state, options.schema);
    const initialIdentity = resolveNAMToneIdentity({
      activePreview,
      installedRecord: selectedRecord,
      savedTone: uiState.namSavedTone,
      localPath: modelPathForSlot(modelState, slot),
      titleFallback: metadata.toneName || options.titleFallback,
      modelNameFallback: options.modelNameFallback,
      creatorFallback: options.creatorFallback,
    });
    const rackState = {
      values,
      modelState,
      slotOrder: asRecord(uiState.namRackSlots).order,
      sourceIds: {
        toneId: firstNumber(options.sourceIds?.toneId, activePreview?.toneId, selectedRecord?.toneId),
        modelId: firstNumber(options.sourceIds?.modelId, activePreview?.modelId, selectedRecord?.modelId),
      },
    };

    let committedRecord: NAMInstalledModel | null = selectedRecord;
    let committed = false;
    const selectedLocalPath = firstString(selectedRecord?.localPath, activePreview?.localPath);
    const shouldCommit = Boolean(
      selectedRecord &&
      (activePreview?.previewDownload || selectedRecord.preview || isPreviewPath(selectedLocalPath)),
    );

    if (shouldCommit && selectedRecord) {
      const commitResult = await nativeBridge.commitNAMPreviewTone(selectedRecord, metadata, rackState);
      if (!commitResult.success) {
        return await failWithRollback(commitResult.error || "Could not keep the previewed NAM Capture.");
      }
      committedRecord = commitResult.record ?? selectedRecord;
      committed = true;
    }

    const committedPath = firstString(committedRecord?.localPath, activePreview?.localPath, modelPathForSlot(modelState, slot));
    const storedDeclaredCaptureType = normalizeNAMCaptureType(
      slot === "pedal"
        ? modelState.pedalDeclaredCaptureType
        : slot === "amp"
          ? modelState.ampDeclaredCaptureType
          : "unknown",
    );
    const previewDeclaredCaptureType = normalizeNAMCaptureType(
      activePreview?.captureType,
    );
    const recordDeclaredCaptureType = committedRecord
      ? captureTypeForInstalled(committedRecord)
      : "unknown";
    const declaredCaptureType = storedDeclaredCaptureType !== "unknown"
      ? storedDeclaredCaptureType
      : previewDeclaredCaptureType !== "unknown"
        ? previewDeclaredCaptureType
        : recordDeclaredCaptureType;
    const currentSlotPath = modelPathForSlot(modelState, slot);
    const declarationNeedsPublication = (slot === "pedal" || slot === "amp")
      && storedDeclaredCaptureType !== declaredCaptureType;
    const shouldPatchModelState = Boolean(
      committedPath
      && (committed || currentSlotPath !== committedPath || declarationNeedsPublication),
    );
    const nextModelState: Record<string, unknown> = {
      ...modelState,
      ...(shouldPatchModelState
        ? modelStatePatchForSlot(slot, committedPath, declaredCaptureType)
        : {}),
    };
    const finalIdentity = resolveNAMToneIdentity({
      activePreview,
      installedRecord: committedRecord,
      savedTone: uiState.namSavedTone,
      localPath: committedPath,
      titleFallback: metadata.toneName || initialIdentity.title,
      modelNameFallback: options.modelNameFallback || initialIdentity.modelName,
      creatorFallback: options.creatorFallback || initialIdentity.creator,
    });
    const toneId = firstNumber(options.sourceIds?.toneId, finalIdentity.toneId, activePreview?.toneId, committedRecord?.toneId);
    const modelId = firstNumber(options.sourceIds?.modelId, finalIdentity.modelId, activePreview?.modelId, committedRecord?.modelId);
    const savedTone: NAMSavedToneState = {
      schemaVersion: 2,
      savedAt: new Date().toISOString(),
      slot,
      toneId,
      modelId,
      title: metadata.toneName,
      captureTitle: firstString(
        activePreview?.title,
        committedRecord?.toneTitle,
        committedRecord?.name,
        finalIdentity.modelName,
        namDisplayNameFromPath(committedPath),
      ),
      modelName: firstString(finalIdentity.modelName, metadata.toneName),
      creator: firstString(metadata.creator, finalIdentity.creator, "OpenStudio"),
      localPath: committedPath,
      source: firstString(activePreview?.source, committedRecord?.source, "local"),
      previewCommitted: committed,
      metadata,
      license: firstString(metadata.license, finalIdentity.license),
      sourceUrl: firstString(metadata.sourceUrl, finalIdentity.sourceUrl),
      checksum: firstString(committedRecord?.checksum, activePreview?.checksum),
      captureType: activePreview?.captureType ?? (committedRecord ? captureTypeForInstalled(committedRecord) : "unknown"),
      includesCab: Boolean(activePreview?.includesCab ?? (committedRecord ? captureIncludesCab(captureTypeForInstalled(committedRecord)) : false)),
      values,
      modelState: nextModelState,
      slots: {
        pedal: cleanPath(nextModelState.pedalModelPath),
        amp: cleanPath(nextModelState.ampModelPath),
        cab: cleanPath(nextModelState.cabIRPath),
      },
      rackState: {
        ...rackState,
        modelState: nextModelState,
        uiState: {
          namRackSlots: uiState.namRackSlots,
        },
      },
    };

    const statePatch: Record<string, unknown> = {
      values: { auditionSource: 0 },
      uiState: {
        ...uiState,
        namActivePreview: null,
        namSavedTone: savedTone,
      },
    };
    if (shouldPatchModelState) {
      statePatch.modelState = modelStatePatchForSlot(
        slot,
        committedPath,
        declaredCaptureType,
      );
    }

    const ok = await nativeBridge.setBuiltInPluginState(options.address, statePatch);
    if (!ok) return await failWithRollback("Could not prepare the rack state for saving.");

    const presetSaved = await nativeBridge.saveBuiltInFXPreset(
      options.address.trackId || "",
      options.address.fxIndex ?? -1,
      options.address.chain === "input",
      metadata.toneName || options.titleFallback || "NAM Rack Preset",
      options.address.chain,
    );
    if (!presetSaved) {
      return await failWithRollback("The Preset could not be saved for recall.");
    }

    return {
      success: true,
      savedTone,
      committedRecord,
      committed,
    };
  } catch (error) {
    console.warn("[NAMToneSave] Save transaction failed", error);
    return await failWithRollback("The Preset save transaction failed.");
  }
}

export function NAMToneSaveModal({
  isOpen,
  draft,
  busy,
  onDraftChange,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  draft: NAMToneSaveDraft;
  busy: boolean;
  onDraftChange: Dispatch<SetStateAction<NAMToneSaveDraft>>;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!busy) onClose();
      }}
      size="lg"
      title={NAM_PRESET_SAVE_COPY.title}
      className="nam-save-tone-modal"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy || !draft.toneName.trim()}>
            <Save size={14} />
            {busy ? "Saving" : NAM_PRESET_SAVE_COPY.action}
          </Button>
        </>
      )}
    >
      <div className="nam-save-tone-form">
        <div className="nam-save-tone-intro">
          <span>{NAM_PRESET_SAVE_COPY.eyebrow}</span>
          <strong>{draft.toneName.trim() || NAM_PRESET_SAVE_COPY.untitled}</strong>
          <p>{NAM_PRESET_SAVE_COPY.description}</p>
        </div>
        <Input
          autoFocus
          fullWidth
          required
          className="nam-save-tone-field nam-save-tone-name"
          label={NAM_PRESET_SAVE_COPY.nameLabel}
          aria-label={NAM_PRESET_SAVE_COPY.nameLabel}
          value={draft.toneName}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, toneName: value }));
          }}
          placeholder="Clean Twin-style verse"
        />
        <Input
          fullWidth
          className="nam-save-tone-field"
          label="Creator"
          aria-label="Creator"
          value={draft.creator ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, creator: value }));
          }}
          placeholder="Creator"
        />
        <Input
          fullWidth
          className="nam-save-tone-field"
          label="Song Name"
          aria-label="Song Name"
          value={draft.songName ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, songName: value }));
          }}
          placeholder="Song or session"
        />
        <Input
          fullWidth
          className="nam-save-tone-field"
          label="Artist / Reference"
          aria-label="Artist or Reference"
          value={draft.artistReference ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, artistReference: value }));
          }}
          placeholder="Reference artist or record"
        />
        <Input
          fullWidth
          className="nam-save-tone-field"
          label="Genre / Style"
          aria-label="Genre or Style"
          value={draft.genreStyle ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, genreStyle: value }));
          }}
          placeholder="Clean, crunch, metal, ambient"
        />
        <Input
          fullWidth
          className="nam-save-tone-field"
          label="Tags"
          aria-label="Tags"
          value={draft.tagsText}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, tagsText: value }));
          }}
          placeholder="tele, chorus, clean"
        />
        <Input
          fullWidth
          className="nam-save-tone-field"
          label="Source URL"
          aria-label="Source URL"
          value={draft.sourceUrl ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, sourceUrl: value }));
          }}
          placeholder="https://www.tone3000.com/..."
        />
        <Input
          fullWidth
          className="nam-save-tone-field"
          label="License"
          aria-label="License"
          value={draft.license ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, license: value }));
          }}
          placeholder="License"
        />
        <Textarea
          fullWidth
          className="nam-save-tone-field nam-save-tone-notes"
          label="Notes"
          aria-label="Notes"
          rows={3}
          value={draft.notes ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onDraftChange((current) => ({ ...current, notes: value }));
          }}
          placeholder="Pickup, guitar, track, and Preset notes"
        />
        <label className="nam-save-tone-favorite">
          <input
            type="checkbox"
            checked={Boolean(draft.favorite)}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              onDraftChange((current) => ({ ...current, favorite: checked }));
            }}
          />
          <span>Favorite</span>
        </label>
      </div>
    </Modal>
  );
}
