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

interface CompressorGraphProps {
  sliders: S13FXSlider[];
  onSliderChange: (sliderIndex: number, value: number) => void;
  width?: number;
  height?: number;
}

// Slider indices (0-based): threshold=0, ratio=1, knee=2, attack=3, release=4,
// hold=5, makeup=6, mix=7, detection=8, sc_hpf=9, sc_lpf=10, auto_gain=11,
// stereo_link=12, lookahead=13

function computeTransferCurve(
  threshold: number,
  ratio: number,
  knee: number,
  makeup: number,
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  const makeupLin = makeup; // dB
  const kneeLo = threshold - knee / 2;
  const kneeHi = threshold + knee / 2;

  for (let inputDB = -60; inputDB <= 0; inputDB += 0.5) {
    let outputDB: number;
    if (inputDB < kneeLo) {
      outputDB = inputDB;
    } else if (inputDB > kneeHi) {
      outputDB = threshold + (inputDB - threshold) / ratio;
    } else {
      // Soft knee quadratic interpolation
      const x = inputDB - kneeLo;
      const gr = (1 - 1 / ratio) * x * x / (2 * knee);
      outputDB = inputDB - gr;
    }
    outputDB += makeupLin;
    points.push({ x: inputDB, y: Math.max(-60, Math.min(0, outputDB)) });
  }
  return points;
}

export function CompressorGraph({
  sliders,
  onSliderChange,
  width = 340,
  height = 180,
}: CompressorGraphProps) {
  const sliderMap = useMemo(() => {
    const map = new Map<number, S13FXSlider>();
    for (const s of sliders) map.set(s.index, s);
    return map;
  }, [sliders]);

  const threshold = sliderMap.get(0)?.value ?? -20;
  const ratio = sliderMap.get(1)?.value ?? 4;
  const knee = sliderMap.get(2)?.value ?? 6;
  const makeup = sliderMap.get(6)?.value ?? 0;

  // Single node representing the threshold/ratio point
  const nodes: GraphNode[] = useMemo(
    () => [
      {
        id: "comp-point",
        x: threshold,
        y: threshold, // At threshold, output = input (before makeup)
        z: knee,
        enabled: true,
        label: "Threshold",
      },
    ],
    [threshold, knee],
  );

  const responseCurve = useMemo(
    () => computeTransferCurve(threshold, ratio, knee, makeup),
    [threshold, ratio, knee, makeup],
  );

  // Unity line for reference (rendered as a per-node curve)
  const perNodeCurves = useMemo(() => {
    const unityPts: { x: number; y: number }[] = [];
    for (let db = -60; db <= 0; db += 1) unityPts.push({ x: db, y: db });
    return [{ nodeId: "unity", points: unityPts }];
  }, []);

  const xAxis: GraphAxis = useMemo(
    () => ({
      label: "Input",
      min: -60,
      max: 0,
      scale: "linear" as const,
      unit: "dB",
      gridLines: [-60, -48, -36, -24, -12, 0],
    }),
    [],
  );

  const yAxis: GraphAxis = useMemo(
    () => ({
      label: "Output",
      min: -60,
      max: 0,
      scale: "linear" as const,
      unit: "dB",
      gridLines: [-60, -48, -36, -24, -12, 0],
    }),
    [],
  );

  const nodeConfig: GraphNodeConfig = useMemo(
    () => ({
      maxNodes: 1,
      zAxis: {
        label: "Knee",
        min: 0,
        max: 24,
        default: 6,
        sensitivity: 0.05,
      },
    }),
    [],
  );

  const handleNodeChange = useCallback(
    (_id: string, changes: Partial<GraphNode>) => {
      if (changes.x !== undefined) {
        // X = threshold
        onSliderChange(0, Math.round(Math.max(-60, Math.min(0, changes.x)) * 10) / 10);
      }
      if (changes.y !== undefined) {
        // Y movement changes ratio: at threshold, output should be threshold
        // so we derive ratio from how far y deviates (not directly useful for a single-point)
        // Instead, treat Y drag above the unity line as ratio adjustment
        const inputAtThreshold = threshold;
        const outputAtPoint = changes.y;
        if (outputAtPoint < inputAtThreshold && inputAtThreshold < 0) {
          // Approximate ratio from threshold and desired output at some point above threshold
          const testInput = 0; // 0 dB
          const desiredOutput = outputAtPoint + (testInput - inputAtThreshold); // rough
          const diff = testInput - threshold;
          if (diff > 0) {
            const newRatio = diff / Math.max(0.1, desiredOutput - threshold + diff);
            onSliderChange(1, Math.round(Math.max(1, Math.min(20, newRatio)) * 10) / 10);
          }
        }
      }
      if (changes.z !== undefined) {
        onSliderChange(2, Math.round(Math.max(0, Math.min(24, changes.z)) * 10) / 10);
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
