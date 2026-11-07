import { nativeBridge } from "../services/NativeBridge";
import type { DAWActions, DAWState, MIDIClip, Track } from "../store/useDAWStore";
import { serializeMIDIClipsForBackend } from "./midiClipSerialization";
import { midiExportOptions } from "./midiExportOptions";

export interface MIDIExportEntry { track: Track; clip: MIDIClip }

export function selectedMIDIExportEntries(state: DAWState): MIDIExportEntry[] {
  const ids = new Set(state.selectedClipIds.length ? state.selectedClipIds : state.selectedClipId ? [state.selectedClipId] : []);
  const trackIds = new Set(state.selectedTrackIds.length ? state.selectedTrackIds : state.selectedTrackId ? [state.selectedTrackId] : []);
  return state.tracks.flatMap(track => track.midiClips
    .filter(clip => ids.size ? ids.has(clip.id) : trackIds.has(track.id))
    .map(clip => ({ track, clip })));
}

/** Snapshot clips, FX and the tempo map together, before opening the save dialog. */
export async function exportMIDISelection(
  state: DAWState & Pick<DAWActions, "showToast">,
  entries = selectedMIDIExportEntries(state),
  scope: "selected" | "single" = "selected",
): Promise<void> {
  if (!entries.length) return;
  const start = Math.min(...entries.map(({ clip }) => clip.startTime));
  const end = Math.max(...entries.map(({ clip }) => clip.startTime + clip.duration));
  const tracks = state.tracks.flatMap(track => {
    const clips = entries.filter(entry => entry.track.id === track.id)
      .map(({ clip }) => ({ ...clip, startTime: clip.startTime - start }));
    return clips.length ? [{ name: track.name, clips: serializeMIDIClipsForBackend(clips, track.midiEffects || []) }] : [];
  });
  const options = midiExportOptions(state, start, end);
  const title = scope === "single" ? "Export This MIDI Clip" : "Export Selected MIDI Clips";
  const name = entries.length === 1 ? entries[0].clip.name || "MIDI Clip" : "Selected MIDI Clips";
  try {
    const path = await nativeBridge.showSaveDialog(`${name}.mid`, title, "*.mid;*.midi");
    if (!path) return;
    const success = await nativeBridge.exportProjectMIDI(path, tracks, options);
    state.showToast(success ? "MIDI clips exported" : "Failed to export MIDI clips", success ? "success" : "error");
  } catch (error) {
    state.showToast(`Failed to export MIDI clips: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
