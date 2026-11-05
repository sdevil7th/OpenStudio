// Pure offline preparation shared by the source runner and packaged support tool.
// Serializer implementations are supplied from the app's actual source at build time.
export function prepareMIDI(projectText, selected, { parseValidatedProject,
  serializeMIDIClipsForBackend, getMIDIClipSourceLoopLength, midiExportOptions }) {
  if (!Array.isArray(selected) || !selected.every(id => typeof id === "string")) throw new Error("Invalid clip selection");
  const project = parseValidatedProject(projectText.replace(/^\uFEFF/, ""));
  const tracks = project.tracks.filter(track => (selected.length || track.type === "midi" || track.type === "instrument") && track.midiClips?.length);
  const clips = tracks.flatMap(track => track.midiClips).filter(clip => !selected.length || selected.includes(clip.id));
  if (selected.some(id => !clips.some(clip => clip.id === id))) throw new Error("Selected MIDI clip is absent from this snapshot");
  const start = selected.length && clips.length ? Math.min(...clips.map(clip => clip.startTime)) : 0;
  const end = selected.length && clips.length ? Math.max(...clips.map(clip => clip.startTime + clip.duration)) : Infinity;
  const unsupported = [];
  let bound = 0;
  for (const track of tracks) for (const effect of track.midiEffects ?? [])
    if (effect.enabled !== false && !["pitch", "velocity", "time", "arpeggiator"].includes(effect.type))
      unsupported.push(`Unsupported MIDI effect: ${effect.type}`);
  for (const track of tracks) for (const clip of track.midiClips) {
    if (!clips.includes(clip)) continue;
    if (clip.notes?.length) throw new Error("Legacy note-array projects need migration in OpenStudio before comparison");
    const loops = clip.loopEnabled === false ? 1 : Math.ceil(clip.duration / Math.max(.01, getMIDIClipSourceLoopLength(clip))) + 1;
    bound += loops * ((clip.events?.length ?? 0) + (clip.ccEvents?.length ?? 0) + 1);
    for (const effect of track.midiEffects ?? []) if (effect.enabled !== false && effect.type === "arpeggiator")
      bound += Math.ceil(clip.duration / Math.max(.01, effect.rateSeconds ?? .125)) * 256;
    if (bound > 250000) throw new Error("Expanded MIDI exceeds the offline comparison work limit");
    for (const event of clip.events ?? []) {
      if (!["noteOn", "noteOff", "cc", "pitchBend", "programChange", "channelPressure", "polyPressure"].includes(event.type))
        unsupported.push(`Unsupported source event: ${event.type}`);
      if (event.centOffset) unsupported.push("Per-note centOffset is not represented by the MIDI exporter");
    }
  }
  const expectedTracks = tracks.map(track => ({ name: track.name, id: track.id,
    clips: serializeMIDIClipsForBackend(track.midiClips.filter(clip => clips.includes(clip))
      .map(clip => ({ ...clip, startTime: clip.startTime - start })), track.midiEffects ?? []) }))
    .filter(track => track.clips.some(clip => clip.events.length));
  return { schemaVersion: 1, scope: selected.length ? "selected_clips" : "project",
    selectedClipIds: selected, rangeStart: start, unsupported: [...new Set(unsupported)], tracks: expectedTracks,
    timing: midiExportOptions({ transport: { tempo: project.tempo }, tempoMarkers: project.tempoMarkers ?? [],
      timeSignature: project.timeSignature ?? { numerator: 4, denominator: 4 } }, start, end) };
}
