import type { BuiltInPluginSchema } from "../../services/NativeBridge";

export function SynthMatrixGuide({ schema, selected, onSelect }: {
  schema: BuiltInPluginSchema; selected: number; onSelect: (slot: number) => void;
}) {
  const value = (id: string) => schema.parameters.find(p => p.id === id)?.value ?? 0;
  const label = (id: string) => { const p = schema.parameters.find(p => p.id === id); return p?.enumOptions?.find(option => option.value === p.value)?.label ?? "Off"; };
  const slots = [1, 2, 3, 4, 5, 6, 7, 8];
  const spans = [4, 12, 24, 1, 35, .8, .25, 4, 1, 1, 4, 4, 1, 4, 4, 4, 1, 4, 4, 1, 4, 1, 24, 24, 3, 3, .45, .45], units = ["oct", "st", "dB", "blend", "ct", "sub", "air", "Q oct", "pan", "tone", "time oct", "time oct", "sustain", "time oct", "time oct", "time oct", "sustain", "time oct", "oct", "track", "rate oct", "depth", "st", "st", "shapes", "shapes", "width", "width"];
  const cutoffIgnored = value("filterMode") === 0 && slots.some(slot => value(`matrix${slot}Source`) > 0 && [0, 7].includes(value(`matrix${slot}Target`)) && value(`matrix${slot}Amount`) !== 0);
  return <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-5 py-3" aria-label="Modulation routes">
    <div className="flex gap-2" aria-label="Route pages">
      {[0, 1].map(page => <button key={page} type="button" aria-pressed={Math.floor((selected - 1) / 4) === page}
        className="min-h-8 rounded border border-daw-border-light px-3 text-xs focus-visible:outline-2 focus-visible:outline-daw-accent aria-pressed:border-daw-accent"
        onClick={() => onSelect(page * 4 + 1)}>Routes {page * 4 + 1}-{page * 4 + 4}</button>)}
    </div>
    {slots.slice(selected <= 4 ? 0 : 4, selected <= 4 ? 4 : 8).map(slot => {
      const source = value(`matrix${slot}Source`), target = value(`matrix${slot}Target`), amount = value(`matrix${slot}Amount`);
      return <button key={slot} type="button" aria-label={`Edit route ${slot}`} aria-pressed={selected === slot}
        className={`flex min-h-10 items-center justify-between gap-3 rounded border px-3 py-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-daw-accent ${selected === slot ? "border-daw-accent bg-daw-accent/10" : "border-daw-border-light"}`} onClick={() => onSelect(slot)}>
        <span className="shrink-0 text-daw-text-muted">{slot}</span><span className="min-w-0 flex-1">{label(`matrix${slot}Source`)} {source > 0 && <>&rarr; {label(`matrix${slot}Target`)}</>}</span>
        <span className="shrink-0 tabular-nums">{source === 0 || amount === 0 ? "Inactive" : `${amount > 0 ? "+" : ""}${(amount * spans[target]).toFixed(2)} ${units[target]}`}</span>
      </button>;
    })}
    <p className="text-xs leading-relaxed text-daw-text-muted">Amount scales each route. LFO and MPE slide are bipolar; other sources run from 0 to 1. Routes add within the displayed destination range. Cutoff/resonance require an active filter. Envelope timing and LFO rate multiply by powers of two; a +4 octave amount means 16 times the base time/rate. Feedback from envelopes or LFO rate uses the previous sample. Pulse-width routes affect the square component; shape routes blend adjacent waveforms. Parameters stay within their safe ranges.</p>
    <p className="text-xs leading-relaxed text-daw-text-muted">Filter-envelope routes require Independent envelope and a nonzero envelope depth to affect the filter. Key tracking is centered on MIDI note 60. Shared LFO rate modulation adds a per-voice phase offset to the shared clock. Pan routes preserve a hard-panned MIDI channel.</p>
    {value("mpeEnabled") < .5 && slots.some(slot => value(`matrix${slot}Source`) === 8) && <p role="status" className="text-xs text-daw-text-muted">Enable MPE zones to use the slide source.</p>}
    {cutoffIgnored && <p role="status" className="text-xs text-daw-text-muted">Choose Low, High or Band pass in Filter to use cutoff or resonance routes.</p>}
  </div>;
}
