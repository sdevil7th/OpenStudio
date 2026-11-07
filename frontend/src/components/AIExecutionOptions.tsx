import { useId, useSyncExternalStore } from "react";
import { Button } from "./ui";
import type { AiToolsStatus } from "../services/NativeBridge";
import { ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID, type AiMusicModelId } from "../data/aiWorkflows";
import { getAIExecutionPreference, setAIExecutionPreference, subscribeAIExecutionPreferences, type AIExecutionPreference } from "../services/aiExecutionPreferences";

export function AIExecutionOptions({ modelId, variant, status, disabled, onPrepareCompiler }: {
  modelId: AiMusicModelId; variant: "original" | "int8"; status: AiToolsStatus; disabled?: boolean; onPrepareCompiler?: () => void;
}) {
  const id = useId();
  const value = useSyncExternalStore(subscribeAIExecutionPreferences,
    () => getAIExecutionPreference(modelId), () => "standard" as const);
  if (modelId !== ACE_STEP_MODEL_ID && modelId !== STABLE_AUDIO_3_MODEL_ID) return null;
  const qualifiedDevice = status.hardware?.platform === "windows"
    && status.hardware.gpuBackend === "cuda"
    && status.hardware.gpuName?.trim().toLowerCase() === "nvidia geforce rtx 4080";
  const originalReady = status.musicModels?.[modelId]?.ready;
  const qualifiedRocm = status.hardware?.platform === "linux"
    && status.hardware.gpuBackend === "rocm" && status.hardware.gpuArchitecture === "gfx1151";
  const original = originalReady && variant === "original";
  const available = qualifiedDevice && original;
  const fastAvailable = modelId === ACE_STEP_MODEL_ID && qualifiedRocm && original;
  const compilerReady = status.musicModels?.[modelId]?.optimizations?.compile?.ready;
  return (
    <div className="min-w-0 space-y-2 rounded border border-daw-border p-3">
      <label htmlFor={id} className="block text-xs font-medium text-daw-text">Generation execution</label>
      <select id={id} value={value} disabled={disabled || variant === "int8"}
        onChange={(event) => setAIExecutionPreference(modelId, event.target.value as AIExecutionPreference)}
        aria-describedby={`${id}-detail`}
        className="w-full min-w-0 rounded border border-daw-border bg-daw-dark px-3 py-2 text-sm text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent disabled:opacity-50">
        <option value="standard">Automatic — standard precision</option>
        {modelId === ACE_STEP_MODEL_ID
          ? <option value="disk-offload" disabled={!available}>Lower memory — temporary disk</option>
          : <option value="fp8-storage" disabled={!available}>Lower GPU memory — FP8 storage</option>}
        {modelId === ACE_STEP_MODEL_ID && <option value="rocm-fast-startup" disabled={!fastAvailable}>Faster startup — qualified AMD</option>}
        {modelId === STABLE_AUDIO_3_MODEL_ID && <option value="compile" disabled={!available || !compilerReady}>Compile repeated blocks — optional setup</option>}
      </select>
      <p id={`${id}-detail`} className="text-xs leading-5 text-daw-text-muted">
        {variant === "int8" ? "Saved INT8 uses its own execution policy. Choose Original to change this setting."
          : value === "rocm-fast-startup" ? "Uses the tested AMD startup optimization without changing precision. Requires the qualified Linux Radeon 8060S runtime and ACE-Step snapshot. Hardware check verifies compatibility before loading. Generated audio can differ; audition each result."
          : value === "compile" ? "Uses compiled repeated blocks at standard precision. The first generation takes longer; repeated generations can be faster. Requires the prepared compiler runtime and qualified Windows RTX 4080 setup. Generated audio can differ; audition each result."
          : !available && !fastAvailable ? modelId === ACE_STEP_MODEL_ID
            ? "Additional options require an installed Original model and a qualified device. Temporary disk uses Windows RTX 4080; faster AMD startup uses Linux gfx1151. Automatic remains available."
            : "FP8 storage requires an installed Original model and the qualified Windows RTX 4080 configuration. Automatic remains available."
          : value === "fp8-storage" ? "Keeps the original files and normal computation precision, with reduced storage precision for selected transformer layers. Audition each result; quality can vary."
          : value === "disk-offload" ? "Bounds host memory with temporary disk storage. It can be slower and needs extra free disk space."
          : "Chooses placement from available memory while retaining standard precision."}
      </p>
      {modelId === STABLE_AUDIO_3_MODEL_ID && available && onPrepareCompiler && <div className="space-y-2">
        <Button size="sm" disabled={disabled} onClick={onPrepareCompiler}>{compilerReady ? "Repair compiler setup" : "Prepare optional compilation"}</Button>
        <p className="text-xs leading-5 text-daw-text-muted">Downloads a separate runtime and validates two test generations. Requires 20 GiB free disk space. Standard and compiled generation use separate runtime slots.</p>
      </div>}
      <p className="text-xs leading-5 text-daw-text-muted">Local device preference, applied to the next generation. It is not saved in projects.</p>
    </div>
  );
}
