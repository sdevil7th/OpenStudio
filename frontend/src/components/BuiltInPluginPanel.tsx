import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { Activity, SlidersHorizontal, X } from "lucide-react";
import {
  BuiltInParamDescriptor,
  BuiltInPluginAddress,
  BuiltInPluginSchema,
  nativeBridge,
} from "../services/NativeBridge";
import { ParametricGraph } from "./ParametricGraph";
import type { GraphAxis, GraphNode, GraphNodeConfig } from "./ParametricGraph";
import { Button } from "./ui";

interface BuiltInPluginPanelProps {
  address: BuiltInPluginAddress;
  fallbackName: string;
  onClose?: () => void;
  initialSchema?: BuiltInPluginSchema;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function formatParamValue(param: BuiltInParamDescriptor) {
  if (param.type === "toggle") return param.value >= 0.5 ? "On" : "Off";
  if (param.type === "enum") {
    return (
      param.enumOptions?.find((option) => Math.round(option.value) === Math.round(param.value))
        ?.label ?? String(Math.round(param.value))
    );
  }
  const span = Math.abs(param.max - param.min);
  const decimals = span <= 2 ? 2 : span <= 50 ? 1 : 0;
  return `${param.value.toFixed(decimals)}${param.unit ? ` ${param.unit}` : ""}`;
}

function normalize(param: BuiltInParamDescriptor) {
  if (param.max <= param.min) return 0;
  return clamp((param.value - param.min) / (param.max - param.min), 0, 1);
}

function getParam(params: BuiltInParamDescriptor[], id: string) {
  return params.find((param) => param.id === id);
}

type BuiltInPluginKind =
  | "eq"
  | "dynamics"
  | "delay"
  | "reverb"
  | "modulation"
  | "saturation"
  | "pitch"
  | "synth"
  | "piano"
  | "drums"
  | "generic";

export function getPluginKind(schema: BuiltInPluginSchema | null): BuiltInPluginKind {
  const label = `${schema?.category ?? ""} ${schema?.name ?? ""}`.toLowerCase();
  if (label.includes("eq")) return "eq";
  if (label.includes("compressor") || label.includes("gate") || label.includes("limiter") || label.includes("dynamics")) return "dynamics";
  if (label.includes("delay")) return "delay";
  if (label.includes("reverb")) return "reverb";
  if (label.includes("chorus") || label.includes("flanger") || label.includes("phaser") || label.includes("modulation")) return "modulation";
  if (label.includes("saturat")) return "saturation";
  if (label.includes("pitch")) return "pitch";
  if (label.includes("piano")) return "piano";
  if (label.includes("drum")) return "drums";
  if (label.includes("synth") || label.includes("sampler")) return "synth";
  return "generic";
}

export function primaryParamIdsForKind(kind: BuiltInPluginKind, schema: BuiltInPluginSchema | null) {
  const name = schema?.name.toLowerCase() ?? "";
  if (kind === "eq") return ["outputGain", "autoGain", "stereoMode", "auditionBand"];
  if (kind === "delay") return ["delayTimeL", "delayTimeR", "feedback", "mix", "ducking"];
  if (kind === "reverb") return ["algorithm", "roomSize", "decayTime", "wetLevel", "dryLevel"];
  if (kind === "modulation") return ["mode", "rate", "depth", "mix", "characterMode"];
  if (kind === "saturation") return ["satType", "drive", "mix", "outputGain", "oversampleMode"];
  if (kind === "pitch") return ["key", "scale", "retuneSpeed", "correctionStrength", "mix"];
  if (kind === "piano") return ["model", "tone", "body", "resonance", "outputGain"];
  if (kind === "drums") return ["kit", "mapPreset", "punch", "ambience", "outputGain"];
  if (kind === "synth") return ["brightness", "detuneCents", "subLevel", "noiseLevel", "outputGain"];
  if (kind === "dynamics" && name.includes("limiter")) return ["threshold", "ceiling", "lookaheadMs", "releaseMs"];
  if (kind === "dynamics" && name.includes("gate")) return ["threshold", "range", "attackMs", "releaseMs", "detectorMode"];
  if (kind === "dynamics") return ["threshold", "ratio", "attack", "release", "autoMakeup"];
  return [];
}

export function groupLabel(group: string) {
  const labels: Record<string, string> = {
    body: "Body",
    character: "Character",
    correction: "Correction",
    detection: "Detection",
    drive: "Drive",
    drums: "Kit",
    dynamic: "Dynamic Bands",
    dynamics: "Dynamics",
    envelope: "Envelope",
    eqBand: "Bands",
    feedback: "Feedback",
    formant: "Formants",
    instrument: "Instrument",
    midi: "MIDI",
    mix: "Mix",
    modulation: "Modulation",
    oscillator: "Oscillators",
    output: "Output",
    piano: "Piano",
    quality: "Quality",
    routing: "Routing",
    scale: "Scale",
    sidechain: "Sidechain",
    space: "Space",
    time: "Timing",
    tone: "Tone",
    width: "Stereo",
  };
  return labels[group] ?? group;
}

export function groupSortWeight(kind: BuiltInPluginKind, group: string) {
  const orderByKind: Record<BuiltInPluginKind, string[]> = {
    eq: ["eqBand", "dynamic", "routing", "output"],
    dynamics: ["dynamics", "detection", "sidechain", "character", "mix", "output"],
    delay: ["time", "feedback", "dynamics", "tone", "character", "width", "mix"],
    reverb: ["space", "time", "tone", "width", "mix"],
    modulation: ["modulation", "feedback", "character", "tone", "width", "mix"],
    saturation: ["drive", "character", "tone", "quality", "mix", "output"],
    pitch: ["scale", "correction", "detection", "formant", "midi", "mix"],
    synth: ["oscillator", "tone", "envelope", "output"],
    piano: ["character", "tone", "body", "width", "envelope", "output"],
    drums: ["drums", "character", "space", "width", "output"],
    generic: ["controls", "output"],
  };
  const order = orderByKind[kind] ?? orderByKind.generic;
  const index = order.indexOf(group);
  return index === -1 ? 100 : index;
}

export function stepForParam(param: BuiltInParamDescriptor) {
  const span = Math.abs(param.max - param.min);
  if (param.type === "toggle" || param.type === "enum") return 1;
  if (param.unit === "Hz" && param.max > 1000) return 1;
  if (param.unit === "ms" || param.unit === "s" || param.unit === "dB" || param.unit === "st" || param.unit === "ct") return Math.max(span / 500, 0.01);
  return Math.max(span / 500, 0.001);
}

export function BuiltInParamControl({
  param,
  onChange,
  compact = false,
}: {
  param: BuiltInParamDescriptor;
  onChange: (param: BuiltInParamDescriptor, value: number) => void;
  compact?: boolean;
}) {
  const pct = normalize(param);
  const style = { "--knob-pct": `${pct * 100}%` } as CSSProperties;

  if (param.type === "enum") {
    return (
      <label className="builtin-control builtin-control-enum" title={param.label}>
        <span className="builtin-control-label">{param.label}</span>
        <select
          value={Math.round(param.value)}
          onChange={(event) => onChange(param, Number(event.currentTarget.value))}
        >
          {(param.enumOptions ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === "toggle") {
    const active = param.value >= 0.5;
    return (
      <button
        type="button"
        className="builtin-control builtin-control-toggle"
        data-active={active}
        onClick={() => onChange(param, active ? 0 : 1)}
        aria-pressed={active}
        title={param.label}
      >
        <span className="builtin-control-label">{param.label}</span>
        <span className="builtin-switch" aria-hidden="true" />
      </button>
    );
  }

  return (
    <label className="builtin-control builtin-control-continuous" data-compact={compact} style={style} title={param.label}>
      <span className="builtin-knob" aria-hidden="true" />
      <span className="builtin-control-main">
        <span className="builtin-control-topline">
          <span className="builtin-control-label">{param.label}</span>
          <span className="builtin-param-value">{formatParamValue(param)}</span>
        </span>
        <input
          type="range"
          min={param.min}
          max={param.max}
          step={stepForParam(param)}
          value={param.value}
          onChange={(event) => onChange(param, Number(event.currentTarget.value))}
        />
      </span>
    </label>
  );
}

function BuiltInVisualization({
  schema,
  onParamChange,
}: {
  schema: BuiltInPluginSchema;
  onParamChange: (param: BuiltInParamDescriptor, value: number) => void;
}) {
  const params = schema.parameters;
  const category = `${schema.category} ${schema.name}`.toLowerCase();
  const width = 360;
  const height = 126;
  const [dynamicsHistory, setDynamicsHistory] = useState<number[]>(() => Array(56).fill(0));
  const gainReductionDb = schema.visualization?.gainReductionDb;

  useEffect(() => {
    setDynamicsHistory(Array(56).fill(0));
  }, [schema.chain, schema.fxIndex, schema.name]);

  useEffect(() => {
    if (typeof gainReductionDb !== "number" || !Number.isFinite(gainReductionDb)) return;
    setDynamicsHistory((history) => [...history.slice(1), clamp(Math.abs(gainReductionDb), 0, 36)]);
  }, [gainReductionDb]);

  if (category.includes("eq")) {
    const nodes: GraphNode[] = [];
    const dynamicGains = schema.visualization?.dynamicGainDb ?? [];
    for (let band = 0; band < 8; band += 1) {
      const enabled = (getParam(params, `band${band}.enabled`)?.value ?? 0) >= 0.5;
      const freq = getParam(params, `band${band}.freq`)?.value ?? 1000;
      const gain = getParam(params, `band${band}.gain`)?.value ?? 0;
      const dynamicValue = dynamicGains[band] ?? 0;
      nodes.push({
        id: `band-${band}`,
        x: freq,
        y: gain,
        z: getParam(params, `band${band}.q`)?.value ?? 1,
        enabled,
        label: `Band ${band + 1}`,
        color: Math.abs(dynamicValue) > 0.05 ? "#fbbf24" : undefined,
      });
    }
    const frequencies = schema.visualization?.frequencies ?? [];
    const responseCurve = schema.visualization?.responseDb?.map((value, index) => ({
      x: frequencies[index] ?? 20,
      y: clamp(value, -24, 24),
    }));
    const spectrumToGraphPoints = (values: number[] | undefined) =>
      values?.map((value, index) => ({
        x: frequencies[index] ?? 20,
        y: clamp(((value + 90) / 78) * 48 - 24, -24, 24),
      })) ?? [];
    const backgroundCurves = schema.visualization?.spectrumReady
      ? [
          {
            id: "spectrum-pre",
            points: spectrumToGraphPoints(schema.visualization.spectrumPreDb),
            color: "rgba(148, 163, 184, 0.72)",
            opacity: 0.42,
            strokeWidth: 1,
          },
          {
            id: "spectrum-post",
            points: spectrumToGraphPoints(schema.visualization.spectrumPostDb),
            color: "rgba(34, 197, 94, 0.76)",
            opacity: 0.58,
            strokeWidth: 1.15,
          },
        ]
      : [];
    const xAxis: GraphAxis = {
      label: "Frequency",
      min: 20,
      max: 20000,
      scale: "log",
      unit: "Hz",
      gridLines: [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000],
    };
    const yAxis: GraphAxis = {
      label: "Gain",
      min: -24,
      max: 24,
      scale: "linear",
      unit: "dB",
      gridLines: [-24, -12, 0, 12, 24],
    };
    const nodeConfig: GraphNodeConfig = {
      maxNodes: 8,
      zAxis: {
        label: "Q",
        min: 0.1,
        max: 30,
        default: 1,
        sensitivity: 0.01,
      },
    };
    return (
      <ParametricGraph
        width={width}
        height={height}
        xAxis={xAxis}
        yAxis={yAxis}
        nodes={nodes}
        nodeConfig={nodeConfig}
        responseCurve={responseCurve}
        backgroundCurves={backgroundCurves}
        className="builtin-visual builtin-eq-visual"
        onNodeChange={(id, changes) => {
          const band = Number(id.replace("band-", ""));
          if (!Number.isFinite(band)) return;
          const enabledParam = getParam(params, `band${band}.enabled`);
          const freqParam = getParam(params, `band${band}.freq`);
          const gainParam = getParam(params, `band${band}.gain`);
          const qParam = getParam(params, `band${band}.q`);
          if (enabledParam && enabledParam.value < 0.5) onParamChange(enabledParam, 1);
          if (freqParam && changes.x !== undefined) onParamChange(freqParam, changes.x);
          if (gainParam && changes.y !== undefined) onParamChange(gainParam, changes.y);
          if (qParam && changes.z !== undefined) onParamChange(qParam, changes.z);
        }}
      />
    );
  }

  if (category.includes("dynamics") || category.includes("compressor") || category.includes("gate") || category.includes("limiter")) {
    const threshold = normalize(getParam(params, "threshold") ?? { value: -18, min: -60, max: 0 } as BuiltInParamDescriptor);
    const ratio = normalize(getParam(params, "ratio") ?? { value: 4, min: 1, max: 20 } as BuiltInParamDescriptor);
    const knee = normalize(getParam(params, "knee") ?? { value: 0, min: 0, max: 24 } as BuiltInParamDescriptor);
    const x = threshold * width;
    const y = height - threshold * height;
    const endY = clamp(y - (1 - ratio) * height * 0.38 + knee * 8, 12, height - 10);
    const currentGr = clamp(Math.abs(gainReductionDb ?? 0), 0, 36);
    const inputLevel = clamp(schema.visualization?.inputLevelDb ?? -90, -90, 6);
    const outputLevel = clamp(schema.visualization?.outputLevelDb ?? -90, -90, 6);
    const levelY = (db: number) => height - 12 - clamp((db + 90) / 96, 0, 1) * (height - 22);
    const historyPoints = dynamicsHistory
      .map((value, index) => {
        const hx = 8 + (index / Math.max(1, dynamicsHistory.length - 1)) * (width - 86);
        const hy = height - 10 - (value / 36) * (height - 26);
        return `${hx},${hy}`;
      })
      .join(" ");
    return (
      <svg className="builtin-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} dynamics curve`}>
        <rect width={width} height={height} rx="6" />
        <polyline className="builtin-dynamics-curve" points={`0,${height - 12} ${x},${y} ${width - 70},${endY}`} />
        <polyline className="builtin-dynamics-history" points={historyPoints} />
        <rect className="builtin-dynamics-meter" x={width - 56} y={levelY(inputLevel)} width="8" height={height - 12 - levelY(inputLevel)} />
        <rect className="builtin-dynamics-meter" x={width - 42} y={levelY(outputLevel)} width="8" height={height - 12 - levelY(outputLevel)} />
        <rect className="builtin-dynamics-gr" x={width - 24} y={10} width="10" height={(currentGr / 36) * (height - 20)} />
        {typeof schema.visualization?.gateOpen === "boolean" && (
          <circle className="builtin-dynamics-status" cx={width - 19} cy={height - 13} r="4" data-active={schema.visualization.gateOpen} />
        )}
        <circle cx={x} cy={y} r="4.5" data-active="true" />
      </svg>
    );
  }

  if (category.includes("saturation")) {
    const drive = normalize(getParam(params, "drive") ?? { value: 6, min: 0, max: 30 } as BuiltInParamDescriptor);
    const bias = getParam(params, "asymmetry")?.value ?? 0;
    const curve = Array.from({ length: 44 }, (_, index) => {
      const xNorm = (index / 43) * 2 - 1;
      const yNorm = Math.tanh(xNorm * (1.2 + drive * 5) + bias * 0.4);
      const x = (index / 43) * width;
      const y = height * 0.5 - yNorm * height * 0.38;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} saturation curve`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        <polyline points={curve} />
      </svg>
    );
  }

  if (category.includes("pitch")) {
    const detected = schema.visualization?.historyDetectedMidi ?? [];
    const corrected = schema.visualization?.historyCorrectedMidi ?? [];
    const confidence = schema.visualization?.historyConfidence ?? [];
    const pitchPoints = (values: number[]) =>
      values
        .map((value, index) => {
          const x = (index / Math.max(1, values.length - 1)) * width;
          const y = height - clamp((value - 36) / 48, 0, 1) * height;
          return `${x},${y}`;
        })
        .join(" ");
    const confidenceBars = confidence.filter((value) => value > 0.01).slice(-28);
    return (
      <svg className="builtin-visual builtin-pitch-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} pitch trace`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        {confidenceBars.map((value, index) => {
          const barWidth = 4;
          const x = width - 124 + index * barWidth;
          return <rect key={index} className="builtin-pitch-confidence" x={x} y={height - 8 - value * 46} width="2.5" height={4 + value * 46} rx="1" />;
        })}
        <polyline className="builtin-pitch-detected" points={pitchPoints(detected)} />
        <polyline className="builtin-pitch-corrected" points={pitchPoints(corrected)} />
        <circle
          className="builtin-pitch-note"
          cx={width - 28}
          cy={height - clamp(((schema.visualization?.correctedHz ?? 0) > 0 ? 0.72 : 0.22), 0, 1) * height}
          r="5"
          data-active={(schema.visualization?.confidence ?? 0) > 0.2}
        />
      </svg>
    );
  }

  if (category.includes("delay")) {
    const delayL = normalize(getParam(params, "delayTimeL") ?? { value: 250, min: 1, max: 2000 } as BuiltInParamDescriptor);
    const delayR = normalize(getParam(params, "delayTimeR") ?? { value: 250, min: 1, max: 2000 } as BuiltInParamDescriptor);
    const feedbackValue = normalize(getParam(params, "feedback") ?? { value: 0.4, min: 0, max: 0.95 } as BuiltInParamDescriptor);
    const mixValue = normalize(getParam(params, "mix") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const tapL = 38 + delayL * 230;
    const tapR = 54 + delayR * 230;
    const repeats = Array.from({ length: 5 }, (_, index) => ({
      x: 54 + index * 58,
      y: height * 0.5 + Math.sin(index * 1.2) * 24 * mixValue,
      r: 5 + feedbackValue * 9 * Math.pow(0.72, index),
      opacity: 0.35 + feedbackValue * Math.pow(0.72, index) * 0.55,
    }));
    return (
      <svg className="builtin-visual builtin-delay-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} taps`}>
        <rect width={width} height={height} rx="6" />
        <line x1="28" y1={height / 2} x2={width - 28} y2={height / 2} />
        <path className="builtin-delay-feedback" d={`M ${tapL} ${height / 2 - 24} C ${width / 2} ${12 + feedbackValue * 12}, ${tapR} ${height / 2 - 24}, ${tapR} ${height / 2}`} />
        {repeats.map((repeat, index) => (
          <circle key={index} className="builtin-delay-repeat" cx={repeat.x} cy={repeat.y} r={repeat.r} style={{ opacity: repeat.opacity }} />
        ))}
        <circle className="builtin-delay-tap" cx={tapL} cy={height / 2 - 16} r="6" data-active="true" />
        <circle className="builtin-delay-tap" cx={tapR} cy={height / 2 + 16} r="6" data-active="true" />
      </svg>
    );
  }

  if (category.includes("reverb")) {
    const decayValue = normalize(getParam(params, "decayTime") ?? { value: 2, min: 0.1, max: 20 } as BuiltInParamDescriptor);
    const sizeValue = normalize(getParam(params, "roomSize") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const dampingValue = normalize(getParam(params, "damping") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const widthValue = normalize(getParam(params, "width") ?? { value: 1, min: 0, max: 1 } as BuiltInParamDescriptor);
    const tail = Array.from({ length: 72 }, (_, index) => {
      const t = index / 71;
      const envelope = Math.exp(-t * (2.2 - decayValue * 1.45));
      const ripple = Math.sin(t * Math.PI * (8 + sizeValue * 12)) * (1 - dampingValue * 0.65);
      const x = t * width;
      const y = height * 0.5 - envelope * ripple * height * 0.32;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual builtin-reverb-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} tail`}>
        <rect width={width} height={height} rx="6" />
        <ellipse className="builtin-reverb-space" cx={width / 2} cy={height / 2} rx={60 + sizeValue * 118} ry={22 + widthValue * 28} />
        <polyline className="builtin-reverb-tail" points={tail} />
        <line x1="24" y1={height / 2} x2={width - 24} y2={height / 2} />
      </svg>
    );
  }

  if (category.includes("modulation") || category.includes("chorus") || category.includes("flanger") || category.includes("phaser")) {
    const depthValue = normalize(getParam(params, "depth") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const spreadValue = normalize(getParam(params, "spread") ?? { value: 0.5, min: 0, max: 1 } as BuiltInParamDescriptor);
    const feedbackValue = normalize(getParam(params, "fbAmount") ?? { value: 0, min: -1, max: 1 } as BuiltInParamDescriptor);
    const waveA = Array.from({ length: 80 }, (_, index) => {
      const t = index / 79;
      const x = t * width;
      const y = height * 0.5 + Math.sin(t * Math.PI * 4) * depthValue * height * 0.32;
      return `${x},${y}`;
    }).join(" ");
    const waveB = Array.from({ length: 80 }, (_, index) => {
      const t = index / 79;
      const x = t * width;
      const y = height * 0.5 + Math.sin(t * Math.PI * 4 + spreadValue * Math.PI) * depthValue * height * 0.26;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual builtin-mod-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} modulation`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        <polyline className="builtin-mod-wave-a" points={waveA} />
        <polyline className="builtin-mod-wave-b" points={waveB} />
        <circle className="builtin-mod-feedback" cx={width - 28} cy={height - 18 - feedbackValue * 72} r="7" data-active={feedbackValue > 0.52} />
      </svg>
    );
  }

  if (category.includes("synth")) {
    const brightness = normalize(getParam(params, "brightness") ?? { value: 0.62, min: 0, max: 1 } as BuiltInParamDescriptor);
    const sub = normalize(getParam(params, "subLevel") ?? { value: 0.18, min: 0, max: 0.8 } as BuiltInParamDescriptor);
    const noise = normalize(getParam(params, "noiseLevel") ?? { value: 0.015, min: 0, max: 0.25 } as BuiltInParamDescriptor);
    const wave = Array.from({ length: 64 }, (_, index) => {
      const phase = index / 63;
      const saw = phase * 2 - 1;
      const square = phase < 0.5 ? 1 : -1;
      const yNorm = saw * (0.5 + brightness * 0.2) + square * brightness * 0.18 + Math.sin(phase * Math.PI * 2) * sub * 0.26;
      const x = phase * width;
      const y = height * 0.5 - yNorm * height * 0.34;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg className="builtin-visual builtin-instrument-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} oscillator`}>
        <rect width={width} height={height} rx="6" />
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
        <polyline className="builtin-instrument-primary" points={wave} />
        <rect className="builtin-instrument-accent" x="18" y={height - 18 - noise * 54} width="22" height={8 + noise * 54} rx="3" />
        <rect className="builtin-instrument-accent" x="48" y={height - 18 - sub * 54} width="22" height={8 + sub * 54} rx="3" />
      </svg>
    );
  }

  if (category.includes("piano")) {
    const toneValue = normalize(getParam(params, "tone") ?? { value: 0.58, min: 0, max: 1 } as BuiltInParamDescriptor);
    const bodyValue = normalize(getParam(params, "body") ?? { value: 0.72, min: 0, max: 1 } as BuiltInParamDescriptor);
    const resonanceValue = normalize(getParam(params, "resonance") ?? { value: 0.38, min: 0, max: 1 } as BuiltInParamDescriptor);
    const harmonics = [1, 2.003, 3.011, 5.031, 1.497].map((ratio, index) => {
      const value = [bodyValue, toneValue * 0.72, toneValue * 0.52, toneValue * 0.34, resonanceValue * 0.64][index];
      return { ratio, value };
    });
    return (
      <svg className="builtin-visual builtin-instrument-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} resonance`}>
        <rect width={width} height={height} rx="6" />
        {Array.from({ length: 18 }, (_, index) => (
          <rect key={index} className="builtin-piano-key" x={12 + index * 18} y="82" width="15" height="34" rx="2" data-active={index % 7 === 1 || index % 7 === 4} />
        ))}
        {harmonics.map((harmonic, index) => (
          <rect
            key={harmonic.ratio}
            className="builtin-instrument-accent"
            x={42 + index * 50}
            y={70 - harmonic.value * 44}
            width="18"
            height={10 + harmonic.value * 44}
            rx="4"
          />
        ))}
        <polyline className="builtin-instrument-primary" points={`18,68 72,${52 - bodyValue * 18} 142,${58 - resonanceValue * 22} 236,${50 - toneValue * 18} 342,64`} />
      </svg>
    );
  }

  if (category.includes("drum")) {
    const punchValue = normalize(getParam(params, "punch") ?? { value: 0.55, min: 0, max: 1 } as BuiltInParamDescriptor);
    const roomValue = normalize(getParam(params, "ambience") ?? { value: 0.18, min: 0, max: 1 } as BuiltInParamDescriptor);
    const widthValue = normalize(getParam(params, "stereoWidth") ?? { value: 0.7, min: 0, max: 1 } as BuiltInParamDescriptor);
    const shells = [
      { x: 176, y: 70, r: 26 + punchValue * 8 },
      { x: 116 - widthValue * 22, y: 56, r: 18 },
      { x: 238 + widthValue * 22, y: 56, r: 18 },
      { x: 72 - widthValue * 28, y: 34, r: 13 + roomValue * 5 },
      { x: 288 + widthValue * 28, y: 34, r: 13 + roomValue * 5 },
    ];
    return (
      <svg className="builtin-visual builtin-instrument-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} kit`}>
        <rect width={width} height={height} rx="6" />
        <ellipse className="builtin-drum-room" cx={width / 2} cy="68" rx={118 + roomValue * 52} ry={34 + roomValue * 18} />
        {shells.map((shell, index) => (
          <circle key={index} className="builtin-drum-shell" cx={shell.x} cy={shell.y} r={shell.r} data-active={index === 0} />
        ))}
        <line x1={width / 2} y1="24" x2={width / 2} y2="110" />
      </svg>
    );
  }

  const bars = params.slice(0, 14);
  return (
    <svg className="builtin-visual" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${schema.name} controls`}>
      <rect width={width} height={height} rx="6" />
      {bars.map((param, index) => {
        const barWidth = width / Math.max(1, bars.length);
        const value = normalize(param);
        const barHeight = 16 + value * (height - 34);
        return (
          <rect
            key={param.id}
            x={index * barWidth + 5}
            y={height - barHeight - 8}
            width={Math.max(4, barWidth - 10)}
            height={barHeight}
            rx="3"
            data-active="true"
          />
        );
      })}
    </svg>
  );
}

export function BuiltInPluginPanel({
  address,
  fallbackName,
  onClose,
  initialSchema,
}: BuiltInPluginPanelProps) {
  const [schema, setSchema] = useState<BuiltInPluginSchema | null>(initialSchema ?? null);
  const [loading, setLoading] = useState(false);

  const loadSchema = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const nextSchema = await nativeBridge.getBuiltInPluginSchema(address);
      setSchema(nextSchema);
    } catch (error) {
      console.error("[BuiltInPluginPanel] Failed to load schema:", error);
      setSchema({
        schemaVersion: 1,
        name: fallbackName,
        category: "Built-in",
        chain: address.chain,
        fxIndex: address.fxIndex ?? -1,
        parameters: [],
      });
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [address, fallbackName]);

  useEffect(() => {
    if (initialSchema) {
      setSchema(initialSchema);
      return;
    }
    void loadSchema();
  }, [initialSchema, loadSchema]);

  useEffect(() => {
    const pluginKind = `${schema?.category ?? ""} ${schema?.name ?? ""}`.toLowerCase();
    const needsLiveSchema = pluginKind.includes("eq") || pluginKind.includes("pitch") || pluginKind.includes("dynamics") || pluginKind.includes("compressor") || pluginKind.includes("gate") || pluginKind.includes("limiter");
    if (!needsLiveSchema) return;
    const intervalId = window.setInterval(() => {
      void loadSchema(false);
    }, 500);
    return () => window.clearInterval(intervalId);
  }, [loadSchema, schema?.category, schema?.name]);

  const pluginKind = useMemo(() => getPluginKind(schema), [schema]);

  const primaryParamIds = useMemo(
    () => primaryParamIdsForKind(pluginKind, schema),
    [pluginKind, schema],
  );

  const primaryParams = useMemo(() => {
    const params = schema?.parameters ?? [];
    return primaryParamIds
      .map((id) => params.find((param) => param.id === id))
      .filter((param): param is BuiltInParamDescriptor => Boolean(param));
  }, [primaryParamIds, schema]);

  const groupedParams = useMemo(() => {
    const primaryIds = new Set(primaryParams.map((param) => param.id));
    const groups = new Map<string, BuiltInParamDescriptor[]>();
    for (const param of schema?.parameters ?? []) {
      if (primaryIds.has(param.id)) continue;
      const group = param.graphRole || "controls";
      groups.set(group, [...(groups.get(group) ?? []), param]);
    }
    return Array.from(groups.entries())
      .sort(([groupA], [groupB]) => groupSortWeight(pluginKind, groupA) - groupSortWeight(pluginKind, groupB));
  }, [pluginKind, primaryParams, schema]);

  const handleParamChange = async (param: BuiltInParamDescriptor, rawValue: number) => {
    const value = param.type === "toggle" ? (rawValue >= 0.5 ? 1 : 0) : clamp(rawValue, param.min, param.max);
    setSchema((current) =>
      current
        ? {
            ...current,
            parameters: current.parameters.map((entry) =>
              entry.id === param.id ? { ...entry, value } : entry,
            ),
          }
        : current,
    );
    await nativeBridge.setBuiltInPluginParam(address, param.id, value);
  };

  const title = schema?.name || fallbackName;

  return (
    <section className="builtin-plugin-panel" data-kind={pluginKind} onClick={(event) => event.stopPropagation()}>
      <div className="builtin-panel-header">
        <div className="builtin-panel-title">
          <Activity size={14} />
          <span>{title}</span>
        </div>
        {onClose && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close editor" aria-label={`Close ${title}`}>
            <X size={14} />
          </Button>
        )}
      </div>

      {schema && schema.parameters.length > 0 && (
        <BuiltInVisualization
          schema={schema}
          onParamChange={(param, value) => {
            void handleParamChange(param, value);
          }}
        />
      )}

      {loading ? (
        <div className="builtin-empty">Loading</div>
      ) : !schema || schema.parameters.length === 0 ? (
        <div className="builtin-empty">No editable parameters</div>
      ) : (
        <div className="builtin-param-groups">
          {primaryParams.length > 0 && (
            <div className="builtin-macro-strip" aria-label={`${title} primary controls`}>
              {primaryParams.map((param) => (
                <BuiltInParamControl
                  key={param.id}
                  param={param}
                  compact
                  onChange={(nextParam, value) => {
                    void handleParamChange(nextParam, value);
                  }}
                />
              ))}
            </div>
          )}
          {groupedParams.map(([group, params]) => (
            <div className="builtin-param-group" key={group}>
              <div className="builtin-group-title">
                <SlidersHorizontal size={11} />
                <span>{groupLabel(group)}</span>
              </div>
              <div className="builtin-param-grid">
                {params.map((param) => (
                  <BuiltInParamControl
                    key={param.id}
                    param={param}
                    onChange={(nextParam, value) => {
                      void handleParamChange(nextParam, value);
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
