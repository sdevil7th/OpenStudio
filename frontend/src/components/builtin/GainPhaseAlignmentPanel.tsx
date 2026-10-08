import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../../store/useDAWStore";
import { nativeBridge, type BuiltInPluginAddress, type GainPhaseAlignmentEntry, type GainPhaseAlignmentResult } from "../../services/NativeBridge";

export function GainPhaseAlignmentPanel({ address, onApply, historyReplayRevision }: {
  historyReplayRevision?: number;
  address: BuiltInPluginAddress;
  onApply?: (entries: GainPhaseAlignmentEntry[]) => Promise<GainPhaseAlignmentResult>;
}) {
  const { tracks } = useDAWStore(useShallow(s => ({ tracks: s.tracks })));
  const [candidates, setCandidates] = useState<BuiltInPluginAddress[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [reference, setReference] = useState(address.instanceId ?? "");
  const [channelPolicy, setChannelPolicy] = useState<"independent" | "linked">("independent");
  const [captureSeconds, setCaptureSeconds] = useState(.5);
  const [weakSignal, setWeakSignal] = useState(false);
  const [routePolicy, setRoutePolicy] = useState<"inputs" | "direct-master" | "fixed-master">("inputs");
  const projectSpan = captureSeconds === -1;
  const projectEndSeconds = tracks.reduce((end, track) => [...track.clips, ...track.midiClips].reduce((latest, clip) => Math.max(latest, clip.startTime + clip.duration), end), 0);
  const [phaseMode, setPhaseMode] = useState<"time" | "allpass" | "spectral">("time");
  const [discovery, setDiscovery] = useState<GainPhaseAlignmentResult | null>(null);
  const [selectedGroup, setSelectedGroup] = useState(0);
  const [result, setResult] = useState<GainPhaseAlignmentResult | null>(null);
  const [audition, setAudition] = useState<{ before: GainPhaseAlignmentEntry[]; after: GainPhaseAlignmentEntry[]; aligned: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const activeCapture = useRef("");
  const [captureProgress, setCaptureProgress] = useState<{ stage: number; progress: number; cancelling?: boolean } | null>(null);
  useEffect(() => { setResult(null); setAudition(null); setDiscovery(null); }, [historyReplayRevision]);
  const name = (item: BuiltInPluginAddress) => `${tracks.find(track => track.id === item.trackId)?.name ?? item.trackId ?? "Track"} · ${item.chain === "input" ? "Input" : "FX"} ${(item.fxIndex ?? 0) + 1}`;
  const refresh = async () => {
    setError("");
    try {
      const next = await nativeBridge.gainPhaseAlignment("list");
      if (!mounted.current) return;
      if (!next.success) throw new Error(next.error ?? "Could not list alignment instances");
      setCandidates(next.candidates ?? []); setResult(null); setAudition(null); setDiscovery(null);
      const current = (next.candidates ?? []).find(item => item.instanceId === address.instanceId) ?? next.candidates?.[0];
      setReference(current?.instanceId ?? ""); setSelected(current?.instanceId ? [current.instanceId] : []);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not list instances"); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; if (activeCapture.current) void nativeBridge.gainPhaseAlignmentJob("release", activeCapture.current).catch(() => {}); activeCapture.current = ""; }; }, [address.instanceId]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (operation: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError("");
    try { await operation(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Alignment failed"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const capture = (discoverGroups = false) => void run(async () => {
    setResult(null); setAudition(null); setDiscovery(null);
    const members = candidates.filter(item => selected.includes(item.instanceId ?? ""));
    members.sort((a, b) => Number(b.instanceId === reference) - Number(a.instanceId === reference));
    if (discoverGroups) setPhaseMode("time");
    const jobId = crypto.randomUUID();
    activeCapture.current = jobId; setCaptureProgress({ stage: 0, progress: 0 });
    const heartbeat = window.setInterval(() => {
      void nativeBridge.gainPhaseAlignmentJob("status", jobId).then(status => {
        if (mounted.current && activeCapture.current === jobId && status.success)
          setCaptureProgress(current => ({ stage: status.stage ?? 0, progress: status.progress ?? 0, cancelling: current?.cancelling }));
      }).catch(() => { /* The capture completion reports bridge errors. */ });
    }, 1000);
    try {
      const next = await nativeBridge.gainPhaseAlignment("capture", members.map(item => ({ address: item })), channelPolicy, !discoverGroups && phaseMode === "allpass", captureSeconds, !discoverGroups && phaseMode === "spectral", jobId, discoverGroups, { projectSpan, projectEndSeconds, weakSignal: projectSpan && weakSignal, routePolicy });
      if (!next.success) throw new Error(next.error ?? "Capture failed");
      if (mounted.current && activeCapture.current === jobId) {
        setDiscovery(next.discovery ? next : null); setSelectedGroup(0);
        setResult(next.discovery ? next.groups?.[0] ?? null : next);
      }
    } finally {
      window.clearInterval(heartbeat);
      if (activeCapture.current === jobId) { activeCapture.current = ""; if (mounted.current) setCaptureProgress(null); }
      void nativeBridge.gainPhaseAlignmentJob("release", jobId).catch(() => {});
    }
  });
  const apply = () => void run(async () => {
    if (!onApply || !result?.accepted || !result.entries) return;
    const changed = await onApply(result.entries);
    if (!changed.success || !changed.before || !changed.after) throw new Error(changed.error ?? "Group was not applied");
    if (mounted.current) setAudition({ before: changed.before, after: changed.after, aligned: true });
  });
  const switchAudition = () => void run(async () => {
    if (!onApply || !audition) return;
    const target = audition.aligned ? audition.before : audition.after;
    const expected = audition.aligned ? audition.after : audition.before;
    const changed = await onApply(target.map((entry, index) => ({ ...entry, expected: expected[index].values })));
    if (!changed.success) throw new Error(changed.error ?? "Group audition was not applied");
    if (mounted.current) setAudition({ ...audition, aligned: !audition.aligned });
  });
  return <section id="utility-alignment" role="tabpanel" aria-label="Align tracks" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4 text-xs">
    <p className="text-daw-text-muted">Select existing Gain Phase instances on related tracks. Play a continuous section with looping off, then analyze their inputs.</p>
    <div className="flex items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1">Reference<select className="suite-select" aria-label="Alignment reference" disabled={busy} value={reference} onChange={event => { const id = event.target.value; setReference(id); setSelected(current => current.includes(id) ? current : [...current.slice(0, 7), id]); setResult(null); setAudition(null); setDiscovery(null); }}>
        {candidates.map(item => <option key={item.instanceId} value={item.instanceId}>{name(item)}</option>)}
      </select></label>
      <label className="flex min-w-0 flex-1 flex-col gap-1">Channels<select className="suite-select" aria-label="Alignment channel policy" disabled={busy} value={channelPolicy} onChange={event => { setChannelPolicy(event.target.value as "independent" | "linked"); setResult(null); setAudition(null); setDiscovery(null); }}><option value="independent">Independent L/R</option><option value="linked">Stereo linked</option></select></label>
      <button className="suite-button" disabled={busy} onClick={() => void run(refresh)}>Refresh</button>
    </div>
    <details className="shrink-0 rounded border border-daw-border-light px-3 py-2">
      <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-daw-accent">Capture settings <span className="ml-2 text-daw-text-muted">{projectSpan ? "To project end" : `${captureSeconds} s`} / {phaseMode === "time" ? "Timing" : phaseMode === "allpass" ? "All-pass fit" : "Spectral FIR"}</span></summary>
      <div className="mt-3 flex flex-col gap-3">
    <label className="flex shrink-0 items-center gap-2">Capture<select className="suite-select" aria-label="Alignment capture duration" disabled={busy} value={captureSeconds} onChange={event => { setCaptureSeconds(Number(event.target.value)); if (Number(event.target.value) > 4 || Number(event.target.value) === -1) setPhaseMode("time"); setResult(null); setAudition(null); setDiscovery(null); }}><option value={.5}>Short (up to 0.5 s)</option><option value={2}>2 s / three sections</option><option value={4}>4 s / three sections</option><option value={30}>30 s / three windows</option><option value={60}>60 s / three windows</option><option value={120}>120 s / three windows</option><option value={-1}>To project end / continuous</option></select></label>
    <label className="flex shrink-0 items-center gap-2">Phase correction<select className="suite-select" aria-label="Alignment phase correction" disabled={busy || captureSeconds > 4 || projectSpan} value={phaseMode} onChange={event => { setPhaseMode(event.target.value as typeof phaseMode); setResult(null); setAudition(null); setDiscovery(null); }}><option value="time">Timing only</option><option value="allpass">All-pass fit</option><option value="spectral">Spectral FIR</option></select></label>
    <label className="flex shrink-0 items-center gap-2">Routing<select className="suite-select min-w-0 flex-1" aria-label="Alignment routing policy" disabled={busy} value={routePolicy} onChange={event => { setRoutePolicy(event.target.value as typeof routePolicy); setResult(null); setAudition(null); setDiscovery(null); }}><option value="inputs">Captured inputs only</option><option value="direct-master">Direct master only</option><option value="fixed-master">Master with fixed FX latency</option></select></label>
    {routePolicy === "direct-master" && <p className="text-xs text-daw-text-muted">Requires Gain Phase last in track FX, master output enabled, matching hardware outputs and no enabled sends. Downstream phase response is not measured.</p>}
    {routePolicy === "fixed-master" && <p className="text-xs text-daw-text-muted">Accounts for reported downstream track-FX latency and host delay compensation. Requires matching master output ranges and no enabled sends. Routing or latency changes invalidate the capture. Nonlinear or frequency-dependent phase changes are not inferred.</p>}
    {projectSpan && <><p className="text-xs text-daw-text-muted">Captures from playback's current position to the last project clip ({projectEndSeconds.toFixed(1)} s), with 8 seconds to 30 minutes remaining. Start playback near the beginning to span the arrangement. Every sample reaches the analysis worker through a bounded queue (at most 4 MiB of queued stereo audio per instance). Queue overflow, seeks or route changes invalidate the capture.</p><label className="flex shrink-0 items-center gap-2"><input type="checkbox" aria-label="Allow weak shared signal" disabled={busy} checked={weakSignal} onChange={event => { setWeakSignal(event.target.checked); setResult(null); setAudition(null); setDiscovery(null); }} />Allow weak shared signal with repeated timing evidence</label><p className="text-xs text-daw-text-muted">At least six windows and three quarters of measurable windows must qualify. Silent windows are omitted; conflicting qualified delays or polarities reject the group. This does not identify instruments or guarantee that bleed belongs in the same group.</p></>}
    {captureSeconds > 4 && <p className="text-xs text-daw-text-muted">Samples three short windows at the beginning, middle and end of the selected span. Playback must remain continuous through the gaps. Timing/polarity only; use up to 4 s for phase fitting. At most 1.5 MiB per stereo instance is retained.</p>}
    {phaseMode === "spectral" && <p className="text-xs text-daw-text-muted">Saves a frequency-dependent curve. Adds 2,304 samples of compensated latency to each selected instance, including bypass. Weak or inconsistent evidence keeps a unity curve.</p>}
      </div>
    </details>
    <div className="flex shrink-0 items-center justify-between gap-2"><span>Inputs to analyze ({selected.length}/8)</span><button className="suite-button" disabled={busy || candidates.length < 2} onClick={() => { const preferred = candidates.find(item => item.instanceId === reference); setSelected([...(preferred ? [preferred] : []), ...candidates.filter(item => item.instanceId !== reference)].slice(0, 8).map(item => item.instanceId!)); setResult(null); setAudition(null); setDiscovery(null); }}>Select available</button></div>
    <div className="max-h-28 shrink-0 overflow-y-auto rounded border border-daw-border-light p-2" aria-label="Alignment group">
      {candidates.length < 2 && <p className="text-daw-text-muted">Add Gain Phase to at least two tracks, then refresh.</p>}
      {candidates.map(item => <label key={item.instanceId} className="flex min-h-7 items-center gap-2">
        <input type="checkbox" aria-label={`Align ${name(item)}`} checked={selected.includes(item.instanceId ?? "")} disabled={busy || item.instanceId === reference || (!selected.includes(item.instanceId ?? "") && selected.length >= 8)} onChange={event => { const checked = event.target.checked; setSelected(current => checked ? [...current, item.instanceId!] : current.filter(id => id !== item.instanceId)); setResult(null); setAudition(null); setDiscovery(null); }} />
        <span className="truncate">{name(item)}{item.instanceId === reference ? " · Reference" : ""}</span>
      </label>)}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button className="suite-button" disabled={busy || selected.length < 2} onClick={() => capture()}>{busy ? "Working…" : "Analyze inputs"}</button>
      <button className="suite-button" disabled={busy || selected.length < 2} onClick={() => capture(true)}>Find related groups</button>
      {captureProgress && <button className="suite-button" disabled={captureProgress.cancelling} onClick={() => { setCaptureProgress(current => current ? { ...current, cancelling: true } : null); void nativeBridge.gainPhaseAlignmentJob("cancel", activeCapture.current).catch(() => setError("Could not cancel the capture")); }}>{captureProgress.cancelling ? "Cancelling..." : "Cancel analysis"}</button>}
      {result && !audition && <button className="suite-button" disabled={busy || !result.accepted || !onApply} onClick={apply}>Apply group</button>}
      {audition && <button className="suite-button" disabled={busy} onClick={switchAudition}>{audition.aligned ? "Hear before" : "Hear aligned"}</button>}
      {audition && <span role="status">{audition.aligned ? "Aligned group active" : "Original group active"}</span>}
    </div>
    {captureProgress && <div className="flex shrink-0 items-center gap-2" role="status"><progress aria-label="Alignment progress" className="min-w-0 flex-1" max={1} value={captureProgress.progress} /><span>{captureProgress.stage === 0 ? "Waiting for capture" : captureProgress.stage === 1 ? `Capturing ${Math.round(captureProgress.progress * 100)}%` : `Analyzing ${Math.round(captureProgress.progress * 100)}%`}</span></div>}
    {error && <p role="alert" className="text-daw-record">{error}</p>}
    {discovery && <div className="flex shrink-0 flex-col gap-2 rounded border border-daw-border-light p-2" aria-label="Discovered alignment groups">
      <p>{discovery.groups?.length ?? 0} related groups; {discovery.unmatched?.length ?? 0} unmatched inputs. Choose a group to review and apply. Unmatched inputs keep their settings.</p>
      {!!discovery.groups?.length && <div className="flex flex-wrap items-center gap-2"><label className="flex min-w-0 flex-1 items-center gap-2">Group<select className="suite-select min-w-0 flex-1" aria-label="Discovered alignment group" value={selectedGroup} disabled={busy} onChange={event => { const index = Number(event.target.value); setSelectedGroup(index); setResult(discovery.groups?.[index] ?? null); setAudition(null); }}>{discovery.groups.map((group, index) => <option key={index} value={index}>Group {index + 1} ({group.entries?.length ?? 0} inputs)</option>)}</select></label><button className="suite-button" disabled={busy || !result?.entries?.length} onClick={() => { setSelected(result!.entries!.map(entry => entry.address.instanceId!)); setReference(result!.entries![0].address.instanceId!); setDiscovery(null); setResult(null); setAudition(null); }}>Use group for analysis</button></div>}
      {!!discovery.unmatched?.length && <details><summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-daw-accent">Unmatched inputs</summary><p className="pt-1 text-daw-text-muted">{discovery.unmatched.map(name).join(", ")}</p></details>}
    </div>}
    {result && <p className="text-xs text-daw-text-muted">Captured {result.captureSeconds?.toFixed(2) ?? ((result.samples ?? 0) / (result.sampleRate ?? 48000)).toFixed(2)} s{result.sparse ? ` span (${result.sampledSeconds?.toFixed(2)} s retained)` : ""}; {result.continuous ? `${result.sectionCount} contiguous windows; ${(result.coveredSamples ?? result.samples ?? 0).toLocaleString()} samples covered. At least six and 75% of measurable windows must agree.` : result.sectionCount === 16 ? "sixteen windows; at least six and 75% of measurable windows must qualify, with consistent polarity and lags within one sample." : result.sectionCount === 3 ? "three beginning/middle/end sections must agree in polarity and within one sample." : "one timing window."}</p>}
    {result?.channelPolicy === "linked" && <p className="text-xs text-daw-text-muted">Stereo linked: one delay, polarity and fitted phase filter per instance. Measurable channels must agree within one sample.</p>}
    {result?.entries && <div className="min-h-32 flex-1 overflow-y-auto rounded border border-daw-border-light" aria-label="Alignment results">
      <table className="w-full text-left tabular-nums"><thead><tr className="border-b border-daw-border-light"><th className="p-2">Track / channel</th><th className="p-2">Add delay</th><th className="p-2">Match</th></tr></thead><tbody>
        {result.entries.flatMap(entry => (entry.channels ?? []).map((channel, index) => <tr key={`${entry.address.instanceId}-${index}`} className="border-b border-daw-border-light">
          <td className="max-w-40 p-2"><span className="block truncate" title={name(entry.address)}>{name(entry.address)} · {index ? "R" : "L"}</span><span className="block text-[10px] text-daw-text-muted">{channel.accepted ? `${channel.invert ? "Invert" : "Keep"} polarity${result.channelPolicy === "linked" ? ` / ${channel.reason}` : ""}` : channel.reason}</span></td>
          <td className="p-2"><span className="whitespace-nowrap">{channel.delay.toFixed(3)} smp</span>{channel.sections && <span className="block max-w-48 text-[10px] text-daw-text-muted">Section lags: {channel.sections.map(section => section.lag.toFixed(2)).join(" / ")}</span>}{(result.fitPhase || result.spectralPhase) && <span className="block max-w-48 text-[10px] text-daw-text-muted">{channel.spectralApplied ? `Saved spectral curve; measured ripple ${channel.spectralRippleDB?.toFixed(2)} dB` : channel.phaseApplied ? `${channel.phaseStages} all-pass ${channel.phaseStages === 1 ? "stage" : "stages"} at ${channel.phaseFrequency?.toFixed(0)} Hz` : channel.phaseReason}</span>}</td><td className="p-2">{(channel.correlation * 100).toFixed(0)}%{channel.phaseApplied && <span className="block text-[10px] text-daw-text-muted">Phase {((channel.phaseAgreementBefore ?? 0) * 100).toFixed(0)} to {((channel.phaseAgreementAfter ?? 0) * 100).toFixed(0)}%</span>}</td>
        </tr>))}
      </tbody></table>
    </div>}
    {result && !result.accepted && <p role="status" className="text-daw-text-muted">No changes applied. Try a louder, less repetitive section or a smaller related group.</p>}
    <details className="shrink-0 text-xs leading-relaxed text-daw-text-muted"><summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-daw-accent">How alignment works</summary><p className="pt-2">{channelPolicy === "linked" ? "Both channels receive the same delay and polarity, preserving the relative timing at the captured inputs. Conflicting channel estimates reject the group." : "Each channel is delayed independently to the latest arrival."} The reference can receive delay too. Apply replaces timing/polarity, enables processing and replaces manual phase rotation with the accepted fit, or Off. Editor Undo restores the entire group. All-pass searches one corner and one to four stages. Spectral learns a 48-point phase curve from one capture half, then checks the actual FIR against both halves and rejects over 1 dB of ripple at measured coherent frequencies. Both keep timing-only correction when evidence is weak or inconsistent. Find related groups uses captured audio from the checked inputs, with timing/polarity only. Every pair and lag/polarity cycle must qualify; weak bleed, silence, inconsistent sections or unrelated performances can remain unmatched. It does not infer an instrument from its name. The reference is preferred where present; other groups choose a strong measured reference. Apply changes only the reviewed group. Use group for analysis checks just those members for a subsequent phase fit. Longer captures require three separate timing estimates to agree. Each timing window is limited to 65,536 samples; short capture is limited to the same size. The 30/60/120 s modes retain three windows rather than the whole span and do not fit phase. Silence or timing changes in any measured window reject the group; unmeasured gaps are not evidence of agreement. Cancel analysis or close this panel to abort. An expired editor heartbeat also cancels after six seconds. Phase agreement is a heuristic, not an acoustic correctness score. Host latency compensation covers the saved FIR. Routing, FX order, bypass, latency and output changes invalidate captured proposals. Direct master only enforces its stated topology. Downstream frequency/phase response and unmeasured project gaps are not analyzed.</p></details>
  </section>;
}
