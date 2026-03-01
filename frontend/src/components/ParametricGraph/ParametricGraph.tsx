import { useCallback, useRef, useState } from "react";
import type { ParametricGraphProps, GraphNode } from "./ParametricGraph.types";

// --- Coordinate helpers ---

const MARGIN = { top: 10, right: 14, bottom: 24, left: 38 };

// Band colors — 8 distinct hues
const NODE_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
];

function valueToPixelX(
  value: number,
  min: number,
  max: number,
  scale: "linear" | "log",
  plotWidth: number,
): number {
  if (scale === "log") {
    if (value <= 0) return 0;
    const logMin = Math.log10(Math.max(min, 1));
    const logMax = Math.log10(max);
    return ((Math.log10(value) - logMin) / (logMax - logMin)) * plotWidth;
  }
  return ((value - min) / (max - min)) * plotWidth;
}

function pixelToValueX(
  px: number,
  min: number,
  max: number,
  scale: "linear" | "log",
  plotWidth: number,
): number {
  const ratio = Math.max(0, Math.min(1, px / plotWidth));
  if (scale === "log") {
    const logMin = Math.log10(Math.max(min, 1));
    const logMax = Math.log10(max);
    return Math.pow(10, logMin + ratio * (logMax - logMin));
  }
  return min + ratio * (max - min);
}

function valueToPixelY(
  value: number,
  min: number,
  max: number,
  plotHeight: number,
): number {
  return (1 - (value - min) / (max - min)) * plotHeight;
}

function pixelToValueY(
  py: number,
  min: number,
  max: number,
  plotHeight: number,
): number {
  const ratio = Math.max(0, Math.min(1, py / plotHeight));
  return max - ratio * (max - min);
}

// --- Format helpers ---

