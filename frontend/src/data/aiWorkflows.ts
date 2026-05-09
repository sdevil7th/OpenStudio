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
  | "output";

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
  hidden?: boolean;
  advanced?: boolean;
  unit?: string;
}

export interface AIWorkflow {
  id: string;
  label: string;
  description: string;
  params: AIWorkflowParam[];
  available?: boolean;
  availabilityNote?: string;
}

export const AI_WORKFLOW_SECTION_LABELS: Record<AIWorkflowSection, string> = {
  prompt: "Prompt and Lyrics",
  source: "Audio Source",
  music: "Musical Controls",
  sampling: "Sampling Controls",
  generation: "Generation",
  output: "Output",
};

const LANGUAGE_OPTIONS = ["en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh"];
const TIME_SIGNATURE_OPTIONS = ["4/4", "3/4", "6/8", "5/4", "7/8"];
const OUTPUT_PLACEMENT_OPTIONS = ["align-source", "playhead", "after-source", "custom"];
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

const PROMPT_PARAM: AIWorkflowParam = {
  key: "prompt",
  label: "Prompt",
  type: "textarea",
  section: "prompt",
  placeholder:
    "mellow melodic rock, soft acoustic guitar intro, deep groovy bass, harmonic female and male vocals",
  default: "",
};

const LYRICS_PARAM: AIWorkflowParam = {
  key: "lyrics",
  label: "Lyrics",
  type: "textarea",
  section: "prompt",
  placeholder: "[verse]\nLine one\nLine two\n[chorus]\n...",
  default: "",
};

const TASK_TYPE_PARAM = (defaultValue: "text2music" | "cover" | "repaint"): AIWorkflowParam => ({
  key: "task_type",
  label: "Task Type",
  type: "text",
  section: "source",
  default: defaultValue,
  hidden: true,
});

const CONTEXT_SOURCE_PARAMS: AIWorkflowParam[] = [
  {
    key: "sourceTrackId",
    label: "Source Track ID",
    type: "text",
    section: "source",
    default: "",
    hidden: true,
  },
  {
    key: "sourceClipId",
    label: "Source Clip ID",
    type: "text",
    section: "source",
    default: "",
    hidden: true,
  },
  {
    key: "sourceAudioPath",
    label: "Source Audio Path",
    type: "text",
    section: "source",
    default: "",
    hidden: true,
  },
  {
    key: "referenceAudioPath",
    label: "Reference Audio Path",
    type: "text",
    section: "source",
    default: "",
    hidden: true,
  },
  {
    key: "srcAudioPath",
    label: "Source Audio Path",
    type: "text",
    section: "source",
    default: "",
    hidden: true,
  },
];

const MUSIC_PARAMS: AIWorkflowParam[] = [
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
    label: "Duration",
    type: "slider",
    section: "music",
    min: 1,
    max: 240,
    step: 1,
    default: 30,
    unit: "s",
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
];

const SAMPLING_PARAMS: AIWorkflowParam[] = [
  {
    key: "seed",
    label: "Seed",
    type: "number",
    section: "sampling",
    default: -1,
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
    key: "temperature",
    label: "Temperature",
    type: "slider",
    section: "sampling",
    min: 0,
    max: 2,
    step: 0.01,
    default: 0.85,
    advanced: true,
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
    advanced: true,
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
    advanced: true,
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
    advanced: true,
  },
];

