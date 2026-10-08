import { editorButton, editorSelect } from "./PluginEditorControls";
import { useEffect, useRef, useState } from "react";
import { nativeBridge, type BuiltInPluginAddress } from "../../services/NativeBridge";

export function IRAudition({ address, disabled, fingerprint }: { address: BuiltInPluginAddress; disabled: boolean; fingerprint: string }) {
  const session = useRef(crypto.randomUUID());
  const request = useRef(0), mounted = useRef(true);
  const [active, setActive] = useState(false), [message, setMessage] = useState("");
  const [sound, setSound] = useState(0), [input, setInput] = useState(0);
  const stop = () => {
    ++request.current; setActive(false); setMessage("");
    void nativeBridge.irAudition("stop", session.current).catch(() => undefined);
  };
  useEffect(() => {
    mounted.current = true;
    const token = session.current;
    const blur = () => { ++request.current; setActive(false); setMessage(""); void nativeBridge.irAudition("stop", token).catch(() => undefined); };
    window.addEventListener("blur", blur);
    return () => { mounted.current = false; ++request.current; window.removeEventListener("blur", blur); void nativeBridge.irAudition("stop", token).catch(() => undefined); };
  }, [address.instanceId]);
  useEffect(() => { stop(); }, [fingerprint]);
  useEffect(() => {
    if (!active) return;
    let pending = false, ended = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void nativeBridge.irAudition("status", session.current).then(status => {
        if (ended || !mounted.current) return;
        if (!status.success) { setMessage(status.error ?? "Audition unavailable"); setActive(false); }
        else if (status.preparing) setMessage(`Preparing audition ${Math.round((status.progress ?? 0) * 100)}%`);
        else if (!status.playing) setActive(false);
      }).catch(() => { if (!ended && mounted.current) { setActive(false); setMessage("Could not read audition status"); } }).finally(() => { pending = false; });
    }, 300);
    return () => { ended = true; window.clearInterval(timer); };
  }, [active]);
  const play = async () => {
    const id = ++request.current; setActive(true); setMessage("Preparing audition…");
    try {
      const result = await nativeBridge.irAudition("play", session.current, { address, sound, input });
      if (!mounted.current || id !== request.current) return;
      if (!result.success) { setActive(false); setMessage(result.error ?? "Audition unavailable"); return; }
      setMessage(`${result.name ?? "Applied IR"} · ${result.seconds?.toFixed(1)} s${result.truncated ? " (tail capped)" : ""}${(result.attenuationDb ?? 0) < -.05 ? ` · ${(result.attenuationDb ?? 0).toFixed(1)} dB preview attenuation` : ""}`);
    } catch { if (mounted.current && id === request.current) { setActive(false); setMessage("Could not prepare audition"); } }
  };
  return <div className="flex shrink-0 flex-col gap-1 border-t border-daw-border-light pt-2" role="group" aria-label="IR audition">
    <div className="flex flex-wrap items-center gap-2">
      <select className={`${editorSelect} min-w-0`} aria-label="IR test signal" value={sound} disabled={active} onChange={event => setSound(Number(event.target.value))}><option value={0}>Impulse</option><option value={1}>Noise burst</option></select>
      <select className={`${editorSelect} min-w-0`} aria-label="IR test input" value={input} disabled={active} onChange={event => setInput(Number(event.target.value))}><option value={0}>Both inputs</option><option value={1}>Left input</option><option value={2}>Right input</option></select>
      <button className={editorButton} disabled={disabled && !active} onClick={() => active ? stop() : void play()}>{active ? "Stop audition" : "Audition IR"}</button>
    </div>
    <p className="text-[10px] text-daw-text-muted">Applied IR + wet EQ through Master level. FX chains and outer reverb controls bypassed.</p>
    {message && <p className="truncate text-[10px] text-daw-text-muted" role="status" title={message}>{message}</p>}
  </div>;
}
