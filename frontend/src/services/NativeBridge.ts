// Type definitions for the JUCE backend

// Waveform visualization data type
export interface ChannelPeak {
  min: number;
  max: number;
}

export interface WaveformPeak {
  channels: ChannelPeak[]; // Per-channel peak data
}

declare global {
  interface Window {
    __JUCE__?: {
      backend: {
        // Native functions registered via withNativeFunction
        addTrack?: (explicitId?: string) => Promise<string>;
        removeTrack?: (trackId: string) => Promise<boolean>;
        reorderTrack?: (
          trackId: string,
          newPosition: number,
        ) => Promise<boolean>;
        getAudioDeviceSetup?: () => Promise<any>;
        setAudioDeviceSetup?: (config: any) => Promise<boolean>;

        // Track Control (Phase 1)
        setTrackRecordArm?: (
          trackId: string,
          armed: boolean,
        ) => Promise<boolean>;
        setTrackInputMonitoring?: (
          trackId: string,
          enabled: boolean,
        ) => Promise<boolean>;
        setTrackInputChannels?: (
          trackId: string,
          startChannel: number,
          numChannels: number,
        ) => Promise<boolean>;

        // Volume/Pan/Mute/Solo (Phase 1)
        setTrackVolume?: (
          trackId: string,
          volumeDB: number,
        ) => Promise<boolean>;
        setTrackPan?: (trackId: string, pan: number) => Promise<boolean>;
        setTrackMute?: (trackId: string, muted: boolean) => Promise<boolean>;
        setTrackSolo?: (trackId: string, soloed: boolean) => Promise<boolean>;

        // Transport (Phase 2)
        setTransportPlaying?: (playing: boolean) => Promise<boolean>;
        setTransportRecording?: (recording: boolean) => Promise<boolean>;
        setTempo?: (bpm: number) => Promise<boolean>;
        getTempo?: () => Promise<number>;
        getTransportPosition?: () => Promise<number>;
        setTransportPosition?: (seconds: number) => Promise<boolean>;

        // Metronome & Time Signature (Phase 3)
        setMetronomeEnabled?: (enabled: boolean) => Promise<boolean>;
        setMetronomeVolume?: (volume: number) => Promise<boolean>;
        isMetronomeEnabled?: () => Promise<boolean>;
        setTimeSignature?: (
          numerator: number,
          denominator: number,
        ) => Promise<boolean>;
        getTimeSignature?: () => Promise<{
          numerator: number;
          denominator: number;
        }>;
        setMetronomeAccentBeats?: (accentBeats: boolean[]) => Promise<boolean>;

        // Recording
        getLastCompletedClips?: () => Promise<
          Array<{
            trackId: string;
            filePath: string;
            startTime: number;
            duration: number;
          }>
        >;
        // Live recording waveform - returns peaks for recording in progress
        getRecordingPeaks?: (
          trackId: string,
          samplesPerPixel: number,
          numPixels: number,
        ) => Promise<WaveformPeak[]>;

        // FX Management (Phase 3)
        scanForPlugins?: () => Promise<boolean>;
        getAvailablePlugins?: () => Promise<any[]>;
        addTrackInputFX?: (
          trackId: string,
          pluginPath: string,
        ) => Promise<boolean>;
        addTrackFX?: (trackId: string, pluginPath: string) => Promise<boolean>;
        openPluginEditor?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<boolean>;
        closePluginEditor?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<boolean>;

        // Metering (Phase 4)
        getMeterLevels?: () => Promise<number[]>;
        getMasterLevel?: () => Promise<number>;

        // Master (Phase 5)
        addMasterFX?: (pluginPath: string) => Promise<boolean>;
        setMasterVolume?: (volume: number) => Promise<boolean>;
        setMasterPan?: (pan: number) => Promise<boolean>;
        getMasterPan?: () => Promise<number>;

        // Waveform Visualization
        getWaveformPeaks?: (
          filePath: string,
          samplesPerPixel: number,
          numPixels: number,
        ) => Promise<WaveformPeak[]>;

        // Playback clip management
        addPlaybackClip?: (
          trackId: string,
          filePath: string,
          startTime: number,
          duration: number,
        ) => Promise<boolean>;
        removePlaybackClip?: (
          trackId: string,
          filePath: string,
        ) => Promise<boolean>;
        clearPlaybackClips?: () => Promise<boolean>;

        // FX Chain Management
        getTrackInputFX?: (trackId: string) => Promise<any[]>;
        getTrackFX?: (trackId: string) => Promise<any[]>;
        removeTrackInputFX?: (
          trackId: string,
          fxIndex: number,
        ) => Promise<boolean>;
        removeTrackFX?: (trackId: string, fxIndex: number) => Promise<boolean>;
        bypassTrackInputFX?: (
          trackId: string,
          fxIndex: number,
          bypassed: boolean,
        ) => Promise<boolean>;
        bypassTrackFX?: (
          trackId: string,
          fxIndex: number,
          bypassed: boolean,
        ) => Promise<boolean>;
        reorderTrackInputFX?: (
          trackId: string,
          fromIndex: number,
          toIndex: number,
        ) => Promise<boolean>;
        reorderTrackFX?: (
          trackId: string,
          fromIndex: number,
          toIndex: number,
        ) => Promise<boolean>;

        // MIDI Device Management (Phase 2)
        getMIDIInputDevices?: () => Promise<string[]>;
        openMIDIDevice?: (deviceName: string) => Promise<boolean>;
        closeMIDIDevice?: (deviceName: string) => Promise<boolean>;
        getOpenMIDIDevices?: () => Promise<string[]>;

        // Track Type Management (Phase 2)
        setTrackType?: (
          trackId: string,
          type: "audio" | "midi" | "instrument",
        ) => Promise<boolean>;
        setTrackMIDIInput?: (
          trackId: string,
          deviceName: string,
          channel: number,
        ) => Promise<boolean>;
        loadInstrument?: (trackId: string, vstPath: string) => Promise<boolean>;

        // Project Save/Load (F2)
        showSaveDialog?: (
          defaultPath?: string,
          title?: string,
        ) => Promise<string>;
        showOpenDialog?: (title?: string) => Promise<string>;
        saveProjectToFile?: (
          filePath: string,
          jsonContent: string,
        ) => Promise<boolean>;
        loadProjectFromFile?: (filePath: string) => Promise<string>;

        // Plugin State Serialization (F2)
        getPluginState?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
        ) => Promise<string>;
        setPluginState?: (
          trackId: string,
          fxIndex: number,
          isInputFX: boolean,
          base64State: string,
        ) => Promise<boolean>;
        getMasterPluginState?: (fxIndex: number) => Promise<string>;
        setMasterPluginState?: (
          fxIndex: number,
          base64State: string,
        ) => Promise<boolean>;

        // MIDI
        sendMidiNote?: (
          trackId: string,
          note: number,
          velocity: number,
          isNoteOn: boolean,
        ) => Promise<void>;

        // Media Import (F10)
        importMediaFile?: (filePath: string) => Promise<{
          filePath: string;
          duration: number;
          sampleRate: number;
          numChannels: number;
          format: string;
        }>;

        // Event system
        addEventListener?: (
          eventId: string,
          callback: (data: any) => void,
        ) => string;
        removeEventListener?: (token: string) => void;
        emitEvent?: (eventId: string, data: any) => void;
      };
    };
  }
}

