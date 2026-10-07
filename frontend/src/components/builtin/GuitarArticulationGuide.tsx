import type { BuiltInPluginSchema } from "../../services/NativeBridge";

const names = ["Sustain", "Palm mute", "Harmonic", "Hammer / pull", "Legato slide", "Slide in", "Slide out", "Dead note", "Pop"];
const descriptions = [
  "The normal plucked-string excitation. Existing sustain and sostenuto pedals continue to hold notes.",
  "A short, damped string. Lower note velocities deepen the mute; the live Palm mute control can damp it further.",
  "Harmonic node projects the feedback onto repeated divisions of the string. Higher nodes suppress lower modes.",
  "Overlap two notes on the same string to move its existing vibration to the destination in 4 ms, without another pick burst.",
  "Overlap notes on the same string to glide the existing vibration over Slide time. Without an overlapping source, the note is plucked normally.",
  "New notes glide up two semitones from below over Slide time.",
  "Note-off starts a five-semitone downward slide through the release. Its keyswitch also starts the slide on sounding strings immediately.",
  "A strongly damped excitation with a short noise-like envelope.",
  "A hard excitation with extra string output for an accented attack.",
];

export function GuitarArticulationGuide({ schema }: { schema: BuiltInPluginSchema }) {
  const value = (id: string, fallback: number) => schema.parameters.find(parameter => parameter.id === id)?.value ?? fallback;
  const selected = Math.round(value("articulation", 0));
  return <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6 py-3 text-xs leading-relaxed" aria-label="Guitar articulation guide">
    <p className="text-daw-text">{descriptions[selected]}</p>
    <p className="text-daw-text-muted">New notes use the selected articulation. Hammer and legato keep each string's note ownership; releasing the source note does not stop its destination. Auto string mode chooses the nearest held string for these transitions.</p>
    {value("articulationKeys", 0) >= .5 && <><p className="text-daw-text-muted">Keyswitches latch per MIDI channel and take precedence over this menu until Reset Controllers (CC121) or transport reset. These notes are silent and select the next articulation:</p><dl className="flex flex-wrap gap-x-5 gap-y-1">{names.map((name, index) => <div key={name} className="flex gap-2"><dt className="tabular-nums text-daw-text-muted">{24 + index}</dt><dd>{name}</dd></div>)}</dl></>}
  </div>;
}
