// @ts-nocheck
import { nativeBridge } from "../../services/NativeBridge";
import { commandManager } from "../commands";
import { logBridgeError } from "../../utils/bridgeErrorHandler";

// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetFn = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetFn = () => any;

export const routingActions = (set: SetFn, get: GetFn) => ({
    storePluginState: async (trackId, fxIndex, slot, isInputFX) => {
      const key = `${trackId}-${fxIndex}`;
      const storeFn = slot === "a" ? nativeBridge.storePluginStateA : nativeBridge.storePluginStateB;
      try {
        const success = await storeFn.call(nativeBridge, trackId, fxIndex, isInputFX);
        if (success) {
          set((s) => ({
            pluginABStates: {
              ...s.pluginABStates,
              [key]: {
                ...s.pluginABStates[key],
                [slot]: "stored",
                active: s.pluginABStates[key]?.active || "a",
              },
            },
          }));
        }
      } catch (e) {
        console.error("[Store] Failed to store plugin state:", e);
      }
    },

    recallPluginState: async (trackId, fxIndex, slot, isInputFX) => {
      const key = `${trackId}-${fxIndex}`;
      const recallFn = slot === "a" ? nativeBridge.recallPluginStateA : nativeBridge.recallPluginStateB;
      try {
        const success = await recallFn.call(nativeBridge, trackId, fxIndex, isInputFX);
        if (success) {
          set((s) => ({
            pluginABStates: {
              ...s.pluginABStates,
              [key]: {
                ...s.pluginABStates[key],
                active: slot,
              },
            },
          }));
        }
      } catch (e) {
        console.error("[Store] Failed to recall plugin state:", e);
      }
    },

    togglePluginAB: async (trackId, fxIndex, isInputFX) => {
      const key = `${trackId}-${fxIndex}`;
      const current = get().pluginABStates[key];
      const currentSlot = current?.active || "a";
      const targetSlot = currentSlot === "a" ? "b" : "a";

      // First store the current state into the current slot
      const storeFn = currentSlot === "a" ? nativeBridge.storePluginStateA : nativeBridge.storePluginStateB;
      await storeFn.call(nativeBridge, trackId, fxIndex, isInputFX);

      // Then recall the target slot
      const recallFn = targetSlot === "a" ? nativeBridge.recallPluginStateA : nativeBridge.recallPluginStateB;
      const success = await recallFn.call(nativeBridge, trackId, fxIndex, isInputFX);

      if (success) {
        set((s) => ({
          pluginABStates: {
            ...s.pluginABStates,
            [key]: {
              ...s.pluginABStates[key],
              [currentSlot]: "stored",
              active: targetSlot,
            },
          },
        }));
      }
    },

    // ========== FX Chain Presets ==========
    saveFXChainPreset: async (trackId, name, chainType) => {
      try {
        let fxSlots: Array<{ name: string; pluginPath?: string }> = [];
        if (chainType === "master") {
          fxSlots = await nativeBridge.getMasterFX();
        } else if (chainType === "input") {
          fxSlots = await nativeBridge.getTrackInputFX(trackId);
        } else {
          fxSlots = await nativeBridge.getTrackFX(trackId);
        }

        const preset = {
          name,
          plugins: fxSlots.map((fx) => ({
            pluginId: fx.pluginPath || fx.name,
          })),
        };

        set((s) => ({
          fxChainPresets: [...s.fxChainPresets, preset],
          isModified: true,
        }));

        get().showToast(`FX chain preset "${name}" saved`, "success");
      } catch (e) {
        console.error("[Store] Failed to save FX chain preset:", e);
        get().showToast("Failed to save FX chain preset", "error");
      }
    },

    loadFXChainPreset: async (trackId, presetIndex, chainType) => {
      const { fxChainPresets, showToast } = get();
      const preset = fxChainPresets[presetIndex];
      if (!preset) return;

      try {
        // First, remove all existing FX from the chain
        let currentFx: Array<{ index: number }> = [];
        if (chainType === "master") {
          currentFx = await nativeBridge.getMasterFX();
        } else if (chainType === "input") {
          currentFx = await nativeBridge.getTrackInputFX(trackId);
        } else {
          currentFx = await nativeBridge.getTrackFX(trackId);
        }

        // Remove in reverse order so indices stay valid
        for (let i = currentFx.length - 1; i >= 0; i--) {
          if (chainType === "master") {
            await nativeBridge.removeMasterFX(currentFx[i].index);
          } else if (chainType === "input") {
            await nativeBridge.removeTrackInputFX(trackId, currentFx[i].index);
          } else {
            await nativeBridge.removeTrackFX(trackId, currentFx[i].index);
          }
        }

        // Add each plugin from the preset
        for (const plugin of preset.plugins) {
          if (chainType === "master") {
            await nativeBridge.addMasterFX(plugin.pluginId);
          } else if (chainType === "input") {
            await nativeBridge.addTrackInputFX(trackId, plugin.pluginId);
          } else {
            await nativeBridge.addTrackFX(trackId, plugin.pluginId);
          }
        }

        showToast(`Loaded FX chain preset "${preset.name}"`, "success");
      } catch (e) {
        console.error("[Store] Failed to load FX chain preset:", e);
        showToast("Failed to load FX chain preset", "error");
      }
    },

    deleteFXChainPreset: (index) => {
      set((s) => ({
        fxChainPresets: s.fxChainPresets.filter((_, i) => i !== index),
        isModified: true,
      }));
    },

    // Sprint 20: Metering + Analysis + Project
    toggleLoudnessMeter: () =>
      set((s) => ({ showLoudnessMeter: !s.showLoudnessMeter })),

    togglePhaseCorrelation: () =>
      set((s) => ({ showPhaseCorrelation: !s.showPhaseCorrelation })),

    toggleProjectTemplates: () =>
      set((s) => ({ showProjectTemplates: !s.showProjectTemplates })),

    archiveSession: async () => {
      const { projectPath, showToast } = get();
      if (!projectPath) {
        showToast("Save the project first before archiving.", "info");
        return;
      }
      try {
        const zipPath = projectPath.replace(/\.(osproj|s13)$/i, "") + "_archive.zip";
        const success = await nativeBridge.archiveSession(projectPath, zipPath);
        if (success) {
          showToast(`Session archived to ${zipPath}`, "success");
        } else {
          showToast("Archive failed.", "error");
        }
      } catch {
        showToast("Archive not available.", "error");
      }
    },

    // Sprint 21: Timeline Interaction
    setTrackWaveformZoom: (trackId, zoom) => {
      const clamped = Math.max(0.1, Math.min(5.0, zoom));
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, waveformZoom: clamped } : t,
        ),
      }));
    },

    toggleSpectralView: (trackId: string) => {
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId ? { ...t, spectralView: !t.spectralView } : t,
        ),
      }));
    },

    toggleCrosshair: () =>
      set((s) => ({ showCrosshair: !s.showCrosshair })),

    slipEditClip: (clipId, newOffset) => {
      const state = get();

      // Find the clip and its old offset
      let oldOffset: number | null = null;
      for (const track of state.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          oldOffset = clip.offset;
          break;
        }
      }
      if (oldOffset === null || oldOffset === newOffset) return;

      const capturedOldOffset = oldOffset;
      const command: Command = {
        type: "SLIP_EDIT_CLIP",
        description: "Slip edit clip",
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId
                  ? { ...clip, offset: newOffset }
                  : clip,
              ),
            })),
          }));
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === clipId
                  ? { ...clip, offset: capturedOldOffset }
                  : clip,
              ),
            })),
          }));
        },
      };

      commandManager.execute(command);
      set({
        canUndo: commandManager.canUndo(),
        canRedo: commandManager.canRedo(),
        isModified: true,
      });
    },


    saveMixerSnapshot: (name: string) => {
      const state = get();
      const snapshot: MixerSnapshot = {
        name,
        timestamp: Date.now(),
        tracks: state.tracks.map((t) => ({
          id: t.id,
          volume: t.volumeDB,
          pan: t.pan,
          mute: t.muted,
          solo: t.soloed,
        })),
      };
      set((s) => {
        const updated = [...s.mixerSnapshots, snapshot];
        localStorage.setItem("s13_mixerSnapshots", JSON.stringify(updated));
        return { mixerSnapshots: updated, isModified: true };
      });
      get().showToast(`Mixer snapshot "${name}" saved`, "success");
    },

    recallMixerSnapshot: (index: number) => {
      const state = get();
      const snapshot = state.mixerSnapshots[index];
      if (!snapshot) return;

      // Capture old state for undo
      const oldTrackStates = state.tracks.map((t) => ({
        id: t.id,
        volumeDB: t.volumeDB,
        volume: t.volume,
        pan: t.pan,
        muted: t.muted,
        soloed: t.soloed,
      }));

      const command: Command = {
        type: "RECALL_MIXER_SNAPSHOT",
        description: `Recall mixer snapshot "${snapshot.name}"`,
        timestamp: Date.now(),
        execute: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const saved = snapshot.tracks.find((st) => st.id === t.id);
              if (!saved) return t;
              const volume = saved.volume <= -60 ? 0 : Math.pow(10, saved.volume / 20);
              return {
                ...t,
                volumeDB: saved.volume,
                volume,
                pan: saved.pan,
                muted: saved.mute,
                soloed: saved.solo,
              };
            }),
          }));
          // Sync to backend
          for (const saved of snapshot.tracks) {
            nativeBridge.setTrackVolume(saved.id, saved.volume).catch(() => {});
            nativeBridge.setTrackPan(saved.id, saved.pan).catch(() => {});
            nativeBridge.setTrackMute(saved.id, saved.mute).catch(() => {});
            nativeBridge.setTrackSolo(saved.id, saved.solo).catch(() => {});
          }
        },
        undo: () => {
          set((s) => ({
            tracks: s.tracks.map((t) => {
              const old = oldTrackStates.find((ot) => ot.id === t.id);
              if (!old) return t;
              return {
                ...t,
                volumeDB: old.volumeDB,
                volume: old.volume,
                pan: old.pan,
                muted: old.muted,
                soloed: old.soloed,
              };
            }),
          }));
          // Sync old state to backend
          for (const old of oldTrackStates) {
            nativeBridge.setTrackVolume(old.id, old.volumeDB).catch(() => {});
            nativeBridge.setTrackPan(old.id, old.pan).catch(() => {});
            nativeBridge.setTrackMute(old.id, old.muted).catch(() => {});
            nativeBridge.setTrackSolo(old.id, old.soloed).catch(() => {});
          }
        },
      };

      commandManager.execute(command);
      set({ canUndo: commandManager.canUndo(), canRedo: commandManager.canRedo() });
      get().showToast(`Recalled mixer snapshot "${snapshot.name}"`, "success");
    },

    deleteMixerSnapshot: (index: number) => {
      set((s) => {
        const updated = s.mixerSnapshots.filter((_, i) => i !== index);
        localStorage.setItem("s13_mixerSnapshots", JSON.stringify(updated));
        return { mixerSnapshots: updated };
      });
    },

});
