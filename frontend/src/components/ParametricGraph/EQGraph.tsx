import { useMemo, useCallback } from "react";
import { ParametricGraph } from "./ParametricGraph";
import type { GraphNode, GraphAxis, GraphNodeConfig } from "./ParametricGraph.types";
import {
  FilterType,
  computeEQResponse,
  computeSingleBandResponse,
  type EQBand,
} from "./eqResponseCurve";

const SAMPLE_RATE = 48000;
const NUM_BANDS = 8;
const SLIDERS_PER_BAND = 5;

const FILTER_TYPES = [
  { value: 0, label: "Low Shelf" },
  { value: 1, label: "Peak" },
  { value: 2, label: "High Shelf" },
  { value: 3, label: "Low Pass" },
  { value: 4, label: "High Pass" },
  { value: 5, label: "Notch" },
];

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

interface EQGraphProps {
  sliders: S13FXSlider[];
  onSliderChange: (sliderIndex: number, value: number) => void;
  width?: number;
  height?: number;
}

function getBandFromSliders(
  sliderMap: Map<number, S13FXSlider>,
  bandIndex: number,
): EQBand {
  const base = bandIndex * SLIDERS_PER_BAND;
  return {
    enabled: (sliderMap.get(base)?.value ?? 0) === 1,
    type: sliderMap.get(base + 1)?.value ?? FilterType.Peak,
    freq: sliderMap.get(base + 2)?.value ?? [80, 250, 800, 2000, 4000, 8000, 12000, 16000][bandIndex],
    gainDB: sliderMap.get(base + 3)?.value ?? 0,
    q: sliderMap.get(base + 4)?.value ?? 1.0,
  };
}

export function EQGraph({
  sliders,
  onSliderChange,
  width = 500,
  height = 200,
}: EQGraphProps) {
  // Build index-based lookup map for robust slider access
  const sliderMap = useMemo(() => {
    const map = new Map<number, S13FXSlider>();
    for (const s of sliders) map.set(s.index, s);
    return map;
  }, [sliders]);

  // Extract bands from slider data
  const bands = useMemo(() => {
    const result: EQBand[] = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      result.push(getBandFromSliders(sliderMap, i));
    }
    return result;
  }, [sliderMap]);

  // Create graph nodes from bands
  const nodes: GraphNode[] = useMemo(
    () =>
      bands.map((band, i) => ({
        id: `band-${i}`,
        x: band.freq,
        y: band.gainDB,
        z: band.q,
        enabled: band.enabled,
        nodeType: band.type,
        label: `Band ${i + 1}`,
      })),
    [bands],
  );

  // Compute combined frequency response
  const responseCurve = useMemo(
    () => computeEQResponse(bands, SAMPLE_RATE),
    [bands],
  );

  // Compute per-node curves
  const perNodeCurves = useMemo(
    () =>
      bands
        .map((band, i) => ({
          nodeId: `band-${i}`,
          points: computeSingleBandResponse(band, SAMPLE_RATE),
        }))
        .filter((c) => c.points.length > 0),
    [bands],
  );

  // Axes configuration
  const xAxis: GraphAxis = useMemo(
    () => ({
      label: "Frequency",
      min: 20,
      max: 20000,
      scale: "log" as const,
      unit: "Hz",
      gridLines: [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000],
    }),
    [],
  );

  const yAxis: GraphAxis = useMemo(
    () => ({
      label: "Gain",
      min: -24,
      max: 24,
      scale: "linear" as const,
      unit: "dB",
      gridLines: [-24, -18, -12, -6, 0, 6, 12, 18, 24],
    }),
    [],
  );

  const nodeConfig: GraphNodeConfig = useMemo(
    () => ({
      maxNodes: NUM_BANDS,
      zAxis: {
        label: "Q",
        min: 0.1,
        max: 10,
        default: 1.0,
        sensitivity: 0.005,
      },
      nodeTypes: FILTER_TYPES,
    }),
    [],
  );

  // Enable first disabled band at the clicked position
  const handleNodeAdd = useCallback(
    (x: number, y: number) => {
      const disabledIdx = bands.findIndex((b) => !b.enabled);
      if (disabledIdx === -1) return; // All 8 bands in use
      const base = disabledIdx * SLIDERS_PER_BAND;
      onSliderChange(base, 1); // Enable
      onSliderChange(base + 1, FilterType.Peak); // Default type
      onSliderChange(base + 2, Math.round(Math.max(20, Math.min(20000, x)))); // Freq
      onSliderChange(base + 3, Math.round(Math.max(-24, Math.min(24, y)) * 10) / 10); // Gain
      onSliderChange(base + 4, 1.0); // Q default
    },
    [bands, onSliderChange],
  );

  // Disable the band
  const handleNodeRemove = useCallback(
    (id: string) => {
      const bandIdx = parseInt(id.replace("band-", ""), 10);
      if (isNaN(bandIdx)) return;
      const base = bandIdx * SLIDERS_PER_BAND;
      onSliderChange(base, 0); // Disable
      onSliderChange(base + 3, 0); // Reset gain
    },
    [onSliderChange],
  );

  // Update freq (x), gain (y), Q (z), or type when node changes
  const handleNodeChange = useCallback(
    (id: string, changes: Partial<GraphNode>) => {
      const bandIdx = parseInt(id.replace("band-", ""), 10);
      if (isNaN(bandIdx)) return;
      const base = bandIdx * SLIDERS_PER_BAND;
      if (changes.x !== undefined) {
        onSliderChange(base + 2, Math.round(Math.max(20, Math.min(20000, changes.x))));
      }
      if (changes.y !== undefined) {
        onSliderChange(base + 3, Math.round(Math.max(-24, Math.min(24, changes.y)) * 10) / 10);
      }
      if (changes.z !== undefined) {
        onSliderChange(base + 4, Math.round(Math.max(0.1, Math.min(10, changes.z)) * 100) / 100);
      }
      if (changes.nodeType !== undefined) {
        onSliderChange(base + 1, changes.nodeType);
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
