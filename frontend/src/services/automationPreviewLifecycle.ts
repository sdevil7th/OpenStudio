import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "./NativeBridge";
import { automationPreviewAllowed } from "../store/actions/automationPreview";
import { getProjectEpoch } from "../utils/projectLifetime";
import { isAutomationEditLocked } from "../store/actions/automation";
import { automationPunchedParameters } from "../utils/automationWriteOwnership";

export function startAutomationPreviewLifecycle() {
  nativeBridge.setAutomationSnapshotGuard(() => useDAWStore.getState().cancelAutomationPreview());
  let restoring=false;
  const stop = useDAWStore.subscribe((state, previous) => {
    if(restoring)return;
    const restore=() => {
      restoring=true;
      try {
        if(state.automationPreviewSession)void state.cancelAutomationPreview();
        else {state.endAutomationWriteSession();void nativeBridge.clearAutomationPreviews();}
      } finally {restoring=false;}
    };
    const session = state.automationPreviewSession;
    const join=state.automationJoinSession;
    if(join?.prepared || join?.preparing) {
      const invalid=join.projectEpoch !== getProjectEpoch() || isAutomationEditLocked(state) || state.isProjectLoading || join.entries.some(entry => {
        const track=state.tracks.find(track => track.id === entry.trackId);
        const lanes=entry.trackId === "master" ? state.masterAutomationLanes : track?.automationLanes;
        const lane=lanes?.find(lane => lane.id === entry.laneId);
        const safe=entry.trackId === "master" ? state.masterAutomationSafeParams : track?.automationSafeParams;
        const read=entry.trackId === "master" ? state.masterAutomationReadEnabled : track?.automationReadEnabled;
        return !read || !lane?.readEnabled || lane.param !== entry.param || lane.unavailableParameter || safe?.includes(entry.param)
          || JSON.stringify(lane.metadata ?? null) !== entry.metadataKey || JSON.stringify(lane.points) !== entry.pointsKey;
      });
      if(invalid) {restore();return;}
    }
    if (!session || !["active","punching","writing"].includes(session.phase)) {
      const invalidWriter=[...automationPunchedParameters].some(key => {
        const [id,param]=key.split("::"),track=state.tracks.find(track => track.id === id);
        const lane=(id === "master" ? state.masterAutomationLanes : track?.automationLanes)?.find(lane => lane.param === param);
        const read=id === "master" ? state.masterAutomationReadEnabled : track?.automationReadEnabled;
        const safe=id === "master" ? state.masterAutomationSafeParams : track?.automationSafeParams;
        return !read || !lane?.readEnabled || lane.unavailableParameter || safe?.includes(param);
      });
      if(automationPunchedParameters.size && (invalidWriter || isAutomationEditLocked(state) || state.isProjectLoading)) {
        restore();
      }
      return;
    }
    if (state.tracks === previous.tracks && state.masterAutomationLanes === previous.masterAutomationLanes
      && state.masterAutomationWriteEnabled === previous.masterAutomationWriteEnabled
      && state.masterAutomationTrimWriteEnabled === previous.masterAutomationTrimWriteEnabled
      && state.masterAutomationSafeParams === previous.masterAutomationSafeParams
      && state.isProjectLoading === previous.isProjectLoading
      && state.globalLocked === previous.globalLocked && state.lockSettings === previous.lockSettings
      && state.transport.isRecording === previous.transport.isRecording) return;
    const lanes = session.trackId === "master" ? state.masterAutomationLanes : state.tracks.find(track => track.id === session.trackId)?.automationLanes;
    if (session.projectEpoch !== getProjectEpoch() || Object.values(session.values).some(entry => {
      const lane = lanes?.find(item => item.id === entry.laneId);
      const target=session.trackId === "master" ? {automationReadEnabled:state.masterAutomationReadEnabled,automationSafeParams:state.masterAutomationSafeParams}
        : state.tracks.find(track => track.id === session.trackId);
      const allowed=session.phase === "writing" ? !isAutomationEditLocked(state) && !state.isProjectLoading && !state.transport.isRecording
        && target?.automationReadEnabled && lane?.readEnabled && !lane.unavailableParameter && !target.automationSafeParams?.includes(entry.param)
        : lane && automationPreviewAllowed(state,session.trackId,lane);
      return !lane || lane.param !== entry.param || !allowed || (session.phase !== "writing" && JSON.stringify(lane.points) !== entry.beforePoints)
        || JSON.stringify(lane.metadata ?? null) !== entry.metadataKey;
    })) restore();
  });
  const stopNative = nativeBridge.subscribe("automationPreviewCleared", (event: { generation?: number }) => {
    const session = useDAWStore.getState().automationPreviewSession;
    if (session && ["active","writing"].includes(session.phase) && !Object.values(session.values).some(value => value.pending)
      && nativeBridge.isCurrentAutomationPreviewClear(event?.generation ?? NaN)) {
      if(session.phase === "writing")useDAWStore.getState().endAutomationWriteSession();
      useDAWStore.setState({ automationPreviewSession: null });
    }
  });
  return () => { nativeBridge.setAutomationSnapshotGuard(undefined); stop(); stopNative(); void useDAWStore.getState().cancelAutomationPreview(); };
}
