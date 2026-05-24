export const ACE_STEP_MODEL_ID = "ace-step-v15-xl-turbo" as const;
export const STABLE_AUDIO_3_MODEL_ID = "stable-audio-3-medium" as const;
export const DEFAULT_AI_MUSIC_MODEL_ID = ACE_STEP_MODEL_ID;

export type AiMusicModelId =
  | typeof ACE_STEP_MODEL_ID
  | typeof STABLE_AUDIO_3_MODEL_ID;

export type AIWorkflowSurface = "ai-track" | "clip-context";

export type AIWorkflowId =
  | "text-to-music"
  | "lyrics-style"
  | "text-to-audio"
  | "variation"
  | "inpaint-selection"
  | "continue-clip";

export type AIWorkflowParamType =
  | "text"
  | "textarea"
  | "number"
  | "slider"
  | "select"
  | "toggle";

export type AIWorkflowSection =
  | "prompt"
  | "source"
  | "music"
  | "sampling"
  | "generation"
  | "advanced";

export interface AIMusicModel {
  id: AiMusicModelId;
  label: string;
  shortLabel: string;
  provider: "ace-step" | "stability-ai";
  attribution?: string;
}

export interface AIWorkflowParam {
  key: string;
  label: string;
  type: AIWorkflowParamType;
  default: unknown;
  section: AIWorkflowSection;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  placeholder?: string;
  description?: string;
}

export interface AIWorkflowSourceRequirement {
  requiresAudioClip: boolean;
  requiresTimeSelection?: boolean;
  outputMode: "new-track-full" | "continuation-tail";
}

export interface AIWorkflow {
  id: AIWorkflowId;
  label: string;
  description: string;
  surface: AIWorkflowSurface;
  modelIds: AiMusicModelId[];
  params: AIWorkflowParam[];
  sourceRequirement?: AIWorkflowSourceRequirement;
  available?: boolean;
  availabilityNote?: string;
}

interface AIWorkflowDefinition extends Omit<AIWorkflow, "params"> {
  params?: AIWorkflowParam[];
  paramsByModel?: Partial<Record<AiMusicModelId, AIWorkflowParam[]>>;
}

export const AI_MUSIC_MODELS: AIMusicModel[] = [
  {
    id: ACE_STEP_MODEL_ID,
    label: "ACE-Step 1.5 XL Turbo",
    shortLabel: "ACE-Step",
    provider: "ace-step",
  },
  {
    id: STABLE_AUDIO_3_MODEL_ID,
    label: "Stable Audio 3 Medium",
    shortLabel: "Stable Audio 3",
    provider: "stability-ai",
    attribution: "Powered by Stability AI",
  },
];

export const AI_WORKFLOW_SECTION_LABELS: Record<AIWorkflowSection, string> = {
  prompt: "Prompt",
  source: "Source Workflow",
  music: "Musical Controls",
  sampling: "Sampling Controls",
  generation: "Generation",
  advanced: "Advanced",
};

const LANGUAGE_OPTIONS = ["en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh"];
const TIME_SIGNATURE_OPTIONS = ["4/4", "3/4", "6/8", "5/4", "7/8"];
const KEY_SCALE_OPTIONS = [
  "C major",
  "C minor",
  "C# major",
  "C# minor",
  "D major",
  "D minor",
  "D# major",
  "D# minor",
  "E major",
  "E minor",
  "F major",
  "F minor",
  "F# major",
  "F# minor",
  "G major",
  "G minor",
  "G# major",
  "G# minor",
  "A major",
  "A minor",
  "A# major",
  "A# minor",
  "B major",
  "B minor",
];

const ACE_PROMPT_PARAM: AIWorkflowParam = {
  key: "prompt",
  label: "Prompt",
  type: "textarea",
  section: "prompt",
  placeholder:
    "mellow melodic rock, soft acoustic guitar intro, deep groovy bass, harmonic female and male vocals",
  default: "",
};

const ACE_LYRICS_PARAM: AIWorkflowParam = {
  key: "lyrics",
  label: "Lyrics",
  type: "textarea",
  section: "prompt",
  placeholder: "[verse]\nLine one\nLine two\n[chorus]\n...",
  default: "",
};

