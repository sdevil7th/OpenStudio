import { useEffect, useState } from "react";
import { nativeBridge, type TrackRoutingInfo } from "../services/NativeBridge";

export function MIDIOutputStatus({ trackId, active }: { trackId: string; active: boolean }) {
  const [status, setStatus] = useState<TrackRoutingInfo["midiOutputDiagnostics"]>();
  useEffect(() => {
    setStatus(undefined);
    if (!active) return;
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try { const routing = await nativeBridge.getTrackRoutingInfo(trackId); if (!cancelled) setStatus(routing?.midiOutputDiagnostics); }
      catch { if (!cancelled) setStatus(undefined); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [trackId, active]);
  if (!status) return null;
  return <div className="space-y-1 text-[10px] leading-relaxed" aria-label="MIDI output status">
    {status.policyPending && <p className="text-neutral-400" role="status">Overlap policy waits for held keys to release.</p>}
    {status.droppedMessages > 0 && <p className="text-amber-300" role="status">MIDI output queue dropped {status.droppedMessages} messages; {status.recoveryCount} recovery resets. Affected channels release pedals and notes before new queued events resume.</p>}
    {status.oversizedMessages > 0 && <p className="text-amber-300" role="status">Skipped {status.oversizedMessages} messages longer than 256 bytes.</p>}
  </div>;
}
