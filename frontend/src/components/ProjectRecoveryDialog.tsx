import { useEffect, useState } from "react";
import { useShallow } from "zustand/shallow";
import { History, ShieldAlert } from "lucide-react";
import { nativeBridge, type ProjectRecoveryCandidate, type WorkRecoveryEntry } from "../services/NativeBridge";
import { WorkRecoveryItems } from "./WorkRecoveryItems";
import { normalizeWorkRecovery } from "../utils/workRecoveryValidation";
import { useDAWStore } from "../store/useDAWStore";
import { Button, Checkbox, Modal, ModalContent, ModalFooter } from "./ui";

export function ProjectRecoveryDialog() {
  const [candidates, setCandidates] = useState<ProjectRecoveryCandidate[]>([]);
  const [work, setWork] = useState<WorkRecoveryEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [withoutPlugins, setWithoutPlugins] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { requestOpenProject } = useDAWStore(useShallow(state => ({ requestOpenProject: state.requestOpenProject })));

  useEffect(() => {
    let alive = true;
    const discover = () => {
      void Promise.all([nativeBridge.discoverProjectRecovery(), nativeBridge.workRecovery("discover")]).then(([entries, unfinished]) => {
        if (!alive) return;
        const pending = normalizeWorkRecovery(unfinished);
        setWork(pending);
        setCandidates(entries.sort((a, b) => b.savedAt - a.savedAt));
        setOpen(entries.length + pending.length > 0);
      }).catch(error => {
        if (alive) useDAWStore.getState().showToast(`Could not check project recovery: ${String(error)}`, "error");
      });
    };
    discover();
    window.addEventListener("openstudio:discover-recovery", discover);
    return () => { alive = false; window.removeEventListener("openstudio:discover-recovery", discover); };
  }, []);

  const dismiss = async (entry: ProjectRecoveryCandidate) => {
    setBusy(true); setError("");
    try {
      if (!await nativeBridge.dismissProjectRecovery(entry.id)) throw new Error("Could not acknowledge this recovery copy.");
      setCandidates(current => current.filter(item => item.id !== entry.id));
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };

  const close = () => { if (!busy) { setOpen(false); void nativeBridge.stopPreview(); } };
  return <Modal title="Recover an interrupted session" isOpen={open && candidates.length + work.length > 0} onClose={close} size="lg">
    <ModalContent>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-daw-accent/30 bg-daw-accent/10 p-4">
          <History className="mt-0.5 shrink-0 text-daw-accent" size={20} />
          <p className="text-sm leading-6 text-daw-text-secondary">Interrupted sessions and unfinished work are available below. Restore opens an unsaved project copy; recording and AI imports retain the original files. Save As when you are ready.</p>
        </div>
        {candidates.length > 0 && <label className="flex items-center gap-3 text-sm text-daw-text">
          <Checkbox checked={withoutPlugins} onChange={() => setWithoutPlugins(value => !value)} />
          Open without plugins for troubleshooting
        </label>}
        {withoutPlugins && <p className="flex gap-2 text-xs leading-5 text-amber-300"><ShieldAlert size={16} className="shrink-0" />Instruments and FX will not be loaded into this copy. Their saved states remain in the original recovery file.</p>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="space-y-3">
          {candidates.map(entry => <section key={entry.id} className="min-w-0 rounded-lg border border-daw-border bg-daw-dark p-4">
            <p className="truncate text-sm font-semibold text-daw-text" title={entry.projectName}>{entry.projectName}</p>
            <p className="mt-1 break-all text-xs leading-5 text-daw-text-muted">{entry.sourcePath || "Untitled — never saved to a project file"}</p>
            <p className="mt-1 text-xs text-daw-text-secondary">Recovery snapshot: {new Date(entry.savedAt).toLocaleString()}</p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void dismiss(entry)}>Dismiss reminder</Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => {
                setOpen(false);
                void nativeBridge.stopPreview();
                void requestOpenProject(entry.path, { recoveryCopy: true, bypassFX: withoutPlugins }).catch(error =>
                  useDAWStore.getState().showToast(`Recovery could not be opened: ${String(error)}`, "error"));
              }}>Restore copy</Button>
            </div>
          </section>)}
        </div>
        <WorkRecoveryItems entries={work} busy={busy} setBusy={setBusy} remove={id => setWork(current => current.filter(entry => entry.id !== id))} />
      </div>
    </ModalContent>
    <ModalFooter><span className="mr-auto text-xs text-daw-text-muted">Recovery files are retained, including after dismissing a reminder.</span><Button variant="ghost" disabled={busy} onClick={close}>Later</Button></ModalFooter>
  </Modal>;
}
