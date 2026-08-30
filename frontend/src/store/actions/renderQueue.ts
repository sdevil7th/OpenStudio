import { nativeBridge } from "../../services/NativeBridge";
import { joinNativePath } from "../../utils/nativePath";
import { prepareForManualRender } from "../../utils/renderPreparation";
import {
  reserveUniqueRenderPath,
  resolveRenderWildcards,
  type RenderWildcardContext,
} from "../../utils/renderJobPlanning";
import type { Region, RenderJob, Track } from "../useDAWStore";

type TrackReference = Pick<Track, "id" | "name">;
type RazorReference = { trackId: string; start: number; end: number };
type RenderRange = { start: number; end: number; name?: string };
type PlannedRender = {
  source: string;
  startTime: number;
  endTime: number;
  filePath: string;
};
type RenderQueueState = {
  renderQueue: RenderJob[];
  tracks: TrackReference[];
  regions: Region[];
  selectedTrackIds: string[];
  selectedClipIds: string[];
  selectedRegionIds: string[];
  razorEdits: RazorReference[];
  syncClipsWithBackend: () => Promise<void>;
  ditherType: "none" | "tpdf" | "shaped";
  secondaryOutputFormat: string;
  projectName: string;
  showRenderQueue: boolean;
};
type RenderQueueUpdate = Partial<
  Pick<RenderQueueState, "renderQueue" | "showRenderQueue">
>;
type SetFn = (
  update: RenderQueueUpdate
    | ((state: RenderQueueState) => RenderQueueUpdate),
) => void;
type GetFn = () => RenderQueueState;

const isLossyFormat = (format: string) => format === "mp3" || format === "ogg";

