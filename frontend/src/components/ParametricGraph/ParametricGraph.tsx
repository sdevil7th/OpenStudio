import { useCallback, useId, useRef, useState } from "react";
import type { ParametricGraphProps, GraphNode } from "./ParametricGraph.types";
import { resolveProfiledParameterWheel } from "../../utils/parameterWheel";

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

const GRAPH_COLORS = {
  surface: "var(--openstudio-graph-surface, #0a0a0a)",
  plot: "var(--openstudio-graph-plot, #111111)",
  grid: "var(--openstudio-graph-grid, #222222)",
  gridZero: "var(--openstudio-graph-grid-zero, #444444)",
  label: "var(--openstudio-graph-label, #737373)",
  tooltip: "var(--openstudio-graph-tooltip, #d4d4d4)",
  response: "var(--openstudio-graph-response, #38bdf8)",
  responseFill: "var(--openstudio-graph-response-fill, rgba(56, 189, 248, 0.08))",
};

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
  backgroundCurves,
  backgroundRegions,
  perNodeCurves,
  onNodeAdd,
  onNodeChange,
  onNodeRemove,
  onNodeDragStart,
  onNodeDragEnd,
  onNodeDragCancel,
  className,
  selectedNodeId,
  selectedNodeIds,
  onSelectionChange,
  onNodeSelect,
}: ParametricGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const clipPathId = useId();
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const activeDrag = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const pointerFocus = useRef(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; endX: number; endY: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number; ids: string[]; moved: boolean } | null>(null);


  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom);

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

  const chooseNode = (id: string, toggle = false) => {
    if (onSelectionChange) {
      const current = selectedNodeIds ?? (selectedNodeId ? [selectedNodeId] : []);
      onSelectionChange(toggle ? current.includes(id) ? current.filter(value => value !== id) : [...current, id] : current.includes(id) ? current : [id], id);
    } else onNodeSelect?.(id);
  };
  const handleNodePointerDown = (e: React.PointerEvent<SVGCircleElement>, nodeId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    pointerFocus.current = true; if (onNodeSelect || onSelectionChange) e.currentTarget.focus(); pointerFocus.current = false;
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
    chooseNode(nodeId, toggle);
    if (toggle && onSelectionChange) return;
    const node = nodes.find(item => item.id === nodeId), point = getSVGPoint(e);
    activeDrag.current = { id: nodeId, offsetX: point.x - toPixelX(node?.x ?? 0), offsetY: point.y - toPixelY(node?.y ?? 0) };
    e.currentTarget.setPointerCapture(e.pointerId); setDragNodeId(nodeId); onNodeDragStart?.(nodeId);
  };
  const handleNodePointerMove = (e: React.PointerEvent<SVGCircleElement>) => {
    const drag = activeDrag.current; if (!drag || !onNodeChange) return;
    const pt = getSVGPoint(e), node = nodes.find(item => item.id === drag.id);
    const x = fromPixelX(pt.x - drag.offsetX), y = fromPixelY(pt.y - drag.offsetY);
    onNodeChange(drag.id, node?.lockY ? { x } : { x, y });
  };
  const finishNodeDrag = (e: React.PointerEvent<SVGCircleElement>, canceled = false) => {
    const drag = activeDrag.current; if (!drag) return;
    activeDrag.current = null; setDragNodeId(null);
    if (canceled && onNodeDragCancel) onNodeDragCancel(drag.id); else onNodeDragEnd?.(drag.id);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const startMarquee = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onSelectionChange || e.button !== 0 || activeDrag.current || (e.target instanceof Element && e.target.closest('[role="button"]'))) return;
    const pt = getSVGPoint(e); if (pt.x < 0 || pt.x > plotWidth || pt.y < 0 || pt.y > plotHeight) return;
    e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);
    marqueeStart.current = { ...pt, ids: e.shiftKey || e.ctrlKey || e.metaKey ? selectedNodeIds ?? [] : [], moved: false };
    setMarquee({ ...pt, endX: pt.x, endY: pt.y });
  };
  const moveMarquee = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = marqueeStart.current; if (!start) return;
    const point = getSVGPoint(e), endX = Math.max(0, Math.min(plotWidth, point.x)), endY = Math.max(0, Math.min(plotHeight, point.y));
    start.moved = start.moved || Math.hypot(endX - start.x, endY - start.y) > 3;
    setMarquee({ x: start.x, y: start.y, endX, endY });
    if (start.moved) {
      const contained = nodes.filter(node => node.enabled && toPixelX(node.x) >= Math.min(start.x,endX) && toPixelX(node.x) <= Math.max(start.x,endX) && toPixelY(node.y) >= Math.min(start.y,endY) && toPixelY(node.y) <= Math.max(start.y,endY)).map(node => node.id);
      const selection = [...new Set([...start.ids, ...contained])];onSelectionChange?.(selection, selection[selection.length - 1]);
    }
  };
  const endMarquee = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = marqueeStart.current;if(!start)return;marqueeStart.current=null;setMarquee(null);
    if(!start.moved)onSelectionChange?.(start.ids);
    if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
  };

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
      if (!onNodeChange || !nodeConfig.zAxis || node.z === undefined) return;
      const gesture = resolveProfiledParameterWheel(e.nativeEvent, "graph");
      if (gesture.preventDefault) e.preventDefault();
      if (gesture.stopPropagation) e.stopPropagation();
      if (gesture.operation !== "adjust") return;
      const { min, max, sensitivity } = nodeConfig.zAxis;
      const delta = -gesture.amount * sensitivity * (gesture.precision === "fine" ? 0.1 : 1);
      const newZ = Math.max(min, Math.min(max, node.z + delta));
      onNodeDragStart?.(node.id);
      onNodeChange(node.id, { z: newZ });
      onNodeDragEnd?.(node.id);
    },
    [onNodeChange, nodeConfig.zAxis, onNodeDragEnd, onNodeDragStart],
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

  const backgroundCurvePaths =
    backgroundCurves?.map((curve) => {
      const pts = curve.points.map((p) => ({
        px: toPixelX(p.x),
        py: toPixelY(p.y),
      }));
      return {
        ...curve,
        path: pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.px} ${p.py}`).join(" "),
      };
    }) ?? [];

  // Find the enabled nodes for rendering
  const enabledNodes = nodes.filter((n) => n.enabled);

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      className={`parametric-graph select-none touch-none ${className ?? ""}`}
      tabIndex={onSelectionChange ? 0 : undefined}
      aria-label={onSelectionChange ? "EQ band graph" : undefined}
      onPointerDown={startMarquee} onPointerMove={moveMarquee} onPointerUp={endMarquee} onPointerCancel={endMarquee}
      onDoubleClick={onSelectionChange ? e => { if (!(e.target instanceof Element && e.target.closest('[role="button"]'))) { const point = getSVGPoint(e); if (point.x >= 0 && point.x <= plotWidth && point.y >= 0 && point.y <= plotHeight) onNodeAdd?.(fromPixelX(point.x), fromPixelY(point.y)); } } : undefined}
      onKeyDown={e => {
        if (e.key === "Escape") { if(activeDrag.current){onNodeDragCancel?.(activeDrag.current.id);activeDrag.current=null;setDragNodeId(null);}marqueeStart.current=null;setMarquee(null);e.stopPropagation(); }
        if (onSelectionChange && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {e.preventDefault();e.stopPropagation();onSelectionChange(nodes.filter(node=>node.enabled).map(node=>node.id),selectedNodeId);}
      }}
      style={{ background: GRAPH_COLORS.surface }}
    >
      <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
        {/* Plot background */}
        <rect
          width={plotWidth}
          height={plotHeight}
          fill={GRAPH_COLORS.plot}
          rx={2}
          onClick={onSelectionChange ? undefined : handleBackgroundClick}
          style={{ cursor: "crosshair" }}
        />

        {backgroundRegions?.map(region => <rect key={region.id} data-spectrum-overlap={region.id}
          x={toPixelX(Math.max(xAxis.min, region.start))} y={0}
          width={Math.max(0, toPixelX(Math.min(xAxis.max, region.end)) - toPixelX(Math.max(xAxis.min, region.start)))} height={plotHeight}
          fill={region.color} opacity={region.opacity ?? .12} pointerEvents="none" clipPath={`url(#${clipPathId})`} />)}

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
              stroke={GRAPH_COLORS.grid}
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
              stroke={v === 0 ? GRAPH_COLORS.gridZero : GRAPH_COLORS.grid}
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
              fill={GRAPH_COLORS.label}
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
              fill={GRAPH_COLORS.label}
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
            fill={GRAPH_COLORS.responseFill}
            clipPath={`url(#${clipPathId})`}
          />
        )}

        {/* Background analyzer/modulation curves */}
        {backgroundCurvePaths.map((curve) => (
          <path
            key={curve.id}
            data-background-curve={curve.id}
            d={curve.path}
            fill="none"
            stroke={curve.color ?? GRAPH_COLORS.label}
            strokeWidth={curve.strokeWidth ?? 1}
            strokeOpacity={curve.opacity ?? 0.35}
            clipPath={`url(#${clipPathId})`}
          />
        ))}

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
              clipPath={`url(#${clipPathId})`}
            />
          );
        })}

        {/* Combined response curve line */}
        {responsePath && (
          <path
            d={responsePath}
            fill="none"
            stroke={GRAPH_COLORS.response}
            strokeWidth={1.5}
            clipPath={`url(#${clipPathId})`}
          />
        )}

        {/* Clip path for curves */}
        <defs>
          <clipPath id={clipPathId}>
            <rect width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>

        {marquee && <rect data-band-marquee="true" x={Math.min(marquee.x,marquee.endX)} y={Math.min(marquee.y,marquee.endY)} width={Math.abs(marquee.endX-marquee.x)} height={Math.abs(marquee.endY-marquee.y)} fill="var(--color-daw-accent)" fillOpacity={.13} stroke="var(--color-daw-accent)" strokeDasharray="4 2" pointerEvents="none" />}
        {/* Draggable nodes */}
        {enabledNodes.map((node) => {
          const nodeIdx = nodes.findIndex((n) => n.id === node.id);
          const color = node.color ?? NODE_COLORS[nodeIdx % NODE_COLORS.length] ?? "#3b82f6";
          const cx = toPixelX(node.x);
          const cy = toPixelY(node.y);
          const isHovered = hoveredNodeId === node.id;
          const isDragging = dragNodeId === node.id;
          const isSelected = selectedNodeIds ? selectedNodeIds.includes(node.id) : selectedNodeId === node.id;

          return (
            <g key={node.id}>
              {/* Larger hit area */}
              <circle
                cx={cx}
                cy={cy}
                r={14}
                fill="transparent"
                role={onNodeSelect ? "button" : undefined}
                tabIndex={onNodeSelect ? 0 : undefined}
                aria-label={onNodeSelect ? `${node.label ?? node.id}: ${Math.round(node.x)} Hz${node.lockY ? " cutoff" : `, ${node.y.toFixed(1)} dB`}` : undefined}
                aria-pressed={onNodeSelect ? isSelected : undefined}
                onFocus={() => { if (!pointerFocus.current) chooseNode(node.id); }}
                onKeyDown={e => {
                  if ((onNodeSelect || onSelectionChange) && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); chooseNode(node.id,e.shiftKey||e.ctrlKey||e.metaKey); }
                  if (onSelectionChange && ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) {
                    e.preventDefault();e.stopPropagation();chooseNode(node.id);onNodeDragStart?.(node.id);
                    const direction = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1;
                    if(e.altKey&&node.z!==undefined)onNodeChange?.(node.id,{z:node.z*2**(direction*(e.shiftKey ? .01 : .1))});
                    else if(e.key==="ArrowLeft"||e.key==="ArrowRight")onNodeChange?.(node.id,{x:xAxis.scale==="log"?node.x*2**(direction*(e.shiftKey ? .01 : .1)/12):node.x+direction*(xAxis.max-xAxis.min)/100});
                    else if(!node.lockY)onNodeChange?.(node.id,{y:node.y+direction*(e.shiftKey ? .01 : .1)});
                    onNodeDragEnd?.(node.id);
                  }
                }}
                style={{ cursor: "grab" }}
                onPointerDown={(e) => handleNodePointerDown(e, node.id)}
                onPointerMove={handleNodePointerMove}
                onPointerUp={e => finishNodeDrag(e)}
                onPointerCancel={e => finishNodeDrag(e,true)}
                onLostPointerCapture={e => finishNodeDrag(e,true)}
                onContextMenu={(e) => handleNodeContextMenu(e, node.id)}
                onWheel={(e) => handleNodeWheel(e, node)}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
              />
              {/* Visible node */}
              <circle
                cx={cx}
                cy={cy}
                r={node.displayLabel ? Math.max(isDragging || isSelected ? 9 : 8, node.displayLabel.length * 3.5 + 3) : (isDragging || isSelected ? 7 : isHovered ? 6 : 5)}
                fill={node.displayLabel ? "var(--openstudio-graph-plot, #151719)" : color}
                fillOpacity={0.85}
                stroke={isHovered || isDragging || isSelected ? "var(--openstudio-graph-node-stroke, #ffffff)" : color}
                strokeWidth={node.displayLabel || isHovered || isDragging || isSelected ? 2 : 1}
                strokeOpacity={0.8}
                pointerEvents="none"
              />
              {node.displayLabel && <text x={cx} y={cy} dy=".35em" textAnchor="middle" fontSize={9} fill="var(--openstudio-graph-node-stroke, #ffffff)" pointerEvents="none" aria-hidden="true">{node.displayLabel}</text>}
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
                  fill={GRAPH_COLORS.tooltip}
                  fontSize={9}
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {formatAxisValue(node.x, xAxis.unit, xAxis.scale)}{xAxis.unit ? xAxis.unit : ""}{" "}
                  {node.lockY ? "cutoff" : formatAxisValue(node.y, yAxis.unit)}
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
