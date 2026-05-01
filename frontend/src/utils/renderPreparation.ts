import { nativeBridge } from "../services/NativeBridge";
import { usePitchEditorStore } from "../store/pitchEditorStore";

const PITCH_RENDER_BUSY_STATES = new Set([
  "queued",
  "processing",
  "preview_processing",
  "final_processing",
]);

export async function waitForPitchEditorRenderReady(timeoutMs = 120000): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const state = usePitchEditorStore.getState();
    if (!state.clipId || !PITCH_RENDER_BUSY_STATES.has(state.applyState)) {
      if (state.applyState === "error") {
        throw new Error("Pitch note render failed. Fix the pitch render before exporting.");
      }
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the pitch note render to finish before export.");
}

export async function clearPitchEditorTransientPreviewsForRender(): Promise<void> {
  const { clipId } = usePitchEditorStore.getState();
  await nativeBridge.clearPitchPreviewRoutesForCorrectedSources().catch(() => 0);
  if (!clipId) return;
  await Promise.allSettled([
    nativeBridge.clearAllPitchPreviewRoutes(clipId),
  ]);
}

export async function prepareForManualRender(
  syncClipsWithBackend: () => Promise<void>,
  label = "manual-render",
): Promise<void> {
  console.log(`[render.preflight] ${label}: waiting for pitch renders`);
  await waitForPitchEditorRenderReady();
  console.log(`[render.preflight] ${label}: clearing transient preview routes`);
  await clearPitchEditorTransientPreviewsForRender();
  console.log(`[render.preflight] ${label}: syncing backend clips`);
  await syncClipsWithBackend();
  await nativeBridge.clearPitchPreviewRoutesForCorrectedSources().catch(() => 0);
  console.log(`[render.preflight] ${label}: ready`);
}