class NativeBridge {
  private isNative: boolean;
  private eventListeners: Map<string, Set<(data: any) => void>> = new Map();

  constructor() {
    this.isNative = typeof window.__JUCE__ !== "undefined";
    if (this.isNative) {
      console.log("NativeBridge: JUCE Object found.");

      // Debugging: Alert the available keys to see what we are working with
      const juce = window.__JUCE__;
      const backend = juce?.backend;
      if (backend) {
        const keys = Object.keys(backend);
        console.log("NativeBridge: Backend keys:", keys);
        console.log("NativeBridge: Functions available:", {
          addTrack: typeof backend.addTrack,
          removeTrack: typeof backend.removeTrack,
          getAudioDeviceSetup: typeof backend.getAudioDeviceSetup,
          addEventListener: typeof backend.addEventListener,
        });

        // CRITICAL: If no functions are exposed, alert
        if (!backend.addTrack && !backend.getAudioDeviceSetup) {
          alert(
            "CRITICAL: Native functions NOT exposed!\nOnly keys: " +
              JSON.stringify(keys) +
              "\n\nFalling back to MOCK data!",
          );
        }
      } else {
        alert("CRITICAL ERROR: window.__JUCE__.backend is missing!");
      }
    } else {
      console.log(
        "NativeBridge: Running in browser mode (no JUCE), using mock data",
      );
    }
  }

