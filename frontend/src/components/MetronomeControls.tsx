import { Play, Square } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { MetronomeIcon } from "./icons";
import { Button } from "./ui";

/** One integrated control, shared by the transport bar and settings dialog. */
export function MetronomeControls({ compact = false }: { compact?: boolean }) {
  const { enabled, practice, pending, loadingProject, toggle, setPractice } = useDAWStore(useShallow(s => ({
    enabled: s.metronomeEnabled,
    practice: s.metronomePracticeEnabled,
    pending: s.metronomePracticePending,
    loadingProject: s.isProjectLoading,
    toggle: s.toggleMetronome,
    setPractice: s.setMetronomePracticeEnabled,
  })));
  const active = enabled || practice;
  return (
    <div role="group" aria-label="Metronome controls" className="inline-flex shrink-0 overflow-hidden rounded border border-neutral-600 focus-within:ring-1 focus-within:ring-amber-400">
      <Button
        variant="warning" size={compact ? "icon-lg" : "md"} shape="square"
        active={active} aria-pressed={active} disabled={pending || loadingProject}
        onClick={toggle} className="gap-2 border-0 focus-visible:outline-offset-[-2px]"
        title={active ? "Disable the metronome, including click-only playback" : "Enable the metronome for playback and recording"}
        aria-label={active ? "Disable Metronome" : "Enable Metronome"}
      >
        <MetronomeIcon size={16} />
        {!compact && "Enable"}
      </Button>
      <Button
        variant="warning" size={compact ? "icon-lg" : "md"} shape="square"
        active={practice} aria-pressed={practice} disabled={pending || loadingProject}
        onClick={() => {
          void setPractice(!practice).then(accepted => {
            const state = useDAWStore.getState();
            if (!accepted && state.metronomePracticeError)
              state.showToast(state.metronomePracticeError, "error");
          });
        }}
        className="gap-2 border-0 border-l border-l-neutral-600 focus-visible:outline-offset-[-2px]"
        title={practice
          ? "Stop click-only playback. If enabled for Play/Record, the metronome still follows playback."
          : "Play the click without moving the playhead. Follows Play/Record when started."}
        aria-label={practice ? "Stop click-only metronome" : "Play click-only metronome"}
        data-qa="metronome-practice"
      >
        {practice ? <Square size={compact ? 12 : 14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        {!compact && (practice ? "Stop click only" : "Play click only")}
      </Button>
    </div>
  );
}