const ACE_BASE_PARAMS: AIWorkflowParam[] = [
  ACE_PROMPT_PARAM,
  ACE_LYRICS_PARAM,
  {
    key: "seed",
    label: "Seed",
    type: "number",
    section: "sampling",
    default: -1,
  },
  {
    key: "bpm",
    label: "BPM",
    type: "number",
    section: "music",
    min: 40,
    max: 240,
    step: 1,
    default: 120,
  },
  {
    key: "duration",
    label: "Duration (seconds)",
    type: "slider",
    section: "music",
    min: 5,
    max: 240,
    step: 1,
    default: 30,
  },
  {
    key: "timesignature",
    label: "Time Signature",
    type: "select",
    section: "music",
    options: TIME_SIGNATURE_OPTIONS,
    default: "4/4",
  },
  {
    key: "language",
    label: "Language",
    type: "select",
    section: "music",
    options: LANGUAGE_OPTIONS,
    default: "en",
  },
  {
    key: "keyscale",
    label: "Key / Scale",
    type: "select",
    section: "music",
    options: KEY_SCALE_OPTIONS,
    default: "C major",
  },
  {
    key: "generate_audio_codes",
    label: "Generate Audio Codes",
    type: "toggle",
    section: "generation",
    default: true,
    description:
      "Matches the OpenStudio ACE split-graph workflow. Disable only for manual direct DiT troubleshooting.",
  },
  {
    key: "inferenceSteps",
    label: "Diffusion Steps",
    type: "slider",
    section: "generation",
    min: 4,
    max: 24,
    step: 1,
    default: 8,
  },
  {
    key: "cfg_scale",
    label: "Text Encoder CFG",
    type: "slider",
    section: "sampling",
    min: 0,
    max: 10,
    step: 0.05,
    default: 2,
  },
  {
    key: "guidance_scale",
    label: "Sampler CFG",
    type: "slider",
    section: "generation",
    min: 0,
    max: 20,
    step: 0.5,
    default: 1,
  },
  {
    key: "shift",
    label: "Turbo Shift",
    type: "slider",
    section: "generation",
    min: 1,
    max: 5,
    step: 0.05,
    default: 3,
  },
  {
    key: "temperature",
    label: "Temperature",
    type: "slider",
    section: "sampling",
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.85,
  },
  {
    key: "top_p",
    label: "Top P",
    type: "slider",
    section: "sampling",
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.9,
  },
  {
    key: "top_k",
    label: "Top K",
    type: "number",
    section: "sampling",
    min: 0,
    max: 200,
    step: 1,
    default: 0,
  },
  {
    key: "min_p",
    label: "Min P",
    type: "slider",
    section: "sampling",
    min: 0,
    max: 1,
    step: 0.001,
    default: 0,
  },
];

const ACE_VARIATION_PROMPT_PARAM: AIWorkflowParam = {
  ...ACE_PROMPT_PARAM,
  label: "Variation Direction",
  placeholder: "Describe the musical change while preserving the source instrumentation",
  default:
    "Create a close musical variation that preserves the source clip's tempo, key, primary instrument, and arrangement density. Do not add vocals or unrelated instruments unless requested.",
};

const ACE_INPAINT_PROMPT_PARAM: AIWorkflowParam = {
  ...ACE_PROMPT_PARAM,
  label: "Replacement Direction",
  placeholder: "Describe the replacement while matching the surrounding audio",
  default: "Replace the selected range naturally while matching the surrounding clip's instrument, tone, tempo, and room.",
};

const ACE_CONTINUE_PROMPT_PARAM: AIWorkflowParam = {
  ...ACE_PROMPT_PARAM,
  label: "Continuation Direction",
  placeholder: "Describe the generated tail while preserving the source instrumentation",
  default:
    "Continue the same musical idea, matching the source clip's tempo, key, primary instrument, tone, room, and mix. Do not add vocals or unrelated instruments unless requested.",
};

const ACE_SOURCE_STRENGTH_PARAM: AIWorkflowParam = {
  key: "audio_cover_strength",
  label: "Source Preservation",
  type: "slider",
  section: "source",
  min: 0,
  max: 1,
  step: 0.01,
  default: 0.55,
  description: "Higher values keep more of the source clip's identity.",
};

const ACE_SOURCE_EXTENSION_PARAM: AIWorkflowParam = {
  key: "extension_duration",
  label: "Tail Length (seconds)",
  type: "slider",
  section: "source",
  min: 2,
  max: 120,
  step: 1,
  default: 20,
};

const ACE_SOURCE_AUDIO_CODES_PARAM: AIWorkflowParam = {
  ...ACE_BASE_PARAMS.find((param) => param.key === "generate_audio_codes")!,
  default: false,
};

