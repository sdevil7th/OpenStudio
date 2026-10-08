import { createFrameCoalescedParamWriter } from "../components/BuiltInPluginPanel";
import { nativeBridge, type PitchRegressionJob, type PitchRegressionResult } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { automationParameterMetadata } from "../store/automationParams";
import { editFXStage } from "./stageFXHistory";

const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

/** Explicit native frontend test job; no normal startup or project-save path invokes it. */
export async function runAutomationEditorFlushRegression(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  const checks: NonNullable<PitchRegressionResult["automationEditorChecks"]> = [];
  const check = (name: string, pass: boolean, detail?: unknown) => {
    checks.push({ name, pass, detail });
    if (!pass) throw new Error(`Automation editor integration: ${name}: ${JSON.stringify(detail)}`);
  };
  let unregister: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let writer: ReturnType<typeof createFrameCoalescedParamWriter> | undefined;
  let editorSession: string | undefined;
  try {
    await wait(500); // Let the main project capture subscriber mount.
    if (!job.projectFixturePath || !await useDAWStore.getState().loadProject(job.projectFixturePath))
      throw new Error("A readable copied project fixture is required");
    const state = useDAWStore.getState(), trackId = job.trackId ?? state.tracks[0]?.id;
    if (!trackId) throw new Error("No fixture track");
    await state.stop(); await state.seekTo(6); await nativeBridge.setMasterMute(true);
    const index = (await nativeBridge.getTrackFX(trackId)).length;
    check("native_builtin_added", await state.addTrackBuiltInFXWithUndo(trackId, "OpenStudio Gain Phase", "track"));
    const address = { trackId, chain: "track" as const, fxIndex: index };
    const schema = await nativeBridge.getBuiltInPluginSchema(address), gain = schema?.parameters.find(parameter => parameter.id === "gain");
    if (!gain) throw new Error("Missing Gain Phase gain descriptor");
    const metadata = (await nativeBridge.getPluginParameters(trackId, index, false)).find(parameter => parameter.paramId === gain.id);
    if (!metadata || metadata.min === undefined || metadata.max === undefined) throw new Error("Missing native gain range");
    editorSession = JSON.stringify({ address, title: "Automation Stop integration", fallbackName: "OpenStudio Gain Phase" });
    check("detached_native_editor_opened", await nativeBridge.openBuiltInPluginEditorWindow(editorSession, { width: 950, height: 720 }));
    const readinessDeadline = performance.now() + 15000;
    let readiness = "opening";
    while (readiness === "opening" && performance.now() < readinessDeadline) {
      await wait(50); readiness = await nativeBridge.getPluginEditorReadiness({ sessionId: editorSession });
    }
    check("detached_native_editor_reached_ready", readiness === "ready", readiness);
    const normalized = (value: number) => (value - metadata.min!) / (metadata.max! - metadata.min!);
    const param = `builtin_track_${index}_${gain.id}`, baseline = normalized(0), final = normalized(-12);
    const laneId = useDAWStore.getState().addAutomationLane(trackId, param, "Native editor Stop QA");
    if (!laneId) throw new Error("Could not create the fixture automation lane");
    useDAWStore.getState().applyAutomationEnvelopeEdit(trackId, laneId, [{ time: 0, value: baseline }, { time: 60, value: baseline }], "Native editor QA baseline");
    const initialPoints = JSON.stringify(useDAWStore.getState().tracks.find(track => track.id === trackId)!.automationLanes.find(lane => lane.id === laneId)!.points);
    useDAWStore.getState().setTrackAutomationRead(trackId, true);
    useDAWStore.getState().setAutomationWriteBehavior("latch");
    useDAWStore.getState().setTrackAutomationWrite(trackId, true);
    const events: Array<Record<string, unknown>> = [];
    unsubscribe = nativeBridge.subscribe("pluginParameterEdit", event => { if (event.param === param || event.phase === "editor-flush-failed") events.push(event); });
    writer = createFrameCoalescedParamWriter({ write: async (id, value) => {
      await wait(300); return nativeBridge.setBuiltInPluginParam(address, id, value);
    } });
    unregister = nativeBridge.registerAutomationEditorFlush(async () => {
      const success = await writer!.flush();
      const ended = await nativeBridge.builtInPluginGesture(address, gain.id, false);
      return success && ended;
    });
    await useDAWStore.getState().play();
    await nativeBridge.builtInPluginGesture(address, gain.id, true);
    writer.writeImmediately(gain.id, -3); await wait(50); writer.enqueue(gain.id, -12);
    const stopStarted = performance.now();
    let stopCompleted = stopStarted;
    const stopping = useDAWStore.getState().stop().then(() => { stopCompleted = performance.now(); });
    await wait(100); const position1 = await nativeBridge.getTransportPosition();
    await wait(100); const position2 = await nativeBridge.getTransportPosition();
    check("audio_position_stops_before_editor_acknowledgement", Math.abs(position2 - position1) < .001, { position1, position2 });
    await stopping;
    check("both_native_webviews_acknowledge_without_timeout", !events.some(event => event.phase === "editor-flush-failed")
      && !useDAWStore.getState().toastMessage.includes("editor could not finish"), { stopCompletionMs: stopCompleted - stopStarted,
        toast: useDAWStore.getState().toastMessage, warnings: events.filter(event => event.phase === "editor-flush-failed") });
    unregister(); unregister = undefined;
    const lane = () => useDAWStore.getState().tracks.find(track => track.id === trackId)!.automationLanes.find(item => item.id === laneId)!;
    const pointsAfterStop = JSON.stringify(lane().points);
    check("queued_final_value_retained_at_stop", lane().points.some(point => Math.abs(point.value - final) < 1e-5), { expected: final, points: lane().points, events });
    check("final_capture_has_estimated_stop_flush_timing", events.some(event => event.phase === "value" && event.transportFlush === true
      && event.capturedWhileRolling === true && Math.abs(Number(event.value) - final) < 1e-5), events);
    useDAWStore.getState().undo();
    check("whole_write_pass_is_one_undo", JSON.stringify(lane().points) === initialPoints);
    useDAWStore.getState().redo();
    check("whole_write_pass_redoes_final_value", JSON.stringify(lane().points) === pointsAfterStop);
    useDAWStore.getState().setTrackAutomationWrite(trackId, false);
    await nativeBridge.setBuiltInPluginParam(address, gain.id, -9); await wait(60);
    check("stopped_manual_edit_does_not_append_automation", JSON.stringify(lane().points) === pointsAfterStop);

    let releaseOldDrain!: (success: boolean) => void;
    const oldDrain = new Promise<boolean>(resolve => { releaseOldDrain = resolve; });
    const removeOldDrain = nativeBridge.registerAutomationEditorFlush(() => oldDrain);
    try {
      await useDAWStore.getState().seekTo(8); await useDAWStore.getState().play();
      const supersededStop = useDAWStore.getState().stop(); await wait(80);
      await useDAWStore.getState().play(); releaseOldDrain(true); await supersededStop;
      await wait(80);
      check("new_play_supersedes_pending_stop_without_seek_or_session_close", useDAWStore.getState().transport.isPlaying
        && await nativeBridge.getTransportPosition() >= 8, useDAWStore.getState().transport);
    } finally { releaseOldDrain(true); removeOldDrain(); }
    await useDAWStore.getState().stop();

    // No audio track is armed: this fixture records only an empty in-memory MIDI take.
    const midiId = `automation-stop-midi-${Date.now()}`;
    for (const track of useDAWStore.getState().tracks) await nativeBridge.setTrackRecordArm(track.id, false);
    await nativeBridge.addTrack(midiId, "midi");
    await nativeBridge.setTrackMIDIInput(midiId, "__automation_qa_virtual__", 0);
    await nativeBridge.setTrackRecordArm(midiId, true);
    let releaseRecordDrain!: (success: boolean) => void;
    const recordDrain = new Promise<boolean>(resolve => { releaseRecordDrain = resolve; });
    const removeRecordDrain = nativeBridge.registerAutomationEditorFlush(() => recordDrain);
    try {
      await useDAWStore.getState().play();
      check("native_midi_fixture_recording_started", await nativeBridge.setTransportRecording(true)
        && (await nativeBridge.getAudioDebugSnapshot()).transportRecording);
      const recordingStop = useDAWStore.getState().stop(); await wait(80);
      check("native_recording_ends_before_editor_drain", !(await nativeBridge.getAudioDebugSnapshot()).transportRecording);
      await useDAWStore.getState().play(); releaseRecordDrain(true); await recordingStop;
      check("play_during_old_stop_does_not_resume_native_recording", !(await nativeBridge.getAudioDebugSnapshot()).transportRecording);
    } finally {
      releaseRecordDrain(true); removeRecordDrain(); await nativeBridge.setTransportRecording(false);
      await useDAWStore.getState().stop(); await nativeBridge.removeTrack(midiId);
    }

    const stuck = nativeBridge.registerAutomationEditorFlush(() => new Promise<boolean>(() => {}));
    try {
      await useDAWStore.getState().play();
      const started = performance.now(); await useDAWStore.getState().stop();
      const elapsed = performance.now() - started;
      check("stalled_editor_stop_is_bounded_and_warns", elapsed >= 1400 && elapsed < 2500
        && useDAWStore.getState().toastMessage.includes("editor could not finish"), { elapsed, toast: useDAWStore.getState().toastMessage });
    } finally { stuck(); }
    await nativeBridge.closeBuiltInPluginEditorWindow(editorSession); editorSession = undefined;
    writer.dispose(false); writer = undefined; unsubscribe(); unsubscribe = undefined;
    const inputIndex = (await nativeBridge.getTrackInputFX(trackId)).length;
    check("native_safe_only_input_fx_added", await useDAWStore.getState().addTrackBuiltInFXWithUndo(trackId, "OpenStudio Gain Phase", "input"));
    const inputParam = `builtin_input_${inputIndex}_gain`;
    useDAWStore.getState().setPluginAutomationSafe(trackId, [param, inputParam], true);
    const stageSafe: string[] = [];
    for (const chain of ["master", "monitor"] as const) {
      const slots = await (chain === "master" ? nativeBridge.getMasterFX() : nativeBridge.getMonitoringFX());
      check(`safe_only_${chain}_fx_added`, await (chain === "master" ? nativeBridge.addMasterBuiltInFX("OpenStudio Gain Phase")
        : nativeBridge.addMonitoringFX("OpenStudio Gain Phase")));
      const parameter = (await nativeBridge.getPluginParameters(chain, slots.length, false)).find(item => item.paramId === "gain");
      if (!parameter?.automationId) throw new Error(`Missing ${chain} gain identity`);
      stageSafe.push(parameter.automationId);
    }
    useDAWStore.getState().setPluginAutomationSafe("master", stageSafe, true);
    const instrumentId = `automation-safe-instrument-${Date.now()}`;
    useDAWStore.getState().addTrack({ id: instrumentId, name: "Safe-only fallback instrument QA", color: "#4898cc", type: "instrument", builtInInstrument: "synth" });
    await wait(200);
    const instrumentParameter = (await nativeBridge.getPluginParameters(instrumentId, -1, false)).find(item => item.automationId);
    if (!instrumentParameter?.automationId) throw new Error("Missing fallback instrument identity");
    useDAWStore.getState().setPluginAutomationSafe(instrumentId, [instrumentParameter.automationId], true);
    check("native_midi_learn_publication_readback", await nativeBridge.setMIDILearnMappings([
      { ccNumber: 14, trackId, chainType: "track", pluginIndex: index, paramIndex: metadata.index, builtIn: true, paramId: "gain" },
      { ccNumber: 15, trackId, chainType: "input", pluginIndex: inputIndex, paramIndex: metadata.index, builtIn: true, paramId: "gain" },
    ]));
    const savedPath = job.resultJsonPath.replace(/[\\/][^\\/]+$/, "/automation-saved.osproj");
    useDAWStore.setState({ projectPath: savedPath });
    check("safe_and_midi_project_copy_saved", await useDAWStore.getState().saveProject());
    const document = JSON.parse(await nativeBridge.loadProjectFromFile(savedPath));
    const savedTrack = document.tracks.find((item: { id: string }) => item.id === trackId);
    check("safe_only_master_monitor_contracts_saved", stageSafe.every(target => document.masterAutomationSafeParameters.some((entry: { param: string; metadata: { paramId?: string } }) => entry.param === target && entry.metadata.paramId === "gain")), document.masterAutomationSafeParameters);
    check("safe_only_instrument_contract_saved", document.tracks.find((item: { id: string }) => item.id === instrumentId).automationSafeParameters.some((entry: { param: string }) => entry.param === instrumentParameter.automationId));
    check("safe_contracts_saved_for_both_chains_without_runtime_generations", [param, inputParam].every(target =>
      savedTrack.automationSafeParameters.some((entry: { param: string; metadata: { paramId?: string; referenceGeneration?: number } }) =>
        entry.param === target && entry.metadata.paramId === "gain" && entry.metadata.referenceGeneration === undefined)), savedTrack.automationSafeParameters);
    check("native_safe_and_midi_copy_reopened", await useDAWStore.getState().loadProject(savedPath));
    const reopenedTrack = useDAWStore.getState().tracks.find(item => item.id === trackId)!;
    check("safe_only_master_monitor_targets_survive_reopening", stageSafe.every(target => useDAWStore.getState().masterAutomationSafeParams?.includes(target)), useDAWStore.getState().masterAutomationSafeParams);
    check("safe_only_fallback_instrument_survives_reopening", useDAWStore.getState().tracks.find(item => item.id === instrumentId)?.automationSafeParams?.includes(instrumentParameter.automationId) === true);
    check("native_safe_targets_survive_reopening", [param, inputParam].every(target => reopenedTrack.automationSafeParams?.includes(target)), reopenedTrack.automationSafeParams);
    const mappings = await nativeBridge.getMIDILearnMappings();
    check("native_midi_assignments_survive_reopening", mappings.length === 2 && mappings.some(item => item.ccNumber === 14 && item.pluginIndex === index && item.paramId === "gain")
      && mappings.some(item => item.ccNumber === 15 && item.pluginIndex === inputIndex && item.paramId === "gain"), mappings);
    const masterTarget = stageSafe.find(target => target.startsWith("builtin_master_"))!;
    let masterSlot = -1;
    let masterParameter;
    for (const slot of await nativeBridge.getMasterFX()) {
      const parameter = (await nativeBridge.getPluginParameters("master", slot.index, false)).find(item => item.automationId === masterTarget);
      if (parameter) { masterSlot = slot.index; masterParameter = parameter; break; }
    }
    if (!masterParameter || masterSlot < 0) throw new Error("Missing restored master Safe target");
    const masterLaneId = useDAWStore.getState().addMasterAutomationLane(masterTarget, "Native stage Undo QA", automationParameterMetadata(masterParameter), { read: true });
    if (!masterLaneId) throw new Error("Master QA lane creation failed");
    useDAWStore.getState().applyAutomationEnvelopeEdit("master", masterLaneId, [{ time: 0, value: .4 }, { time: 60, value: .4 }], "Native stage constant Read QA");
    useDAWStore.getState().setMasterAutomationRead(true);
    await wait(100);
    check("native_master_stage_removed_with_history", await editFXStage("master", "Native stage remove QA", () => nativeBridge.removeMasterFX(masterSlot)));
    check("native_master_removed_lane_pruned", !useDAWStore.getState().masterAutomationLanes.some(lane => lane.id === masterLaneId));
    useDAWStore.getState().undo();
    const restoreDeadline = performance.now() + 3000;
    while (!useDAWStore.getState().masterAutomationLanes.some(lane => lane.id === masterLaneId) && performance.now() < restoreDeadline) await wait(20);
    const restoredMasterLane = useDAWStore.getState().masterAutomationLanes.find(lane => lane.id === masterLaneId);
    check("native_master_stage_undo_rebinds_curve_and_safe", restoredMasterLane?.param === masterTarget && !restoredMasterLane.unavailableParameter
      && restoredMasterLane.points.every(point => point.value === .4) && useDAWStore.getState().masterAutomationSafeParams?.includes(masterTarget) === true, restoredMasterLane);
    useDAWStore.getState().redo();
    const removeDeadline = performance.now() + 3000;
    while (useDAWStore.getState().masterAutomationLanes.some(lane => lane.id === masterLaneId) && performance.now() < removeDeadline) await wait(20);
    check("native_master_stage_redo_removes_curve_and_safe", !useDAWStore.getState().masterAutomationLanes.some(lane => lane.id === masterLaneId)
      && !useDAWStore.getState().masterAutomationSafeParams?.includes(masterTarget));

    // Exercise the actual WebView bindings while the export worker owns the
    // mutation lock. A message-thread lock wait used to deadlock hosted setup.
    const masterCount = (await nativeBridge.getMasterFX()).length;
    const exportPath = job.resultJsonPath.replace(/[\\/][^\\/]+$/, "/mutation-overlap.wav");
    const exporting = nativeBridge.renderProject({ source: `stem:${trackId}`, startTime: 5, endTime: 60,
      filePath: exportPath, format: "wav", sampleRate: 44100, bitDepth: 32, channels: 2,
      normalize: false, addTail: false, tailLength: 0, includeMetronome: false });
    let exportFinished = false;
    void exporting.then(() => { exportFinished = true; }, () => { exportFinished = true; });
    const overlapDeadline = performance.now() + 5000;
    let offline = false;
    while (!exportFinished && !offline && performance.now() < overlapDeadline) {
      offline = (await nativeBridge.getAudioDebugSnapshot()).offlineRenderActive === true;
      if (!offline) await wait(10);
    }
    check("offline_export_observed_for_mutation_overlap", offline);
    let mutationFinished = false;
    const mutation = nativeBridge.addMasterBuiltInFX("OpenStudio Gain Phase").then(result => {
      mutationFinished = true; return result;
    });
    await wait(25);
    const duringMutation = await nativeBridge.getAudioDebugSnapshot();
    check("webview_responds_while_native_mutation_is_deferred", duringMutation.offlineRenderActive === true && !mutationFinished);
    const overlapResults = await Promise.all([exporting, mutation]);
    check("overlapping_export_and_native_mutation_complete", overlapResults.every(Boolean));
    check("deferred_mutation_changes_the_chain_once", (await nativeBridge.getMasterFX()).length === masterCount + 1);
    check("overlap_fixture_cleanup", await nativeBridge.removeMasterFX(masterCount)
      && (await nativeBridge.getMasterFX()).length === masterCount);
    return { success: true, jobType: "automation_editor_flush", automationEditorChecks: checks };
  } catch (error) {
    return { success: false, jobType: "automation_editor_flush", automationEditorChecks: checks,
      error: error instanceof Error ? error.stack : String(error) };
  } finally {
    unregister?.(); unsubscribe?.(); writer?.dispose(false);
    if (editorSession) await nativeBridge.closeBuiltInPluginEditorWindow(editorSession);
    // The explicit test fixture is never saved over the user's project.
    useDAWStore.setState({ isModified: false });
    await nativeBridge.setMasterMute(true);
  }
}
