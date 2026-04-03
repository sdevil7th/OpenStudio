// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const renderQueueActions = (set: SetFn, get: GetFn) => ({
    addToRenderQueue: (options) => {
      set((s) => ({
        renderQueue: [
          ...s.renderQueue,
          { id: crypto.randomUUID(), options, status: "pending" },
        ],
      }));
    },
    removeFromRenderQueue: (jobId) => {
      set((s) => ({
        renderQueue: s.renderQueue.filter((j) => j.id !== jobId),
      }));
    },
    clearRenderQueue: () => set({ renderQueue: [] }),
    executeRenderQueue: async () => {
      const queue = get().renderQueue.filter((j) => j.status === "pending");
      for (const job of queue) {
        set((s) => ({
          renderQueue: s.renderQueue.map((j) =>
            j.id === job.id ? { ...j, status: "rendering" as const } : j
          ),
        }));
        try {
          await get().syncClipsWithBackend();
          await nativeBridge.renderProject({
            source: job.options.source,
            startTime: job.options.startTime,
            endTime: job.options.endTime,
            filePath: `${job.options.directory}/${job.options.fileName}.${job.options.format}`,
            format: job.options.format,
            sampleRate: job.options.sampleRate,
            bitDepth: job.options.bitDepth,
            channels: job.options.channels === "mono" ? 1 : 2,
            normalize: job.options.normalize,
            addTail: job.options.addTail,
            tailLength: job.options.tailLength,
          });
          set((s) => ({
            renderQueue: s.renderQueue.map((j) =>
              j.id === job.id ? { ...j, status: "done" as const } : j
            ),
          }));
        } catch (err) {
          set((s) => ({
            renderQueue: s.renderQueue.map((j) =>
              j.id === job.id
                ? { ...j, status: "error" as const, error: String(err) }
                : j
            ),
          }));
        }
      }
    },
    toggleRenderQueue: () =>
      set((s) => ({ showRenderQueue: !s.showRenderQueue })),

});
