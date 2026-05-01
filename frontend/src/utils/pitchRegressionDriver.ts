import {
  nativeBridge,
  type PitchCorrectionCompletionData,
  type PitchContourData,
  type PitchNoteData,
  type PitchRegressionJob,
  type PitchRegressionResult,
  type PitchScrubPreviewStatus,
} from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { usePitchEditorStore } from "../store/pitchEditorStore";

let started = false;

function normalizeArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, T>)
      .filter(([key]) => /^\d+$/.test(key))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, item]) => item);
    if (entries.length > 0) {
      return entries;
    }
  }
  return [];
}

function baseNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const leaf = normalized.split("/").pop() ?? normalized;
  return leaf.replace(/\.[^.]+$/, "") || "Regression Clip";
}

function replaceFixtureClipSource(job: PitchRegressionJob) {
  let replaced = false;

  useDAWStore.setState((state) => ({
    tracks: state.tracks.map((track) => {
      if (track.id !== job.trackId) {
        return track;
      }

      return {
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== job.clipId) {
            return clip;
          }

          replaced = true;
          return {
            ...clip,
            filePath: job.sourceAudioPath,
            name: baseNameFromPath(job.sourceAudioPath),
            offset: 0,
            pitchCorrectionSourceFilePath: undefined,
            pitchCorrectionSourceOffset: undefined,
          };
        }),
      };
    }),
  }));

  if (!replaced) {
    throw new Error(`Fixture clip not found for track=${job.trackId} clip=${job.clipId}`);
  }
}

function deriveExportOutputPath(job: PitchRegressionJob) {
  if (job.exportOutputPath) {
    return job.exportOutputPath;
  }
  return job.resultJsonPath.replace(/\.json$/i, "_export.wav");
}

function deriveAuditionPlaybackOutputPath(job: PitchRegressionJob) {
  if (job.auditionPlaybackOutputPath) {
    return job.auditionPlaybackOutputPath;
  }
  return job.resultJsonPath.replace(/\.json$/i, "_after_app_playback_4s.wav");
}

function deriveAuditionExportOutputPath(job: PitchRegressionJob) {
  if (job.auditionExportOutputPath) {
    return job.auditionExportOutputPath;
  }
  return job.resultJsonPath.replace(/\.json$/i, "_after_export_4s.wav");
}

function waitForPitchCorrectionCompletion(targetClipId: string, timeoutMs = 120000) {
  return new Promise<PitchCorrectionCompletionData>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};

    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      reject(new Error(`Timed out waiting for pitchCorrectionComplete for clip ${targetClipId}`));
    }, timeoutMs);

    unsubscribe = nativeBridge.onPitchCorrectionComplete((data) => {
      if (settled || data.clipId !== targetClipId) {
        return;
      }

      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(data);
    });
  });
}

async function waitForContourReady(timeoutMs = 120000) {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    const state = usePitchEditorStore.getState();
    if (state.contour) {
      return state.contour;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }

  return null;
}

async function reportRegressionResult(result: PitchRegressionResult) {
  await nativeBridge.completePitchRegressionJob(result);
}

