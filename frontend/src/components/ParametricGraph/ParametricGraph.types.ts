export interface GraphAxis {
  label: string;
  min: number;
  max: number;
  scale: "linear" | "log";
  unit?: string;
  gridLines?: number[];
}

export interface GraphNode {
  id: string;
  x: number; // value in axis units (e.g., Hz for freq)
  y: number; // value in axis units (e.g., dB for gain)
  z?: number; // third parameter (e.g., Q), scroll-wheel controlled
  enabled: boolean;
  color?: string;
  label?: string;
  nodeType?: number; // enum value for per-node type (e.g., filter type)
}

export interface GraphNodeConfig {
  maxNodes: number;
  zAxis?: {
    label: string;
    min: number;
    max: number;
    default: number;
    sensitivity: number; // scroll delta per value unit
  };
  nodeTypes?: { value: number; label: string }[];
}

export interface ParametricGraphProps {
  width: number;
  height: number;
  xAxis: GraphAxis;
  yAxis: GraphAxis;
  nodes: GraphNode[];
  nodeConfig: GraphNodeConfig;
  responseCurve?: { x: number; y: number }[];
  perNodeCurves?: { nodeId: string; points: { x: number; y: number }[] }[];
  onNodeAdd?: (x: number, y: number) => void;
  onNodeChange?: (id: string, changes: Partial<GraphNode>) => void;
  onNodeRemove?: (id: string) => void;
  onNodeDragStart?: (id: string) => void;
  onNodeDragEnd?: (id: string) => void;
  className?: string;
}
