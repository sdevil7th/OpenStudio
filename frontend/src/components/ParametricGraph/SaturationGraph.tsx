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

interface SaturationGraphProps {
  sliders: S13FXSlider[];
  onSliderChange: (sliderIndex: number, value: number) => void;
  width?: number;
  height?: number;
}

const NUM_POINTS = 8;
const SLIDERS_PER_POINT = 3; // enabled, input, output

function computeWaveshaperCurve(
  points: { enabled: boolean; input: number; output: number }[],
): { x: number; y: number }[] {
  // Collect enabled points, sort by input
  const sorted = points
    .filter((p) => p.enabled)
    .sort((a, b) => a.input - b.input);

  if (sorted.length < 2) {
    // Unity curve
    const curve: { x: number; y: number }[] = [];
    for (let x = -1; x <= 1; x += 0.02) curve.push({ x, y: x });
    return curve;
  }

  const curve: { x: number; y: number }[] = [];
  for (let x = -1; x <= 1; x += 0.01) {
    let y: number;
    if (x <= sorted[0].input) {
      y = sorted[0].output;
    } else if (x >= sorted[sorted.length - 1].input) {
      y = sorted[sorted.length - 1].output;
    } else {
      // Find segment
      let i = 0;
      while (i < sorted.length - 1 && sorted[i + 1].input < x) i++;
      const x0 = sorted[i].input;
      const y0 = sorted[i].output;
      const x1 = sorted[i + 1].input;
      const y1 = sorted[i + 1].output;
      let t = (x - x0) / Math.max(x1 - x0, 0.0001);
      // Smoothstep interpolation
      t = t * t * (3 - 2 * t);
      y = y0 + t * (y1 - y0);
    }
    curve.push({ x, y });
  }
  return curve;
}

export function SaturationGraph({
  sliders,
  onSliderChange,
  width = 340,
  height = 180,
}: SaturationGraphProps) {
  const sliderMap = useMemo(() => {
    const map = new Map<number, S13FXSlider>();
    for (const s of sliders) map.set(s.index, s);
    return map;
  }, [sliders]);

  // Extract control points
  const controlPoints = useMemo(() => {
    const result: { enabled: boolean; input: number; output: number }[] = [];
    for (let i = 0; i < NUM_POINTS; i++) {
      const base = i * SLIDERS_PER_POINT;
      result.push({
        enabled: (sliderMap.get(base)?.value ?? 0) === 1,
        input: sliderMap.get(base + 1)?.value ?? 0,
        output: sliderMap.get(base + 2)?.value ?? 0,
      });
    }
    return result;
  }, [sliderMap]);

  // Create nodes: x=input, y=output
  const nodes: GraphNode[] = useMemo(
    () =>
      controlPoints.map((pt, i) => ({
        id: `pt-${i}`,
        x: pt.input,
        y: pt.output,
        enabled: pt.enabled,
        label: `Point ${i + 1}`,
      })),
    [controlPoints],
  );

  const responseCurve = useMemo(
    () => computeWaveshaperCurve(controlPoints),
    [controlPoints],
  );

  // Unity line as reference
  const perNodeCurves = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (let x = -1; x <= 1; x += 0.05) pts.push({ x, y: x });
    return [{ nodeId: "unity", points: pts }];
  }, []);

  const xAxis: GraphAxis = useMemo(
    () => ({
      label: "Input",
      min: -1,
      max: 1,
      scale: "linear" as const,
      gridLines: [-1, -0.5, 0, 0.5, 1],
    }),
    [],
  );

  const yAxis: GraphAxis = useMemo(
    () => ({
      label: "Output",
      min: -1,
      max: 1,
      scale: "linear" as const,
      gridLines: [-1, -0.5, 0, 0.5, 1],
    }),
    [],
  );

  const nodeConfig: GraphNodeConfig = useMemo(
    () => ({
      maxNodes: NUM_POINTS,
    }),
    [],
  );

  const handleNodeAdd = useCallback(
    (x: number, y: number) => {
      const disabledIdx = controlPoints.findIndex((p) => !p.enabled);
      if (disabledIdx === -1) return;
      const base = disabledIdx * SLIDERS_PER_POINT;
      onSliderChange(base, 1); // Enable
      onSliderChange(base + 1, Math.round(Math.max(-1, Math.min(1, x)) * 100) / 100); // Input
      onSliderChange(base + 2, Math.round(Math.max(-1, Math.min(1, y)) * 100) / 100); // Output
    },
    [controlPoints, onSliderChange],
  );

  const handleNodeRemove = useCallback(
    (id: string) => {
      const ptIdx = parseInt(id.replace("pt-", ""), 10);
      if (isNaN(ptIdx)) return;
      const base = ptIdx * SLIDERS_PER_POINT;
      onSliderChange(base, 0); // Disable
    },
    [onSliderChange],
  );

  const handleNodeChange = useCallback(
    (id: string, changes: Partial<GraphNode>) => {
      const ptIdx = parseInt(id.replace("pt-", ""), 10);
      if (isNaN(ptIdx)) return;
      const base = ptIdx * SLIDERS_PER_POINT;
      if (changes.x !== undefined) {
        onSliderChange(base + 1, Math.round(Math.max(-1, Math.min(1, changes.x)) * 100) / 100);
      }
      if (changes.y !== undefined) {
        onSliderChange(base + 2, Math.round(Math.max(-1, Math.min(1, changes.y)) * 100) / 100);
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
      responseCurve={responseCurve}
      perNodeCurves={perNodeCurves}
      onNodeAdd={handleNodeAdd}
      onNodeChange={handleNodeChange}
      onNodeRemove={handleNodeRemove}
    />
  );
}
