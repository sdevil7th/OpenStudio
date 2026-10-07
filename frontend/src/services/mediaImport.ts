import { getProjectEpoch } from "../utils/projectLifetime";
import { nativeBridge } from "./NativeBridge";
import { appDialogs } from "./appDialogs";
import { useDAWStore } from "../store/useDAWStore";

export type MediaImportKind = "audio" | "midi" | "media";
export const audioImportFilter = "*.wav;*.wave;*.aif;*.aiff;*.flac;*.ogg;*.mp3;*.m4a;*.aac;*.wma;*.opus";
export const midiImportFilter = "*.mid;*.midi";
let importing = false;

/** Menu, command palette and shortcuts use the same actions as timeline drops. */
export async function importMediaWithDialog(kind: MediaImportKind): Promise<void> {
  if (importing || useDAWStore.getState().globalLocked) return;
  importing = true;
  const epoch = getProjectEpoch();
  const initial = useDAWStore.getState();
  const startTime = initial.transport.currentTime;
  const selectedId = initial.selectedTrackIds[0] ?? initial.selectedTrackId ?? undefined;
  const filter = kind === "audio" ? audioImportFilter : kind === "midi" ? midiImportFilter
    : `${audioImportFilter};${midiImportFilter};*.mp4;*.mov;*.mkv;*.webm;*.avi`;
  try {
    const paths = await nativeBridge.showImportFilesDialog(`Import ${kind === "midi" ? "MIDI" : kind === "audio" ? "Audio" : "Media"} Files`, filter);
    for (const filePath of paths) {
      if (getProjectEpoch() !== epoch || useDAWStore.getState().globalLocked) return;
      const state = useDAWStore.getState();
      const selected = state.tracks.find((track) => track.id === selectedId);
      if (/\.(mid|midi)$/i.test(filePath)) {
        await state.importExternalMIDIAtTimeline({ filePath, startTime,
          targetTrackId: paths.length === 1 && (selected?.type === "midi" || selected?.type === "instrument") ? selected.id : undefined });
      } else {
        await state.importExternalMediaAtTimeline({ filePath, startTime,
          trackId: paths.length === 1 && selected?.type === "audio" ? selected.id : undefined });
      }
    }
  } catch (error) {
    await appDialogs.alert(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { importing = false; }
}
