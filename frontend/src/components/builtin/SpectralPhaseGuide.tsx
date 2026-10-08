import type { BuiltInPluginSchema } from "../../services/NativeBridge";

export function SpectralPhaseGuide({ schema }: { schema: BuiltInPluginSchema }) {
  const value = (id: string) => schema.parameters.find(parameter => parameter.id === id)?.value ?? 0;
  const enabled = value("spectralPhaseEnabled") >= .5;
  const curves = ["L", "R"].map(channel => Array.from({ length: 48 }, (_, i) => value(`spectralPhase${channel}${i}`) * value("spectralPhaseAmount")));
  const extent = Math.max(180, ...curves.flat().map(Math.abs));
  const points = (curve: number[]) => curve.map((degrees, i) => `${32 + i * 416 / 47},${52 - degrees / extent * 40}`).join(" ");
  return <figure className="flex min-w-0 shrink-0 flex-col gap-1" aria-label="Saved spectral phase curve">
    <svg viewBox="0 0 480 114" className="max-h-28 w-full" role="img" aria-label="Left and right phase correction from 20 Hz to 20 kHz">
      <path d="M32 12V92H448 M32 52H448" fill="none" stroke="currentColor" opacity={.25} />
      <polyline points={points(curves[0])} fill="none" stroke="#38bdf8" strokeWidth={2} />
      <polyline points={points(curves[1])} fill="none" stroke="#fbbf24" strokeWidth={2} strokeDasharray="4 3" />
      <g fill="currentColor" fontSize={9}><text x={1} y={16}>{extent.toFixed(0)}°</text><text x={8} y={55}>0°</text><text x={1} y={94}>−{extent.toFixed(0)}°</text><text x={32} y={110}>20 Hz</text><text x={217} y={110}>632 Hz</text><text x={414} y={110}>20 kHz</text></g>
    </svg>
    <figcaption className="text-xs leading-relaxed text-daw-text-muted">Left: blue; Right: dashed gold. {enabled ? "2,304 samples of compensated latency, including bypass." : "Spectral processing is off; its curve remains saved."} Analyze related tracks in Align to learn a curve. This shows the requested phase; finite FIR response can differ near the frequency limits.</figcaption>
  </figure>;
}
