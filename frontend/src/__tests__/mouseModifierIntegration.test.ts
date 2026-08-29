import { describe, expect, it } from "vitest";
import timelineSource from "../components/Timeline.tsx?raw";
import pianoRollSource from "../components/PianoRoll.tsx?raw";
import sortableTrackHeaderSource from "../components/SortableTrackHeader.tsx?raw";
import preferencesSource from "../components/PreferencesModal.tsx?raw";
import clipEditingSource from "../store/actions/clipEditing.ts?raw";

describe("live mouse-modifier integration", () => {
  it("layers active behavior profiles and sparse user overrides at event time", () => {
    expect(timelineSource).toContain("const state = useDAWStore.getState();");
    expect(timelineSource).toContain("state.mouseBehaviorProfileId");
    expect(timelineSource).toContain("profile: behaviorProfile.modifiers");
    expect(timelineSource).toContain("overrides: state.mouseModifiers as MouseModifierOverrideMap");
    expect(timelineSource).toContain("platform: toMouseBehaviorPlatform(platform)");

    expect(sortableTrackHeaderSource).toContain("state.mouseBehaviorProfileId");
    expect(sortableTrackHeaderSource).toContain("profile: behaviorProfile.modifiers");
    expect(sortableTrackHeaderSource).toContain("overrides: state.mouseModifiers as MouseModifierOverrideMap");
  });

  it("passes the active mouse profile to wheel resolution", () => {
    expect(timelineSource).toContain("const behaviorProfile = getMouseBehaviorProfile(");
    expect(timelineSource).toContain("}, behaviorProfile.wheel);");
  });

  it.each([
    "clip_drag",
    "clip_resize",
    "timeline_click",
    "track_header",
    "automation_point",
    "fade_handle",
    "ruler_click",
  ])("resolves the %s Preferences context in its real interaction surface", (context) => {
    const combinedSource = `${timelineSource}\n${sortableTrackHeaderSource}`;
    expect(combinedSource).toContain(`"${context}"`);
  });
});