const GENERATION_PARAMS: AIWorkflowParam[] = [
  {
    key: "generate_audio_codes",
    label: "Generate Audio Codes",
    type: "toggle",
    section: "generation",
    default: true,
    description:
      "Matches the OpenStudio ACE split-graph workflow. Disable only for manual direct DiT troubleshooting.",
    advanced: true,
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
];

const OUTPUT_PARAMS: AIWorkflowParam[] = [
  {
    key: "outputPlacement",
    label: "Clip Placement",
    type: "select",
    section: "output",
    options: OUTPUT_PLACEMENT_OPTIONS,
    default: "align-source",
  },
  {
    key: "customStartTime",
    label: "Custom Start",
    type: "number",
    section: "output",
    min: 0,
    step: 0.001,
    default: 0,
    unit: "s",
  },
];

const COVER_STRENGTH_PARAM: AIWorkflowParam = {
  key: "audio_cover_strength",
  label: "Cover Strength",
  type: "slider",
  section: "source",
  min: 0,
  max: 1,
  step: 0.01,
  default: 0.55,
};

const REPAINT_PARAMS: AIWorkflowParam[] = [
  {
    key: "repainting_start",
    label: "Repaint Start",
    type: "number",
    section: "source",
    min: 0,
    step: 0.001,
    default: 0,
    unit: "s",
  },
  {
    key: "repainting_end",
    label: "Repaint End",
    type: "number",
    section: "source",
    min: 0,
    step: 0.001,
    default: 30,
    unit: "s",
  },
  {
    ...COVER_STRENGTH_PARAM,
    label: "Edit Strength",
    default: 0.45,
  },
];

const textWorkflowParams = [
  TASK_TYPE_PARAM("text2music"),
  PROMPT_PARAM,
  ...MUSIC_PARAMS,
  ...SAMPLING_PARAMS,
  ...GENERATION_PARAMS,
];

const lyricsWorkflowParams = [
  TASK_TYPE_PARAM("text2music"),
  PROMPT_PARAM,
  LYRICS_PARAM,
  ...MUSIC_PARAMS,
  ...SAMPLING_PARAMS,
  ...GENERATION_PARAMS,
];

const contextTextParams = [
  TASK_TYPE_PARAM("text2music"),
  ...CONTEXT_SOURCE_PARAMS,
  PROMPT_PARAM,
  LYRICS_PARAM,
  ...MUSIC_PARAMS,
  ...OUTPUT_PARAMS,
  ...SAMPLING_PARAMS,
  ...GENERATION_PARAMS,
];

export const AI_WORKFLOWS: AIWorkflow[] = [
  {
    id: "text-to-music",
    label: "Text / Instrumental",
    description: "Generate a fresh instrumental or non-lyrical clip from a style and arrangement prompt.",
    params: textWorkflowParams,
    available: true,
  },
  {
    id: "lyrics+style",
    label: "Lyrics + Style",
    description: "Generate a song guided by both prompt text and structured lyrics.",
    params: lyricsWorkflowParams,
    available: true,
  },
  {
    id: "reference-generate",
    label: "Reference Generate",
    description: "Generate from the selected clip as reference audio, with optional prompt and lyrics guidance.",
    params: contextTextParams,
    available: true,
  },
  {
    id: "cover-remix",
    label: "Cover / Remix",
    description: "Use the selected clip as source audio and reshape it with ACE cover generation.",
    params: [
      TASK_TYPE_PARAM("cover"),
      ...CONTEXT_SOURCE_PARAMS,
      PROMPT_PARAM,
      COVER_STRENGTH_PARAM,
      ...MUSIC_PARAMS,
      ...OUTPUT_PARAMS,
      ...SAMPLING_PARAMS,
      ...GENERATION_PARAMS,
    ],
    available: true,
  },
  {
    id: "repaint-edit",
    label: "Repaint / Edit",
    description: "Edit a bounded region of the selected clip while keeping the rest anchored to the source.",
    params: [
      TASK_TYPE_PARAM("repaint"),
      ...CONTEXT_SOURCE_PARAMS,
      PROMPT_PARAM,
      ...REPAINT_PARAMS,
      ...MUSIC_PARAMS,
      ...OUTPUT_PARAMS,
      ...SAMPLING_PARAMS,
      ...GENERATION_PARAMS,
    ],
    available: true,
  },
];

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

export function getAIWorkflow(workflowId?: string | null): AIWorkflow {
  return (
    AI_WORKFLOWS.find((workflow) => workflow.id === workflowId) ?? AI_WORKFLOWS[0]
  );
}

export function getDefaultWorkflowParams(
  workflowId?: string | null,
): Record<string, unknown> {
  const workflow = getAIWorkflow(workflowId);
  return Object.fromEntries(
    workflow.params.map((param) => [param.key, param.default]),
  );
}

export function normalizeWorkflowParams(
  workflowId?: string | null,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  const workflow = getAIWorkflow(workflowId);
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
): Record<string, unknown> {
  return normalizeWorkflowParams(workflowId, {
    ...getDefaultWorkflowParams(workflowId),
    ...(params ?? {}),
  });
}