const ACE_SOURCE_SAMPLING_PARAMS: AIWorkflowParam[] = [
  ACE_SOURCE_AUDIO_CODES_PARAM,
  {
    key: "seed",
    label: "Seed",
    type: "number",
    section: "sampling",
    default: -1,
  },
  {
    key: "inferenceSteps",
    label: "Diffusion Steps",
    type: "slider",
    section: "generation",
    min: 4,
    max: 24,
    step: 1,
    default: 8,
  },
  {
    key: "cfg_scale",
    label: "Text Encoder CFG",
    type: "slider",
    section: "sampling",
    min: 0,
    max: 10,
    step: 0.05,
    default: 2,
  },
  {
    key: "guidance_scale",
    label: "Sampler CFG",
    type: "slider",
    section: "generation",
    min: 0,
    max: 20,
    step: 0.5,
    default: 1,
  },
];

const ACE_VARIATION_PARAMS: AIWorkflowParam[] = [
  ACE_VARIATION_PROMPT_PARAM,
  ACE_SOURCE_STRENGTH_PARAM,
  ...ACE_SOURCE_SAMPLING_PARAMS,
];

const ACE_INPAINT_PARAMS: AIWorkflowParam[] = [
  ACE_INPAINT_PROMPT_PARAM,
  ACE_SOURCE_STRENGTH_PARAM,
  ...ACE_SOURCE_SAMPLING_PARAMS,
];

const ACE_CONTINUE_PARAMS: AIWorkflowParam[] = [
  ACE_CONTINUE_PROMPT_PARAM,
  ACE_SOURCE_EXTENSION_PARAM,
  ACE_SOURCE_STRENGTH_PARAM,
  ...ACE_SOURCE_SAMPLING_PARAMS,
];

const STABLE_TEXT_PARAMS: AIWorkflowParam[] = [
  {
    key: "prompt",
    label: "Prompt",
    type: "textarea",
    section: "prompt",
    placeholder: "cinematic analog synth pulse, wide stereo ambience, clean impact",
    default: "",
  },
  {
    key: "negative_prompt",
    label: "Negative Prompt",
    type: "textarea",
    section: "prompt",
    placeholder: "distorted, noisy, clipped, low quality",
    default: "",
  },
  {
    key: "seed",
    label: "Seed",
    type: "number",
    section: "sampling",
    default: -1,
  },
  {
    key: "duration",
    label: "Duration (seconds)",
    type: "slider",
    section: "generation",
    min: 1,
    max: 240,
    step: 1,
    default: 30,
  },
  {
    key: "steps",
    label: "Steps",
    type: "slider",
    section: "generation",
    min: 4,
    max: 32,
    step: 1,
    default: 8,
    description: "Stable Audio 3 Medium is tuned for 8 steps; very high step counts can reduce quality.",
  },
  {
    key: "cfg_scale",
    label: "CFG Scale",
    type: "slider",
    section: "sampling",
    min: 0.1,
    max: 3,
    step: 0.1,
    default: 1,
    description: "Use the medium-model range. CFG 7 is for base models and can sound over-guided here.",
  },
  {
    key: "lora_path",
    label: "LoRA Path",
    type: "text",
    section: "advanced",
    placeholder: "Optional .safetensors file",
    default: "",
  },
  {
    key: "lora_strength",
    label: "LoRA Strength",
    type: "slider",
    section: "advanced",
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
  },
];

const STABLE_VARIATION_PROMPT_PARAM: AIWorkflowParam = {
  ...STABLE_TEXT_PARAMS[0],
  label: "Variation Direction",
  placeholder: "Describe the musical change while preserving the source instrumentation",
  default:
    "Create a close musical variation that preserves the source clip's tempo, key, primary instrument, arrangement density, and mix character. Do not add vocals or unrelated instruments unless requested.",
};

const STABLE_INPAINT_PROMPT_PARAM: AIWorkflowParam = {
  ...STABLE_TEXT_PARAMS[0],
  label: "Replacement Direction",
  placeholder: "Optional direction for the selected replacement range",
  default: "Replace the selected range naturally while matching the surrounding clip.",
};

const STABLE_CONTINUE_PROMPT_PARAM: AIWorkflowParam = {
  ...STABLE_TEXT_PARAMS[0],
  label: "Continuation Direction",
  placeholder: "Describe the generated tail while preserving the source instrumentation",
  default:
    "Continue the same musical idea, matching the source clip's tempo, key, primary instrument, harmony, room tone, and mix. Do not add vocals or unrelated instruments unless requested.",
};

