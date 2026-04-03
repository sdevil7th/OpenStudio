import { useMemo, useCallback } from "react";
import { ParametricGraph } from "./ParametricGraph";
import type { GraphNode, GraphAxis, GraphNodeConfig } from "./ParametricGraph.types";

interface S13FXSlider {
  index: number;
  name: string;
  min: number;
  max: number;
  def: number;
  inc: number;
  value: number;
  isEnum: boolean;
  enumNames?: string[];
}

interface ChorusGraphProps {
  sliders: S13FXSlider[];
  onSliderChange: (sliderIndex: number, value: number) => void;
  width?: number;
  height?: number;
}

const NUM_VOICES = 4;
const SLIDERS_PER_VOICE = 4; // enabled, delay, depth, rate

export function ChorusGraph({
  sliders,
  onSliderChange,
  width = 340,
  height = 180,
}: ChorusGraphProps) {
  const sliderMap = useMemo(() => {
    const map = new Map<number, S13FXSlider>();
    for (const s of sliders) map.set(s.index, s);
    return map;
  }, [sliders]);

  // Extract voices
  const voices = useMemo(() => {
    const result: { enabled: boolean; delay: number; depth: number; rate: number }[] = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      const base = i * SLIDERS_PER_VOICE;
      result.push({
        enabled: (sliderMap.get(base)?.value ?? 0) === 1,
        delay: sliderMap.get(base + 1)?.value ?? 5,
        depth: sliderMap.get(base + 2)?.value ?? 2,
        rate: sliderMap.get(base + 3)?.value ?? 0.5,
      });
    }
    return result;
  }, [sliderMap]);

  // Nodes: x=delay (ms), y=depth (ms), z=rate (Hz)
  const nodes: GraphNode[] = useMemo(
    () =>
      voices.map((v, i) => ({
        id: `voice-${i}`,
        x: v.delay,
        y: v.depth,
        z: v.rate,
        enabled: v.enabled,
        label: `Voice ${i + 1}`,
      })),
    [voices],
  );

  // Generate per-voice LFO waveforms for visualization
  const perNodeCurves = useMemo(() => {
    return voices
      .map((voice, i) => {
        if (!voice.enabled) return null;
        const points: { x: number; y: number }[] = [];
        const period = 1 / Math.max(voice.rate, 0.01);
        const numSamples = 100;
        const duration = Math.min(period * 2, 30); // Show up to 2 cycles

        for (let j = 0; j <= numSamples; j++) {
          const t = (j / numSamples) * duration;
          // LFO modulation: delay ± depth
          const modulation = voice.depth * Math.sin(2 * Math.PI * voice.rate * t);
          const delayAtTime = voice.delay + modulation;
          // Map to graph: x=time-as-delay position, y=modulated delay depth
          points.push({ x: delayAtTime, y: voice.depth + modulation });
        }
        return { nodeId: `voice-${i}`, points };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [voices]);

  const xAxis: GraphAxis = useMemo(
    () => ({
      label: "Delay",
      min: 0,
      max: 30,
      scale: "linear" as const,
      unit: "ms",
      gridLines: [0, 5, 10, 15, 20, 25, 30],
    }),
    [],
  );

  const yAxis: GraphAxis = useMemo(
    () => ({
      label: "Depth",
      min: 0,
      max: 10,
      scale: "linear" as const,
      unit: "ms",
      gridLines: [0, 2, 4, 6, 8, 10],
    }),
    [],
  );

  const nodeConfig: GraphNodeConfig = useMemo(
    () => ({
      maxNodes: NUM_VOICES,
      zAxis: {
        label: "Rate",
        min: 0.05,
        max: 5,
        default: 0.5,
        sensitivity: 0.005,
      },
    }),
    [],
  );

  const handleNodeAdd = useCallback(
    (x: number, y: number) => {
      const disabledIdx = voices.findIndex((v) => !v.enabled);
      if (disabledIdx === -1) return;
      const base = disabledIdx * SLIDERS_PER_VOICE;
      onSliderChange(base, 1); // Enable
      onSliderChange(base + 1, Math.round(Math.max(0.1, Math.min(30, x)) * 10) / 10); // Delay
      onSliderChange(base + 2, Math.round(Math.max(0.1, Math.min(10, y)) * 10) / 10); // Depth
      onSliderChange(base + 3, 0.5); // Default rate
    },
    [voices, onSliderChange],
  );

  const handleNodeRemove = useCallback(
    (id: string) => {
      const voiceIdx = parseInt(id.replace("voice-", ""), 10);
      if (isNaN(voiceIdx)) return;
      const base = voiceIdx * SLIDERS_PER_VOICE;
      onSliderChange(base, 0); // Disable
    },
    [onSliderChange],
  );

  const handleNodeChange = useCallback(
    (id: string, changes: Partial<GraphNode>) => {
      const voiceIdx = parseInt(id.replace("voice-", ""), 10);
      if (isNaN(voiceIdx)) return;
      const base = voiceIdx * SLIDERS_PER_VOICE;
      if (changes.x !== undefined) {
        onSliderChange(base + 1, Math.round(Math.max(0.1, Math.min(30, changes.x)) * 10) / 10);
      }
      if (changes.y !== undefined) {
        onSliderChange(base + 2, Math.round(Math.max(0.1, Math.min(10, changes.y)) * 10) / 10);
      }
      if (changes.z !== undefined) {
        onSliderChange(base + 3, Math.round(Math.max(0.05, Math.min(5, changes.z)) * 100) / 100);
      }
    },
    [onSliderChange],
  );

  return (
    <ParametricGraph
      width={width}
      height={height}
      xAxis={xAxis}
      yAxis={yAxis}
      nodes={nodes}
      nodeConfig={nodeConfig}
      perNodeCurves={perNodeCurves}
      onNodeAdd={handleNodeAdd}
      onNodeChange={handleNodeChange}
      onNodeRemove={handleNodeRemove}
    />
  );
}
