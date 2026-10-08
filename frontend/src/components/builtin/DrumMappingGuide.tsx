import type { BuiltInPluginSchema } from "../../services/NativeBridge";

export function DrumMappingGuide({ schema, piece }: { schema: BuiltInPluginSchema; piece: number }) {
  const mappings = schema.drumMapping?.filter(row => row.piece === piece && !row.ignored);
  const articulated = (schema.parameters.find(p => p.id === "articulationEngine")?.value ?? 0) >= .5;
  return <div className="shrink-0 px-5 pb-3 text-xs leading-relaxed text-daw-text-muted" aria-label="Selected drum mapping">
    <details><summary className="min-h-8 cursor-pointer py-1">Mapping &amp; articulation &middot; {mappings?.length ?? 0} input notes</summary>
      <p>{articulated ? "Articulated voices share eight mixer groups." : "Choose Articulated in Performance for additional drum hits."}</p>
      <div className="mt-1 max-h-24 overflow-y-auto text-left" aria-label="Drum input mapping rows">{mappings?.map(row => <p key={row.inputNote}>MIDI {row.inputNote} to {row.voiceNote} - {row.articulation ?? "Synthesized voice"}{row.openness !== undefined && row.openness > 0 ? ` - ${Math.round(row.openness * 100)}% open` : ""}</p>)}</div>
      <p>Closed/pedal hats choke open hats on the same channel. Poly pressure 64+ chokes matching cymbal/hat input keys. Remapping retains ringing voices original input ownership.</p>
      <p>Tuning affects pitched components. Decay scales envelopes and pitch fall; noise generation stays unchanged. Pan offset precedes Width. Unassigned Extended studio notes are silent.</p>
    </details>
  </div>;
}