function formatAxisValue(value: number, unit?: string, scale?: string): string {
  if (unit === "Hz") {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
    return `${Math.round(value)}`;
  }
  if (unit === "dB") return `${value > 0 ? "+" : ""}${value.toFixed(0)}`;
  if (unit === "ms") return `${Math.round(value)}`;
  if (unit === "%") return `${Math.round(value)}`;
  if (unit === "s") return `${value.toFixed(1)}`;
  if (scale === "log") return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

export function ParametricGraph({
  width,
  height,
  xAxis,
  yAxis,
  nodes,
  nodeConfig,
  responseCurve,
  perNodeCurves,
  onNodeAdd,
  onNodeChange,
  onNodeRemove,
  onNodeDragStart,
  onNodeDragEnd,
  className,
}: ParametricGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;

  // --- Coordinate converters bound to current axes ---
  const toPixelX = useCallback(
    (v: number) => valueToPixelX(v, xAxis.min, xAxis.max, xAxis.scale, plotWidth),
    [xAxis.min, xAxis.max, xAxis.scale, plotWidth],
  );
  const toPixelY = useCallback(
    (v: number) => valueToPixelY(v, yAxis.min, yAxis.max, plotHeight),
    [yAxis.min, yAxis.max, plotHeight],
  );
  const fromPixelX = useCallback(
    (px: number) => pixelToValueX(px, xAxis.min, xAxis.max, xAxis.scale, plotWidth),
    [xAxis.min, xAxis.max, xAxis.scale, plotWidth],
  );
  const fromPixelY = useCallback(
    (py: number) => pixelToValueY(py, yAxis.min, yAxis.max, plotHeight),
    [yAxis.min, yAxis.max, plotHeight],
  );

  // --- Event handlers ---

  const getSVGPoint = useCallback(
    (e: React.PointerEvent | React.MouseEvent) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: e.clientX - rect.left - MARGIN.left,
        y: e.clientY - rect.top - MARGIN.top,
      };
    },
    [],
  );

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<SVGRectElement>) => {
      if (!onNodeAdd) return;
      const pt = getSVGPoint(e);
      const xVal = fromPixelX(pt.x);
      const yVal = fromPixelY(pt.y);
      onNodeAdd(xVal, yVal);
    },
    [onNodeAdd, getSVGPoint, fromPixelX, fromPixelY],
  );

  const handleNodePointerDown = useCallback(
    (e: React.PointerEvent<SVGCircleElement>, nodeId: string) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as SVGCircleElement).setPointerCapture(e.pointerId);
      setDragNodeId(nodeId);
      onNodeDragStart?.(nodeId);
    },
    [onNodeDragStart],
  );

  const handleNodePointerMove = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!dragNodeId || !onNodeChange) return;
      const pt = getSVGPoint(e);
      const xVal = Math.max(xAxis.min, Math.min(xAxis.max, fromPixelX(pt.x)));
      const yVal = Math.max(yAxis.min, Math.min(yAxis.max, fromPixelY(pt.y)));
      onNodeChange(dragNodeId, { x: xVal, y: yVal });
    },
    [dragNodeId, onNodeChange, getSVGPoint, fromPixelX, fromPixelY, xAxis, yAxis],
  );

  const handleNodePointerUp = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (dragNodeId) {
        (e.target as SVGCircleElement).releasePointerCapture(e.pointerId);
        onNodeDragEnd?.(dragNodeId);
        setDragNodeId(null);
      }
    },
    [dragNodeId, onNodeDragEnd],
  );

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      onNodeRemove?.(nodeId);
    },
    [onNodeRemove],
  );

  const handleNodeWheel = useCallback(
    (e: React.WheelEvent, node: GraphNode) => {
      e.stopPropagation();
      if (!onNodeChange || !nodeConfig.zAxis || node.z === undefined) return;
      const { min, max, sensitivity } = nodeConfig.zAxis;
      const delta = -e.deltaY * sensitivity;
      const newZ = Math.max(min, Math.min(max, node.z + delta));
      onNodeChange(node.id, { z: newZ });
    },
    [onNodeChange, nodeConfig.zAxis],
  );

  // --- Rendering ---

  const xGridLines = xAxis.gridLines ?? [];
  const yGridLines = yAxis.gridLines ?? [];

  // Build the combined response curve path
  let responsePath = "";
  let responseAreaPath = "";
  if (responseCurve && responseCurve.length > 0) {
    const zeroY = toPixelY(0);
    const pts = responseCurve.map((p) => ({
      px: toPixelX(p.x),
      py: toPixelY(p.y),
    }));
    responsePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.px} ${p.py}`).join(" ");
    responseAreaPath =
      `M ${pts[0].px} ${zeroY} ` +
      pts.map((p) => `L ${p.px} ${p.py}`).join(" ") +
      ` L ${pts[pts.length - 1].px} ${zeroY} Z`;
  }

  // Build per-node curve paths
  const nodeCurvePaths: { nodeId: string; path: string }[] = [];
  if (perNodeCurves) {
    for (const nc of perNodeCurves) {
      const pts = nc.points.map((p) => ({
        px: toPixelX(p.x),
        py: toPixelY(p.y),
      }));
      const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.px} ${p.py}`).join(" ");
      nodeCurvePaths.push({ nodeId: nc.nodeId, path });
    }
  }

  // Find the enabled nodes for rendering
  const enabledNodes = nodes.filter((n) => n.enabled);

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      className={`select-none ${className ?? ""}`}
      style={{ background: "#0a0a0a" }}
    >
      <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
        {/* Plot background */}
        <rect
          width={plotWidth}
          height={plotHeight}
          fill="#111111"
          rx={2}
          onClick={handleBackgroundClick}
          style={{ cursor: "crosshair" }}
        />

        {/* X grid lines */}
        {xGridLines.map((v) => {
          const px = toPixelX(v);
          if (px < 0 || px > plotWidth) return null;
          return (
            <line
              key={`xg-${v}`}
              x1={px}
              y1={0}
              x2={px}
              y2={plotHeight}
              stroke="#222"
              strokeWidth={1}
            />
          );
        })}

        {/* Y grid lines */}
        {yGridLines.map((v) => {
          const py = toPixelY(v);
          if (py < 0 || py > plotHeight) return null;
          return (
            <line
              key={`yg-${v}`}
              x1={0}
              y1={py}
              x2={plotWidth}
              y2={py}
              stroke={v === 0 ? "#444" : "#222"}
              strokeWidth={v === 0 ? 1 : 0.5}
            />
          );
        })}

        {/* X axis labels */}
        {xGridLines.map((v) => {
          const px = toPixelX(v);
          if (px < 0 || px > plotWidth) return null;
          return (
            <text
              key={`xl-${v}`}
              x={px}
              y={plotHeight + 14}
              fill="#555"
              fontSize={8}
              textAnchor="middle"
            >
              {formatAxisValue(v, xAxis.unit, xAxis.scale)}
            </text>
          );
        })}

        {/* Y axis labels */}
        {yGridLines.map((v) => {
          const py = toPixelY(v);
          if (py < 0 || py > plotHeight) return null;
          return (
            <text
              key={`yl-${v}`}
              x={-6}
              y={py + 3}
              fill="#555"
              fontSize={8}
              textAnchor="end"
            >
              {formatAxisValue(v, yAxis.unit)}
            </text>
          );
        })}

        {/* Combined response area fill */}
        {responseAreaPath && (
          <path
            d={responseAreaPath}
            fill="rgba(59, 130, 246, 0.08)"
            clipPath="url(#plotClip)"
          />
        )}

        {/* Per-node individual curves */}
        {nodeCurvePaths.map((nc) => {
          const node = enabledNodes.find((n) => n.id === nc.nodeId);
          const nodeIdx = nodes.findIndex((n) => n.id === nc.nodeId);
          const color = node?.color ?? NODE_COLORS[nodeIdx % NODE_COLORS.length] ?? "#666";
          return (
            <path
              key={`nc-${nc.nodeId}`}
              d={nc.path}
              fill="none"
              stroke={color}
              strokeWidth={1}
              strokeOpacity={hoveredNodeId === nc.nodeId ? 0.6 : 0.2}
              clipPath="url(#plotClip)"
            />
          );
        })}

        {/* Combined response curve line */}
        {responsePath && (
          <path
            d={responsePath}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={1.5}
            clipPath="url(#plotClip)"
          />
        )}

        {/* Clip path for curves */}
        <defs>
          <clipPath id="plotClip">
            <rect width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>

        {/* Draggable nodes */}
        {enabledNodes.map((node) => {
          const nodeIdx = nodes.findIndex((n) => n.id === node.id);
          const color = node.color ?? NODE_COLORS[nodeIdx % NODE_COLORS.length] ?? "#3b82f6";
          const cx = toPixelX(node.x);
          const cy = toPixelY(node.y);
          const isHovered = hoveredNodeId === node.id;
          const isDragging = dragNodeId === node.id;

          return (
            <g key={node.id}>
              {/* Larger hit area */}
              <circle
                cx={cx}
                cy={cy}
                r={14}
                fill="transparent"
                style={{ cursor: "grab" }}
                onPointerDown={(e) => handleNodePointerDown(e, node.id)}
                onPointerMove={handleNodePointerMove}
                onPointerUp={handleNodePointerUp}
                onContextMenu={(e) => handleNodeContextMenu(e, node.id)}
                onWheel={(e) => handleNodeWheel(e, node)}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
              />
              {/* Visible node */}
              <circle
                cx={cx}
                cy={cy}
                r={isDragging ? 7 : isHovered ? 6 : 5}
                fill={color}
                fillOpacity={0.85}
                stroke={isHovered || isDragging ? "#fff" : color}
                strokeWidth={isHovered || isDragging ? 1.5 : 1}
                strokeOpacity={0.8}
                pointerEvents="none"
              />
              {/* Q ring (z parameter visualization) */}
              {node.z !== undefined && nodeConfig.zAxis && (isHovered || isDragging) && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={Math.max(8, 30 / Math.max(0.1, node.z))}
                  fill="none"
                  stroke={color}
                  strokeWidth={0.5}
                  strokeOpacity={0.4}
                  strokeDasharray="2,2"
                  pointerEvents="none"
                />
              )}
              {/* Tooltip */}
              {(isHovered || isDragging) && (
                <text
                  x={cx}
                  y={cy - 12}
                  fill="#ccc"
                  fontSize={9}
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {formatAxisValue(node.x, xAxis.unit, xAxis.scale)}{xAxis.unit ? xAxis.unit : ""}{" "}
                  {formatAxisValue(node.y, yAxis.unit)}
                  {node.z !== undefined && nodeConfig.zAxis
                    ? ` ${nodeConfig.zAxis.label}:${node.z.toFixed(1)}`
                    : ""}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
