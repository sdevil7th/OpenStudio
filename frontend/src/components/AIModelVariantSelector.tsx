import { useId } from "react";
import type { AiToolsStatus } from "../services/NativeBridge";
import { MINIMAX_MUSIC_3_MODEL_ID, type AiMusicModelId } from "../data/aiWorkflows";

export type AIModelVariant = "original" | "int8";

export function AIModelVariantSelector({ modelId, value, status, onChange, disabled, setup = false }: {
  modelId: AiMusicModelId;
  value: AIModelVariant;
  status: AiToolsStatus;
  onChange: (value: AIModelVariant) => void;
  disabled?: boolean;
  setup?: boolean;
}) {
  const id = useId();
  const cuda = status.hardware?.gpuBackend?.toLowerCase() === "cuda";
  const installed = status.musicModels?.[modelId]?.variants?.int8?.ready ?? false;
  const mini = modelId === MINIMAX_MUSIC_3_MODEL_ID;
  const memory = status.hardware?.gpuMemoryMb ?? 0;
  const suggestion = !cuda
    ? "Use Original on this device. The INT8 version currently requires an NVIDIA GPU."
    : mini && memory > 0 && memory < 16384
      ? "MiniMax is demanding even with INT8. With less than 16 GB of GPU memory, try ACE-Step or Stable Audio first."
    : mini
      ? "Try INT8 for MiniMax on a smaller GPU, including 16 GB cards. It uses less memory and can reduce slow CPU offloading."
      : memory > 0 && memory <= 16384
        ? "Try INT8 to use less GPU memory. Original may be faster when it fits comfortably."
        : "Choose Original when GPU memory is plentiful, or INT8 to reduce memory use.";
  return (
    <div className="min-w-0 space-y-2">
      <p id={`${id}-help`} className="text-xs leading-5 text-daw-text-secondary">{suggestion}</p>
      <label htmlFor={id} className="block text-xs font-medium text-daw-text">Model version</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as AIModelVariant)}
        disabled={disabled} aria-describedby={`${id}-help ${id}-detail`}
        className="w-full min-w-0 rounded border border-daw-border bg-daw-dark px-3 py-2 text-sm text-daw-text focus-visible:outline-2 focus-visible:outline-daw-accent disabled:opacity-50">
        <option value="original">Original — full precision</option>
        <option value="int8" disabled={!cuda}>INT8 — lower memory{installed ? " (installed)" : " (setup needed)"}</option>
      </select>
      <p id={`${id}-detail`} className="text-xs leading-5 text-daw-text-muted">
        {value === "int8"
          ? `${mini ? "8-bit language model; original audio components." : "8-bit diffusion transformer; original audio components."} Quality and speed can vary. ${setup ? "Setup reuses installed weights or downloads the original model, then saves a smaller INT8 copy once. The first download is not smaller." : !cuda ? "Choose Original to generate on this device." : installed ? "Ready to generate locally." : "Download and prepare this version in AI Runtime Setup."}`
          : "Uses the original model weights. Larger models may need slower CPU offloading."}
      </p>
    </div>
  );
}
