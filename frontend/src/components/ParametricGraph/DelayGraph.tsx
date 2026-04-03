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

interface DelayGraphProps {
  sliders: S13FXSlider[];
  onSliderChange: (sliderIndex: number, value: number) => void;
  width?: number;
  height?: number;
}

const NUM_TAPS = 8;
const SLIDERS_PER_TAP = 5;

export function DelayGraph({
  sliders,
  onSliderChange,
  width = 340,
  height = 180,
}: DelayGraphProps) {
  const sliderMap = useMemo(() => {
    const map = new Map<number, S13FXSlider>();
    for (const s of sliders) map.set(s.index, s);
    return map;
  }, [sliders]);

  // Extract taps from sliders
  const taps = useMemo(() => {
    const result: { enabled: boolean; time: number; level: number; pan: number; feedback: number }[] = [];
    for (let i = 0; i < NUM_TAPS; i++) {
      const base = i * SLIDERS_PER_TAP;
      result.push({
        enabled: (sliderMap.get(base)?.value ?? 0) === 1,
        time: sliderMap.get(base + 1)?.value ?? 250,
        level: sliderMap.get(base + 2)?.value ?? 100,
        pan: sliderMap.get(base + 3)?.value ?? 0,
        feedback: sliderMap.get(base + 4)?.value ?? 0,
      });
    }
    return result;
  }, [sliderMap]);

  // Create nodes: x=time, y=level, z=pan
  const nodes: GraphNode[] = useMemo(
    () =>
      taps.map((tap, i) => ({
        id: `tap-${i}`,
        x: tap.time,
        y: tap.level,
        z: tap.pan,
        enabled: tap.enabled,
        label: `Tap ${i + 1}`,
      })),
    [taps],
  );

  const xAxis: GraphAxis = useMemo(
    () => ({
      label: "Time",
      min: 0,
      max: 2000,
      scale: "linear" as const,
      unit: "ms",
      gridLines: [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000],
    }),
    [],
  );

  const yAxis: GraphAxis = useMemo(
    () => ({
      label: "Level",
      min: 0,
      max: 100,
      scale: "linear" as const,
      unit: "%",
      gridLines: [0, 25, 50, 75, 100],
    }),
    [],
  );

  const nodeConfig: GraphNodeConfig = useMemo(
    () => ({
      maxNodes: NUM_TAPS,
      zAxis: {
        label: "Pan",
        min: -100,
        max: 100,
        default: 0,
        sensitivity: 0.5,
      },
    }),
    [],
  );

  const handleNodeAdd = useCallback(
    (x: number, y: number) => {
      const disabledIdx = taps.findIndex((t) => !t.enabled);
      if (disabledIdx === -1) return;
      const base = disabledIdx * SLIDERS_PER_TAP;
      onSliderChange(base, 1); // Enable
      onSliderChange(base + 1, Math.round(Math.max(1, Math.min(2000, x)))); // Time
      onSliderChange(base + 2, Math.round(Math.max(0, Math.min(100, y)))); // Level
      onSliderChange(base + 3, 0); // Pan center
      onSliderChange(base + 4, 0); // No feedback
    },
    [taps, onSliderChange],
  );

  const handleNodeRemove = useCallback(
    (id: string) => {
      const tapIdx = parseInt(id.replace("tap-", ""), 10);
      if (isNaN(tapIdx)) return;
      const base = tapIdx * SLIDERS_PER_TAP;
      onSliderChange(base, 0); // Disable
    },
    [onSliderChange],
  );

  const handleNodeChange = useCallback(
    (id: string, changes: Partial<GraphNode>) => {
      const tapIdx = parseInt(id.replace("tap-", ""), 10);
      if (isNaN(tapIdx)) return;
      const base = tapIdx * SLIDERS_PER_TAP;
      if (changes.x !== undefined) {
        onSliderChange(base + 1, Math.round(Math.max(1, Math.min(2000, changes.x))));
      }
      if (changes.y !== undefined) {
        onSliderChange(base + 2, Math.round(Math.max(0, Math.min(100, changes.y))));
      }
      if (changes.z !== undefined) {
        onSliderChange(base + 3, Math.round(Math.max(-100, Math.min(100, changes.z))));
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
      onNodeAdd={handleNodeAdd}
      onNodeChange={handleNodeChange}
      onNodeRemove={handleNodeRemove}
    />
  );
}
