import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";

interface SharedTransportSyncOptions {
  interpolate?: boolean;
}

export function startSharedTransportSync(options: SharedTransportSyncOptions = {}): () => void {
  const interpolate = options.interpolate !== false;
  let frameId = 0;
  let lastFrameTime = performance.now();

  const unsubscribeTransport = nativeBridge.onTransportUpdate((data) => {
    const state = useDAWStore.getState();
    const backendPos = Math.max(0, Number(data.position) || 0);
    const frontendPos = state.transport.currentTime;
    const drift = Math.abs(backendPos - frontendPos);
    const backendPlaying = Boolean(data.isPlaying);
    const frontendPlaying = state.transport.isPlaying;

    if (backendPlaying !== frontendPlaying || (!backendPlaying && drift > 0.001) || drift > 0.03) {
      useDAWStore.setState((current) => ({
        transport: {
          ...current.transport,
          isPlaying: backendPlaying,
          isPaused: false,
          isRecording: backendPlaying ? current.transport.isRecording : false,
          currentTime: backendPos,
        },
      }));
    }
  });

  const tick = () => {
    const now = performance.now();
    const dt = Math.max(0, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const state = useDAWStore.getState();
    if (state.transport.isPlaying) {
      let nextTime = state.transport.currentTime + dt;
      const { loopEnabled, loopStart, loopEnd } = state.transport;
      if (loopEnabled && loopEnd > loopStart && nextTime >= loopEnd) {
        nextTime = loopStart + (nextTime - loopEnd);
      }
      state.setCurrentTime(nextTime);
    }

    frameId = window.requestAnimationFrame(tick);
  };

  if (interpolate) {
    frameId = window.requestAnimationFrame(tick);
  }

  return () => {
    unsubscribeTransport();
    if (frameId) {
      window.cancelAnimationFrame(frameId);
    }
  };
}
