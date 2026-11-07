import { ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID } from "../data/aiWorkflows";

export type AIExecutionPreference = "standard" | "disk-offload" | "fp8-storage" | "rocm-fast-startup" | "compile";
const key = "openstudio.ai-execution-preferences.v1";
let cached: Record<string, AIExecutionPreference> | undefined;

function valid(model: string, value: unknown): value is AIExecutionPreference {
  return value === "standard" || model === ACE_STEP_MODEL_ID && (value === "disk-offload" || value === "rocm-fast-startup")
    || model === STABLE_AUDIO_3_MODEL_ID && (value === "fp8-storage" || value === "compile");
}

function read(): Record<string, AIExecutionPreference> {
  if (cached) return cached;
  cached = {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (value && typeof value === "object") {
      for (const model of [ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID]) {
        const preference = (value as Record<string, unknown>)[model];
        if (valid(model, preference)) cached[model] = preference;
      }
    }
  } catch { /* Standard remains usable if local storage is unavailable. */ }
  return cached;
}

export function getAIExecutionPreference(model: string): AIExecutionPreference {
  return read()[model] ?? "standard";
}

export function setAIExecutionPreference(model: string, value: AIExecutionPreference): void {
  if (!valid(model, value)) throw new Error("This execution option is unavailable for the selected model.");
  cached = { ...read(), [model]: value };
  try { window.localStorage.setItem(key, JSON.stringify(cached)); } catch { /* Keep the session choice. */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(key));
}

export function subscribeAIExecutionPreferences(changed: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) { cached = undefined; changed(); } };
  window.addEventListener(key, changed);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(key, changed); window.removeEventListener("storage", storage); };
}

// Apply only at the native request boundary. These hardware preferences never
// enter portable track/clip parameters, undo history, presets or project files.
export function withAIExecutionPreference(model: string, params: Record<string, unknown>): Record<string, unknown> {
  const preference = getAIExecutionPreference(model);
  return preference === "standard" || params.modelVariant === "int8"
    ? { ...params } : { ...params, generationOptimization: preference };
}
