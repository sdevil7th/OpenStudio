import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { automationParameterChoices, automationLaneIsDiscrete, formatAutomationParameterValue, formatAutomationValue } from "../store/automationParams";
import { ProfiledRangeInput } from "./ui";

export function AutomationPreviewControls({ trackId }: { trackId: string }) {
  const { target, track, masterLanes, session, captured, selection, playing, locked, masterWrite, masterTrim, masterSafe, begin, change, capture, cancel, commit, discard, punch, boundary } = useDAWStore(useShallow(state => ({
    target: state.selectedAutomationTarget, track: state.tracks.find(item => item.id === trackId), masterLanes: state.masterAutomationLanes,
    session: state.automationPreviewSession, captured: state.automationCapturedPreview, selection: state.timeSelection,
    playing: state.transport.isPlaying || state.transport.isRecording, locked: state.globalLocked || state.lockSettings.envelopes,
    masterSafe: state.masterAutomationSafeParams, masterWrite: state.masterAutomationWriteEnabled, masterTrim: state.masterAutomationTrimWriteEnabled,
    begin: state.beginAutomationPreview, change: state.setAutomationPreviewValue, capture: state.captureAutomationPreview,
    cancel: state.cancelAutomationPreview, commit: state.commitAutomationPreview, discard: state.discardAutomationPreviewCapture,
    punch:state.punchAutomationPreview,boundary:state.writeAutomationToBoundary,
  })));
  useEffect(() => () => { if (useDAWStore.getState().automationPreviewSession?.trackId === trackId) void useDAWStore.getState().cancelAutomationPreview(); }, [trackId]);
  const lane = target?.kind === "master" && trackId === "master" ? masterLanes.find(item => item.id === target.laneId)
    : target?.kind === "track" && target.trackId === trackId ? track?.automationLanes.find(item => item.id === target.laneId) : undefined;
  const active = session?.trackId === trackId ? session : null, saved = captured?.trackId === trackId ? captured : null;
  const safe = lane && (trackId === "master" ? masterSafe : track?.automationSafeParams)?.includes(lane.param);
  const write = trackId === "master" ? masterWrite || masterTrim : track?.automationWriteEnabled || track?.automationTrimWriteEnabled;
  const eligible = lane && !lane.unavailableParameter && !lane.param.startsWith("midi_") && !safe && !write && !locked;
  const pending = active?.phase === "restoring" || active?.phase === "punching" || Object.values(active?.values ?? {}).some(value => value.pending);
  return <details className="mt-3 rounded border border-neutral-700 p-2 text-[11px]">
    <summary className="cursor-pointer focus-visible:outline focus-visible:outline-daw-accent">Audible Preview &amp; Capture</summary>
    <p className="mt-2 text-neutral-400">Audition selected envelopes without changing their curves. During playback, Punch records these values until Stop or End Punch. Capture retains values for a stopped range Commit. Closing this dialog finishes an active Punch.</p>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" disabled={!eligible || pending || active?.phase === "writing" || !!(session && session.trackId !== trackId)} onClick={() => lane && void begin(trackId, lane.id)}
        className="min-h-8 rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Audition selected envelope</button>
      <button type="button" disabled={!active || pending || active.phase !== "active"} onClick={() => void capture()} className="min-h-8 rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Capture values</button>
      <button type="button" disabled={!active || pending || !playing || active.phase !== "active"} onClick={() => void punch()} className="min-h-8 rounded border border-red-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Punch Preview</button>
      <button type="button" disabled={!active || active.phase === "punching"} onClick={() => void cancel()} className="min-h-8 rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">{active?.phase === "writing" ? "End Punch" : "Cancel Preview"}</button>
      {active?.phase === "writing" && <><button type="button" onClick={() => boundary("start")} className="min-h-8 rounded border border-neutral-600 px-2 py-1 focus-visible:outline focus-visible:outline-daw-accent">Write to start</button>
        <button type="button" onClick={() => boundary("end")} className="min-h-8 rounded border border-neutral-600 px-2 py-1 focus-visible:outline focus-visible:outline-daw-accent">Write to end</button></>}
      <button type="button" disabled={!saved || playing || locked || !selection || selection.end <= selection.start} onClick={() => void commit()}
        className="min-h-8 rounded bg-daw-accent px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-white">Commit captured range</button>
      {saved && <button type="button" onClick={discard} className="min-h-8 rounded border border-neutral-600 px-2 py-1 focus-visible:outline focus-visible:outline-daw-accent">Discard capture</button>}
    </div>
    {!lane && <p className="mt-2 text-neutral-400">Select an envelope row or a timeline lane to audition it.</p>}
    {write && <p className="mt-2 text-amber-300">Disarm Write and Trim before auditioning.</p>}
    {lane?.param.startsWith("midi_") && <p className="mt-2 text-neutral-400">Audible Preview currently supports audio and FX controls. MIDI controller envelopes use normal Read/Write.</p>}
    {safe && <p className="mt-2 text-neutral-400">This parameter is Automation Safe.</p>}
    {active && <div className="mt-2 space-y-2" aria-label="Auditioned parameters">
      {Object.values(active.values).map(entry => {
        const current = (trackId === "master" ? masterLanes : track?.automationLanes)?.find(item => item.id === entry.laneId);
        const choices = automationParameterChoices(current?.metadata), discrete = current && automationLaneIsDiscrete(current);
        const boolean = current?.metadata?.type === "toggle" || current?.param === "mute" || current?.param.endsWith("_mute");
        const label = current?.metadata ? formatAutomationParameterValue(current.metadata, entry.value) : formatAutomationValue(entry.param, entry.value);
        return <label key={entry.param} className="flex flex-wrap items-center gap-2"><span className="min-w-24 flex-1 truncate" title={entry.label}>{entry.label}</span>
          {choices.length || boolean ? <select aria-label={`Preview ${entry.label}`} value={entry.value} disabled={pending}
            onChange={event => void change(trackId, entry.param, Number(event.target.value))} className="min-h-8 max-w-full rounded bg-neutral-800 px-2 py-1">
            {(choices.length ? choices : [{value:0,label:"Off"},{value:1,label:"On"}]).map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select> : <ProfiledRangeInput aria-label={`Preview ${entry.label}`} min={0} max={1} step={discrete && current?.metadata?.stepCount ? 1 / (current.metadata.stepCount - 1) : .001}
            value={entry.value} disabled={pending} onValueChange={value => void change(trackId, entry.param, value)} className="min-w-24 flex-1 accent-sky-400 disabled:opacity-40" />}
          <span className="min-w-16 text-right tabular-nums">{label}</span></label>;
      })}
      <p className="text-sky-300" role="status">{pending ? "Preparing or restoring Preview…" : active.phase === "writing" ? "Punch is writing auditioned controls until Stop or End Punch." : "Preview is active; envelope points are unchanged."}</p>
    </div>}
    {saved && <p className="mt-2 text-neutral-400">Captured {Object.keys(saved.values).length} parameter{Object.keys(saved.values).length === 1 ? "" : "s"}. {selection ? `Range: ${selection.start.toFixed(3)}–${selection.end.toFixed(3)} s.` : "Select a time range in the timeline."}</p>}
  </details>;
}
