import { describe, expect, it } from "vitest";
import modalSource from "../components/AiToolsSetupModal.tsx?raw";
import bridgeSource from "../services/NativeBridge.ts?raw";
import storeSource from "../store/useDAWStore.ts?raw";
import mainComponentSource from "../../../Source/MainComponent.cpp?raw";
import stemSeparatorSource from "../../../Source/StemSeparator.cpp?raw";

describe("AI feature installer contract", () => {
  it("defaults the setup checklist to requested compatible features or stem separation", () => {
    expect(modalSource).toContain("const AI_FEATURES: AiFeatureId[] = [\"stemSeparation\", \"audioGeneration\"]");
    expect(modalSource).toContain("function defaultSelectedFeatures");
    expect(modalSource).toContain("if (requestedFeature)");
    expect(modalSource).toContain("return stem.compatible && !stem.ready ? [\"stemSeparation\"] : []");
  });

  it("keeps incompatible Audio Generation disabled while Stem Separation remains selectable", () => {
    expect(modalSource).toContain("function buildSetupCatalog");
    expect(modalSource).toContain("disabled = !item.compatible && !item.ready");
    expect(modalSource).toContain("title={disabled ? item.disabledReason : statusLabel(item)}");
    expect(modalSource).toContain("Hardware not supported");
    expect(modalSource).toContain("Incompatible features are disabled and will not be installed.");
    expect(modalSource).toContain("supported GPU with at least 8 GB memory was not detected");
    expect(modalSource).toContain("CPU-only machines are supported.");
  });

  it("sends modular feature selections over the native bridge", () => {
    expect(bridgeSource).toContain("export type AiFeatureId = \"stemSeparation\" | \"audioGeneration\"");
    expect(bridgeSource).toContain("selectedFeatures?: AiFeatureId[]");
    expect(bridgeSource).toContain("requestedFeature?: AiFeatureId");
    expect(bridgeSource).toContain("JSON.stringify(options)");
  });

  it("keeps old install calls as a stem-separation default in the store", () => {
    expect(storeSource).toContain("options.requestedFeature ?? \"stemSeparation\"");
    expect(storeSource).toContain("selectedFeatures: [\"stemSeparation\"]");
  });

  it("exposes strict Stable Audio 3 manual import controls", () => {
    expect(modalSource).toContain("STABLE_AUDIO_MODEL_URL");
    expect(modalSource).toContain("Open Hugging Face Model Page");
    expect(modalSource).toContain("Proceed with Setup");
    expect(modalSource).toContain("Use Downloads Folder");
    expect(modalSource).toContain("Cancel Setup");
    expect(modalSource).toContain("stableAudioSelectedFolder");
    expect(modalSource).toContain("modelId: STABLE_AUDIO_3_MODEL_ID");
    expect(modalSource).toContain("stableAudioLicenseAccepted");
    expect(modalSource).toContain("LICENSE_GEMMA.md");
    expect(bridgeSource).toContain("stableAudioModelPath?: string");
    expect(bridgeSource).toContain("stableAudioLicenseAccepted?: boolean");
    expect(bridgeSource).toContain("modelId?: AiMusicModelId");
    expect(mainComponentSource).toContain(".withNativeFunction (\"browseForFolder\"");
    expect(mainComponentSource).toContain("canSelectDirectories");
  });

  it("validates Stable Audio 3 folder layout and license before import", () => {
    expect(stemSeparatorSource).toContain("model.safetensors");
    expect(stemSeparatorSource).toContain("t5gemma-b-b-ul2/tokenizer.model");
    expect(stemSeparatorSource).toContain("Stable Audio 3 setup requires accepting");
    expect(stemSeparatorSource).toContain("stable_audio_model_path_required");
    expect(stemSeparatorSource).toContain("stable_audio_model_layout_invalid");
    expect(stemSeparatorSource).toContain("stable_audio_import_requested");
    expect(stemSeparatorSource).toContain("stable_audio_command_started");
    expect(stemSeparatorSource).toContain("Stable Audio 3 dependencies can take several minutes to install.");
    expect(stemSeparatorSource).toContain("stable_audio_command_cancelled");
    expect(stemSeparatorSource).toContain("copyDirectoryTo(destination)");
  });

  it("keeps Stable Audio runtime separate from the ACE runtime", () => {
    expect(stemSeparatorSource).toContain("getStableAudioRuntimeRoot");
    expect(stemSeparatorSource).toContain("stable-audio-runtime");
    expect(stemSeparatorSource).toContain("Installing Stable Audio 3 CUDA PyTorch runtime");
    expect(stemSeparatorSource).toContain("git+https://github.com/Stability-AI/stable-audio-3.git");
    expect(stemSeparatorSource).toContain("stable_audio_flash_attention_skipped");
    expect(stemSeparatorSource).toContain("PyTorch attention fallback");
  });

  it("keeps Stable Audio install options intact through the store action", () => {
    expect(storeSource).toContain("const isStableAudioImport = options.modelId === STABLE_AUDIO_3_MODEL_ID");
    expect(storeSource).toContain("...options");
    expect(storeSource).toContain("Stable Audio 3 setup is starting in the background.");
  });

  it("sanitizes internal ACE runtime paths from setup UI copy", () => {
    expect(modalSource).toContain("function sanitizeSetupMessage");
    expect(modalSource).toContain("ACE-Step runtime files are missing. Repair or reinstall ACE-Step Audio Generation setup.");
    expect(modalSource).toContain("displayActivityLines");
  });
});
