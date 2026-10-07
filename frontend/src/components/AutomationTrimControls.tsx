import { useShallow } from "zustand/shallow";
import { useState, useEffect } from "react";
import { useDAWStore } from "../store/useDAWStore";
import { interpolateAtTime, sendAutomationParamId, VOLUME_DB_RANGE, VOLUME_MIN_DB } from "../store/automationParams";
import { ProfiledRangeInput } from "./ui";

export function AutomationTrimControls({ trackId }: { trackId: string }) {
  const [param,setParam]=useState("trim_volume");
  useEffect(()=>setParam("trim_volume"),[trackId]);
  const { track, tracks, masterDB, masterArm, masterWrite, masterLanes, masterRead, liveValues, time, playing, locked, preview, arm, begin, change, commit, freeze, policy, setPolicy, masterSafe } = useDAWStore(useShallow(state => ({
    track: state.tracks.find(item => item.id === trackId), masterDB: state.masterTrimVolumeDB ?? 0,
    masterArm: state.masterAutomationTrimWriteEnabled ?? false, masterWrite: state.masterAutomationWriteEnabled, masterLanes: state.masterAutomationLanes, masterRead: state.masterAutomationReadEnabled,
    tracks:state.tracks,liveValues:state.automationTrimLiveValues,time: state.transport.currentTime, playing: state.transport.isPlaying || state.transport.isRecording,
    locked: state.globalLocked || state.lockSettings.envelopes, arm: state.setAutomationTrimWrite, begin: state.beginAutomationTrimEdit,
    preview: !!state.automationPreviewSession,
    change: state.setAutomationTrimValue, commit: state.commitAutomationTrimEdit, freeze: state.freezeAutomationTrim,
    policy:state.automationTrimCoalesce ?? "manual",setPolicy:state.setAutomationTrimCoalesce,masterSafe:state.masterAutomationSafeParams,
  })));
  const master = trackId === "master", armed = master ? masterArm : track?.automationTrimWriteEnabled ?? false;
  const selectedSend=track?.sends.find(send=>sendAutomationParamId(send.destTrackId,"trim")===param);
  const activeParam=selectedSend ? param : "trim_volume";
  const lane = (master ? masterLanes : track?.automationLanes)?.find(item => item.param === activeParam);
  const read = (master ? masterRead : track?.automationReadEnabled) && lane?.readEnabled && !!lane.points.length;
  const live=liveValues?.[activeParam==="trim_volume" ? trackId : trackId+"\n"+activeParam];
  const manualDB=selectedSend ? selectedSend.trimDB ?? 0 : master ? masterDB : track?.trimVolumeDB ?? 0;
  const db = live ?? (playing && read ? interpolateAtTime(lane!.points, time) * VOLUME_DB_RANGE + VOLUME_MIN_DB : manualDB);
  const writable = armed || (master ? masterWrite : track?.automationWriteEnabled);
  const disabled = locked || preview || (master ? masterSafe : track?.automationSafeParams)?.includes(activeParam) || (playing && read && !writable);
  return <details className="mt-3 rounded border border-neutral-700 p-2 text-[11px]">
    <summary className="cursor-pointer focus-visible:outline focus-visible:outline-daw-accent">Realtime Trim</summary>
    <p className="mt-2 text-neutral-400">Record separate dB offsets for track volume and sends. Arm Trim limits writing to those offsets; other envelopes keep reading.</p>
    {!!track?.sends.length && <label className="mt-2 flex flex-wrap items-center gap-2">Trim target
      <select aria-label="Trim target" value={activeParam} onChange={event=>setParam(event.target.value)} className="min-h-8 max-w-full rounded bg-neutral-800 px-2 py-1">
        <option value="trim_volume">Track volume</option>
        {track.sends.map(send=><option key={send.destTrackId} value={sendAutomationParamId(send.destTrackId,"trim")}>Send: {tracks.find(item=>item.id===send.destTrackId)?.name ?? send.destTrackId}</option>)}
      </select></label>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" aria-pressed={armed} disabled={locked || preview || (playing && armed && policy==="on-exit")} onClick={() => arm(trackId, !armed)}
        className={`min-h-8 rounded border px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent ${armed ? "border-red-500 bg-red-950/50 text-red-200" : "border-neutral-600"}`}>{armed ? "Trim armed" : "Arm Trim"}</button>
      <label className="flex min-w-40 flex-1 items-center gap-2">Offset
        <ProfiledRangeInput aria-label="Realtime Trim offset" min={-60} max={12} step={.1} value={db} disabled={disabled}
          onBeginEdit={() => begin(trackId,activeParam)} onCommitEdit={() => commit(trackId,activeParam)}
          onValueChange={value => change(trackId, value,activeParam)} className="min-w-20 flex-1 accent-sky-400 disabled:opacity-40" />
      </label>
      <input type="number" aria-label="Realtime Trim dB" min={-60} max={12} step={.1} value={Number(db.toFixed(1))} disabled={disabled}
        onFocus={() => begin(trackId,activeParam)} onBlur={() => commit(trackId,activeParam)} onChange={event => { if (event.target.value !== "") change(trackId, Number(event.target.value),activeParam); }}
        className="min-h-8 w-20 rounded bg-neutral-800 px-2 py-1 disabled:opacity-40" /><span>dB</span>
      <button type="button" disabled={disabled} onClick={() => change(trackId, 0,activeParam)} className="min-h-8 rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Reset to 0</button>
      <button type="button" disabled={disabled || playing || !(lane?.points.length || manualDB)} onClick={() => freeze(trackId,activeParam)}
        className="min-h-8 rounded border border-neutral-600 px-2 py-1 disabled:opacity-40 focus-visible:outline focus-visible:outline-daw-accent">Freeze Trim</button>
    </div>
    <label className="mt-2 flex flex-wrap items-center gap-2">Coalesce Trim
      <select aria-label="Trim coalescing policy" value={policy} disabled={locked || playing || preview} onChange={event=>setPolicy(event.target.value as "manual"|"after-pass"|"on-exit")} className="min-h-8 max-w-full rounded bg-neutral-800 px-2 py-1 disabled:opacity-40">
        <option value="manual">Manually</option><option value="after-pass">After each pass at Stop</option><option value="on-exit">When exiting Trim while stopped</option>
      </select>
    </label>
    {preview && <p className="mt-2 text-amber-300">Cancel Preview before editing Trim.</p>}
    <p className="mt-2 text-neutral-400">With Read enabled, the Trim curve controls the offset during playback. Freeze Trim combines it with volume as one undoable edit while stopped.</p>
  </details>;
}
