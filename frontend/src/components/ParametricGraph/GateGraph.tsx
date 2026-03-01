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

interface GateGraphProps {
  sliders: S13FXSlider[];
  onSliderChange: (sliderIndex: number, value: number) => void;
  width?: number;
  height?: number;
}

// Slider indices: threshold=0, range=1, hysteresis=2, attack=3, hold=4,
// release=5, lookahead=6, detection=7, sc_hpf=8, sc_lpf=9, mode=10, mix=11

function computeGateTransferCurve(
  threshold: number,
  range: number,
  hysteresis: number,
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  const closeThreshold = threshold - hysteresis;

  for (let inputDB = -80; inputDB <= 0; inputDB += 0.5) {
    let outputDB: number;
    if (inputDB >= threshold) {
      outputDB = inputDB; // Gate open — pass through
    } else if (inputDB <= closeThreshold) {
      outputDB = inputDB + range; // Gate closed — attenuated by range
      outputDB = Math.max(outputDB, -80);
    } else {
      // Transition zone (hysteresis region) — smooth interpolation
      const t = (inputDB - closeThreshold) / Math.max(hysteresis, 0.1);
      const smoothT = t * t * (3 - 2 * t); // smoothstep
      outputDB = inputDB + range * (1 - smoothT);
      outputDB = Math.max(outputDB, -80);
    }
    points.push({ x: inputDB, y: outputDB });
  }
  return points;
}

export function GateGraph({
  sliders,
  onSliderChange,
  width = 340,
  height = 180,
}: GateGraphProps) {
  const sliderMap = useMemo(() => {
    const map = new Map<number, S13FXSlider>();
    for (const s of sliders) map.set(s.index, s);
    return map;
  }, [sliders]);

  const threshold = sliderMap.get(0)?.value ?? -40;
  const range = sliderMap.get(1)?.value ?? -80;
  const hysteresis = sliderMap.get(2)?.value ?? 6;

  const nodes: GraphNode[] = useMemo(
    () => [
      {
        id: "gate-threshold",
        x: threshold,
        y: threshold, // At threshold, output = input (gate open)
        z: hysteresis,
        enabled: true,
        label: "Threshold",
      },
    ],
    [threshold, hysteresis],
  );

  const responseCurve = useMemo(
    () => computeGateTransferCurve(threshold, range, hysteresis),
    [threshold, range, hysteresis],
  );

  // Unity line
  const perNodeCurves = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (let db = -80; db <= 0; db += 1) pts.push({ x: db, y: db });
    return [{ nodeId: "unity", points: pts }];
  }, []);

  const xAxis: GraphAxis = useMemo(
    () => ({
      label: "Input",
      min: -80,
      max: 0,
      scale: "linear" as const,
      unit: "dB",
      gridLines: [-80, -60, -40, -20, 0],
    }),
    [],
  );

  const yAxis: GraphAxis = useMemo(
    () => ({
      label: "Output",
      min: -80,
      max: 0,
      scale: "linear" as const,
      unit: "dB",
      gridLines: [-80, -60, -40, -20, 0],
    }),
    [],
  );

  const nodeConfig: GraphNodeConfig = useMemo(
    () => ({
      maxNodes: 1,
      zAxis: {
        label: "Hyst",
        min: 0,
        max: 12,
        default: 6,
        sensitivity: 0.05,
      },
    }),
    [],
  );

  const handleNodeChange = useCallback(
    (_id: string, changes: Partial<GraphNode>) => {
      if (changes.x !== undefined) {
        onSliderChange(0, Math.round(Math.max(-80, Math.min(0, changes.x)) * 10) / 10);
      }
      if (changes.y !== undefined) {
        // Y drag below unity adjusts range
        const diff = changes.y - (changes.x ?? threshold);
        if (diff < 0) {
          onSliderChange(1, Math.round(Math.max(-80, Math.min(0, diff)) * 10) / 10);
        }
      }
      if (changes.z !== undefined) {
        onSliderChange(2, Math.round(Math.max(0, Math.min(12, changes.z)) * 10) / 10);
      }
    },
    [onSliderChange, threshold],
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
      onNodeChange={handleNodeChange}
    />
  );
}
