// @ts-nocheck
/**
 * Transport actions — play, record, stop, pause, seek, tempo, loop, punch,
 * time selection, record modes, playhead behavior.
 * Extracted from useDAWStore.ts for modularity.
 */

import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";
import { resetSyncCache } from "./clips";

const AUDIO_TRANSPORT_LOG_PREFIX = "[audio.transport]";
const AUDIO_RECORD_LOG_PREFIX = "[audio.record]";

const stringifyForDebug = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable: ${String(error)}]`;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const transportActions = (set: SetFn, get: GetFn) => ({
    play: async () => {
      const { transport, syncClipsWithBackend, pixelsPerSecond, timeSelection } = get();
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:start`, {
        transportBefore: transport,
      });
      console.log("[DAW] PLAY requested", {
        currentTime: transport.currentTime,
        loopEnabled: transport.loopEnabled,
        loopStart: transport.loopStart,
        loopEnd: transport.loopEnd,
        timeSelection,
      });

      // If time selection exists and loop is enabled, start from selection and sync loop bounds
      let startTime = transport.currentTime;
      if (timeSelection && transport.loopEnabled) {
        startTime = timeSelection.start;
        set((state) => ({
          transport: {
            ...state.transport,
            currentTime: timeSelection.start,
            loopStart: timeSelection.start,
            loopEnd: timeSelection.end,
          },
        }));
      } else if (transport.loopEnabled && transport.loopEnd > transport.loopStart) {
        // Loop enabled without time selection — if playhead is outside loop region, snap to loopStart
        if (startTime < transport.loopStart || startTime >= transport.loopEnd) {
          startTime = transport.loopStart;
          set((state) => ({
            transport: {
              ...state.transport,
              currentTime: transport.loopStart,
            },
          }));
        }
      }

      // Store the start position for stop behavior
      set({ playStartPosition: startTime });

      // Scroll timeline so playhead is visible (position it ~100px from left edge)
      set({ scrollX: Math.max(0, startTime * pixelsPerSecond - 100) });

      // Check if any track has ARA active — if so, use minimal play path
      // (matching the plugin-initiated requestStartPlayback path that works).
      // Skip syncClipsWithBackend when ARA is active — ARA tracks don't use
      // PlaybackEngine clips (fillTrackBuffer is skipped), and the full sync
      // disrupts the ARA renderer causing ~300ms/block.
      const araActive = await nativeBridge.hasAnyActiveARA();
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:ara`, { araActive, startTime });

      if (araActive) {
        const positionResult = await nativeBridge.setTransportPosition(startTime);
        console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:setTransportPosition`, { startTime, positionResult });
        set((state) => ({
          transport: {
            ...state.transport,
            isPlaying: true,
            isPaused: false,
            isRecording: false,
          },
          recordingClips: [],
          recordingMIDIPreviews: {},
        }));
        const playingResult = await nativeBridge.setTransportPlaying(true);
        console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:setTransportPlaying`, { playingResult, mode: "ara" });
      } else {
        await syncClipsWithBackend();
        const positionResult = await nativeBridge.setTransportPosition(startTime);
        console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:setTransportPosition`, { startTime, positionResult });
        set((state) => ({
          transport: {
            ...state.transport,
            isPlaying: true,
            isPaused: false,
            isRecording: false,
          },
          recordingClips: [],
          recordingMIDIPreviews: {},
        }));
        const playingResult = await nativeBridge.setTransportPlaying(true);
        console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:setTransportPlaying`, { playingResult, mode: "standard" });
      }

      const debugSnapshot = await nativeBridge.getAudioDebugSnapshot();
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:debugSnapshot`, debugSnapshot, stringifyForDebug(debugSnapshot));
      window.setTimeout(async () => {
        try {
          const delayedSnapshot = await nativeBridge.getAudioDebugSnapshot();
          console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} play:debugSnapshotDelayed`, delayedSnapshot, stringifyForDebug(delayedSnapshot));
        } catch (error) {
          console.warn(`${AUDIO_TRANSPORT_LOG_PREFIX} play:debugSnapshotDelayed failed`, error);
        }
      }, 500);
      const hasMidiClips = get().tracks.some((t) => (t.midiClips?.length ?? 0) > 0);
      if (debugSnapshot.playbackClipCount <= 0 && !hasMidiClips) {
        get().showToast("Playback started with no registered clips", "error");
      }
    },

    record: async () => {
      const { tracks, transport, pixelsPerSecond, timeSelection } = get();
      const armedTracks = tracks
        .map((t) => ({ track: t }))
        .filter(({ track }) => track.armed);
      console.log(`${AUDIO_RECORD_LOG_PREFIX} record:start`, {
        transportBefore: transport,
        armedTrackIds: armedTracks.map(({ track }) => track.id),
      });

      const wasAlreadyPlaying = transport.isPlaying;
      const armedMidiTracks = armedTracks
        .map(({ track }) => track)
        .filter((track) => track.type === "midi" || track.type === "instrument");

      if (armedMidiTracks.length > 0) {
        let openDevices: string[] = [];
        try {
          const devices = await nativeBridge.getOpenMIDIDevices();
          openDevices = Array.isArray(devices) ? devices : [];
        } catch (error) {
          console.warn(`${AUDIO_RECORD_LOG_PREFIX} record:getOpenMIDIDevices failed`, error);
        }

        const missingInputTracks: string[] = [];
        const failedDeviceTracks: string[] = [];

        for (const track of armedMidiTracks) {
          const deviceName = track.midiInputDevice?.trim();
          if (!deviceName) {
            missingInputTracks.push(track.name);
            continue;
          }

          if (openDevices.includes(deviceName)) {
            continue;
          }

          const opened = await nativeBridge.openMIDIDevice(deviceName).catch(() => false);
          if (opened) {
            openDevices.push(deviceName);
          } else {
            failedDeviceTracks.push(`${track.name} (${deviceName})`);
          }
        }

        if (missingInputTracks.length > 0) {
          get().showToast(
            `Armed MIDI tracks have no MIDI input selected: ${missingInputTracks.join(", ")}. Hardware MIDI recording will be empty until you choose one. Virtual keyboard still works.`,
            "info",
          );
        }

        if (failedDeviceTracks.length > 0) {
          get().showToast(
            `Failed to open MIDI input device for: ${failedDeviceTracks.join(", ")}.`,
            "error",
          );
        }
      }

      // If time selection exists and loop is enabled, start from selection
      if (!wasAlreadyPlaying && timeSelection && transport.loopEnabled) {
        set((state) => ({
          transport: {
            ...state.transport,
            currentTime: timeSelection.start,
            loopStart: timeSelection.start,
            loopEnd: timeSelection.end,
          },
        }));
      } else if (!wasAlreadyPlaying && transport.loopEnabled && transport.loopEnd > transport.loopStart) {
        // Loop enabled without time selection — if playhead is outside loop region, snap to loopStart
        if (transport.currentTime < transport.loopStart || transport.currentTime >= transport.loopEnd) {
          set((state) => ({
            transport: {
              ...state.transport,
              currentTime: transport.loopStart,
            },
          }));
        }
      }

      const currentTime = get().transport.currentTime;

      // Store the start position for stop behavior (only if not already playing)
      if (!wasAlreadyPlaying) {
        set({ playStartPosition: currentTime });
        // Scroll timeline so playhead is visible
        set({ scrollX: Math.max(0, currentTime * pixelsPerSecond - 100) });
      }

      // Create recording clips for armed tracks at current position
      const newRecordingClips: RecordingClip[] = armedTracks.map(
        ({ track }) => ({
          trackId: track.id,
          startTime: currentTime,
        }),
      );

      // Only sync clips with backend if we're starting fresh (not already playing)
      if (!wasAlreadyPlaying) {
        // Sync clips FIRST (slow), then position + play back-to-back
        await get().syncClipsWithBackend();
        const positionResult = await nativeBridge.setTransportPosition(currentTime);
        console.log(`${AUDIO_RECORD_LOG_PREFIX} record:setTransportPosition`, { currentTime, positionResult });
      } else {
        console.log(
          "[DAW] Punch-in recording: already playing, preserving playback state",
        );
      }

      set((state) => ({
        transport: {
          ...state.transport,
          isPlaying: true,
          isPaused: false,
          isRecording: armedTracks.length > 0,
        },
        recordingClips: newRecordingClips,
        recordingMIDIPreviews: {},
      }));

      // Sync punch range with backend before recording starts
      const punchState = get().transport;
      const punchResult = await nativeBridge.setPunchRange(punchState.punchStart, punchState.punchEnd, punchState.punchEnabled);
      console.log(`${AUDIO_RECORD_LOG_PREFIX} record:setPunchRange`, {
        punchStart: punchState.punchStart,
        punchEnd: punchState.punchEnd,
        punchEnabled: punchState.punchEnabled,
        punchResult,
      });

      // Start both playback and recording
      if (!wasAlreadyPlaying) {
        const playingResult = await nativeBridge.setTransportPlaying(true);
        console.log(`${AUDIO_RECORD_LOG_PREFIX} record:setTransportPlaying`, { playingResult });
      }
      const recordingResult = await nativeBridge.setTransportRecording(true);
      console.log(`${AUDIO_RECORD_LOG_PREFIX} record:setTransportRecording`, { recordingResult });
      const recordSnapshot = await nativeBridge.getAudioDebugSnapshot();
      console.log(`${AUDIO_RECORD_LOG_PREFIX} record:debugSnapshot`, recordSnapshot, stringifyForDebug(recordSnapshot));
    },

    pause: () => {
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} pause`, {
        transportBefore: get().transport,
      });
      set((state) => ({
        transport: { ...state.transport, isPlaying: false, isPaused: true },
      }));
      nativeBridge.setTransportPlaying(false).then((result) => {
        console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} pause:setTransportPlaying`, { result });
      });
    },

    stop: async () => {
      const { playStartPosition, transport, addClip, playheadStopBehavior } = get();
      const wasRecording = transport.isRecording;
      const wasPlaying = transport.isPlaying || transport.isPaused;
      console.log("[useDAWStore] STOP called. Was recording:", wasRecording);

      // Determine where to place playhead after stop
      // "stop-in-place": keep at current position (first stop press)
      // "return-to-start": go back to where play started (always)
      // Double-stop convention: if already stopped, go to start position
      let stopTime: number;
      if (!wasPlaying) {
        // Already stopped — return to play start position (double-stop)
        stopTime = playStartPosition;
      } else if (playheadStopBehavior === "stop-in-place") {
        stopTime = transport.currentTime;
      } else {
        stopTime = playStartPosition;
      }

      set((state) => ({
        transport: {
          ...state.transport,
          isPlaying: false,
          isPaused: false,
          isRecording: false,
          currentTime: stopTime,
        },
        recordingClips: [], // Clear recording clips
        recordingMIDIPreviews: {},
        // Reset scroll to bring playhead into view
        scrollX: Math.max(0, stopTime * state.pixelsPerSecond - 100), // Keep 100px margin
        // Reset all meter levels and automation display values to zero on stop
        masterLevel: 0,
        meterLevels: {},
        peakLevels: {},
        automatedParamValues: {},
      }));
      console.log(
        "[useDAWStore] STOP State updated. Transport stopped, recordingClips cleared.",
      );
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} stop:stateUpdated`, {
        stopTime,
        wasPlaying,
        wasRecording,
      });

      // Clear sync cache so next play does a fresh diff
      resetSyncCache();

      // Stop playback and recording
      const playingResult = await nativeBridge.setTransportPlaying(false);
      const recordingResult = await nativeBridge.setTransportRecording(false);
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} stop:native`, { playingResult, recordingResult });
      console.log("[useDAWStore] STOP Native transport stopped.");

      // If we were recording, fetch the new clips and add them to the tracks
      if (wasRecording) {
        const newClips = await nativeBridge.getLastCompletedClips();
        const currentTracks = get().tracks;
        const currentRecordMode = get().recordMode;
        const armedAudioTrackIds = new Set(
          currentTracks
            .filter((track) => track.armed && track.type === "audio")
            .map((track) => track.id),
        );
        const armedMIDITrackIds = new Set(
          currentTracks
            .filter((track) => track.armed && (track.type === "midi" || track.type === "instrument"))
            .map((track) => track.id),
        );
        console.log(
          "[useDAWStore] Received recorded clips:",
          JSON.stringify(newClips, null, 2),
          "mode:", currentRecordMode,
        );
        console.log(`${AUDIO_RECORD_LOG_PREFIX} stop:getLastCompletedClips`, {
          count: newClips.length,
          clips: newClips,
        });
        const completedAudioClips = newClips.filter(
          (clipInfo) => clipInfo.duration > 0 && armedAudioTrackIds.has(clipInfo.trackId),
        );

        // Group clips by trackId for loop recording take handling
        const clipsByTrack = new Map<string, typeof newClips>();
        for (const clipInfo of completedAudioClips) {
          const existing = clipsByTrack.get(clipInfo.trackId) || [];
          existing.push(clipInfo);
          clipsByTrack.set(clipInfo.trackId, existing);
        }

        for (const [trackId, trackClips] of clipsByTrack) {
          const track = currentTracks.find((t) => t.id === trackId);
          const clipColor = track?.color || "#4361ee";

          // Create AudioClip objects for each recorded clip
          const recordedClips: AudioClip[] = trackClips.map((clipInfo, idx) => ({
            id: crypto.randomUUID(),
            name: trackClips.length > 1 ? `Take ${idx + 1}` : "Recording",
            filePath: clipInfo.filePath,
            startTime: clipInfo.startTime,
            duration: clipInfo.duration,
            offset: 0,
            color: clipColor,
            volumeDB: 0,
            fadeIn: 0,
            fadeOut: 0,
            sampleRate: get().audioDeviceSetup?.sampleRate || 44100,
          }));

          if (currentRecordMode === "replace" && recordedClips.length > 0) {
            const recStart = recordedClips[0].startTime;
            const recEnd = recStart + recordedClips[0].duration;
            set((s) => ({
              tracks: s.tracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.filter((c) => {
                        const clipEnd = c.startTime + c.duration;
                        return clipEnd <= recStart || c.startTime >= recEnd;
                      }),
                    }
                  : t,
              ),
            }));
          }

          if (recordedClips.length > 1) {
            // Loop recording: first clip is the main clip, rest are takes
            const mainClip = recordedClips[0];
            mainClip.takes = recordedClips.slice(1);
            mainClip.activeTakeIndex = recordedClips.length - 1; // Last take is active
            addClip(trackId, mainClip);
          } else if (recordedClips.length === 1) {
            addClip(trackId, recordedClips[0]);
          }

          // Register clips with backend
          for (const newClip of recordedClips) {
            console.log("[useDAWStore] Recording clip:", trackId,
              "startTime:", newClip.startTime.toFixed(3),
              "duration:", newClip.duration.toFixed(3),
              "file:", newClip.filePath);
          }

          // Register the active clip with the playback backend
          const activeClip = recordedClips.length > 1
            ? recordedClips[recordedClips.length - 1]
            : recordedClips[0];
          if (activeClip) {
            nativeBridge.addPlaybackClip(
              trackId,
              activeClip.filePath,
              activeClip.startTime,
              activeClip.duration,
              0,
              activeClip.volumeDB || 0,
              activeClip.fadeIn || 0,
              activeClip.fadeOut || 0,
              activeClip.id,
              activeClip.pitchCorrectionSourceFilePath,
              activeClip.pitchCorrectionSourceOffset,
            ).catch((e) => console.warn("[useDAWStore] addPlaybackClip after record failed:", e));
          }
        }

        // Also fetch completed MIDI clips
        const newMIDIClips = await nativeBridge.getLastCompletedMIDIClips();
        console.log("[useDAWStore] Received MIDI clips:", newMIDIClips.length);
        const completedMIDIClips = newMIDIClips.filter(
          (midiClipInfo) =>
            midiClipInfo.events.length > 0 && armedMIDITrackIds.has(midiClipInfo.trackId),
        );

        if (completedAudioClips.length === 0 && completedMIDIClips.length === 0) {
          get().showToast("Recording stopped, but no completed clip was returned", "error");
        }

        for (const midiClipInfo of completedMIDIClips) {
          const track = get().tracks.find((t) => t.id === midiClipInfo.trackId);
          const clipColor = track?.color || "#4361ee";

          // Convert backend events to frontend MIDIEvent format
          const events: MIDIEvent[] = midiClipInfo.events.map((e) => ({
            timestamp: e.timestamp,
            type: e.type as MIDIEvent["type"],
            note: e.note,
            velocity: e.velocity,
            controller: e.controller,
            value: e.value,
          }));

          const newMIDIClip: MIDIClip = {
            id: crypto.randomUUID(),
            name: "MIDI Recording",
            startTime: midiClipInfo.startTime,
            duration: midiClipInfo.duration,
            events,
            color: clipColor,
          };

          set((s) => ({
            tracks: s.tracks.map((t) =>
              t.id === midiClipInfo.trackId
                ? { ...t, midiClips: [...t.midiClips, newMIDIClip] }
                : t,
            ),
            isModified: true,
          }));

          console.log("[useDAWStore] Added MIDI clip to track", midiClipInfo.trackId,
            "with", events.length, "events, duration:", midiClipInfo.duration.toFixed(3));
        }
      }

      // Reset backend position to match frontend stop position
      const finalStopTime = get().transport.currentTime;
      const positionResult = await nativeBridge.setTransportPosition(finalStopTime);
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} stop:setTransportPosition`, { finalStopTime, positionResult });
      const stopSnapshot = await nativeBridge.getAudioDebugSnapshot();
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} stop:debugSnapshot`, stopSnapshot, stringifyForDebug(stopSnapshot));
    },

    togglePlayPause: async () => {
      const { transport } = get();
      if (transport.isPlaying) {
        get().pause();
      } else {
        await get().play();
      }
    },

    setCurrentTime: (time) => {
      set((state) => ({
        transport: { ...state.transport, currentTime: time },
      }));
    },

    seekTo: async (time) => {
      const { transport } = get();
      const wasPlaying = transport.isPlaying && !transport.isPaused;
      const wasRecording = transport.isRecording;
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} seek:start`, {
        time,
        transportBefore: transport,
        wasPlaying,
        wasRecording,
      });

      // If playing, pause first
      if (wasPlaying) {
        const pauseResult = await nativeBridge.setTransportPlaying(false);
        console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} seek:pauseForSeek`, { pauseResult });
        if (wasRecording) {
          const recordingPauseResult = await nativeBridge.setTransportRecording(false);
          console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} seek:pauseRecordingForSeek`, { recordingPauseResult });
        }
      }

      // Update position in store
      set((state) => ({
        transport: { ...state.transport, currentTime: time },
      }));

      // Sync position with backend
      const positionResult = await nativeBridge.setTransportPosition(time);
      console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} seek:setTransportPosition`, { time, positionResult });

      // If was playing, resume playback from new position
      if (wasPlaying) {
        const resumeResult = await nativeBridge.setTransportPlaying(true);
        console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} seek:resumePlayback`, { resumeResult });
        if (wasRecording) {
          const resumeRecordingResult = await nativeBridge.setTransportRecording(true);
          console.log(`${AUDIO_TRANSPORT_LOG_PREFIX} seek:resumeRecording`, { resumeRecordingResult });
        }
      }
    },

    setTempo: async (tempo) => {
      const oldTempo = get().transport.tempo;
      if (oldTempo === tempo) return;

      const command: Command = {
        type: "SET_TEMPO",
        description: `Set tempo to ${tempo} BPM`,
        timestamp: Date.now(),
        execute: async () => {
          set((s) => ({ transport: { ...s.transport, tempo } }));
          await nativeBridge.setTempo(tempo);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
        undo: async () => {
          set((s) => ({ transport: { ...s.transport, tempo: oldTempo } }));
          await nativeBridge.setTempo(oldTempo);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    toggleLoop: () => {
      const { projectRange, transport } = get();
      const enabling = !transport.loopEnabled;
      set((state) => ({
        transport: {
          ...state.transport,
          loopEnabled: enabling,
          // When enabling loop, sync to the project range
          ...(enabling && projectRange.end > projectRange.start
            ? { loopStart: projectRange.start, loopEnd: projectRange.end }
            : {}),
        },
      }));
    },

    setLoopRegion: (start, end) => {
      set((state) => ({
        transport: { ...state.transport, loopStart: start, loopEnd: end },
      }));
    },

    togglePunch: () => {
      const { transport, timeSelection } = get();
      const enabling = !transport.punchEnabled;
      set((state) => ({
        transport: {
          ...state.transport,
          punchEnabled: enabling,
          // When enabling punch, sync to time selection if it exists
          ...(enabling && timeSelection
            ? { punchStart: timeSelection.start, punchEnd: timeSelection.end }
            : {}),
        },
      }));
      // Sync with backend
      const t = get().transport;
      nativeBridge.setPunchRange(t.punchStart, t.punchEnd, t.punchEnabled).catch(logBridgeError("sync"));
    },

    setPunchRange: (start, end) => {
      set((state) => ({
        transport: { ...state.transport, punchStart: start, punchEnd: end },
      }));
      const t = get().transport;
      nativeBridge.setPunchRange(start, end, t.punchEnabled).catch(logBridgeError("sync"));
    },

    setTrackRecordSafe: (trackId, safe) => {
      set((state) => ({
        tracks: state.tracks.map((t) =>
          t.id === trackId ? { ...t, recordSafe: safe, armed: safe ? false : t.armed } : t,
        ),
      }));
      nativeBridge.setTrackRecordSafe(trackId, safe).catch(logBridgeError("sync"));
    },

    setTimeSelection: (start, end) => {
      set({ timeSelection: { start, end } });
    },

    clearTimeSelection: () => {
      set({ timeSelection: null });
    },

    setLoopToSelection: () => {
      const { timeSelection } = get();
      if (timeSelection) {
        set((state) => ({
          transport: {
            ...state.transport,
            loopEnabled: true,
            loopStart: timeSelection.start,
            loopEnd: timeSelection.end,
          },
        }));
      }
    },

    toggleMetronome: async () => {
      const current = get().metronomeEnabled;
      set({ metronomeEnabled: !current });
      await nativeBridge.setMetronomeEnabled(!current);
      // If enabling, sync current volume to backend
      if (!current) {
        await nativeBridge.setMetronomeVolume(get().metronomeVolume);
      }
    },

    setMetronomeVolume: async (volume) => {
      set({ metronomeVolume: volume });
      await nativeBridge.setMetronomeVolume(volume);
    },

    setMetronomeAccentBeats: async (accentBeats) => {
      set({ metronomeAccentBeats: accentBeats });
      await nativeBridge.setMetronomeAccentBeats(accentBeats);
      // Regenerate metronome track if it exists
      if (get().metronomeTrackId) {
        await get().generateMetronomeTrack();
      }
    },

    setTimeSignature: async (numerator, denominator) => {
      const oldTimeSig = { ...get().timeSignature };
      const oldAccents = [...get().metronomeAccentBeats];

      // Compute new accents
      const newAccents = Array(numerator).fill(false);
      newAccents[0] = true;
      for (let i = 1; i < Math.min(oldAccents.length, numerator); i++) {
        newAccents[i] = oldAccents[i];
      }

      const command: Command = {
        type: "SET_TIME_SIGNATURE",
        description: `Set time signature to ${numerator}/${denominator}`,
        timestamp: Date.now(),
        execute: async () => {
          set({ timeSignature: { numerator, denominator }, metronomeAccentBeats: newAccents });
          await nativeBridge.setTimeSignature(numerator, denominator);
          await nativeBridge.setMetronomeAccentBeats(newAccents);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
        undo: async () => {
          set({ timeSignature: oldTimeSig, metronomeAccentBeats: oldAccents });
          await nativeBridge.setTimeSignature(oldTimeSig.numerator, oldTimeSig.denominator);
          await nativeBridge.setMetronomeAccentBeats(oldAccents);
          if (get().metronomeTrackId) await get().generateMetronomeTrack();
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
    },

    generateMetronomeTrack: async () => {
      const state = get();

      // Remove existing metronome track if any
      if (state.metronomeTrackId) {
        await get().removeMetronomeTrack();
      }

      const { projectRange } = get();

      // Call backend to render metronome to WAV file
      const filePath = await nativeBridge.renderMetronomeToFile(
        projectRange.start,
        projectRange.end,
      );

      if (!filePath) {
        console.error("[DAW] Failed to render metronome to file");
        return;
      }

      // Create a new track for the metronome
      const trackId = await nativeBridge.addTrack();
      if (!trackId) {
        console.error("[DAW] Failed to create metronome track");
        return;
      }

      // Add track to frontend state
      get().addTrack({
        id: trackId,
        name: "Metronome",
        color: "#f59e0b",
      });

      // Create the clip
      const duration = projectRange.end - projectRange.start;
      const clipId = crypto.randomUUID();
      const clip: AudioClip = {
        id: clipId,
        filePath: filePath,
        name: "Metronome",
        startTime: projectRange.start,
        duration: duration,
        offset: 0,
        color: "#f59e0b",
        volumeDB: 0,
        fadeIn: 0,
        fadeOut: 0,
      };

      get().addClip(trackId, clip);

      // Register clip with backend for playback
      await nativeBridge.addPlaybackClip(
        trackId,
        filePath,
        projectRange.start,
        duration,
        0, 0, 0, 0,
        clip.id,
        clip.pitchCorrectionSourceFilePath,
        clip.pitchCorrectionSourceOffset,
      );

      set({ metronomeTrackId: trackId, isModified: true });
    },

    removeMetronomeTrack: async () => {
      const { metronomeTrackId } = get();
      if (!metronomeTrackId) return;

      await get().removeTrack(metronomeTrackId);
      set({ metronomeTrackId: null });
    },

    setProjectRange: (start, end) => {
      const newStart = Math.max(0, start);
      const newEnd = Math.max(start, end);
      set({
        projectRange: { start: newStart, end: newEnd },
        isModified: true,
      });
      // Sync loop region when loop is active and range is valid
      if (get().transport.loopEnabled && newEnd > newStart) {
        set((state) => ({
          transport: {
            ...state.transport,
            loopStart: newStart,
            loopEnd: newEnd,
          },
        }));
      }
      // Regenerate metronome track if it exists
      if (get().metronomeTrackId) {
        get().generateMetronomeTrack();
      }
    },

    tapTempo: () => {
      const now = performance.now();
      const { tapTimestamps } = get();

      // Add new timestamp
      const newTimestamps = [...tapTimestamps, now];

      // Keep only last 8 taps
      const MAX_TAPS = 8;
      if (newTimestamps.length > MAX_TAPS) {
        newTimestamps.shift();
      }

      // Calculate BPM if we have at least 2 taps
      if (newTimestamps.length >= 2) {
        // Calculate intervals between taps
        const intervals: number[] = [];
        for (let i = 1; i < newTimestamps.length; i++) {
          intervals.push(newTimestamps[i] - newTimestamps[i - 1]);
        }

        // Calculate average interval in milliseconds
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

        // Convert to BPM (60000 ms per minute)
        const bpm = Math.round(60000 / avgInterval);

        // Clamp BPM to reasonable range (40-240)
        const clampedBpm = Math.max(40, Math.min(240, bpm));

        // Update tempo
        set({ tapTimestamps: newTimestamps });
        get().setTempo(clampedBpm);
      } else {
        // Just store the timestamp
        set({ tapTimestamps: newTimestamps });
      }

      // Reset tap timestamps after 2 seconds of inactivity
      setTimeout(() => {
        const { tapTimestamps: currentTaps } = get();
        if (currentTaps.length > 0 && performance.now() - currentTaps[currentTaps.length - 1] > 2000) {
          set({ tapTimestamps: [] });
        }
      }, 2000);
    },


});
