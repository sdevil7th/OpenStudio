import type { AudioDeviceDraft, AudioDeviceSetupResponse } from "../services/NativeBridge";

export const wasapiModes = [
  { value: "Windows Audio", label: "Shared" },
  { value: "Windows Audio (Exclusive Mode)", label: "Exclusive" },
  { value: "Windows Audio (Low Latency Mode)", label: "Shared Low Latency" },
];
export const isWasapiType = (type: string) => wasapiModes.some((mode) => mode.value === type);

export const audioDeviceDraft = (current: AudioDeviceDraft): AudioDeviceDraft => ({
  audioDeviceType: current.audioDeviceType,
  inputDevice: current.inputDevice,
  outputDevice: current.outputDevice,
  sampleRate: current.sampleRate,
  bufferSize: current.bufferSize,
});

interface SettingsState {
  setup: AudioDeviceSetupResponse | null;
  applied: AudioDeviceSetupResponse | null;
  loading: boolean;
  resolving: boolean;
  error: string | null;
}

/** Owns one modal session. Only the latest revision may publish async results. */
export class AudioSettingsSession {
  private revision = 0;
  private listeners = new Set<() => void>();
  private state: SettingsState = { setup: null, applied: null, loading: false, resolving: false, error: null };

  constructor(private query: (draft: AudioDeviceDraft) => Promise<AudioDeviceSetupResponse>) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: Partial<SettingsState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }
  invalidate = () => { ++this.revision; };
  setError = (error: string | null) => this.publish({ error });

  async load(read: () => Promise<AudioDeviceSetupResponse>) {
    const revision = ++this.revision;
    this.publish({ setup: null, loading: true, resolving: false, error: null });
    try {
      const setup = await read();
      if (revision !== this.revision) return;
      this.publish({ setup, applied: setup, loading: false });
    } catch (error) {
      if (revision === this.revision)
        this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  acceptApplied(setup: AudioDeviceSetupResponse, preserveDraft = false) {
    ++this.revision;
    this.publish({ applied: setup, setup: preserveDraft ? this.state.setup : setup, error: null, resolving: false });
  }

  async select(change: Partial<AudioDeviceDraft>) {
    if (!this.state.setup) return;
    const revision = ++this.revision;
    const current = { ...this.state.setup.current, ...change };
    const deviceChanged = (["audioDeviceType", "inputDevice", "outputDevice"] as const)
      .some((key) => change[key] !== undefined && change[key] !== this.state.setup!.current[key]);
    if (deviceChanged) {
      current.sampleRate = change.sampleRate ?? 0;
      current.bufferSize = change.bufferSize ?? 0;
    }
    this.publish({ setup: { ...this.state.setup, current, adjustments: [] }, resolving: true, error: null });
    try {
      const setup = await this.query(audioDeviceDraft(current));
      if (revision !== this.revision) return;
      this.publish({ setup, resolving: false, error: setup.error || null });
    } catch (error) {
      if (revision === this.revision)
        this.publish({ resolving: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
