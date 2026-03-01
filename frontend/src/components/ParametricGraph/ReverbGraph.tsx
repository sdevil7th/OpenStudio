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

interface ReverbGraphProps {
  sliders: S13FXSlider[];
  onSliderChange: (sliderIndex: number, value: number) => void;
  width?: number;
  height?: number;
}

const NUM_POINTS = 6;
const SLIDERS_PER_POINT = 2; // time, level

export function ReverbGraph({
  sliders,
  onSliderChange,
  width = 340,
  height = 180,
}: ReverbGraphProps) {
  const sliderMap = useMemo(() => {
    const map = new Map<number, S13FXSlider>();
    for (const s of sliders) map.set(s.index, s);
    return map;
  }, [sliders]);

  // Extract envelope points from sliders
  // Slider layout: point N uses sliders N*2 and N*2+1 (0-based)
  const envPoints = useMemo(() => {
    const result: { time: number; level: number }[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      const base = i * SLIDERS_PER_POINT;
      result.push({
        time: sliderMap.get(base)?.value ?? i,
        level: sliderMap.get(base + 1)?.value ?? Math.max(0, 100 - i * 20),
      });
    }
    return result;
  }, [sliderMap]);

  // Nodes: x=time, y=level — all always enabled for reverb envelope
  const nodes: GraphNode[] = useMemo(
    () =>
      envPoints.map((pt, i) => ({
        id: `env-${i}`,
        x: pt.time,
        y: pt.level,
        enabled: true,
        label: `Point ${i + 1}`,
      })),
    [envPoints],
  );

  // Build envelope response curve (connect points in order sorted by time)
  const responseCurve = useMemo(() => {
    const sorted = [...envPoints]
      .map((p, i) => ({ ...p, idx: i }))
      .sort((a, b) => a.time - b.time);

    const points: { x: number; y: number }[] = [];
    // Start at 0,0 if first point isn't at time 0
    if (sorted.length > 0 && sorted[0].time > 0) {
      points.push({ x: 0, y: sorted[0].level });
    }
    for (const p of sorted) {
      points.push({ x: p.time, y: p.level });
    }
    // Extend to max time at 0 level if last point isn't 0
    const last = sorted[sorted.length - 1];
    if (last && last.level > 0) {
      points.push({ x: last.time + 0.5, y: 0 });
    }
    return points;
  }, [envPoints]);

  const xAxis: GraphAxis = useMemo(
    () => ({
      label: "Time",
      min: 0,
      max: 10,
      scale: "linear" as const,
      unit: "s",
      gridLines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
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
      maxNodes: NUM_POINTS,
    }),
    [],
  );

  const handleNodeChange = useCallback(
    (id: string, changes: Partial<GraphNode>) => {
      const ptIdx = parseInt(id.replace("env-", ""), 10);
      if (isNaN(ptIdx)) return;
      const base = ptIdx * SLIDERS_PER_POINT;
      if (changes.x !== undefined) {
        const timeSlider = sliderMap.get(base);
        const maxTime = timeSlider?.max ?? 10;
        onSliderChange(base, Math.round(Math.max(0, Math.min(maxTime, changes.x)) * 100) / 100);
      }
      if (changes.y !== undefined) {
        onSliderChange(base + 1, Math.round(Math.max(0, Math.min(100, changes.y))));
      }
    },
    [onSliderChange, sliderMap],
  );

  return (
    <ParametricGraph
      width={width}
      height={height}
      xAxis={xAxis}
      yAxis={yAxis}
      nodes={nodes}
      nodeConfig={nodeConfig}
      responseCurve={responseCurve}
      onNodeChange={handleNodeChange}
    />
  );
}