async function waitForScrubPreviewState(
  clipId: string,
  predicate: (status: PitchScrubPreviewStatus | null) => boolean,
  timeoutMs: number,
) {
  const startedAt = performance.now();
  let lastStatus: PitchScrubPreviewStatus | null = null;
  while (performance.now() - startedAt < timeoutMs) {
    lastStatus = await nativeBridge.getPitchScrubPreviewStatus(clipId);
    if (predicate(lastStatus)) {
      return { status: lastStatus, elapsedMs: performance.now() - startedAt };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  return { status: lastStatus, elapsedMs: performance.now() - startedAt };
}

function normalizePitchNotes(value: PitchRegressionJob["notes"] | PitchRegressionJob["expectedNotes"]) {
  return normalizeArray<PitchNoteData>(value);
}

function finiteNumberOrNull(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function applyTargetShiftSemitones(
  notes: PitchNoteData[],
  targetShiftSemitones: unknown,
) {
  const targetShift = finiteNumberOrNull(targetShiftSemitones);
  if (targetShift === null) {
    return {
      notes: notes.map((note) => ({ ...note })),
      targetShiftSemitones: null,
      actualRequestedShiftSemitones: null,
      requestedShiftErrorCents: null,
      chromaticSnapBypassed: false,
    };
  }

  const shiftedNotes = notes.map((note) => {
    const detectedPitch = finiteNumberOrNull(note.detectedPitch);
    if (detectedPitch === null) {
      throw new Error(`Cannot apply targetShiftSemitones=${targetShift}: note ${note.id} has invalid detectedPitch.`);
    }
    return {
      ...note,
      detectedPitch,
      correctedPitch: detectedPitch + targetShift,
    };
  });

  const shiftDeltas = shiftedNotes.map((note) => note.correctedPitch - note.detectedPitch);
  const averageShift = shiftDeltas.reduce((sum, delta) => sum + delta, 0) / Math.max(1, shiftDeltas.length);
  const maxErrorSemitones = shiftDeltas.reduce(
    (maxError, delta) => Math.max(maxError, Math.abs(delta - targetShift)),
    0,
  );
  if (maxErrorSemitones > 0.01) {
    throw new Error(
      `Requested relative pitch shift is not exact: target=${targetShift.toFixed(4)} st, `
      + `actual=${averageShift.toFixed(4)} st, maxError=${(maxErrorSemitones * 100).toFixed(2)} cents.`,
    );
  }

  return {
    notes: shiftedNotes,
    targetShiftSemitones: targetShift,
    actualRequestedShiftSemitones: averageShift,
    requestedShiftErrorCents: maxErrorSemitones * 100,
    chromaticSnapBypassed: true,
  };
}

function computeMedian(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) * 0.5
    : sorted[middle];
}

function overlapDuration(startA: number, endA: number, startB: number, endB: number) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function computeAnalysisSummary(
  contour: PitchContourData,
  expectedNotes: PitchNoteData[],
  job: PitchRegressionJob,
) {
  const notes = normalizePitchNotes(contour.notes);
  const frameTimes = normalizeArray<number>(contour.frames?.times);
  const frameMidi = normalizeArray<number>(contour.frames?.midi);
  const frameConfidence = normalizeArray<number>(contour.frames?.confidence);
  const frameVoiced = normalizeArray<boolean>(contour.frames?.voiced);

  const voicedMidi = frameMidi.filter((_, index) => frameVoiced[index]);
  const voicedConfidence = frameConfidence.filter((_, index) => frameVoiced[index]);

  let jumpCountOver2Semitones = 0;
  let jumpCountOver5Semitones = 0;
  let previousVoicedMidi: number | null = null;
  for (let index = 0; index < frameMidi.length; index += 1) {
    if (!frameVoiced[index]) {
      continue;
    }
    const midi = frameMidi[index];
    if (previousVoicedMidi != null) {
      const delta = Math.abs(midi - previousVoicedMidi);
      if (delta > 2) {
        jumpCountOver2Semitones += 1;
      }
      if (delta > 5) {
        jumpCountOver5Semitones += 1;
      }
    }
    previousVoicedMidi = midi;
  }

  const analysisStartSec = job.analysisOffsetSec ?? 0;
  const analysisDurationSec =
    job.analysisDurationSec ??
    Math.max(0, (frameTimes[frameTimes.length - 1] ?? 0) - (frameTimes[0] ?? 0));

  const expectedMatches = expectedNotes.map((expectedNote) => {
    let bestDetected: PitchNoteData | null = null;
    let bestOverlap = 0;

    for (const detectedNote of notes) {
      const overlap = overlapDuration(
        expectedNote.startTime,
        expectedNote.endTime,
        detectedNote.startTime,
        detectedNote.endTime,
      );
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestDetected = detectedNote;
      }
    }

    if (!bestDetected) {
      return {
        expectedId: expectedNote.id,
        matched: false,
        overlapSec: 0,
        overlapRatio: 0,
        startDeltaSec: null,
        endDeltaSec: null,
        pitchDeltaSemitones: null,
      };
    }

    const expectedDuration = Math.max(0.001, expectedNote.endTime - expectedNote.startTime);
    return {
      expectedId: expectedNote.id,
      matched: bestOverlap > 0,
      overlapSec: bestOverlap,
      overlapRatio: bestOverlap / expectedDuration,
      startDeltaSec: bestDetected.startTime - expectedNote.startTime,
      endDeltaSec: bestDetected.endTime - expectedNote.endTime,
      pitchDeltaSemitones: bestDetected.detectedPitch - expectedNote.detectedPitch,
    };
  });

  const unmatchedDetectedNoteCount = notes.filter((detectedNote) =>
    !expectedNotes.some((expectedNote) =>
      overlapDuration(
        expectedNote.startTime,
        expectedNote.endTime,
        detectedNote.startTime,
        detectedNote.endTime,
      ) > 0,
    ),
  ).length;
  const boundaryKindCounts = notes.reduce<Record<string, number>>((acc, note) => {
    for (const kind of [note.entryBoundaryKind ?? "unknown", note.exitBoundaryKind ?? "unknown"]) {
      acc[kind] = (acc[kind] ?? 0) + 1;
    }
    return acc;
  }, {});
  const cornerBoundaryCount = notes.filter((note) =>
    note.entryBoundaryReason?.includes("pitch_corner")
    || note.exitBoundaryReason?.includes("pitch_corner")
    || note.entryBoundaryKind === "soft_legato"
    || note.exitBoundaryKind === "soft_legato",
  ).length;
  const boundaryCandidates = normalizeArray(contour.boundaryCandidates);
  const cornerCandidateCount = boundaryCandidates.filter((candidate: any) =>
    String(candidate?.reason ?? "").includes("pitch_corner"),
  ).length;
  const destructiveCornerSplitCount = boundaryCandidates.filter((candidate: any) =>
    String(candidate?.reason ?? "").includes("pitch_corner")
    && String(candidate?.kind ?? "") !== "hard_word_like"
    && candidate?.destructiveSplitAllowed === true,
  ).length;
  const hardAcousticSplitCount = boundaryCandidates.filter((candidate: any) =>
    String(candidate?.kind ?? "") === "hard_word_like" && candidate?.destructiveSplitAllowed === true,
  ).length;
  const pitchDeviationCandidateCount = boundaryCandidates.filter((candidate: any) =>
    String(candidate?.reason ?? "").includes("pitch_hysteresis"),
  ).length;
  const destructivePitchJumpSplitCount = boundaryCandidates.filter((candidate: any) =>
    String(candidate?.reason ?? "").includes("pitch_hysteresis") && candidate?.destructiveSplitAllowed === true,
  ).length;
  const vibratoSuppressedCandidateCount = boundaryCandidates.filter((candidate: any) =>
    String(candidate?.kind ?? "") === "internal_vibrato"
    || String(candidate?.reason ?? "").includes("vibrato_suppressed"),
  ).length;
  const wordGroups = new Map<string, PitchNoteData[]>();
  for (const note of notes) {
    const groupId = note.wordGroupId && note.wordGroupId.length > 0 ? note.wordGroupId : note.id;
    const group = wordGroups.get(groupId) ?? [];
    group.push(note);
    wordGroups.set(groupId, group);
  }
  const wordGroupMatches = expectedNotes.map((expectedNote) => {
    let bestGroupId = "";
    let bestOverlap = 0;
    let bestFragmentCount = 0;
    let bestGroupStart = 0;
    let bestGroupEnd = 0;
    for (const [groupId, groupNotes] of wordGroups.entries()) {
      const overlap = groupNotes.reduce((sum, detectedNote) => sum + overlapDuration(
        expectedNote.startTime,
        expectedNote.endTime,
        detectedNote.startTime,
        detectedNote.endTime,
      ), 0);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestGroupId = groupId;
        bestFragmentCount = groupNotes.length;
        bestGroupStart = Math.min(...groupNotes.map((note) => note.startTime));
        bestGroupEnd = Math.max(...groupNotes.map((note) => note.endTime));
      }
    }
    const expectedDuration = Math.max(0.001, expectedNote.endTime - expectedNote.startTime);
    const groupDuration = Math.max(0, bestGroupEnd - bestGroupStart);
    return {
      expectedId: expectedNote.id,
      wordGroupId: bestGroupId,
      overlapSec: bestOverlap,
      overlapRatio: bestOverlap / expectedDuration,
      fragmentCount: bestFragmentCount,
      groupStartSec: bestGroupStart,
      groupEndSec: bestGroupEnd,
      groupDurationSec: groupDuration,
      groupOverhangSec: Math.max(0, expectedNote.startTime - bestGroupStart)
        + Math.max(0, bestGroupEnd - expectedNote.endTime),
    };
  });

  return {
    analyzerWindowStartSec: analysisStartSec,
    analyzerWindowEndSec: analysisStartSec + analysisDurationSec,
    noteCount: notes.length,
    expectedNoteCount: expectedNotes.length,
    noteCountDelta: notes.length - expectedNotes.length,
    frameCount: frameTimes.length,
    voicedFrameCount: frameVoiced.filter(Boolean).length,
    voicedFrameRatio: frameVoiced.length > 0
      ? frameVoiced.filter(Boolean).length / frameVoiced.length
      : 0,
    medianVoicedMidi: computeMedian(voicedMidi),
    medianVoicedConfidence: computeMedian(voicedConfidence),
    jumpCountOver2Semitones,
    jumpCountOver5Semitones,
    jumpRateOver2PerSecond: analysisDurationSec > 0
      ? jumpCountOver2Semitones / analysisDurationSec
      : 0,
    expectedMatches,
    matchedExpectedCount: expectedMatches.filter((match) => match.matched).length,
    unmatchedDetectedNoteCount,
    boundaryKindCounts,
    cornerBoundaryCount,
    boundaryCandidateCount: boundaryCandidates.length,
    cornerCandidateCount,
    destructiveCornerSplitCount,
    hardAcousticSplitCount,
    pitchDeviationCandidateCount,
    destructivePitchJumpSplitCount,
    vibratoSuppressedCandidateCount,
    wordGroupCount: wordGroups.size,
    wordGroupMatches,
    minWordGroupOverlapRatio: wordGroupMatches.length > 0
      ? Math.min(...wordGroupMatches.map((match) => match.overlapRatio))
      : 0,
    maxWordGroupFragmentsPerExpected: wordGroupMatches.length > 0
      ? Math.max(...wordGroupMatches.map((match) => match.fragmentCount))
      : 0,
    maxWordGroupOverhangSec: wordGroupMatches.length > 0
      ? Math.max(...wordGroupMatches.map((match) => match.groupOverhangSec))
      : 0,
    hardWordLikeBoundaryCount: boundaryKindCounts.hard_word_like ?? 0,
    softLegatoBoundaryCount: boundaryKindCounts.soft_legato ?? 0,
  };
}

