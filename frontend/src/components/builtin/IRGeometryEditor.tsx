import { editorButton, editorSelect } from "./PluginEditorControls";
import { useRef, useState } from "react";
import type { BuiltInPluginSchema } from "../../services/NativeBridge";

type Shape = Required<NonNullable<NonNullable<BuiltInPluginSchema["impulseResponse"]>["shape"]>>;
const points = [
  ["Recorded source L", "geometrySourceLX", "geometrySourceLY", "Src L"],
  ["Recorded source R", "geometrySourceRX", "geometrySourceRY", "Src R"],
  ["Microphone L", "geometryMicLX", "geometryMicLY", "Mic L"],
  ["Microphone R", "geometryMicRX", "geometryMicRY", "Mic R"],
  ["Requested source L", "geometryTargetLX", "geometryTargetLY", "New L"],
  ["Requested source R", "geometryTargetRX", "geometryTargetRY", "New R"],
] as const;
type View = { scale: number; x: number; y: number };
export function IRGeometryEditor({ shape, busy, geometry, onChange }: {
  shape: Shape; busy: boolean; geometry?: NonNullable<BuiltInPluginSchema["impulseResponse"]>["geometry"];
  onChange: (patch: Partial<Shape>) => void;
}) {
  const [selected, setSelected] = useState(4);
  const [, refreshView] = useState(0);
  const drag = useRef<{ pointer: number; point: number; view: View } | null>(null);
  const coordinates = points.map(([, x, y]) => [shape[x], shape[y]]);
  const xs = coordinates.map(p => p[0]), ys = coordinates.map(p => p[1]);
  const left = Math.min(...xs) - .5, right = Math.max(...xs) + .5, bottom = Math.min(...ys) - .5, top = Math.max(...ys) + .5;
  const view = drag.current?.view ?? { scale: Math.min(500 / (right - left), 150 / (top - bottom)), x: (left + right) / 2, y: (bottom + top) / 2 };
  const update = (point: number, x: number, y: number) => onChange({
    [points[point][1]]: Math.max(-50, Math.min(50, Math.round(x * 100) / 100)),
    [points[point][2]]: Math.max(-50, Math.min(50, Math.round(y * 100) / 100)),
  });
  return <div className="flex shrink-0 flex-col gap-2" aria-label="Declared direct-path geometry">
    <div className="flex flex-wrap items-center gap-2"><button className={editorButton} disabled={busy || shape.reverse || shape.size !== 1} aria-pressed={shape.geometryEnabled} onClick={() => onChange({ geometryEnabled: !shape.geometryEnabled })}>Direct placement {shape.geometryEnabled ? "On" : "Off"}</button><span className="text-[10px] text-daw-text-muted">Declared coordinates in metres · Size 1, Reverse off</span></div>
    <svg className="h-44 w-full shrink-0 touch-none rounded border border-daw-border-light bg-daw-dark" viewBox="0 0 600 220" aria-label="IR source and microphone positions"
      onPointerMove={event => {
        const current = drag.current; if (!current || current.pointer !== event.pointerId || busy) return;
        const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
        const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        update(current.point, (at.x - 300) / current.view.scale + current.view.x, (110 - at.y) / current.view.scale + current.view.y);
      }} onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; refreshView(value => value + 1); } }} onPointerCancel={() => { drag.current = null; refreshView(value => value + 1); }}>
      <title>Two recorded sources, two microphones and two requested sources. Drag requested markers or use arrow keys; Apply commits the draft.</title>
      {coordinates.slice(0, 2).flatMap((source, index) => coordinates.slice(2, 4).map((mic, channel) => <line key={`${index}-${channel}`} x1={300 + (source[0] - view.x) * view.scale} y1={110 - (source[1] - view.y) * view.scale} x2={300 + (mic[0] - view.x) * view.scale} y2={110 - (mic[1] - view.y) * view.scale} stroke="var(--color-daw-border-light)" />))}
      {coordinates.map(([x, y], index) => <g key={index} transform={`translate(${300 + (x - view.x) * view.scale} ${110 - (y - view.y) * view.scale})`}>
        <circle r={index >= 4 ? 16 : 5} fill={index >= 4 ? "var(--color-daw-accent)" : "var(--color-daw-text-muted)"} opacity={index >= 4 ? .85 : 1}
          className={index >= 4 ? "cursor-move focus-visible:outline-2 focus-visible:outline-daw-accent" : undefined}
          role={index >= 4 ? "button" : undefined} tabIndex={index >= 4 && !busy ? 0 : undefined} aria-label={index >= 4 ? `Move ${points[index][0].toLowerCase()}` : undefined}
          onPointerDown={event => { if (index < 4 || busy) return; event.preventDefault(); setSelected(index); drag.current = { pointer: event.pointerId, point: index, view }; event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); }}
          onKeyDown={event => { if (busy || index < 4 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 1 : .1; update(index, x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0)); }} />
        <text x={index >= 4 || index === 3 ? 13 : -13} y={index >= 4 ? -12 : 17} textAnchor={index >= 4 || index === 3 ? "start" : "end"} fontSize="14" fill="var(--color-daw-text-muted)">{points[index][3]}</text>
      </g>)}
    </svg>
    <div className="flex items-end gap-2"><label className="flex min-w-0 flex-[2] flex-col gap-1 text-[11px]">Point<select className={`${editorSelect} min-w-0`} aria-label="IR geometry point" value={selected} disabled={busy} onChange={event => setSelected(Number(event.target.value))}>{points.map(([label], index) => <option key={label} value={index}>{label}</option>)}</select></label>{(["X", "Y"] as const).map((axis, index) => <label key={axis} className="flex min-w-0 flex-1 flex-col gap-1 text-[11px]">{axis} (m)<input className={`${editorSelect} min-w-0 w-full`} type="number" aria-label={`IR geometry ${axis}`} min={-50} max={50} step={.1} value={coordinates[selected][index]} disabled={busy} onChange={event => onChange({ [points[selected][index + 1] as typeof points[number][1 | 2]]: Number(event.target.value) })} /></label>)}</div>
    <p className="text-[10px] leading-relaxed text-daw-text-muted">Enter your measured source/mic coordinates; defaults are illustrative. Only Direct changes; room reflections stay in place. Recorded-column blends are inactive while enabled. Applied common causal delay: {(geometry?.commonDelayMs ?? 0).toFixed(2)} ms{geometry?.gainLimited ? " · distance gain capped" : ""}. Not a measured new room position.</p>
  </div>;
}
