import { nativeBridge, type PitchRegressionJob, type PitchRegressionResult } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { automationParameterMetadata } from "../store/automationParams";

const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
/** Explicit QA job: changes only the loaded fixture, exports after the guitar lead-in, and never saves it. */
export async function runAutomationAudioRegression(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  const artifacts: Record<string, string> = {};
  const checks: NonNullable<PitchRegressionResult["automationEditorChecks"]> = [];
  let progress: Promise<unknown> = Promise.resolve();
  const checkpoint = (phase: string) => {
    const state = useDAWStore.getState();
    const snapshot = JSON.stringify({ tracks: [], phase, checks, artifacts, preview: state.automationPreviewSession,
      transport: state.transport, join: state.automationJoinSession,
      lanes: state.tracks[0]?.automationLanes });
    const path = job.resultJsonPath.replace(/[.][^.]+$/, ".progress.json");
    progress = progress.then(() => nativeBridge.saveProjectToFile(path, snapshot)).catch(() => undefined);
  };
  const check = (name: string, pass: boolean, detail?: unknown) => {
    checks.push({ name, pass, detail }); checkpoint(name); if (!pass) throw new Error(name);
  };
  const bounded = async <T,>(phase: string, work: Promise<T>): Promise<T> => {
    checkpoint(phase);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at ${phase}`)), 10000);
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  try {
    if(job.projectFixturePath) {
      const reads=await Promise.all([nativeBridge.loadProjectFromFile(job.projectFixturePath),nativeBridge.loadProjectFromFile(job.projectFixturePath)]);
      check("overlapping_native_project_reads_preserve_snapshot",reads[0].length>0 && reads[0]===reads[1]);
    }
    if (!job.projectFixturePath || !await useDAWStore.getState().loadProject(job.projectFixturePath)) {
      const state = useDAWStore.getState();
      throw new Error(`Copied guitar fixture could not load: ${JSON.stringify({ path: job.projectFixturePath,
        restoreError: state.projectRestoreError, loading: state.isProjectLoading, loadingMessage: state.projectLoadingMessage,
        previewPhase: state.automationPreviewSession?.phase, lastToast: state.toastMessage })}`);
    }
    const trackId = job.trackId ?? useDAWStore.getState().tracks[0]?.id;
    if (!trackId) throw new Error("No fixture track");
    await useDAWStore.getState().stop(); await nativeBridge.setMasterMute(true);
    useDAWStore.getState().setTrackAutomationWrite(trackId, false);
    useDAWStore.getState().setAutomationTrimWrite(trackId, false);
    for (const lane of [...useDAWStore.getState().tracks.find(track => track.id === trackId)!.automationLanes]) useDAWStore.getState().setAutomationLaneRead(trackId, lane.id, false);
    const volume = useDAWStore.getState().addAutomationLane(trackId, "volume", "Performance passage QA");
    if (!volume) throw new Error("Volume lane creation failed");
    useDAWStore.getState().applyAutomationEnvelopeEdit(trackId, volume, [{ time: 0, value: 60 / 72 }, { time: 60, value: 60 / 72 }], "Guitar QA baseline");
    useDAWStore.getState().setAutomationLaneRead(trackId, volume, true);
    useDAWStore.getState().setTrackAutomationRead(trackId, true);
    useDAWStore.getState().setAutomationTrimValue(trackId, 0);
    // Diagnostic opt-in only: determine whether ordinary realtime playback
    // changes the cold vendor export. This is never a production render delay.
    const warmup = Math.max(0, Math.min(30, job.automationAudioPlaybackWarmupSeconds ?? 0));
    if (warmup > 0) {
      await useDAWStore.getState().seekTo(0);
      await useDAWStore.getState().play();
      await wait(warmup * 1000);
      const position = await nativeBridge.getTransportPosition();
      await useDAWStore.getState().stop();
      check("diagnostic_realtime_playback_completed", position >= warmup - .25, { requestedSeconds: warmup, position });
    }
    const render = async (name: string) => {
      await wait(150);
      const filePath = job.resultJsonPath.replace(/[\\/][^\\/]+$/, `/guitar-${name}.wav`);
      const exportStart = Math.max(0, Math.min(5, job.automationAudioExportStartSeconds ?? 5));
      check(`render_${name}`, await nativeBridge.renderProject({ source: `stem:${trackId}`, startTime: exportStart, endTime: 13,
        filePath, format: "wav", sampleRate: 44100, bitDepth: 32, channels: 2, normalize: false,
        addTail: false, tailLength: 0, includeMetronome: false }), { filePath, timelineStart: exportStart, timelineEnd: 13 });
      artifacts[name] = filePath;
    };
    const vendorValues = new Map<string, number>();
    check("native_audio_configuration", true, await nativeBridge.getAudioDebugSnapshot());
    const vendorSnapshot = async (phase: string) => {
      const fx = await nativeBridge.getTrackFX(trackId);
      for (const slot of fx.filter(item => item.name.includes("AmpliTube") || item.pluginPath?.includes("AmpliTube"))) {
        const parameters = await nativeBridge.getPluginParameters(trackId, slot.index, false);
        const changed = parameters.filter(parameter => {
          const key = `${slot.index}:${parameter.hostParamId ?? parameter.index}`;
          if (phase === "before") { vendorValues.set(key, parameter.value); return false; }
          return !vendorValues.has(key) || Math.abs(vendorValues.get(key)! - parameter.value) > 1e-6;
        });
        check(`vendor_parameters_${phase}`, changed.length === 0, { index: slot.index, parameters, changed });
      }
    };
    await vendorSnapshot("before"); await render("wet-base"); await vendorSnapshot("after_first");
    await render("wet-repeat"); await vendorSnapshot("after_repeat");
    if (job.automationAudioRepeatOnly) return { success: true, jobType: "automation_audio", automationEditorChecks: checks, automationAudioArtifacts: artifacts };
    useDAWStore.getState().setAutomationTrimValue(trackId, -6);
    await render("wet-minus6"); await render("wet-minus6-repeat");
    check("wet_freeze", useDAWStore.getState().freezeAutomationTrim(trackId)); await render("wet-frozen");
    useDAWStore.getState().undo(); await render("wet-undo");
    useDAWStore.getState().setAutomationTrimValue(trackId, 0);
    const loadedFX = await nativeBridge.getTrackFX(trackId);
    if (loadedFX.length === 1 && loadedFX[0].name === "OpenStudio NAM Rack") {
      const output = (await nativeBridge.getPluginParameters(trackId, 0, false)).find(parameter => parameter.paramId === "outputTrimDb");
      if (!output || output.min === undefined || output.max === undefined) throw new Error("NAM output automation descriptor required");
      const baselineDB = output.min + output.value * (output.max - output.min);
      check("nam_relative_output_range", baselineDB - 12 >= output.min, { baselineDB, minimum: output.min });
      const reduced = output.value - 12 / (output.max - output.min);
      const lane = useDAWStore.getState().addAutomationLane(trackId, "builtin_track_0_outputTrimDb", "NAM output inside guitar performance", automationParameterMetadata(output));
      if (!lane) throw new Error("NAM output lane creation failed");
      useDAWStore.getState().applyAutomationEnvelopeEdit(trackId, lane, [
        { time: 0, value: output.value }, { time: 7, value: output.value }, { time: 7.001, value: reduced },
        { time: 10, value: reduced }, { time: 10.001, value: output.value }, { time: 60, value: output.value },
      ], "NAM output movement inside played guitar");
      useDAWStore.getState().setAutomationLaneRead(trackId, lane, true);
      await render("wet-nam-output");
      useDAWStore.getState().setAutomationLaneRead(trackId, lane, false);
    }
    for (const fx of await nativeBridge.getTrackFX(trackId)) await nativeBridge.bypassTrackFX(trackId, fx.index, true);
    for (const fx of await nativeBridge.getTrackInputFX(trackId)) await nativeBridge.bypassTrackInputFX(trackId, fx.index, true);
    await render("dry-base"); await render("dry-repeat");
    for (const chain of ["track", "input"] as const) {
      const input = chain === "input", index = (await (input ? nativeBridge.getTrackInputFX(trackId) : nativeBridge.getTrackFX(trackId))).length;
      check(`gain_${chain}_added`, await useDAWStore.getState().addTrackBuiltInFXWithUndo(trackId, "OpenStudio Gain Phase", chain));
      const param = `builtin_${chain}_${index}_gain`;
      const lane = useDAWStore.getState().addAutomationLane(trackId, param, `Guitar ${chain} gain QA`);
      if (!lane) throw new Error("Gain lane creation failed");
      useDAWStore.getState().applyAutomationEnvelopeEdit(trackId, lane, [
        { time: 0, value: 60 / 84 }, { time: 7, value: 60 / 84 }, { time: 7.001, value: 48 / 84 },
        { time: 10, value: 48 / 84 }, { time: 10.001, value: 60 / 84 }, { time: 60, value: 60 / 84 },
      ], `Guitar ${chain} gain movement inside performance`);
      useDAWStore.getState().setTrackAutomationRead(trackId, true);
      await render(`dry-gain-${chain}`);
      useDAWStore.getState().setAutomationLaneRead(trackId, lane, false);
      await (input ? nativeBridge.bypassTrackInputFX(trackId, index, true) : nativeBridge.bypassTrackFX(trackId, index, true));
    }
    useDAWStore.getState().setAutomationTrimValue(trackId, -6); await render("dry-minus6");
    check("dry_freeze", useDAWStore.getState().freezeAutomationTrim(trackId)); await render("dry-frozen");
    useDAWStore.getState().undo(); await render("dry-undo");
    // Exercise the real frontend writer over the user's played passage.
    const state=useDAWStore.getState(),baselineVolume=[{time:0,value:60/72},{time:60,value:60/72}];
    state.setAutomationTrimValue(trackId,0);state.setAutomationAutoJoin(true);
    await bounded("seek_for_punch", state.seekTo(8));await bounded("play_for_punch", state.play());
    check("native_preview_enter",await bounded("begin_preview",state.beginAutomationPreview(trackId,volume)));
    check("native_preview_value",await bounded("change_preview",state.setAutomationPreviewValue(trackId,"volume",48/72)));
    check("native_preview_punch",await bounded("punch_preview",state.punchAutomationPreview()));
    const punchStart=await nativeBridge.getTransportPosition();
    await wait(500);const punchEnd=await nativeBridge.getTransportPosition();
    check("native_punch_holds_volume",Math.abs(Number(await nativeBridge.getAutomationCurrentValue(trackId,"volume"))+12)<1e-5,{punchStart,punchEnd});
    await bounded("stop_punch",state.stop());await bounded("cancel_punch",state.cancelAutomationPreview());
    const punchPoints=useDAWStore.getState().tracks.find(track=>track.id===trackId)!.automationLanes.find(lane=>lane.id===volume)!.points;
    const join=useDAWStore.getState().automationJoinSession;
    check("native_punch_records_audible_pass",punchPoints.some(point=>point.time>=8 && point.time<=punchEnd+.1 && Math.abs(point.value-48/72)<1e-6),
      {timelineStart:punchStart+.03,timelineEnd:punchEnd-.03,points:punchPoints});
    check("native_join_retains_stop_point",!!join && join.time>=punchStart && Math.abs(join.time-punchEnd)<.15,{join});
    await render("dry-punch");
    await state.seekTo(8);await state.play();
    const joinDeadline=performance.now()+4000;
    while(await nativeBridge.getTransportPosition()<join!.time+.25 && performance.now()<joinDeadline)await wait(40);
    const joinedAt=await nativeBridge.getTransportPosition();
    check("native_auto_join_holds_after_boundary",joinedAt>=join!.time+.25 && useDAWStore.getState().automationJoinSession===null
      && Math.abs(Number(await nativeBridge.getAutomationCurrentValue(trackId,"volume"))+12)<1e-5,{timelineStart:join!.time+.03,timelineEnd:joinedAt-.03});
    await state.stop();await render("dry-auto-join");
    state.setAutomationAutoJoin(false);state.applyAutomationEnvelopeEdit(trackId,volume,baselineVolume,"Restore QA baseline");
    state.setAutomationTrimWrite(trackId,true);state.setAutomationTrimCoalesce("after-pass");
    await state.seekTo(8);await state.play();
    state.beginAutomationTrimEdit(trackId);state.setAutomationTrimValue(trackId,-6);
    const trimStart=await nativeBridge.getTransportPosition();await wait(400);
    const trimEnd=await nativeBridge.getTransportPosition();state.commitAutomationTrimEdit(trackId);
    await state.stop();
    check("native_trim_coalesces_after_pass",useDAWStore.getState().tracks.find(track=>track.id===trackId)!.automationLanes.find(lane=>lane.param==="trim_volume")!.points.length===0,
      {timelineStart:trimStart+.03,timelineEnd:trimEnd-.03});
    await render("dry-auto-trim");state.undo();await render("dry-auto-trim-undo");
    return { success: true, jobType: "automation_audio", automationEditorChecks: checks, automationAudioArtifacts: artifacts };
  } catch (error) { return { success: false, jobType: "automation_audio", automationEditorChecks: checks, automationAudioArtifacts: artifacts,
    error: error instanceof Error ? error.stack : String(error) }; }
  finally { useDAWStore.setState({ isModified: false }); await nativeBridge.setMasterMute(true); }
}