describe("timeline modifier semantics", () => {
  it("captures clip drag intent once and routes move variants truthfully", () => {
    expect(timelineSource).toContain("isTimelineClipCopyAction(modifierAction)");
    expect(timelineSource).toContain('modifierAction === "constrain"');
    expect(timelineSource).toContain('modifierAction === "bypass_snap"');
    expect(timelineSource).toContain("copyOnDrag,");
    expect(timelineSource).toContain("axisLockRequested:");
    expect(timelineSource).toContain("snapBypassRequested:");
    expect(timelineSource).toContain("Boolean(gesture.snapBypassRequested)");
    expect(timelineSource).toContain("previewTimelineGestureFromPointer(point.x, point.y, event)");
  });

  it("routes normal, fine, and symmetric resize through the tested geometry helper", () => {
    expect(timelineSource).toContain("computeMouseModifierTimelineResize({");
    expect(timelineSource).toContain('gesture.resizeAction === "fine"');
    expect(timelineSource).toContain('gesture.resizeAction === "symmetric"');
    expect(timelineSource).toContain("commitPreviewedResizeTimelineClip(");
  });

  it("implements background seek, range selection, extension, zoom, and razor by semantic action", () => {
    for (const action of ["seek", "select_range", "extend_selection", "zoom", "razor"]) {
      expect(timelineSource).toContain(`action === "${action}"`);
    }
    expect(timelineSource).toContain("timelinePointerActionRef.current = { action, startTime: time, dragged: false }");
    expect(timelineSource).toContain("setTimeSelectionDrag({ active: true, startTime: anchor })");
    expect(timelineSource).toContain("seekTo(Math.max(0, (pointerPos.x + scrollX) / pixelsPerSecond))");
  });

  it("starts audio and MIDI slip edits from the semantic profile action", () => {
    expect(timelineSource.match(/modifierAction === "slip"/g)).toHaveLength(2);
    expect(timelineSource.match(/slipEditRef\.current = \{/g)).toHaveLength(2);
    expect(timelineSource).toContain("originalIsModified: state.isModified");
    expect(timelineSource).toContain("isModified: originalIsModified ?? state.isModified");
    expect(timelineSource).toContain("isTimelineClipGestureLocked(useDAWStore.getState(), [edit.clipId])");
    expect(timelineSource).toContain("cancelActiveTimelineClipGesture()");
    expect(timelineSource).toContain("finalizeSlipTimelineGesture()");
    expect(timelineSource).toContain("slipEditClip(edit.clipId, finalOffset)");
  });

  it("keeps marquee selection and gain-point creation reachable through semantic actions", () => {
    expect(timelineSource).toContain('} else if (action === "seek") {');
    expect(timelineSource).toContain("marqueeRef.current = {");
    expect(timelineSource).toContain('if (action === "constrain" && !clipEditLocked) {');
    expect(timelineSource).toContain("addClipGainPoint(clip.id, timeInClip, gain)");
  });

  it("hit-tests, starts, updates, and clears profile-driven razor selections", () => {
    expect(timelineSource).toContain("const trackHitResult = getTrackAtY(");
    expect(timelineSource).toContain("setRazorDrag({");
    expect(timelineSource).toContain("clearRazorEdits();");
    expect(timelineSource).toContain("addRazorEdit(razorDrag.trackId, start, end)");
    expect(timelineSource).toContain("setRazorDrag(null)");
  });

  it("terminates range and slip gestures outside the Stage and on cancellation", () => {
    expect(timelineSource).toContain("const resetRangeGestures = () => {");
    expect(timelineSource).toContain("finalizeSlipTimelineGestureRef.current();");
    expect(timelineSource).toContain("const releasedInsideTimeline = event.target instanceof Node");
    const pointerCancel = timelineSource.slice(
      timelineSource.indexOf("const handlePointerCancel = () =>"),
      timelineSource.indexOf('window.addEventListener("pointercancel"'),
    );
    expect(pointerCancel).toContain("resetRangeGestures();");
    expect(pointerCancel).toContain("timelinePointerActionRef.current = null;");
  });

  it("allows automation drawing only through the resolved plain timeline action", () => {
    const stageMouseDown = timelineSource.slice(
      timelineSource.indexOf("const resolvedTimelineAction ="),
      timelineSource.indexOf("const time = Math.max", timelineSource.indexOf("const resolvedTimelineAction =")),
    );
    expect(stageMouseDown).toContain('resolveLiveMouseModifierAction(e.evt || {}, "timeline_click")');
    expect(stageMouseDown).toContain('resolvedTimelineAction === "seek"');
    expect(stageMouseDown).not.toContain("!e.evt?.shiftKey");
    expect(stageMouseDown).not.toContain("!e.evt?.ctrlKey");
  });

  it("captures automation action and uses stable-ID track point transactions", () => {
    expect(timelineSource).toContain('action === "delete"');
    expect(timelineSource).toContain("resolveAutomationPointDrag(gesture, {");
    expect(timelineSource).toContain("snapEnabled: snapEnabledRef.current");
    expect(timelineSource).toContain("snapTime: snapTimelineTime");
    expect(timelineSource).toContain("gesture.axisLock = preview.axisLock");
    expect(timelineSource).toContain("e.target.position({ x: preview.x, y: preview.y })");
    expect(timelineSource).toContain("getAutomationPointId(point, pi)");
    expect(timelineSource).toContain("setSelectedAutomationPoint(pointTarget)");
    expect(timelineSource).toContain("deleteSelectedAutomationPoint()");
    expect(timelineSource).toContain("beginAutomationPointEdit(pointTarget)");
    expect(timelineSource).toContain("beginAutomationPointCopyEdit(pointTarget)");
    expect(timelineSource).toContain("previewAutomationPointEdit(");
    expect(timelineSource).toContain("commitAutomationPointEdit()");
    expect(timelineSource).toContain("automationPointGestureRef.current = {");
    expect(timelineSource).toContain("gesture?.key ===");
  });

  it("restores an automation drag on every non-commit termination path", () => {
    expect(timelineSource).toContain("const cancelActiveAutomationEdit = useCallback(() => {");
    expect(timelineSource).toContain("state.cancelAutomationPointEdit();");
    expect(timelineSource).toContain('window.addEventListener("blur", handleWindowBlur)');
    expect(timelineSource).toContain('window.addEventListener("pointercancel", handlePointerCancel)');
    expect(timelineSource).toContain('window.addEventListener("keydown", handleWindowKeyDown)');
    expect(timelineSource).toContain('event.key !== "Escape"');
    const cleanup = timelineSource.slice(
      timelineSource.indexOf("return () => {", timelineSource.indexOf("const handlePointerCancel")),
      timelineSource.indexOf("// Time selection drag state"),
    );
    expect(cleanup).toContain("cancelActiveAutomationEdit();");
  });

  it("implements one-transaction fade pointer lifecycle, modifiers, and shape cycling", () => {
    expect(timelineSource).toContain("beginFadeHandleGesture");
    expect(timelineSource).toContain('gesture.action === "fine"');
    expect(timelineSource).toContain('gesture.action === "symmetric" ? fadeLength');
    expect(timelineSource).toContain("fadeHandleGestureRef.current = {");
    expect(timelineSource).toContain('fadeAction === "shape_cycle"');
    expect(timelineSource).toContain("cycleTimelineClipFadeShape(clip.id, side)");
    expect(timelineSource).toContain("setClipFadeInShape(");
    expect(timelineSource).toContain("setClipFadeOutShape(");
    expect(timelineSource).toContain("beginClipFadeEdit(clip.id)");
    expect(timelineSource).toContain("previewClipFades(");
    expect(timelineSource).toContain("commitClipFadeEdit(clip.id)");
    expect(timelineSource).toContain("cancelActiveTimelineClipGesture");
    expect(timelineSource).toContain("cancelClipFadeEdit(fadeClipId)");
    expect(timelineSource).toContain("const activeFadeHandle = fadeHandleGestureRef.current");
    expect(timelineSource).toContain("commitClipFadeEdit(activeFadeHandle.clipId)");
    expect(timelineSource).toContain('window.addEventListener("blur", handleWindowBlur)');
    expect(timelineSource).toContain('window.addEventListener("pointercancel", handlePointerCancel)');
    expect(timelineSource).toContain("cancelActiveAutomationEdit();");
    expect(timelineSource).toContain('event.key !== "Escape"');
    expect(timelineSource).toContain("cancelActiveTimelineClipGesture();");
    expect(timelineSource).not.toContain("setClipFades(");
  });

  it("keeps ruler intent stable in global listeners", () => {
    expect(timelineSource).toContain('action === "loop_set"');
    expect(timelineSource).toContain('action === "time_select"');
    expect(timelineSource).toContain('action === "zoom_to"');
    expect(timelineSource).toContain('drag.type = "loop-create"');
    expect(timelineSource).toContain('drag.type = "time-select"');
    expect(timelineSource).toContain('drag.type = "zoom-create"');
    expect(timelineSource).toContain('window.addEventListener("mousemove", handleGlobalMouseMove)');
  });
});

describe("track-header modifier semantics", () => {
  it("maps selection and undo-aware mute/solo operations without raw modifier branches", () => {
    expect(sortableTrackHeaderSource).toContain('action === "select"');
    expect(sortableTrackHeaderSource).toContain('action === "toggle_select"');
    expect(sortableTrackHeaderSource).toContain('action === "range_select"');
    expect(sortableTrackHeaderSource).toContain('action === "solo"');
    expect(sortableTrackHeaderSource).toContain('action === "mute"');
    expect(sortableTrackHeaderSource).toContain("selectTrack(track.id, { ctrl: true })");
    expect(sortableTrackHeaderSource).toContain("selectTrack(track.id, { shift: true })");
    expect(sortableTrackHeaderSource).toContain("void toggleTrackSolo(track.id)");
    expect(sortableTrackHeaderSource).toContain("void toggleTrackMute(track.id)");
  });

  it("does not apply header actions to embedded controls", () => {
    expect(sortableTrackHeaderSource).toContain(
      '"button, input, select, [data-color-bar], [data-no-select]"',
    );
  });
});

describe("intentional undo-safety guards", () => {
  it("previews stretch, restores the preview, and commits through the undo-safe action", () => {
    expect(timelineSource).toContain('gesture.resizeAction === "stretch"');
    expect(timelineSource).toContain("previewResizeTimelineClip(gesture.clipId, isMidi, {");
    expect(timelineSource).toContain("const stretched = await useDAWStore.getState().stretchClip(");
    expect(timelineSource).toContain("restoreTimelineGestureUndo();");
    expect(timelineSource).toContain("getSafeMouseModifierNoop(context, action)");
    expect(preferencesSource).toContain("getSafeMouseModifierNoop(key, action)");
  });

  it("reverts an in-progress stretch on Escape, blur, and pointer cancellation", () => {
    expect(timelineSource).toContain('event.key !== "Escape"');
    expect(timelineSource).toContain('window.addEventListener("blur", handleWindowBlur)');
    expect(timelineSource).toContain('window.addEventListener("pointercancel", handlePointerCancel)');
    expect(timelineSource).toContain("if (hadTimelineDrag && !activeGesture.isFadeDrag)");
    expect(timelineSource).toContain("restoreTimelineGestureUndo();");
  });

  it("supports master automation gestures and commits movement only on drag end", () => {
    expect(timelineSource).toContain('const key = `master:${lane.id}:${pointId}`');
    expect(timelineSource).toContain("setSelectedAutomationPoint(pointTarget)");
    expect(timelineSource).toContain("deleteSelectedAutomationPoint()");
    expect(timelineSource).toContain("beginAutomationPointEdit(pointTarget)");
    expect(timelineSource).toContain("previewAutomationPointEdit(");
    expect(timelineSource).toContain("commitAutomationPointEdit()");
    expect(timelineSource).toContain("resolveAutomationPointDrag(gesture, {");

    const masterSection = timelineSource.slice(
      timelineSource.indexOf("const renderMasterAutomationLanes"),
      timelineSource.indexOf("// Render razor edits"),
    );
    const dragMoveSection = masterSection.slice(
      masterSection.indexOf("onDragMove="),
      masterSection.indexOf("onDragEnd="),
    );
    expect(dragMoveSection).not.toContain("commitAutomationPointEdit()");
  });
});

describe("context-specific profile wheel integration", () => {
  it("hit-tests FL Studio and Cubase timeline targets before resolving the profile", () => {
    expect(timelineSource).toContain("findTimelineClipHit(timelineClipHitMapRef.current, stageX, mouseY)");
    expect(timelineSource).toContain('contextualSubtarget = "fade_handle"');
    expect(timelineSource).toContain('contextualSubtarget = "event_volume"');
    expect(timelineSource).toContain('gesture.target === "track-order"');
    expect(timelineSource).toContain('gesture.target === "clip-position"');
    expect(timelineSource).toContain("state.beginTrackReorderEdit(target.trackId)");
    expect(timelineSource).toContain("state.commitTrackReorderEdit(target.trackId)");
    expect(timelineSource).toContain("previewTrackReorder(trackId, direction)");
    expect(timelineSource).toContain("state.beginClipNudgeEdit(target.clipId)");
    expect(timelineSource).toContain("state.commitClipNudgeEdit(target.clipId)");
    expect(timelineSource).toContain("state.previewClipNudge(");
    expect(timelineSource).toContain("state.beginClipFadeEdit(target.clipId)");
    expect(timelineSource).toContain("state.previewClipFades(clipHit.clipId");
    expect(timelineSource).toContain("state.commitClipFadeEdit(target.clipId)");
    expect(timelineSource).toContain("state.beginClipVolumeEdit(target.clipId)");
    expect(timelineSource).toContain("state.commitClipVolumeEdit(target.clipId)");
    expect(timelineSource).toContain("timelineContextWheelEditControllerRef.current?.touch({");
    expect(timelineSource).toContain("createTimelineContextWheelAccumulator(100)");
    expect(timelineSource).toContain("createTimelineContextWheelAccumulator(1)");
    const wheelSection = timelineSource.slice(
      timelineSource.indexOf("const handleWheel = (e: WheelEvent) =>"),
      timelineSource.indexOf('container.addEventListener("wheel", handleWheel'),
    );
    expect(wheelSection).toContain("getAccumulatedWheelNudgeDirection(");
    expect(wheelSection).toContain("getAccumulatedWheelStepCount(");
    expect(wheelSection).toContain("`track-reorder:${trackId}`");
    expect(wheelSection).toContain("`clip-nudge:${clipHit.clipId}`");
    expect(wheelSection).toContain("`clip-fade:${clipHit.clipId}:${side}`");
    expect(wheelSection).toContain("`clip-volume:${clipHit.clipId}`");
    expect(wheelSection).toContain("timelineDiscreteWheelAccumulatorRef.current?.reset()");
    expect(wheelSection).toContain("timelineSmoothWheelAccumulatorRef.current?.reset()");
    expect(wheelSection).not.toContain("getWheelNudgeDirection(");
    expect(wheelSection).not.toContain("getWheelStepCount(");
    expect(wheelSection).not.toContain("reorderTrack(");
    expect(wheelSection).not.toContain("nudgeClips(");
  });

  it("implements Audacity waveform and spectrogram scale ownership at an explicit scale strip", () => {
    expect(timelineSource).toContain("TIMELINE_VERTICAL_SCALE_WIDTH");
    expect(timelineSource).toContain("getTimelineVerticalScaleSubtarget({");
    expect(timelineSource).toContain('gesture.target === "spectrogram-db-floor"');
    expect(timelineSource).toContain("waveformScaleView.spectrogramDbFloor");
    expect(timelineSource).toContain("verticalOffset: waveformScaleView.verticalOffset");
    expect(timelineSource).toContain("spectrogramScale");
    expect(timelineSource).toContain("computeSpectrogramBandGeometry({");
    expect(timelineSource).toContain("height={geometry.height}");
  });

  it("uses the shared audio/MIDI/recording extent for horizontal Timeline scrolling", () => {
    const wheelSection = timelineSource.slice(
      timelineSource.indexOf("const handleWheel = (e: WheelEvent) =>"),
      timelineSource.indexOf('container.addEventListener("wheel", handleWheel'),
    );
    expect(wheelSection).toContain("getTimelineHorizontalScrollMax(");
    expect(wheelSection).toContain("state.recordingClips.length > 0");
    expect(timelineSource).toContain("const maxClipEnd = getTimelineVisibleContentEnd(");
  });

  it("resizes the exact Ableton automation lane and renders its stored height", () => {
    expect(timelineSource).toContain('gesture.target === "lane-height"');
    expect(timelineSource).toContain("const hitLane = visibleLanes[trackHit.laneIndex]");
    expect(timelineSource).toContain("computeWheelResizedSize({");
    expect(timelineSource).toContain("createWheelEditBurstController({");
    expect(timelineSource).toContain("beginAutomationLaneHeightEdit(");
    expect(timelineSource).toContain("setAutomationLaneHeight(");
    expect(timelineSource).toContain("commitAutomationLaneHeightEdit(");
    expect(timelineSource).toContain("timelineContextWheelEditControllerRef.current?.dispose()");
    expect(timelineSource).toContain("const laneH = getAutomationLaneHeight(lane)");
    expect(timelineSource).toContain("getAutomationLaneOffset(visibleLanes, laneIdx)");
  });

  it("hit-tests Piano Roll notes and routes zoom, nudge, and property edits through undo-aware actions", () => {
    expect(pianoRollSource).toContain("const wheelHit = isInsideStage");
    expect(pianoRollSource).toContain("hitTestPianoRoll(stageX, stageY, {");
    expect(pianoRollSource).toContain('gesture.target === "midi-note-height"');
    expect(pianoRollSource).toContain("computeAnchoredVerticalWheelZoom({");
    expect(pianoRollSource).toContain('closest<HTMLElement>(".piano-roll-key-viewport")');
    expect(pianoRollSource).toContain("getMidiNoteHeightZoomPointerOffset({");
    expect(pianoRollSource).toContain('gesture.target === "note-position"');
    expect(pianoRollSource).toContain('gesture.target === "note-property"');
    expect(pianoRollSource).toContain("commitMIDIClipEvents(");
    expect(pianoRollSource).toContain("contextWheelEditControllerRef.current?.dispose()");
    expect(pianoRollSource).toContain("createPianoRollContextWheelAccumulator()");
    const wheelSection = pianoRollSource.slice(
      pianoRollSource.indexOf("const handleWheel = (event: WheelEvent) =>"),
      pianoRollSource.indexOf('container.addEventListener("wheel", handleWheel'),
    );
    expect(wheelSection).toContain("getAccumulatedWheelNudgeDirection(");
    expect(wheelSection).toContain("getAccumulatedWheelStepCount(");
    expect(wheelSection).toContain("`note-nudge:${sessionKey}:${trackId}:${clipId}:${initialNoteId}`");
    expect(wheelSection).toContain("`note-property:${sessionKey}:${trackId}:${clipId}:${initialNoteId}:${propertyKey}`");
    expect(wheelSection).toContain("contextWheelAccumulatorRef.current?.reset()");
    expect(wheelSection).not.toContain("getWheelNudgeDirection(");
    expect(wheelSection).not.toContain("getWheelStepCount(");
    expect(wheelSection).toContain("rebuildMIDIEventsForNotes(");
    expect(wheelSection).toContain("previewMIDIClipEvents(trackId, clipId");
    expect(wheelSection).toContain("contextWheelEditControllerRef.current?.touch(target)");
    expect(wheelSection).not.toContain("moveMIDINotes(");
    expect(wheelSection).not.toContain("commitMIDIClipEvents(");
  });

  it("moves MIDI and audio clips together while skipping locked/no-op nudges", () => {
    expect(clipEditingSource).toContain("let touchedMIDI = false");
    expect(clipEditingSource).toContain("selectedState.selectedClipIds.includes(clip.id) && !isClipEditLocked(selectedState, clip)");
    expect(clipEditingSource).toContain("if (touchedMIDI) syncMIDITracksForTimelineClips(get, get().tracks)");
    expect(clipEditingSource).toContain("clipPositions.size === 0");
  });
});