const STABLE_SOURCE_NEGATIVE_PARAM: AIWorkflowParam = {
  ...STABLE_TEXT_PARAMS[1],
  placeholder: "distorted, noisy, clipped, abrupt transition, low quality",
  default: "unrelated instruments, unexpected vocals, full band arrangement unless present in the source, distorted, noisy, clipped, abrupt transition, low quality",
};

const STABLE_SOURCE_SEED_PARAM = STABLE_TEXT_PARAMS[2];
const STABLE_SOURCE_STEPS_PARAM = STABLE_TEXT_PARAMS[4];
const STABLE_SOURCE_CFG_PARAM = STABLE_TEXT_PARAMS[5];
const STABLE_SOURCE_LORA_PATH_PARAM = STABLE_TEXT_PARAMS[6];
const STABLE_SOURCE_LORA_STRENGTH_PARAM = STABLE_TEXT_PARAMS[7];

const STABLE_SOURCE_EXTENSION_PARAM: AIWorkflowParam = {
  key: "extension_duration",
  label: "Tail Length (seconds)",
  type: "slider",
  section: "source",
  min: 1,
  max: 120,
  step: 1,
  default: 8,
};

const STABLE_VARIATION_AMOUNT_PARAM: AIWorkflowParam = {
  key: "noise_amount",
  label: "Variation Amount",
  type: "slider",
  section: "source",
  min: 0,
  max: 1,
  step: 0.01,
  default: 0.5,
  description:
    "Lower values reconstruct more of the source clip; higher values rewrite more of it. Around 0.5 is a safer default for single-instrument clips.",
};

const STABLE_SOURCE_ADVANCED_PARAMS: AIWorkflowParam[] = [
  STABLE_SOURCE_STEPS_PARAM,
  STABLE_SOURCE_CFG_PARAM,
  STABLE_SOURCE_LORA_PATH_PARAM,
  STABLE_SOURCE_LORA_STRENGTH_PARAM,
];

const STABLE_VARIATION_PARAMS: AIWorkflowParam[] = [
  STABLE_VARIATION_PROMPT_PARAM,
  STABLE_SOURCE_NEGATIVE_PARAM,
  STABLE_SOURCE_SEED_PARAM,
  STABLE_VARIATION_AMOUNT_PARAM,
  ...STABLE_SOURCE_ADVANCED_PARAMS,
];

const STABLE_INPAINT_PARAMS: AIWorkflowParam[] = [
  STABLE_INPAINT_PROMPT_PARAM,
  STABLE_SOURCE_NEGATIVE_PARAM,
  STABLE_SOURCE_SEED_PARAM,
  ...STABLE_SOURCE_ADVANCED_PARAMS,
];

const STABLE_CONTINUE_PARAMS: AIWorkflowParam[] = [
  STABLE_CONTINUE_PROMPT_PARAM,
  STABLE_SOURCE_NEGATIVE_PARAM,
  STABLE_SOURCE_SEED_PARAM,
  STABLE_SOURCE_EXTENSION_PARAM,
  ...STABLE_SOURCE_ADVANCED_PARAMS,
];

