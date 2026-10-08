import type { BuiltInPluginSchema } from "../../services/NativeBridge";
import { instrumentNoteName, useInstrumentPerformance } from "./InstrumentEditorParts";

type Performance = NonNullable<BuiltInPluginSchema["visualization"]>["guitarPerformance"];
const strings = ["6 · Low E", "5 · A", "4 · D", "3 · G", "2 · B", "1 · High E"];

export function GuitarPerformanceView({ performance, articulationNames }: { performance: Performance; articulationNames: string[] }) {
  const name = (index: number) => articulationNames[index] ?? `Articulation ${index + 1}`;
  if (!performance?.available) return <div className="guitar-live-performance my-4 text-xs" role="status">Live string allocation unavailable</div>;
  const overrides = performance.nextArticulations.filter(item => item.source === "keyswitch");
  const base = performance.nextArticulations.find(item => item.source !== "keyswitch");
  return <section className="guitar-live-performance my-4 text-xs" aria-label="Live guitar strings">
    <div className="mb-2 flex items-center justify-between gap-2"><strong>LIVE STRINGS</strong><span className="instrument-subtle">{performance.voices.length} voices</span></div>
    <div className="flex flex-col gap-1">{strings.map((label, index) => {
      const voices = performance.voices.filter(voice => voice.stringIndex === index).sort((a, b) => Number(b.assigned) - Number(a.assigned));
      return <div key={index} className="guitar-live-string flex items-start gap-2 border-t py-2" aria-label={`String ${label}`}>
        <span className="guitar-live-string-name shrink-0">{label}</span><div className="min-w-0 flex-1">
          {voices.length ? voices.map(voice => <div key={`${voice.channel}:${voice.slot}`} className="mb-1 last:mb-0">
            <span className="font-semibold">{instrumentNoteName(voice.note)}</span> <span className="instrument-subtle">ch {voice.channel} · {voice.releasing ? "releasing" : voice.held ? "held" : voice.sustained ? "pedal" : "decaying"}</span>
            <div>{voice.plucked ? name(voice.articulation) : "Legacy voice"}{voice.assigned ? " · assigned" : ""}</div>
          </div>) : <span className="instrument-subtle">Idle</span>}
        </div>
      </div>;
    })}</div>
    <div className="mt-2 leading-relaxed" aria-label="Next-note articulation">
      {base && <div>Next notes: {base.source === "legacy" ? "Legacy voice" : `${name(base.articulation)} · panel`}</div>}
      {overrides.map(item => <div key={item.channel}>Ch {item.channel}: {name(item.articulation)} · keyswitch</div>)}
    </div>
    <p className="instrument-subtle mt-2 leading-relaxed">Voice allocation includes releases; note names are before bend or slide. Resonance tails are not string voices.</p>
  </section>;
}

export function GuitarLivePerformance({ articulationNames }: { articulationNames: string[] }) {
  const performance = useInstrumentPerformance()?.guitarPerformance;
  return <GuitarPerformanceView performance={performance} articulationNames={articulationNames} />;
}