export const renderQueueActions = (set: SetFn, get: GetFn) => ({
  addToRenderQueue: (options: RenderJob["options"]) => {
    set((state) => ({
      renderQueue: [
        ...state.renderQueue,
        { id: crypto.randomUUID(), options, status: "pending" },
      ],
    }));
  },

  removeFromRenderQueue: (jobId: string) => {
    set((state) => ({
      renderQueue: state.renderQueue.filter((job) => job.id !== jobId),
    }));
  },

  clearRenderQueue: () => set({ renderQueue: [] }),

  executeRenderQueue: async () => {
    const queue = get().renderQueue.filter((job) => job.status === "pending");
    for (const job of queue) {
      set((state) => ({
        renderQueue: state.renderQueue.map((candidate) =>
          candidate.id === job.id
            ? { ...candidate, status: "rendering" as const, error: undefined }
            : candidate,
        ),
      }));

      try {
        await prepareForManualRender(get().syncClipsWithBackend, "render-queue");
        const options = job.options;
        if (!options.directory || !options.fileName) {
          throw new Error("The queued render has no output directory or file name.");
        }
        if (options.endTime <= options.startTime
            && options.bounds !== "project_regions"
            && options.bounds !== "selected_regions"
            && options.source !== "razor") {
          throw new Error("The queued render range is invalid.");
        }
        if (options.secondaryOutputEnabled
            && options.secondaryOutputFormat === options.format) {
          throw new Error("Secondary output must use a different format from the primary output.");
        }

        const currentState = get();
        const tracks = options.tracks ?? currentState.tracks.map(({ id, name }) => ({ id, name }));
        const regions = options.regions ?? currentState.regions;
        const selectedRegionIds = options.selectedRegionIds ?? currentState.selectedRegionIds;
        const ranges: RenderRange[] = options.bounds === "project_regions" && regions.length > 0
          ? regions.map((region) => ({
              start: region.startTime,
              end: region.endTime,
              name: region.name,
            }))
          : options.bounds === "selected_regions"
            ? regions
                .filter((region) => selectedRegionIds.includes(region.id))
                .map((region) => ({
                  start: region.startTime,
                  end: region.endTime,
                  name: region.name,
                }))
            : [{ start: options.startTime, end: options.endTime }];
        if (ranges.length === 0) {
          throw new Error("The queued render no longer has any selected regions.");
        }

        const reservedPaths = new Set<string>();
        const renderDate = new Date();
        const outputPath = (
          context: RenderWildcardContext,
          suffix: string,
          format: string = options.format,
        ) => {
          const desired = joinNativePath(
            options.directory,
            `${resolveRenderWildcards(options.fileName, {
              projectName: options.projectName ?? currentState.projectName,
              ...context,
            }, renderDate)}.${format}`,
          );
          return reserveUniqueRenderPath(desired, suffix, reservedPaths);
        };

        const plannedRenders: PlannedRender[] = [];
        if (options.source === "razor") {
          const razorEdits = options.razorEdits ?? currentState.razorEdits;
          if (razorEdits.length === 0) {
            throw new Error("The queued render has no razor edit areas.");
          }
          razorEdits.forEach((razor, index) => {
            const track = tracks.find((candidate) => candidate.id === razor.trackId);
            plannedRenders.push({
              source: `stem:${razor.trackId}`,
              startTime: razor.start,
              endTime: razor.end,
              filePath: outputPath(
                { trackName: track?.name, index: index + 1 },
                `${track?.name || "track"}-${index + 1}`,
              ),
            });
          });
        } else {
          ranges.forEach((range, rangeIndex) => {
            const regionContext = range.name ? { regionName: range.name } : {};
            if (options.source === "stems") {
              plannedRenders.push({
                source: "master",
                startTime: range.start,
                endTime: range.end,
                filePath: outputPath(
                  { index: 0, ...regionContext },
                  range.name ? `${range.name}-master-${rangeIndex + 1}` : "master",
                ),
              });
              tracks.forEach((track, index) => {
                plannedRenders.push({
                  source: `stem:${track.id}`,
                  startTime: range.start,
                  endTime: range.end,
                  filePath: outputPath(
                    { trackName: track.name, index: index + 1, ...regionContext },
                    `${track.name}-${index + 1}${range.name ? `-${range.name}-${rangeIndex + 1}` : ""}`,
                  ),
                });
              });
            } else if (options.source === "selected_tracks") {
              const selectedTracks = tracks.filter((track) =>
                (options.selectedTrackIds ?? currentState.selectedTrackIds).includes(track.id),
              );
              if (selectedTracks.length === 0) {
                throw new Error("The queued render has no selected tracks.");
              }
              selectedTracks.forEach((track, index) => {
                plannedRenders.push({
                  source: `stem:${track.id}`,
                  startTime: range.start,
                  endTime: range.end,
                  filePath: outputPath(
                    { trackName: track.name, index: index + 1, ...regionContext },
                    `${track.name}-${index + 1}${range.name ? `-${range.name}-${rangeIndex + 1}` : ""}`,
                  ),
                });
              });
            } else {
              plannedRenders.push({
                source: options.source,
                startTime: range.start,
                endTime: range.end,
                filePath: outputPath(
                  regionContext,
                  range.name ? `${range.name}-${rangeIndex + 1}` : "master",
                ),
              });
            }
          });
        }

        const renderOne = async (
          plan: PlannedRender,
          format: string,
          bitDepth: number,
        ) => {
          const params = {
            source: plan.source,
            startTime: plan.startTime,
            endTime: plan.endTime,
            filePath: plan.filePath,
            format,
            sampleRate: options.sampleRate,
            bitDepth,
            channels: options.channels === "mono" ? 1 : 2,
            normalize: options.normalize,
            addTail: options.addTail,
            tailLength: options.tailLength,
            includeMetronome: false,
            includedClipIds: plan.source === "selected_items"
                || plan.source === "selected_items_master"
              ? options.selectedClipIds ?? currentState.selectedClipIds
              : [],
          };
          if ((plan.source === "selected_items" || plan.source === "selected_items_master")
              && params.includedClipIds.length === 0) {
            throw new Error("The queued selected-item render has no clip selection snapshot.");
          }

          const shouldDither = options.dither && !isLossyFormat(format) && bitDepth !== 32;
          const success = shouldDither
            ? await nativeBridge.renderProjectWithDither({
                ...params,
                ditherType: (options.ditherType ?? currentState.ditherType) === "shaped" ? "shaped" : "tpdf",
              })
            : await nativeBridge.renderProject(params);
          if (!success) {
            throw new Error(`Audio engine rejected ${plan.source} output "${plan.filePath}".`);
          }
        };

        const primaryBitDepth = options.format === "mp3"
          ? options.mp3Bitrate
          : options.format === "ogg"
            ? options.oggQuality
            : options.bitDepth;
        for (const plan of plannedRenders) {
          await renderOne(plan, options.format, primaryBitDepth);
          if (options.secondaryOutputEnabled) {
            const secondaryFormat = options.secondaryOutputFormat ?? currentState.secondaryOutputFormat;
            const secondaryPath = plan.filePath.replace(/\.[^.]+$/, `.${secondaryFormat}`);
            const secondaryBitDepth = secondaryFormat === "mp3"
              ? options.mp3Bitrate
              : secondaryFormat === "ogg"
                ? options.oggQuality
                : options.secondaryOutputBitDepth ?? options.bitDepth;
            await renderOne(
              { ...plan, filePath: secondaryPath },
              secondaryFormat,
              secondaryBitDepth,
            );
          }
        }

        set((state) => ({
          renderQueue: state.renderQueue.map((candidate) =>
            candidate.id === job.id
              ? { ...candidate, status: "done" as const, error: undefined }
              : candidate,
          ),
        }));
      } catch (error) {
        set((state) => ({
          renderQueue: state.renderQueue.map((candidate) =>
            candidate.id === job.id
              ? { ...candidate, status: "error" as const, error: String(error) }
              : candidate,
          ),
        }));
      }
    }
  },

  toggleRenderQueue: () =>
    set((state) => ({ showRenderQueue: !state.showRenderQueue })),
});