  // Set callback for meter update events from C++
  onMeterUpdate(
    callback: (data: {
      trackLevels: number[];
      masterLevel: number;
      timestamp: number;
    }) => void,
  ) {
    if (!this.isNative || !window.__JUCE__?.backend?.addEventListener) return;

    window.__JUCE__.backend.addEventListener("meterUpdate", (data: any) => {
      callback(data);
    });
  }

  // CORRECTED: Call native functions directly as methods
  async addTrack(explicitId?: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.addTrack) {
      if (explicitId) {
        return await window.__JUCE__.backend.addTrack(explicitId);
      } else {
        return await window.__JUCE__.backend.addTrack();
      }
    } else {
      const id =
        explicitId || "Mock_Track_" + Math.random().toString(36).substr(2, 9);
      console.log("Mock: addTrack", id);
      return id;
    }
  }

  async removeTrack(trackId: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeTrack) {
      return await window.__JUCE__.backend.removeTrack(trackId);
    } else {
      console.log("Mock: removeTrack", trackId);
      return true;
    }
  }

  async reorderTrack(trackId: string, newPosition: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.reorderTrack) {
      return await window.__JUCE__.backend.reorderTrack(trackId, newPosition);
    } else {
      console.log("Mock: reorderTrack", trackId, newPosition);
      return true;
    }
  }

  async getAudioDeviceSetup(): Promise<any> {
    console.log(
      "[NativeBridge] getAudioDeviceSetup called, isNative:",
      this.isNative,
    );
    console.log(
      "[NativeBridge] window.__JUCE__?.backend.getAudioDeviceSetup exists:",
      typeof window.__JUCE__?.backend.getAudioDeviceSetup,
    );

    if (this.isNative && window.__JUCE__?.backend.getAudioDeviceSetup) {
      try {
        console.log("[NativeBridge] Calling backend.getAudioDeviceSetup()...");
        const result = await window.__JUCE__.backend.getAudioDeviceSetup();
        console.log("[NativeBridge] Got result:", result);
        return result;
      } catch (error) {
        console.error(
          "[NativeBridge] Error calling getAudioDeviceSetup:",
          error,
        );
        throw error;
      }
    } else {
      console.log("[NativeBridge] Using mock data");
      // Mock Data
      return {
        current: {
          audioDeviceType: "Mock",
          inputDevice: "Mock In",
          outputDevice: "Mock Out",
          sampleRate: 44100,
          bufferSize: 512,
        },
        availableTypes: ["Mock", "ASIO", "WASAPI"],
        inputs: ["Mock In", "Mic 1"],
        outputs: ["Mock Out", "Speakers"],
        sampleRates: [44100, 48000],
        bufferSizes: [256, 512, 1024],
      };
    }
  }

  async setAudioDeviceSetup(config: any): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setAudioDeviceSetup) {
      return await window.__JUCE__.backend.setAudioDeviceSetup(config);
    } else {
      console.log("Mock: setAudioDeviceSetup", config);
      return true;
    }
  }

  // Track Control (Phase 1)
  // Track Control (Phase 1)
  async setTrackRecordArm(trackId: string, armed: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackRecordArm) {
      return await window.__JUCE__.backend.setTrackRecordArm(trackId, armed);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackRecordArm: track ${trackId}, armed: ${armed}`,
      );
      return true;
    }
  }

  async setTrackInputMonitoring(
    trackId: string,
    enabled: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackInputMonitoring) {
      return await window.__JUCE__.backend.setTrackInputMonitoring(
        trackId,
        enabled,
      );
    } else {
      console.log(
        `[NativeBridge] Mock setTrackInputMonitoring: track ${trackId}, enabled: ${enabled}`,
      );
      return true;
    }
  }

  async setTrackInputChannels(
    trackId: string,
    startChannel: number,
    numChannels: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackInputChannels) {
      return await window.__JUCE__.backend.setTrackInputChannels(
        trackId,
        startChannel,
        numChannels,
      );
    } else {
      console.log(
        `[NativeBridge] Mock setTrackInputChannels: track ${trackId}, ${startChannel}-${startChannel + numChannels - 1}`,
      );
      return true;
    }
  }

  // Volume/Pan/Mute/Solo (Phase 1)
  // Volume/Pan/Mute/Solo (Phase 1)
  async setTrackVolume(trackId: string, volumeDB: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackVolume) {
      return await window.__JUCE__.backend.setTrackVolume(trackId, volumeDB);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackVolume: track ${trackId}, ${volumeDB} dB`,
      );
      return true;
    }
  }

  async setTrackPan(trackId: string, pan: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackPan) {
      return await window.__JUCE__.backend.setTrackPan(trackId, pan);
    } else {
      console.log(`[NativeBridge] Mock setTrackPan: track ${trackId}, ${pan}`);
      return true;
    }
  }

  async setTrackMute(trackId: string, muted: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackMute) {
      return await window.__JUCE__.backend.setTrackMute(trackId, muted);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackMute: track ${trackId}, ${muted}`,
      );
      return true;
    }
  }

  async setTrackSolo(trackId: string, soloed: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackSolo) {
      return await window.__JUCE__.backend.setTrackSolo(trackId, soloed);
    } else {
      console.log(
        `[NativeBridge] Mock setTrackSolo: track ${trackId}, ${soloed}`,
      );
      return true;
    }
  }

  // Transport Control (Phase 2)
  async setTransportPlaying(playing: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTransportPlaying) {
      return await window.__JUCE__.backend.setTransportPlaying(playing);
    } else {
      console.log(`[NativeBridge] Mock setTransportPlaying: ${playing}`);
      return true;
    }
  }

  async setTransportRecording(recording: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTransportRecording) {
      return await window.__JUCE__.backend.setTransportRecording(recording);
    } else {
      console.log(`[NativeBridge] Mock setTransportRecording: ${recording}`);
      return true;
    }
  }

  async setTempo(bpm: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTempo) {
      return await window.__JUCE__.backend.setTempo(bpm);
    } else {
      console.log(`[NativeBridge] Mock setTempo: ${bpm} BPM`);
      return true;
    }
  }

  async getTempo(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getTempo) {
      return await window.__JUCE__.backend.getTempo();
    } else {
      return 120;
    }
  }

  async getTransportPosition(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getTransportPosition) {
      return await window.__JUCE__.backend.getTransportPosition();
    } else {
      return 0;
    }
  }

  async setTransportPosition(seconds: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTransportPosition) {
      return await window.__JUCE__.backend.setTransportPosition(seconds);
    } else {
      console.log(`[NativeBridge] Mock setTransportPosition: ${seconds}s`);
      return true;
    }
  }

  // Metronome & Time Signature (Phase 3)
  async setMetronomeEnabled(enabled: boolean): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeEnabled) {
      return await window.__JUCE__.backend.setMetronomeEnabled(enabled);
    }
    return false;
  }

  async setMetronomeVolume(volume: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeVolume) {
      return await window.__JUCE__.backend.setMetronomeVolume(volume);
    }
    return false;
  }

  async isMetronomeEnabled(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.isMetronomeEnabled) {
      return await window.__JUCE__.backend.isMetronomeEnabled();
    }
    return false;
  }

  async setTimeSignature(
    numerator: number,
    denominator: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTimeSignature) {
      return await window.__JUCE__.backend.setTimeSignature(
        numerator,
        denominator,
      );
    }
    return false;
  }

  async getTimeSignature(): Promise<{
    numerator: number;
    denominator: number;
  }> {
    if (this.isNative && window.__JUCE__?.backend.getTimeSignature) {
      return await window.__JUCE__.backend.getTimeSignature();
    }
    return { numerator: 4, denominator: 4 };
  }

  async setMetronomeAccentBeats(accentBeats: boolean[]): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMetronomeAccentBeats) {
      return await window.__JUCE__.backend.setMetronomeAccentBeats(accentBeats);
    }
    console.log("[NativeBridge] Mock setMetronomeAccentBeats:", accentBeats);
    return true;
  }

  // Recording
  async getLastCompletedClips(): Promise<
    Array<{
      trackId: string;
      filePath: string;
      startTime: number;
      duration: number;
    }>
  > {
    if (this.isNative && window.__JUCE__?.backend.getLastCompletedClips) {
      return await window.__JUCE__.backend.getLastCompletedClips();
    }
    return [];
  }

  // Live recording waveform - get peaks for recording in progress
  async getRecordingPeaks(
    trackId: string,
    samplesPerPixel: number,
    numPixels: number,
  ): Promise<WaveformPeak[]> {
    if (this.isNative && window.__JUCE__?.backend.getRecordingPeaks) {
      return await window.__JUCE__.backend.getRecordingPeaks(
        trackId,
        samplesPerPixel,
        numPixels,
      );
    } else {
      // Mock: generate fake live recording waveform data
      const peaks: WaveformPeak[] = [];
      for (let i = 0; i < numPixels; i++) {
        // Simulate recording waveform with some randomness
        const amplitude = 0.3 + Math.random() * 0.4;
        peaks.push({
          channels: [
            { min: -amplitude, max: amplitude },
            { min: -amplitude * 0.9, max: amplitude * 0.9 },
          ],
        });
      }
      return peaks;
    }
  }

  // FX Management (Phase 3)
  async scanForPlugins(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.scanForPlugins) {
      return await window.__JUCE__.backend.scanForPlugins();
    } else {
      console.log("[NativeBridge] Mock scanForPlugins");
      return true;
    }
  }

  async getAvailablePlugins(): Promise<any[]> {
    if (this.isNative && window.__JUCE__?.backend.getAvailablePlugins) {
      return await window.__JUCE__.backend.getAvailablePlugins();
    } else {
      console.log("[NativeBridge] Mock getAvailablePlugins");
      return [
        {
          name: "Mock Compressor",
          manufacturer: "Mock Audio",
          category: "Dynamics",
          fileOrIdentifier: "/mock/comp.vst3",
        },
        {
          name: "Mock Reverb",
          manufacturer: "Mock FX",
          category: "Reverb",
          fileOrIdentifier: "/mock/reverb.vst3",
        },
      ];
    }
  }

  async addTrackInputFX(trackId: string, pluginPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addTrackInputFX) {
      return await window.__JUCE__.backend.addTrackInputFX(trackId, pluginPath);
    } else {
      console.log(
        `[NativeBridge] Mock addTrackInputFX: track ${trackId}, plugin ${pluginPath}`,
      );
      return true;
    }
  }

  async addTrackFX(trackId: string, pluginPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addTrackFX) {
      return await window.__JUCE__.backend.addTrackFX(trackId, pluginPath);
    } else {
      console.log(
        `[NativeBridge] Mock addTrackFX: track ${trackId}, plugin ${pluginPath}`,
      );
      return true;
    }
  }

  async openPluginEditor(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openPluginEditor) {
      return await window.__JUCE__.backend.openPluginEditor(
        trackId,
        fxIndex,
        isInputFX,
      );
    } else {
      console.log(
        `[NativeBridge] Mock openPluginEditor: track ${trackId}, fx ${fxIndex}, isInput: ${isInputFX}`,
      );
      return true;
    }
  }

  async closePluginEditor(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.closePluginEditor) {
      return await window.__JUCE__.backend.closePluginEditor(
        trackId,
        fxIndex,
        isInputFX,
      );
    } else {
      console.log(
        `[NativeBridge] Mock closePluginEditor: track ${trackId}, fx ${fxIndex}`,
      );
      return true;
    }
  }

  // Metering (Phase 4)
  async getMeterLevels(): Promise<number[]> {
    if (this.isNative && window.__JUCE__?.backend.getMeterLevels) {
      return await window.__JUCE__.backend.getMeterLevels();
    } else {
      // Mock: return random levels for testing
      return [Math.random() * 0.5, Math.random() * 0.5, Math.random() * 0.5];
    }
  }

  async getMasterLevel(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getMasterLevel) {
      return await window.__JUCE__.backend.getMasterLevel();
    } else {
      // Mock: return random level
      return Math.random() * 0.5;
    }
  }

  // Master & Monitoring (Phase 5)
  async addMasterFX(pluginPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addMasterFX) {
      return await window.__JUCE__.backend.addMasterFX(pluginPath);
    } else {
      console.log(`[NativeBridge] Mock addMasterFX: ${pluginPath}`);
      return true;
    }
  }

  async setMasterVolume(volume: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterVolume) {
      return await window.__JUCE__.backend.setMasterVolume(volume);
    } else {
      console.log(`[NativeBridge] Mock setMasterVolume: ${volume}`);
      return true;
    }
  }

  async setMasterPan(pan: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterPan) {
      return await window.__JUCE__.backend.setMasterPan(pan);
    } else {
      console.log(`[NativeBridge] Mock setMasterPan: ${pan}`);
      return true;
    }
  }

  async getMasterPan(): Promise<number> {
    if (this.isNative && window.__JUCE__?.backend.getMasterPan) {
      return await window.__JUCE__.backend.getMasterPan();
    } else {
      return 0.0;
    }
  }

  // Waveform Visualization
  async getWaveformPeaks(
    filePath: string,
    samplesPerPixel: number,
    numPixels: number,
  ): Promise<WaveformPeak[]> {
    if (this.isNative && window.__JUCE__?.backend.getWaveformPeaks) {
      return await window.__JUCE__.backend.getWaveformPeaks(
        filePath,
        samplesPerPixel,
        numPixels,
      );
    } else {
      // Mock: generate fake waveform data for testing
      const peaks: WaveformPeak[] = [];
      for (let i = 0; i < numPixels; i++) {
        const amplitude = Math.sin(i * 0.1) * 0.5 + Math.random() * 0.3;
        peaks.push({
          channels: [
            { min: -amplitude, max: amplitude }, // Left channel
            { min: -amplitude * 0.8, max: amplitude * 0.8 }, // Right channel (slightly different)
          ],
        });
      }
      return peaks;
    }
  }

  // Playback clip management
  // Playback clip management
  async addPlaybackClip(
    trackId: string,
    filePath: string,
    startTime: number,
    duration: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.addPlaybackClip) {
      return await window.__JUCE__.backend.addPlaybackClip(
        trackId,
        filePath,
        startTime,
        duration,
      );
    }
    return false;
  }

  async removePlaybackClip(
    trackId: string,
    filePath: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removePlaybackClip) {
      return await window.__JUCE__.backend.removePlaybackClip(
        trackId,
        filePath,
      );
    }
    return false;
  }

  async clearPlaybackClips(): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.clearPlaybackClips) {
      return await window.__JUCE__.backend.clearPlaybackClips();
    }
    return false;
  }

  // MIDI Device Management (Phase 2)
  async getMIDIInputDevices(): Promise<string[]> {
    if (this.isNative && window.__JUCE__?.backend.getMIDIInputDevices) {
      return await window.__JUCE__.backend.getMIDIInputDevices();
    }
    return [];
  }

  async openMIDIDevice(deviceName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.openMIDIDevice) {
      return await window.__JUCE__.backend.openMIDIDevice(deviceName);
    }
    return false;
  }

  async closeMIDIDevice(deviceName: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.closeMIDIDevice) {
      return await window.__JUCE__.backend.closeMIDIDevice(deviceName);
    }
    return false;
  }

  async getOpenMIDIDevices(): Promise<string[]> {
    if (this.isNative && window.__JUCE__?.backend.getOpenMIDIDevices) {
      return await window.__JUCE__.backend.getOpenMIDIDevices();
    }
    return [];
  }

  // Track Type Management (Phase 2)
  // Track Type Management (Phase 2)
  async setTrackType(
    trackId: string,
    type: "audio" | "midi" | "instrument",
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackType) {
      return await window.__JUCE__.backend.setTrackType(trackId, type);
    }
    return false;
  }

  async setTrackMIDIInput(
    trackId: string,
    deviceName: string,
    channel: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setTrackMIDIInput) {
      return await window.__JUCE__.backend.setTrackMIDIInput(
        trackId,
        deviceName,
        channel,
      );
    }
    return false;
  }

  async loadInstrument(trackId: string, vstPath: string): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.loadInstrument) {
      return await window.__JUCE__.backend.loadInstrument(trackId, vstPath);
    }
    return false;
  }

  // Project Save/Load (F2)
  async showSaveDialog(defaultPath?: string, title?: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.showSaveDialog) {
      return await window.__JUCE__.backend.showSaveDialog(defaultPath, title);
    }
    console.log("[NativeBridge] Mock showSaveDialog");
    return "";
  }

  async showOpenDialog(title?: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.showOpenDialog) {
      return await window.__JUCE__.backend.showOpenDialog(title);
    }
    console.log("[NativeBridge] Mock showOpenDialog");
    return "";
  }

  async saveProjectToFile(
    filePath: string,
    jsonContent: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.saveProjectToFile) {
      return await window.__JUCE__.backend.saveProjectToFile(
        filePath,
        jsonContent,
      );
    }
    console.log(
      `[NativeBridge] Mock saveProjectToFile: ${filePath} (${jsonContent.length} bytes)`,
    );
    return true;
  }

  async loadProjectFromFile(filePath: string): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.loadProjectFromFile) {
      return await window.__JUCE__.backend.loadProjectFromFile(filePath);
    }
    console.log(`[NativeBridge] Mock loadProjectFromFile: ${filePath}`);
    return "";
  }

  // Render/Export (F3)
  async renderProject(options: {
    source: string;
    startTime: number;
    endTime: number;
    filePath: string;
    format: string;
    sampleRate: number;
    bitDepth: number;
    channels: number;
    normalize: boolean;
    addTail: boolean;
    tailLength: number;
  }): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.renderProject) {
      return await window.__JUCE__.backend.renderProject(
        options.source,
        options.startTime,
        options.endTime,
        options.filePath,
        options.format,
        options.sampleRate,
        options.bitDepth,
        options.channels,
        options.normalize,
        options.addTail,
        options.tailLength
      );
    }
    console.log(
      `[NativeBridge] Mock renderProject: ${options.filePath} (${options.format}, ${options.startTime}-${options.endTime}s)`,
    );
    // Simulate render progress
    return new Promise((resolve) => {
      setTimeout(() => resolve(true), 2000);
    });
  }

  // MIDI
  async sendMidiNote(
    trackId: string,
    note: number,
    velocity: number,
    isNoteOn: boolean
  ): Promise<void> {
    if (this.isNative && window.__JUCE__?.backend.sendMidiNote) {
      await window.__JUCE__.backend.sendMidiNote(
        trackId,
        note,
        velocity,
        isNoteOn
      );
      return;
    }
    console.log(
      `[NativeBridge] Mock sendMidiNote: track=${trackId}, note=${note}, velocity=${velocity}, on=${isNoteOn}`,
    );
  }

  // Media Import (F10)
  async importMediaFile(filePath: string): Promise<{
    filePath: string;
    duration: number;
    sampleRate: number;
    numChannels: number;
    format: string;
  }> {
    if (this.isNative && window.__JUCE__?.backend.importMediaFile) {
      return await window.__JUCE__.backend.importMediaFile(filePath);
    }
    console.log(`[NativeBridge] Mock importMediaFile: ${filePath}`);
    // Mock: return fake audio file metadata
    return {
      filePath: filePath,
      duration: 30.5,
      sampleRate: 44100,
      numChannels: 2,
      format: filePath.endsWith('.wav') ? 'WAV' :
              filePath.endsWith('.mp3') ? 'MP3' :
              filePath.endsWith('.mp4') ? 'MP4' : 'Unknown',
    };
  }

  // Plugin State Management (F2)
  async getPluginState(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
  ): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getPluginState) {
      return await window.__JUCE__.backend.getPluginState(
        trackId,
        fxIndex,
        isInputFX,
      );
    }
    // Mock state
    return "";
  }

  async setPluginState(
    trackId: string,
    fxIndex: number,
    isInputFX: boolean,
    base64State: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setPluginState) {
      return await window.__JUCE__.backend.setPluginState(
        trackId,
        fxIndex,
        isInputFX,
        base64State,
      );
    }
    return true;
  }

  async getMasterPluginState(fxIndex: number): Promise<string> {
    if (this.isNative && window.__JUCE__?.backend.getMasterPluginState) {
      return await window.__JUCE__.backend.getMasterPluginState(fxIndex);
    }
    return "";
  }

  async setMasterPluginState(
    fxIndex: number,
    base64State: string,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.setMasterPluginState) {
      return await window.__JUCE__.backend.setMasterPluginState(
        fxIndex,
        base64State,
      );
    }
    return true;
  }

  // FX Chain Management
  // FX Chain Management
  async getTrackInputFX(trackId: string): Promise<any[]> {
    if (this.isNative && window.__JUCE__?.backend.getTrackInputFX) {
      return await window.__JUCE__.backend.getTrackInputFX(trackId);
    }
    return [];
  }

  async getTrackFX(trackId: string): Promise<any[]> {
    if (this.isNative && window.__JUCE__?.backend.getTrackFX) {
      return await window.__JUCE__.backend.getTrackFX(trackId);
    }
    return [];
  }

  async removeTrackInputFX(trackId: string, fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeTrackInputFX) {
      return await window.__JUCE__.backend.removeTrackInputFX(trackId, fxIndex);
    }
    return false;
  }

  async removeTrackFX(trackId: string, fxIndex: number): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.removeTrackFX) {
      return await window.__JUCE__.backend.removeTrackFX(trackId, fxIndex);
    }
    return false;
  }

  async bypassTrackInputFX(
    trackId: string,
    fxIndex: number,
    bypassed: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.bypassTrackInputFX) {
      return await window.__JUCE__.backend.bypassTrackInputFX(
        trackId,
        fxIndex,
        bypassed,
      );
    }
    return false;
  }

  async bypassTrackFX(
    trackId: string,
    fxIndex: number,
    bypassed: boolean,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.bypassTrackFX) {
      return await window.__JUCE__.backend.bypassTrackFX(
        trackId,
        fxIndex,
        bypassed,
      );
    }
    return false;
  }

  async reorderTrackInputFX(
    trackId: string,
    fromIndex: number,
    toIndex: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.reorderTrackInputFX) {
      return await window.__JUCE__.backend.reorderTrackInputFX(
        trackId,
        fromIndex,
        toIndex,
      );
    }
    console.log(
      `[NativeBridge] Mock reorderTrackInputFX: track ${trackId}, from ${fromIndex} to ${toIndex}`,
    );
    return true;
  }

  async reorderTrackFX(
    trackId: string,
    fromIndex: number,
    toIndex: number,
  ): Promise<boolean> {
    if (this.isNative && window.__JUCE__?.backend.reorderTrackFX) {
      return await window.__JUCE__.backend.reorderTrackFX(
        trackId,
        fromIndex,
        toIndex,
      );
    }
    console.log(
      `[NativeBridge] Mock reorderTrackFX: track ${trackId}, from ${fromIndex} to ${toIndex}`,
    );
    return true;
  }

  // Event subscription
  subscribe(eventId: string, callback: (data: any) => void): () => void {
    if (this.isNative && window.__JUCE__?.backend.addEventListener) {
      const token = window.__JUCE__.backend.addEventListener(eventId, callback);
      return () => {
        if (window.__JUCE__?.backend.removeEventListener) {
          window.__JUCE__.backend.removeEventListener(token);
        }
      };
    } else {
      // Mock subscription
      if (!this.eventListeners.has(eventId)) {
        this.eventListeners.set(eventId, new Set());
      }
      this.eventListeners.get(eventId)!.add(callback);
      return () => {
        this.eventListeners.get(eventId)?.delete(callback);
      };
    }
  }
}

export const nativeBridge = new NativeBridge();