const AI_WORKFLOW_DEFINITIONS: AIWorkflowDefinition[] = [
  {
    id: "text-to-music",
    label: "Text to Music",
    description: "Generate a fresh music clip from a detailed style and arrangement prompt.",
    surface: "ai-track",
    modelIds: [ACE_STEP_MODEL_ID],
    params: ACE_BASE_PARAMS,
    available: true,
  },
  {
    id: "lyrics-style",
    label: "Lyrics + Style",
    description: "Generate a song guided by both prompt text and structured lyrics.",
    surface: "ai-track",
    modelIds: [ACE_STEP_MODEL_ID],
    params: ACE_BASE_PARAMS,
    available: true,
  },
  {
    id: "text-to-audio",
    label: "Text to Audio",
    description: "Generate audio from a text prompt with Stable Audio 3 Medium.",
    surface: "ai-track",
    modelIds: [STABLE_AUDIO_3_MODEL_ID],
    params: STABLE_TEXT_PARAMS,
    available: true,
  },
  {
    id: "variation",
    label: "Create Variation",
    description: "Generate a source-conditioned variation aligned to the original clip.",
    surface: "clip-context",
    modelIds: [ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID],
    paramsByModel: {
      [ACE_STEP_MODEL_ID]: ACE_VARIATION_PARAMS,
      [STABLE_AUDIO_3_MODEL_ID]: STABLE_VARIATION_PARAMS,
    },
    sourceRequirement: {
      requiresAudioClip: true,
      outputMode: "new-track-full",
    },
    available: true,
  },
  {
    id: "inpaint-selection",
    label: "Inpaint Selection",
    description: "Regenerate the selected time range while keeping the clip around it.",
    surface: "clip-context",
    modelIds: [ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID],
    paramsByModel: {
      [ACE_STEP_MODEL_ID]: ACE_INPAINT_PARAMS,
      [STABLE_AUDIO_3_MODEL_ID]: STABLE_INPAINT_PARAMS,
    },
    sourceRequirement: {
      requiresAudioClip: true,
      requiresTimeSelection: true,
      outputMode: "new-track-full",
    },
    available: true,
  },
  {
    id: "continue-clip",
    label: "Continue Clip",
    description: "Generate a continuation tail from the selected source clip.",
    surface: "clip-context",
    modelIds: [ACE_STEP_MODEL_ID, STABLE_AUDIO_3_MODEL_ID],
    paramsByModel: {
      [ACE_STEP_MODEL_ID]: ACE_CONTINUE_PARAMS,
      [STABLE_AUDIO_3_MODEL_ID]: STABLE_CONTINUE_PARAMS,
    },
    sourceRequirement: {
      requiresAudioClip: true,
      outputMode: "continuation-tail",
    },
    available: true,
  },
];

export const AI_WORKFLOWS: AIWorkflow[] = AI_WORKFLOW_DEFINITIONS.map((workflow) =>
  resolveWorkflowForModel(workflow, workflow.modelIds[0]),
);

export function resolveAiMusicModelId(
  modelId?: string | null,
): AiMusicModelId {
  return AI_MUSIC_MODELS.some((model) => model.id === modelId)
    ? (modelId as AiMusicModelId)
    : DEFAULT_AI_MUSIC_MODEL_ID;
}

export function getAiMusicModel(modelId?: string | null): AIMusicModel {
  const resolvedModelId = resolveAiMusicModelId(modelId);
  return AI_MUSIC_MODELS.find((model) => model.id === resolvedModelId) ?? AI_MUSIC_MODELS[0];
}

export function normalizeWorkflowId(
  workflowId?: string | null,
): AIWorkflowId | null {
  if (workflowId === "lyrics+style") {
    return "lyrics-style";
  }
  if (AI_WORKFLOW_DEFINITIONS.some((workflow) => workflow.id === workflowId)) {
    return workflowId as AIWorkflowId;
  }
  return null;
}

function getWorkflowDefinition(
  workflowId?: string | null,
): AIWorkflowDefinition | undefined {
  const normalizedId = normalizeWorkflowId(workflowId);
  return AI_WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === normalizedId);
}

function resolveWorkflowForModel(
  workflow: AIWorkflowDefinition,
  modelId: AiMusicModelId,
): AIWorkflow {
  const params =
    workflow.paramsByModel?.[modelId]
    ?? workflow.params
    ?? workflow.paramsByModel?.[workflow.modelIds[0]]
    ?? [];
  return {
    ...workflow,
    params,
  };
}

export function isModelSupportedForWorkflow(
  modelId: string | null | undefined,
  workflowId: string | null | undefined,
) {
  const resolvedModelId = resolveAiMusicModelId(modelId);
  const workflow = getWorkflowDefinition(workflowId);
  return Boolean(workflow?.modelIds.includes(resolvedModelId));
}

export function getAIWorkflowsForSurface(
  surface: AIWorkflowSurface,
  modelId?: string | null,
): AIWorkflow[] {
  const resolvedModelId = resolveAiMusicModelId(modelId);
  return AI_WORKFLOW_DEFINITIONS
    .filter((workflow) => (
      workflow.surface === surface
      && workflow.modelIds.includes(resolvedModelId)
      && workflow.available !== false
    ))
    .map((workflow) => resolveWorkflowForModel(workflow, resolvedModelId));
}

export function getAIModelsForWorkflow(
  workflowId?: string | null,
): AIMusicModel[] {
  const workflow = getWorkflowDefinition(workflowId);
  if (!workflow) return [AI_MUSIC_MODELS[0]];
  return AI_MUSIC_MODELS.filter((model) => workflow.modelIds.includes(model.id));
}