function waitForDirectPitchAnalysis(targetClipId: string, timeoutMs = 120000) {
  return new Promise<PitchContourData>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};

    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      reject(new Error(`Timed out waiting for pitch analysis for clip ${targetClipId}`));
    }, timeoutMs);

    unsubscribe = nativeBridge.onPitchAnalysisComplete(async (notification: any) => {
      if (settled || notification?.clipId !== targetClipId || !notification?.ready) {
        return;
      }

      try {
        const fullResult = await nativeBridge.getLastPitchAnalysisResult();
        if (!fullResult) {
          return;
        }

        settled = true;
        window.clearTimeout(timeout);
        unsubscribe();
        resolve(fullResult);
      } catch (error) {
        settled = true;
        window.clearTimeout(timeout);
        unsubscribe();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function runAnalysisRegressionJob(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  const clipId = job.clipId || "pitch-analysis-clip";
  const analysisOffsetSec = job.analysisOffsetSec ?? 0;
  const analysisDurationSec = job.analysisDurationSec ?? 30;
  const expectedNotes = normalizePitchNotes(job.expectedNotes ?? job.notes);

  const startedAt = performance.now();
  const completionPromise = waitForDirectPitchAnalysis(clipId);
  const response = await nativeBridge.analyzePitchContourDirect(
    job.sourceAudioPath,
    analysisOffsetSec,
    analysisDurationSec,
    clipId,
  );
  const analysisStarted = !!(response as { started?: boolean } | null)?.started;
  if (!analysisStarted) {
    throw new Error("Direct pitch analysis request was not accepted.");
  }

  const contour = await completionPromise;
  const elapsedMs = performance.now() - startedAt;
  const analysisSummary = computeAnalysisSummary(contour, expectedNotes, job);

  return {
    success: true,
    jobType: "analysis",
    clipId,
    elapsedMs,
    sourceAudioPath: job.sourceAudioPath,
    label: job.label,
    analysisSummary,
    analysisResult: contour,
  };
}

async function runScrubRegressionJob(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  const clipId = job.clipId || "pitch-scrub-clip";
  if (!job.projectFixturePath || !job.trackId) {
    throw new Error("Scrub regression job is missing required fixture project metadata.");
  }

  const normalizedNotes = normalizePitchNotes(job.notes);
  if (normalizedNotes.length === 0) {
    throw new Error("Scrub regression job requires at least one note.");
  }

  const note = { ...normalizedNotes[0] };
  const loadOk = await useDAWStore.getState().loadProject(job.projectFixturePath, { bypassFX: true });
  if (!loadOk) {
    throw new Error(`Failed to load fixture project: ${job.projectFixturePath}`);
  }

  replaceFixtureClipSource(job);
  await useDAWStore.getState().syncClipsWithBackend();
  useDAWStore.getState().openPitchEditor(job.trackId, clipId, -1);
  await usePitchEditorStore.getState().analyze();
  const contour = await waitForContourReady();
  if (!contour) {
    throw new Error("Pitch analysis did not produce a contour for scrub regression.");
  }

  const contourNotes = normalizePitchNotes(contour.notes);

  const scrubWaitMs = Math.max(150, job.scrubWaitMs ?? 800);
  const scrubUpdatePitchRatio = job.scrubUpdatePitchRatio ?? Math.pow(2, (note.correctedPitch - note.detectedPitch) / 12);
  const scrubFrames = job.frames ?? contour.frames;
  const repeatCount = Math.max(1, job.scrubRepeatCount ?? 1);
  const selectionChangeRequested = !!job.scrubSelectionChange;

  async function performScrubCycle(
    cycleNote: PitchNoteData,
    scenarioName: string,
  ) {
    await nativeBridge.startPitchScrubPreview(job.trackId!, clipId, cycleNote, scrubFrames);
    const started = await waitForScrubPreviewState(clipId, (status) => !!status?.audible, scrubWaitMs);

    await nativeBridge.updatePitchScrubPreview(clipId, scrubUpdatePitchRatio);
    const afterUpdate = await waitForScrubPreviewState(
      clipId,
      (status) => !!status?.audible && (status.pitchRatio ?? 0) > 0,
      scrubWaitMs,
    );
    const routingStatus = await nativeBridge.getPitchPreviewRoutingStatus(clipId);
    if (routingStatus && (routingStatus.monitorMode !== "scrub" || routingStatus.clipLivePreviewActive)) {
      throw new Error(`Unexpected scrub routing state: ${JSON.stringify(routingStatus)}`);
    }

    await nativeBridge.stopPitchScrubPreview(clipId);
    const stopped = await waitForScrubPreviewState(
      clipId,
      (status) => !!status && !status.active && !status.releasePending,
      scrubWaitMs,
    );

    const finalStatus = stopped.status ?? afterUpdate.status ?? started.status ?? null;
    return {
      name: scenarioName,
      audible: !!(started.status?.audible || started.status?.firstDragAudible || afterUpdate.status?.audible),
      firstDragAudible: !!(started.status?.firstDragAudible || afterUpdate.status?.firstDragAudible || finalStatus?.firstDragAudible),
      startLatencyMs: started.status?.audible ? started.elapsedMs : null,
      stopLatencyMs: stopped.status && !stopped.status.active && !stopped.status.releasePending ? stopped.elapsedMs : null,
      repeatStability: finalStatus?.repeatStability ?? null,
      lastPeak: finalStatus?.lastPeak ?? null,
      mixedCallbackCount: finalStatus?.mixedCallbackCount,
      mixedSampleCount: finalStatus?.mixedSampleCount,
      status: finalStatus ?? undefined,
      routingStatus: routingStatus ?? undefined,
    };
  }

  const scenarioResults: Array<{
    name: string;
    audible: boolean;
    firstDragAudible: boolean;
    startLatencyMs: number | null;
    stopLatencyMs: number | null;
    repeatStability: number | null;
    lastPeak: number | null;
    mixedCallbackCount?: number;
    mixedSampleCount?: number;
    status?: PitchScrubPreviewStatus;
    routingStatus?: Awaited<ReturnType<typeof nativeBridge.getPitchPreviewRoutingStatus>>;
  }> = [];

  scenarioResults.push(await performScrubCycle(note, "first_drag"));

  for (let repeatIndex = 1; repeatIndex < repeatCount; repeatIndex += 1) {
    scenarioResults.push(await performScrubCycle(note, `repeated_drag_${repeatIndex + 1}`));
  }

  if (job.scrubTransportCycle) {
    const cycleStart = Math.max(0, note.startTime);
    await useDAWStore.getState().seekTo(cycleStart);
    await useDAWStore.getState().play();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await useDAWStore.getState().stop();
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    scenarioResults.push(await performScrubCycle(note, "after_transport_cycle"));
  }

  let selectionChangeScenario: typeof scenarioResults[number] | undefined;

  if (job.scrubSelectionChange) {
    const alternateNote = contourNotes.find((candidate) => candidate.id !== note.id) ?? normalizedNotes.find((candidate) => candidate.id !== note.id);
    if (alternateNote) {
      selectionChangeScenario = await performScrubCycle(
        {
          ...alternateNote,
          transitionIn: alternateNote.transitionIn ?? note.transitionIn,
          transitionOut: alternateNote.transitionOut ?? note.transitionOut,
        },
        "selection_change",
      );
      scenarioResults.push(selectionChangeScenario);
    }
  }

  const firstScenario = scenarioResults[0];
  const finalScenario = scenarioResults[scenarioResults.length - 1];
  const finalStatus = finalScenario?.status ?? null;
  const scenarioPassCount = scenarioResults.filter((scenario) => scenario.audible).length;
  const repeatedDragScenarios = scenarioResults.filter((scenario) => scenario.name.startsWith("repeated_drag_"));
  const repeatedDragAudible = repeatedDragScenarios.length > 0
    ? repeatedDragScenarios.every((scenario) => scenario.audible)
    : firstScenario?.audible ?? false;
  const afterTransportScenario = scenarioResults.find((scenario) => scenario.name === "after_transport_cycle");

  return {
    success: scenarioPassCount > 0,
    jobType: "scrub",
    clipId,
    sourceAudioPath: job.sourceAudioPath,
    label: job.label,
    scrubPreviewAudible: !!firstScenario?.audible,
    scrubPreviewFirstDragAudible: !!firstScenario?.firstDragAudible,
    scrubPreviewStartLatencyMs: firstScenario?.startLatencyMs ?? null,
    scrubPreviewStopLatencyMs: finalScenario?.stopLatencyMs ?? null,
    scrubPreviewMixedCallbackCount: finalScenario?.mixedCallbackCount,
    scrubPreviewMixedSampleCount: finalScenario?.mixedSampleCount,
    scrubPreviewLastPeak: finalScenario?.lastPeak ?? null,
    scrubPreviewRepeatStability: finalScenario?.repeatStability ?? null,
    scrubPreviewScenarioCount: scenarioResults.length,
    scrubPreviewScenarioPassCount: scenarioPassCount,
    scrubPreviewRepeatedDragAudible: repeatedDragAudible,
    scrubPreviewAfterTransportCycleAudible: afterTransportScenario ? afterTransportScenario.audible : false,
    scrubPreviewSelectionChangeAudible: selectionChangeScenario ? selectionChangeScenario.audible : false,
    scrubPreviewSelectionChangeRequested: selectionChangeRequested,
    scrubPreviewInputNoteCount: normalizedNotes.length,
    scrubPreviewContourNoteCount: contourNotes.length,
    scrubPreviewAlternateNoteFound: !!selectionChangeScenario,
    scrubPreviewScenarioNames: scenarioResults.map((scenario) => scenario.name),
    scrubPreviewScenarioResults: scenarioResults.map((scenario) => ({
      name: scenario.name,
      audible: scenario.audible,
      firstDragAudible: scenario.firstDragAudible,
      startLatencyMs: scenario.startLatencyMs,
      stopLatencyMs: scenario.stopLatencyMs,
      repeatStability: scenario.repeatStability,
      lastPeak: scenario.lastPeak,
      routingStatus: scenario.routingStatus,
    })),
    scrubPreviewStatus: finalStatus ?? undefined,
    analysisResult: contour,
  };
}

async function runRenderRegressionJob(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  const normalizedNotes = normalizePitchNotes(job.notes);
  const targetShiftRequest = applyTargetShiftSemitones(normalizedNotes, job.targetShiftSemitones);
  const requestedNotes = targetShiftRequest.notes;
  const renderMode = job.renderMode ?? "single";
  if (!job.projectFixturePath || !job.trackId) {
    throw new Error("Render regression job is missing required fixture project metadata.");
  }
  if (requestedNotes.length === 0) {
    throw new Error("Regression job did not contain any editable notes.");
  }
  if (Math.abs(job.globalFormantSemitones ?? 0) > 0.001 || requestedNotes.some((note) => Math.abs(note.formantShift ?? 0) > 0.001)) {
    throw new Error("The current UI+bridge regression harness is pitch-only for now. Formant edits must stay at zero.");
  }

  const loadOk = await useDAWStore.getState().loadProject(job.projectFixturePath, { bypassFX: true });
  if (!loadOk) {
    throw new Error(`Failed to load fixture project: ${job.projectFixturePath}`);
  }

  replaceFixtureClipSource(job);
  await useDAWStore.getState().syncClipsWithBackend();
  useDAWStore.getState().openPitchEditor(job.trackId, job.clipId, -1);

  const pitchStore = usePitchEditorStore.getState();
  await pitchStore.analyze();
  const contour = await waitForContourReady();

  if (!contour) {
    throw new Error("Pitch analysis did not produce a contour.");
  }

  usePitchEditorStore.setState((state) => ({
    ...state,
    contour: job.frames
      ? {
          ...contour,
          frames: job.frames,
        }
      : contour,
    notes: requestedNotes.map((note) => ({ ...note })),
    selectedNoteIds: requestedNotes.length > 0 ? [requestedNotes[0].id] : [],
    globalFormantCents: Math.round((job.globalFormantSemitones ?? 0) * 100),
  }));

  const startedAt = performance.now();
  const completionPromise = waitForPitchCorrectionCompletion(job.clipId);
  if (renderMode === "single" || renderMode === "note_hq") {
    await usePitchEditorStore.getState().applyCorrection();
  } else {
    const requestId = `pitch-regression-${Date.now()}`;
    const requestGroupId = `${requestId}-${renderMode}`;
    const accepted = (await nativeBridge.applyPitchCorrection(
      job.trackId,
      job.clipId,
      requestedNotes,
      job.frames
        ? {
            times: normalizeArray<number>(job.frames.times),
            midi: normalizeArray<number>(job.frames.midi),
            confidence: normalizeArray<number>(job.frames.confidence),
            rms: normalizeArray<number>(job.frames.rms),
            voiced: normalizeArray<boolean>(job.frames.voiced),
          }
        : contour.frames,
      requestId,
      job.globalFormantSemitones ?? 0,
      job.windowStartSec,
      job.windowEndSec,
      renderMode,
      requestGroupId,
    )) as boolean | { outputFile: string; success: boolean } | null;
    const acceptedOk =
      accepted === true ||
      (typeof accepted === "object" && accepted !== null && accepted.success === true);
    if (!acceptedOk) {
      throw new Error(`Pitch correction request was not accepted for renderMode='${renderMode}'.`);
    }
  }
  const completion = await completionPromise;
  const elapsedMs = performance.now() - startedAt;

  if (!completion.success || !completion.outputFile) {
    const reason = completion.hardFailReason || completion.fallbackReason || "no output file";
    throw new Error(`Pitch correction failed for clip ${job.clipId}: ${reason}`);
  }

  await useDAWStore.getState().syncClipsWithBackend();

  return {
    success: true,
    jobType: "render",
    outputFile: completion.outputFile,
    clipId: completion.clipId,
    requestId: completion.requestId,
    renderMode: completion.renderMode ?? renderMode,
    targetShiftSemitones: targetShiftRequest.targetShiftSemitones,
    actualRequestedShiftSemitones: targetShiftRequest.actualRequestedShiftSemitones,
    requestedShiftErrorCents: targetShiftRequest.requestedShiftErrorCents,
    chromaticSnapBypassed: targetShiftRequest.chromaticSnapBypassed,
    requestedRendererBranch: completion.requestedRendererBranch,
    actualRendererBranch: completion.actualRendererBranch,
    pitchOnlyRecoveryPath: completion.pitchOnlyRecoveryPath,
    pitchOnlyNeutralFormantUsed: completion.pitchOnlyNeutralFormantUsed,
    processingMode: completion.processingMode,
    formantCurveUsed: completion.formantCurveUsed,
    explicitFormantRequested: completion.explicitFormantRequested,
    pitchOnlyFormantSuppressed: completion.pitchOnlyFormantSuppressed,
    usedFallback: completion.usedFallback,
    fallbackReason: completion.fallbackReason,
    hardFailReason: completion.hardFailReason,
    pitchRenderStrategy: completion.pitchRenderStrategy,
    pitchRenderProductPath: completion.pitchRenderProductPath,
    pitchRenderBackendId: completion.pitchRenderBackendId,
    pitchRenderBackendVersion: completion.pitchRenderBackendVersion,
    pitchRenderBackendFailureCode: completion.pitchRenderBackendFailureCode,
    pitchRenderBackendCapabilities: completion.pitchRenderBackendCapabilities,
    pitchRenderBackendDiagnostics: completion.pitchRenderBackendDiagnostics,
    pitchRenderBackendFallbackUsed: completion.pitchRenderBackendFallbackUsed,
    pitchRenderDirection: completion.pitchRenderDirection,
    downshiftFormantGuardUsed: completion.downshiftFormantGuardUsed,
    downshiftFormantGuardAlpha: completion.downshiftFormantGuardAlpha,
    noteHqEffectiveStartSec: completion.noteHqEffectiveStartSec,
    noteHqEffectiveEndSec: completion.noteHqEffectiveEndSec,
    noteHqContextStartSec: completion.noteHqContextStartSec,
    noteHqContextEndSec: completion.noteHqContextEndSec,
    noteHqAudibleCommitStartSec: completion.noteHqAudibleCommitStartSec,
    noteHqAudibleCommitEndSec: completion.noteHqAudibleCommitEndSec,
    noteHqPreBodyDryProtectedSamples: completion.noteHqPreBodyDryProtectedSamples,
    noteHqEntryInsideBodyFadeMs: completion.noteHqEntryInsideBodyFadeMs,
    noteHqExitLeadInMs: completion.noteHqExitLeadInMs,
    noteHqEntryBridgeStartSec: completion.noteHqEntryBridgeStartSec,
    noteHqEntryBridgeEndSec: completion.noteHqEntryBridgeEndSec,
    noteHqEntryBridgeWetLagMs: completion.noteHqEntryBridgeWetLagMs,
    noteHqEntryBridgeEnvelopeGainDb: completion.noteHqEntryBridgeEnvelopeGainDb,
    noteHqEntryBridgeUsed: completion.noteHqEntryBridgeUsed,
    noteHqEntryTransientDryPreservedMs: completion.noteHqEntryTransientDryPreservedMs,
    pitchOnlyEntrySimpleHandoffUsed: completion.pitchOnlyEntrySimpleHandoffUsed,
    pitchOnlyEntrySafeHandoffUsed: completion.pitchOnlyEntrySafeHandoffUsed,
    pitchOnlyEntryDryHoldMs: completion.pitchOnlyEntryDryHoldMs,
    pitchOnlyEntrySafeBridgeMs: completion.pitchOnlyEntrySafeBridgeMs,
    pitchOnlyEntryWetAlignmentMs: completion.pitchOnlyEntryWetAlignmentMs,
    pitchOnlyEntryWetGainDb: completion.pitchOnlyEntryWetGainDb,
    pitchOnlyEntryWetVsDryRmsDb: completion.pitchOnlyEntryWetVsDryRmsDb,
    pitchOnlyEntryEqualPowerBlendUsed: completion.pitchOnlyEntryEqualPowerBlendUsed,
    pitchOnlyEntryRmsContinuityUsed: completion.pitchOnlyEntryRmsContinuityUsed,
    pitchOnlyEntryRmsContinuityGainDb: completion.pitchOnlyEntryRmsContinuityGainDb,
    pitchOnlyEntryRmsContinuityMs: completion.pitchOnlyEntryRmsContinuityMs,
    pitchOnlyEntryPhaseSafeUsed: completion.pitchOnlyEntryPhaseSafeUsed,
    pitchOnlyEntryWetAlignmentAccepted: completion.pitchOnlyEntryWetAlignmentAccepted,
    pitchOnlyEntryFirstCycleCorrelation: completion.pitchOnlyEntryFirstCycleCorrelation,
    pitchOnlyEntryZeroCrossOffsetMs: completion.pitchOnlyEntryZeroCrossOffsetMs,
    pitchOnlyEntryBridgeGainRampDb: completion.pitchOnlyEntryBridgeGainRampDb,
    pitchOnlyDownshiftCoreEnvelopePassUsed: completion.pitchOnlyDownshiftCoreEnvelopePassUsed,
    pitchOnlyDownshiftCoreRmsTrimDb: completion.pitchOnlyDownshiftCoreRmsTrimDb,
    pitchOnlyDownshiftCoreEnvelopeMaxDb: completion.pitchOnlyDownshiftCoreEnvelopeMaxDb,
    pitchOnlyDownshiftCoreEnvelopeFrames: completion.pitchOnlyDownshiftCoreEnvelopeFrames,
    pitchOnlyEntryWetLagMs: completion.pitchOnlyEntryWetLagMs,
    pitchOnlyEntryBridgeDurationMs: completion.pitchOnlyEntryBridgeDurationMs,
    pitchOnlyExitDryRestoreUsed: completion.pitchOnlyExitDryRestoreUsed,
    pitchOnlyExitDryRestoreStartSec: completion.pitchOnlyExitDryRestoreStartSec,
    pitchOnlyExitDryRestoreEndSec: completion.pitchOnlyExitDryRestoreEndSec,
    noteHqEntryBoundaryKind: completion.noteHqEntryBoundaryKind,
    noteHqExitBoundaryKind: completion.noteHqExitBoundaryKind,
    noteHqEntryBoundaryScore: completion.noteHqEntryBoundaryScore,
    noteHqExitBoundaryScore: completion.noteHqExitBoundaryScore,
    noteHqRendererEntryBoundaryKind: completion.noteHqRendererEntryBoundaryKind,
    noteHqRendererExitBoundaryKind: completion.noteHqRendererExitBoundaryKind,
    noteHqEditIslandCount: completion.noteHqEditIslandCount,
    noteHqEditedNoteCount: completion.noteHqEditedNoteCount,
    noteHqEntryPitchHandoffUsed: completion.noteHqEntryPitchHandoffUsed,
    noteHqEntryPitchHandoffStartSec: completion.noteHqEntryPitchHandoffStartSec,
    noteHqEntryPitchHandoffEndSec: completion.noteHqEntryPitchHandoffEndSec,
    noteHqEntryPitchHandoffPreMs: completion.noteHqEntryPitchHandoffPreMs,
    noteHqEntryPitchHandoffBodyMs: completion.noteHqEntryPitchHandoffBodyMs,
    noteHqEntryPitchSlopeJumpStPerSec: completion.noteHqEntryPitchSlopeJumpStPerSec,
    noteHqEntryPitchAccelerationLimited: completion.noteHqEntryPitchAccelerationLimited,
    rubberBandQualityPromoted: completion.rubberBandQualityPromoted,
    phraseHqRenderUsed: completion.phraseHqRenderUsed,
    phraseHqExpandedToFullClip: completion.phraseHqExpandedToFullClip,
    phraseHqExternalUsed: completion.phraseHqExternalUsed,
    phraseHqExternalRendererPath: completion.phraseHqExternalRendererPath,
    phraseHqStartSec: completion.phraseHqStartSec,
    phraseHqEndSec: completion.phraseHqEndSec,
    externalPitchRendererAvailable: completion.externalPitchRendererAvailable,
    elapsedMs,
    outputDurationSec: completion.outputDurationSec,
    bridgeUsed: completion.bridgeUsed,
    bridgeFallbackUsed: completion.bridgeFallbackUsed,
    bridgeStartSec: completion.bridgeStartSec,
    bridgeLengthMs: completion.bridgeLengthMs,
    bridgeAlignmentLagSamples: completion.bridgeAlignmentLagSamples,
    bridgeCorrelationScore: completion.bridgeCorrelationScore,
    bridgeGainDeltaDb: completion.bridgeGainDeltaDb,
    bodyReplacementUsed: completion.bodyReplacementUsed,
    bodyReplacementFallbackUsed: completion.bodyReplacementFallbackUsed,
    entryLockStartSec: completion.entryLockStartSec,
    entryLockLengthMs: completion.entryLockLengthMs,
    exitLockStartSec: completion.exitLockStartSec,
    renderedBodyStartSec: completion.renderedBodyStartSec,
    renderedBodyEndSec: completion.renderedBodyEndSec,
    islandNativeUsed: completion.islandNativeUsed,
    islandNativeFallbackUsed: completion.islandNativeFallbackUsed,
    islandRenderStartSec: completion.islandRenderStartSec,
    islandRenderEndSec: completion.islandRenderEndSec,
    transientMaskPeak: completion.transientMaskPeak,
    voicedCoreMaskPeak: completion.voicedCoreMaskPeak,
    hpssUsed: completion.hpssUsed,
    hpssFallbackUsed: completion.hpssFallbackUsed,
    harmonicMaskPeak: completion.harmonicMaskPeak,
    aperiodicMaskPeak: completion.aperiodicMaskPeak,
    spectralEnvelopeCorrectionUsed: completion.spectralEnvelopeCorrectionUsed,
    pitchOnlyCoreTimbreCorrectionUsed: completion.pitchOnlyCoreTimbreCorrectionUsed,
    pitchOnlyCoreEnvelopeMix: completion.pitchOnlyCoreEnvelopeMix,
    pitchOnlyCoreRmsTrimDb: completion.pitchOnlyCoreRmsTrimDb,
    pitchOnlyCoreEnvelopeLifter: completion.pitchOnlyCoreEnvelopeLifter,
    pitchOnlyEntryTimbreCorrectionUsed: completion.pitchOnlyEntryTimbreCorrectionUsed,
    pitchOnlyEntryRmsTrimDb: completion.pitchOnlyEntryRmsTrimDb,
    pitchOnlyEntryTiltDb: completion.pitchOnlyEntryTiltDb,
    pitchOnlyEntryHandoffUsed: completion.pitchOnlyEntryHandoffUsed,
    pitchOnlyExitHandoffUsed: completion.pitchOnlyExitHandoffUsed,
    vocalSourceFilterUsed: completion.vocalSourceFilterUsed,
    vocalSourceFilterVoicedCoverage: completion.vocalSourceFilterVoicedCoverage,
    vocalSourceFilterResidualMix: completion.vocalSourceFilterResidualMix,
    vocalSourceFilterFallbackUsed: completion.vocalSourceFilterFallbackUsed,
    vocalSourceFilterFallbackReason: completion.vocalSourceFilterFallbackReason,
    vocalSourceFilterEntryDryMs: completion.vocalSourceFilterEntryDryMs,
    vocalSourceFilterExitDryMs: completion.vocalSourceFilterExitDryMs,
    wsolaUsed: completion.wsolaUsed,
    wsolaFallbackUsed: completion.wsolaFallbackUsed,
    wsolaEntryLagSamples: completion.wsolaEntryLagSamples,
    wsolaExitLagSamples: completion.wsolaExitLagSamples,
    wsolaCorrelationScore: completion.wsolaCorrelationScore,
    phaseLockUsed: completion.phaseLockUsed,
    phaseLockFallbackUsed: completion.phaseLockFallbackUsed,
    phaseAlignedEntry: completion.phaseAlignedEntry,
    phaseAlignedExit: completion.phaseAlignedExit,
    phasePeakCount: completion.phasePeakCount,
    transitionHqUsed: completion.transitionHqUsed,
    transitionHqFallbackUsed: completion.transitionHqFallbackUsed,
    transitionStartSec: completion.transitionStartSec,
    transitionEndSec: completion.transitionEndSec,
    transitionTransientPeak: completion.transitionTransientPeak,
    transitionVoicedCorePeak: completion.transitionVoicedCorePeak,
    transitionResidualPeak: completion.transitionResidualPeak,
    transitionEnvelopeCorrectionUsed: completion.transitionEnvelopeCorrectionUsed,
    engineV2Used: completion.engineV2Used,
    engineV2FallbackUsed: completion.engineV2FallbackUsed,
    engineV2TransitionCount: completion.engineV2TransitionCount,
    engineV2TransitionStartSec: completion.engineV2TransitionStartSec,
    engineV2TransitionEndSec: completion.engineV2TransitionEndSec,
    engineV2HarmonicSupportPeak: completion.engineV2HarmonicSupportPeak,
    engineV2ResidualSupportPeak: completion.engineV2ResidualSupportPeak,
    engineV2EnvelopeSupportPeak: completion.engineV2EnvelopeSupportPeak,
    transientBypassUsed: completion.transientBypassUsed,
    residualCarryUsed: completion.residualCarryUsed,
    cepstralCutoffUsed: completion.cepstralCutoffUsed,
    fftSizeUsed: completion.fftSizeUsed,
    hopSizeUsed: completion.hopSizeUsed,
    immediateLeftNeighborUsed: completion.immediateLeftNeighborUsed,
    immediateRightNeighborUsed: completion.immediateRightNeighborUsed,
    leftNeighborSamplesRendered: completion.leftNeighborSamplesRendered,
    rightNeighborSamplesRendered: completion.rightNeighborSamplesRendered,
    leftNeighborSmoothMs: completion.leftNeighborSmoothMs,
    rightNeighborSmoothMs: completion.rightNeighborSmoothMs,
    nonImmediateNeighborTouched: completion.nonImmediateNeighborTouched,
    entryAlignmentOffsetMs: completion.entryAlignmentOffsetMs,
    exitAlignmentOffsetMs: completion.exitAlignmentOffsetMs,
    firstVoicedCyclesEntryUsed: completion.firstVoicedCyclesEntryUsed,
    firstVoicedCyclesExitUsed: completion.firstVoicedCyclesExitUsed,
    v3TransitionPairUsed: completion.v3TransitionPairUsed,
    v3ContinuousRenderUsed: completion.v3ContinuousRenderUsed,
    v3EntryAnchorMs: completion.v3EntryAnchorMs,
    v3ExitAnchorMs: completion.v3ExitAnchorMs,
    v3FirstCyclesEntryCount: completion.v3FirstCyclesEntryCount,
    v3FirstCyclesExitCount: completion.v3FirstCyclesExitCount,
    v3ShellDurationMs: completion.v3ShellDurationMs,
    v3BodyDurationMs: completion.v3BodyDurationMs,
    v3ResidualMix: completion.v3ResidualMix,
    v3FormantMode: completion.v3FormantMode,
    v3NeighborLeftOverlapMs: completion.v3NeighborLeftOverlapMs,
    v3NeighborRightOverlapMs: completion.v3NeighborRightOverlapMs,
    sourceAudioPath: job.sourceAudioPath,
    referenceAudioPath: job.referenceAudioPath,
    windowStartSec: job.windowStartSec,
    windowEndSec: job.windowEndSec,
    noteBodyStartSec: job.noteBodyStartSec,
    noteBodyEndSec: job.noteBodyEndSec,
    entryWindowSec: job.entryWindowSec,
    exitWindowSec: job.exitWindowSec,
    neighborWindowSec: job.neighborWindowSec,
    previewCoverageStartSec: completion.previewCoverageStartSec,
    previewCoverageEndSec: completion.previewCoverageEndSec,
    candidateCoverageStartSec: completion.candidateCoverageStartSec,
    candidateCoverageEndSec: completion.candidateCoverageEndSec,
    label: job.label,
  };
}

async function runExportRegressionJob(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  const applyResult = await runRenderRegressionJob({ ...job, renderMode: "note_hq" });
  const store = useDAWStore.getState();
  const track = store.tracks.find((candidate) => candidate.id === job.trackId);
  const clip = track?.clips.find((candidate) => candidate.id === job.clipId);
  if (!clip) {
    throw new Error(`Fixture clip not found after pitch apply: ${job.clipId}`);
  }

  await store.syncClipsWithBackend();
  const exportOutputPath = deriveExportOutputPath(job);
  const renderEndTime = Math.max(clip.startTime + clip.duration, job.windowEndSec ?? 0);
  const exportOk = await nativeBridge.renderProject({
    source: "master",
    startTime: 0,
    endTime: renderEndTime,
    filePath: exportOutputPath,
    format: "wav",
    sampleRate: 44100,
    bitDepth: 24,
    channels: 2,
    normalize: false,
    addTail: false,
    tailLength: 0,
  });
  if (!exportOk) {
    throw new Error(`Export regression render failed: ${exportOutputPath}`);
  }

  return {
    ...applyResult,
    jobType: "export",
    outputFile: exportOutputPath,
    pitchCorrectionOutputFile: applyResult.outputFile,
    exportOutputFile: exportOutputPath,
  };
}

async function runCleanExportRegressionJob(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  if (!job.projectFixturePath || !job.trackId) {
    throw new Error("Clean export regression job is missing required fixture project metadata.");
  }

  const loadOk = await useDAWStore.getState().loadProject(job.projectFixturePath, { bypassFX: true });
  if (!loadOk) {
    throw new Error(`Failed to load fixture project: ${job.projectFixturePath}`);
  }

  replaceFixtureClipSource(job);
  await useDAWStore.getState().syncClipsWithBackend();

  const store = useDAWStore.getState();
  const track = store.tracks.find((candidate) => candidate.id === job.trackId);
  const clip = track?.clips.find((candidate) => candidate.id === job.clipId);
  if (!clip) {
    throw new Error(`Fixture clip not found for clean export: ${job.clipId}`);
  }

  const exportOutputPath = deriveExportOutputPath(job);
  const renderEndTime = Math.max(clip.startTime + clip.duration, job.windowEndSec ?? 0);
  const exportOk = await nativeBridge.renderProject({
    source: "master",
    startTime: 0,
    endTime: renderEndTime,
    filePath: exportOutputPath,
    format: "wav",
    sampleRate: 44100,
    bitDepth: 24,
    channels: 2,
    normalize: false,
    addTail: false,
    tailLength: 0,
  });
  if (!exportOk) {
    throw new Error(`Clean export regression render failed: ${exportOutputPath}`);
  }

  const targetShift = finiteNumberOrNull(job.targetShiftSemitones) ?? 0;
  return {
    success: true,
    jobType: "clean_export",
    outputFile: exportOutputPath,
    exportOutputFile: exportOutputPath,
    clipId: job.clipId,
    renderMode: job.renderMode ?? "note_hq",
    targetShiftSemitones: targetShift,
    actualRequestedShiftSemitones: 0,
    requestedShiftErrorCents: Math.abs(targetShift) * 100,
    chromaticSnapBypassed: true,
    processingMode: "no-pitch-clean-export",
    formantCurveUsed: false,
    explicitFormantRequested: false,
    pitchOnlyFormantSuppressed: false,
    sourceAudioPath: job.sourceAudioPath,
    referenceAudioPath: job.referenceAudioPath,
    windowStartSec: job.windowStartSec,
    windowEndSec: job.windowEndSec,
    noteBodyStartSec: job.noteBodyStartSec,
    noteBodyEndSec: job.noteBodyEndSec,
    entryWindowSec: job.entryWindowSec,
    exitWindowSec: job.exitWindowSec,
    neighborWindowSec: job.neighborWindowSec,
    label: job.label,
  };
}

async function runAuditionRegressionJob(job: PitchRegressionJob): Promise<PitchRegressionResult> {
  if (!job.trackId) {
    throw new Error("Audition regression job is missing trackId.");
  }

  const notes = normalizePitchNotes(job.notes);
  if (notes.length === 0) {
    throw new Error("Audition regression job did not contain any editable notes.");
  }

  const noteStart = job.noteBodyStartSec ?? notes[0].startTime;
  const auditionStart = job.auditionStartSec ?? Math.max(0, noteStart - 1.0);
  const auditionDuration = job.auditionDurationSec ?? 4.5;
  if (auditionDuration < 4.0) {
    throw new Error(`Audition capture duration must be at least 4 seconds; got ${auditionDuration}.`);
  }

  const applyResult = await runRenderRegressionJob({ ...job, renderMode: "note_hq" });
  const playbackOutputPath = deriveAuditionPlaybackOutputPath(job);
  const exportOutputPath = deriveAuditionExportOutputPath(job);
  const routeReportPath = playbackOutputPath.replace(/\.[^.\\/]+$/, "_route.json");

  await useDAWStore.getState().syncClipsWithBackend();
  const appFinalCapture = await nativeBridge.capturePitchAppFinalContext({
    trackId: job.trackId,
    clipId: job.clipId,
    startTime: auditionStart,
    duration: auditionDuration,
    wavPath: playbackOutputPath,
    routeJsonPath: routeReportPath,
    sampleRate: 44100,
    metadata: {
      jobLabel: job.label ?? null,
      renderMode: "note_hq",
      outputFile: applyResult.outputFile ?? null,
      targetShiftSemitones: applyResult.targetShiftSemitones ?? job.targetShiftSemitones ?? null,
      actualRequestedShiftSemitones: applyResult.actualRequestedShiftSemitones ?? null,
      formantCurveUsed: applyResult.formantCurveUsed ?? null,
      actualRendererBranch: applyResult.actualRendererBranch ?? null,
    },
  });
  const capture = appFinalCapture?.capture;
  if (!capture?.success || !capture.filePath) {
    throw new Error(`Pitch audition playback capture failed: ${capture?.error ?? "unknown error"}`);
  }

  const exportOk = await nativeBridge.renderProject({
    source: "master",
    startTime: auditionStart,
    endTime: auditionStart + auditionDuration,
    filePath: exportOutputPath,
    format: "wav",
    sampleRate: 44100,
    bitDepth: 24,
    channels: 2,
    normalize: false,
    addTail: false,
    tailLength: 0,
  });
  if (!exportOk) {
    throw new Error(`Pitch audition export render failed: ${exportOutputPath}`);
  }

  return {
    ...applyResult,
    jobType: "audition",
    outputFile: playbackOutputPath,
    auditionPlaybackOutputFile: playbackOutputPath,
    auditionExportOutputFile: exportOutputPath,
    auditionStartSec: auditionStart,
    auditionDurationSec: auditionDuration,
    auditionCapture: capture,
    appFinalCapture: appFinalCapture ?? undefined,
    exportOutputFile: exportOutputPath,
    pitchCorrectionOutputFile: applyResult.outputFile,
  };
}

export async function maybeRunPitchRegressionDriver() {
  if (started) {
    return;
  }

  started = true;

  const job = await nativeBridge.getPitchRegressionJob();
  if (!job) {
    return;
  }

  try {
    const result = job.jobType === "analysis"
      ? await runAnalysisRegressionJob(job)
      : job.jobType === "scrub"
        ? await runScrubRegressionJob(job)
        : job.jobType === "export"
          ? await runExportRegressionJob(job)
          : job.jobType === "clean_export"
            ? await runCleanExportRegressionJob(job)
            : job.jobType === "audition"
              ? await runAuditionRegressionJob(job)
              : await runRenderRegressionJob(job);
    await reportRegressionResult(result);
  } catch (error) {
    await reportRegressionResult({
      success: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
  }
}
