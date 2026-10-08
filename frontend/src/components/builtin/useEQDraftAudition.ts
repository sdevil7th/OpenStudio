import { useEffect, useRef, useState } from "react";
import { nativeBridge, type EQMatchResult } from "../../services/NativeBridge";
import { eqValues, type EQToolbarProps } from "./EQToolbar";

export function useEQDraftAudition(props: EQToolbarProps, bands: EQMatchResult["bands"], expected: Record<string, number> | undefined, sampleRate?: number, continuous = false) {
  const [active, setActive] = useState(false), [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const mounted = useRef(true), session = useRef(""), live = useRef(false), updating = useRef(false);
  const latestBands = useRef(bands); latestBands.current = bands;
  const sentProposal = useRef("");
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const values = eqValues(props.schema);
  const fingerprint = JSON.stringify(values), proposal = JSON.stringify(bands);
  const eligible = values.stereoMode < .5 && values.autoGain < .5
    && values.auditionBand < .5 && (values.detectorListenBand ?? 0) < .5 && values.bypass < .5;
  const stop = async (immediate = false) => {
    const id = session.current; session.current = ""; live.current = false; clearInterval(timer.current);
    if (mounted.current) { setActive(false); setPending(false); if (id) setMessage("Audition stopped."); }
    if (id) await nativeBridge.eqDraftAudition("stop", id, { immediate }).catch(() => {});
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void stop(); }; }, []);
  useEffect(() => { void stop(); setMessage(""); }, [fingerprint, sampleRate, props.historyReplayRevision, props.address.instanceId, props.address.trackId, props.address.chain, props.address.fxIndex]);
  useEffect(() => { if (!continuous || !bands?.length) { void stop(); setMessage(""); } }, [proposal, continuous]);
  useEffect(() => {
    if (!continuous) return;
    const updater = setInterval(() => {
      const id = session.current, next = latestBands.current, key = JSON.stringify(next);
      if (!id || !live.current || updating.current || !next?.length || key === sentProposal.current) return;
      updating.current = true;
      void nativeBridge.eqDraftAudition("update", id, { bands: next }).then(result => {
        if (session.current !== id || !mounted.current) return;
        if (!result.success) { void stop(); setMessage(result.error || "Could not update audition"); }
        else sentProposal.current = key;
      }).catch(() => { if (session.current === id) { void stop(); setMessage("Audition connection lost."); } }).finally(() => { updating.current = false; });
    }, 50);
    return () => clearInterval(updater);
  }, [continuous]);
  const start = async () => {
    if (!eligible || !bands?.length || !expected || pending || active) return;
    const id = crypto.randomUUID(); session.current = id; setPending(true); setMessage("");
    try {
      if (!await props.onFlush()) throw new Error("Pending EQ writes failed");
      const actual = eqValues(await nativeBridge.getBuiltInPluginSchema(props.address));
      const meters = await nativeBridge.getBuiltInPluginMeters(props.address);
      if (Object.entries(expected).some(([key, value]) => actual[key] === undefined || Math.abs(actual[key] - value) > 1e-5)
        || (sampleRate !== undefined && meters?.sampleRate !== sampleRate)) throw new Error("EQ settings or sample rate changed; fit again");
      const state = await nativeBridge.getBuiltInPluginState(props.address);
      if (!state.fullState) throw new Error("The EQ state is unavailable");
      if (session.current !== id || !mounted.current) return;
      const startingBands = latestBands.current;
      if (!startingBands?.length) { await stop(); return; }
      const result = await nativeBridge.eqDraftAudition("start", id, { address: props.address, bands: startingBands, expectedState: state.fullState });
      if (session.current !== id || !mounted.current) return;
      if (!result.success) throw new Error(result.error || "Could not audition the proposal");
      live.current = true; sentProposal.current = JSON.stringify(startingBands);
      setActive(true); setMessage("Auditioning the proposal. Saved EQ and Undo remain unchanged.");
      let polling = false;
      timer.current = setInterval(() => {
        if (polling) return; polling = true;
        void nativeBridge.eqDraftAudition("status", id).then(status => {
          if (session.current !== id) return;
          if (!status.success || !status.active) { void stop(); setMessage(status.reason === 2 ? "EQ changed; audition stopped." : "Audition stopped."); }
        }).catch(() => { if (session.current === id) { void stop(); setMessage("Audition connection lost."); } }).finally(() => { polling = false; });
      }, 1000);
    } catch (reason) {
      if (session.current === id && mounted.current) { await stop(); setMessage(reason instanceof Error ? reason.message : String(reason)); }
    } finally { if (mounted.current && session.current === id) setPending(false); }
  };
  return { active, pending, message, eligible, start, stop };
}