export function getDefaultWorkflowForModel(
  modelId?: string | null,
  surface: AIWorkflowSurface = "ai-track",
): AIWorkflow {
  return getAIWorkflowsForSurface(surface, modelId)[0]
    ?? getAIWorkflowsForSurface(surface, DEFAULT_AI_MUSIC_MODEL_ID)[0]
    ?? AI_WORKFLOWS[0];
}

export function getAIWorkflow(
  workflowId?: string | null,
  modelId?: string | null,
  surface?: AIWorkflowSurface,
): AIWorkflow {
  const resolvedModelId = resolveAiMusicModelId(modelId);
  const workflow = getWorkflowDefinition(workflowId);
  if (
    workflow
    && workflow.modelIds.includes(resolvedModelId)
    && (!surface || workflow.surface === surface)
  ) {
    return resolveWorkflowForModel(workflow, resolvedModelId);
  }
  return getDefaultWorkflowForModel(resolvedModelId, surface ?? workflow?.surface ?? "ai-track");
}

function normalizeText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : String(value ?? fallback);
}

function normalizeNumber(
  value: unknown,
  fallback: number,
  min?: number,
  max?: number,
) {
  const parsed =
    typeof value === "number"
      ? value
      : value === "" || value == null
        ? fallback
        : Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  if (typeof min === "number" && typeof max === "number") {
    return Math.min(max, Math.max(min, safeValue));
  }
  if (typeof min === "number") {
    return Math.max(min, safeValue);
  }
  if (typeof max === "number") {
    return Math.min(max, safeValue);
  }
  return safeValue;
}

function normalizeToggle(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "off"].includes(lowered)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function normalizeSelectValue(param: AIWorkflowParam, value: unknown) {
  const normalized = normalizeText(value, String(param.default ?? ""));
  if (param.options?.includes(normalized)) {
    return normalized;
  }
  if (param.key === "timesignature") {
    if (/^\d+\/\d+$/.test(normalized)) return normalized;
    const numeric = Number(normalized);
    if (Number.isFinite(numeric) && numeric > 0) {
      return `${Math.round(numeric)}/4`;
    }
  }
  return String(param.default ?? "");
}

export function getDefaultWorkflowParams(
  workflowId?: string | null,
  modelId?: string | null,
): Record<string, unknown> {
  const workflow = getAIWorkflow(workflowId, modelId);
  return Object.fromEntries(
    workflow.params.map((param) => [param.key, param.default]),
  );
}

export function normalizeWorkflowParams(
  workflowId?: string | null,
  params?: Record<string, unknown>,
  modelId?: string | null,
): Record<string, unknown> {
  const workflow = getAIWorkflow(workflowId, modelId);
  const source = params ?? {};
  const normalized = Object.fromEntries(
    workflow.params.map((param) => {
      const value = source[param.key];

      if (param.type === "textarea" || param.type === "text") {
        return [param.key, normalizeText(value, String(param.default ?? ""))];
      }

      if (param.type === "number" || param.type === "slider") {
        return [
          param.key,
          normalizeNumber(
            value,
            Number(param.default ?? 0),
            param.min,
            param.max,
          ),
        ];
      }

      if (param.type === "toggle") {
        return [param.key, normalizeToggle(value, Boolean(param.default))];
      }

      return [param.key, normalizeSelectValue(param, value)];
    }),
  );

  return normalized;
}

export function mergeWorkflowParams(
  workflowId?: string | null,
  params?: Record<string, unknown>,
  modelId?: string | null,
): Record<string, unknown> {
  return normalizeWorkflowParams(workflowId, {
    ...getDefaultWorkflowParams(workflowId, modelId),
    ...(params ?? {}),
  }, modelId);
}

export function getClipInpaintRange(
  timeSelection: { start: number; end: number } | null | undefined,
  clip: { startTime: number; duration: number },
) {
  if (!timeSelection) {
    return null;
  }
  const clipEnd = clip.startTime + clip.duration;
  const rangeStart = Math.max(timeSelection.start, clip.startTime) - clip.startTime;
  const rangeEnd = Math.min(timeSelection.end, clipEnd) - clip.startTime;
  if (rangeEnd <= rangeStart) {
    return null;
  }
  return {
    start: Math.max(0, rangeStart),
    end: Math.min(clip.duration, rangeEnd),
  };
}
