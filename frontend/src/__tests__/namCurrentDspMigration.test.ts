// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CURRENT_NAM_EFFECTS_DSP_VERSION,
  CURRENT_NAM_REVERB_ENGINE_VERSION,
  isCurrentNAMRackPresetState,
  migrateLegacyNAMRackPresetDspState,
} from "../utils/namRackPresetTransactions";
import {
  normalizeNAMEffectsDspVersion,
  sanitizeNAMRackDspState,
  sanitizeNAMRackPortableDspState,
} from "../utils/namPortableState";

describe("current-only NAM Rack DSP migration", () => {
  it("canonicalizes every recognized effects and reverb marker to the current engines", () => {
    expect(CURRENT_NAM_EFFECTS_DSP_VERSION).toBe(11);
    expect(CURRENT_NAM_REVERB_ENGINE_VERSION).toBe(5);
    for (const legacyVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      expect(normalizeNAMEffectsDspVersion(legacyVersion)).toBe(11);
      expect(sanitizeNAMRackDspState({
        namEffectsDspVersion: legacyVersion,
        reverbEngineVersion: Math.min(legacyVersion, 5),
      })).toEqual({
        namEffectsDspVersion: 11,
        reverbEngineVersion: 5,
      });
    }
    expect(normalizeNAMEffectsDspVersion(0)).toBeUndefined();
    expect(normalizeNAMEffectsDspVersion(12)).toBeUndefined();
  });

  it("migrates a complete legacy tone without retaining obsolete pedal voices", () => {
    expect(migrateLegacyNAMRackPresetDspState({
      schemaVersion: 1,
      values: {
        precisionDriveEnabled: 0,
        precisionDriveVolumeDb: 0,
        precisionDriveDrive: 0.57,
        chaosDrive: 0.83,
        chaosTone: 0.41,
        chaosLevelDb: 2.5,
      },
      dspState: {
        reverbEngineVersion: 3,
        namEffectsDspVersion: 2,
      },
    }, { completePreset: true })).toMatchObject({
      schemaVersion: 1,
      values: {
        precisionDriveEnabled: 0,
        precisionDriveVolumeDb: 9,
        precisionDriveBright: 0.55,
        precisionDriveAttack: 0.5,
        precisionDriveGate: 0,
        precisionDriveDrive: 0.57,
        chaosEnabled: 0,
        chaosMode: 0,
        chaosWeight: 0.5,
        chaosDrive: 0.83,
        chaosTone: 0.41,
        chaosGate: 0.22,
        chaosMix: 1,
        chaosLevelDb: 2.5,
      },
      dspState: {
        reverbEngineVersion: 5,
        namEffectsDspVersion: 11,
      },
    });
  });

  it("preserves an explicit nonzero Precision Volume while filling absent current controls", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { precisionDriveVolumeDb: -1.75 },
      dspState: { namEffectsDspVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number>; dspState: Record<string, number> };
    expect(migrated.values.precisionDriveVolumeDb).toBe(-1.75);
    expect(migrated.values.chaosMode).toBe(0);
    expect(migrated.values.chaosWeight).toBe(0.5);
    expect(migrated.values.chaosGate).toBe(0.22);
    expect(migrated.dspState).toMatchObject({
      reverbEngineVersion: 5,
      namEffectsDspVersion: 11,
    });
  });

  it("maps the retired Detail macro to its exact V6 Punch timing and removes it", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        compressorDetail: 0.25,
        compressorToneDb: 2,
      },
      dspState: { namEffectsDspVersion: 6, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number>; dspState: Record<string, number> };

    expect(migrated.values.compressorAttackMs).toBeCloseTo(34.5, 6);
    expect(migrated.values.compressorReleaseMs).toBeCloseTo(94.5, 6);
    expect(migrated.values.compressorToneDb).toBe(2);
    expect(migrated.values).not.toHaveProperty("compressorDetail");
    expect(migrated.dspState.namEffectsDspVersion).toBe(11);
  });

  it("treats missing or unrecognized complete-preset markers as migration inputs", () => {
    for (const namEffectsDspVersion of [undefined, 0, 12]) {
      const migrated = migrateLegacyNAMRackPresetDspState({
        values: { precisionDriveVolumeDb: 0 },
        dspState: namEffectsDspVersion === undefined
          ? {}
          : { namEffectsDspVersion },
      }, { completePreset: true }) as {
        values: Record<string, number>;
        dspState: Record<string, number>;
      };
      expect(migrated.values.precisionDriveVolumeDb).toBe(9);
      expect(migrated.dspState).toMatchObject({
        namEffectsDspVersion: 11,
        reverbEngineVersion: 5,
      });
    }
  });

  it("preserves Instrument Profile from V8+ and Reverb Voice from V9+ through V11", () => {
    for (const sourceVersion of [9, 10, 11]) {
      const migrated = migrateLegacyNAMRackPresetDspState({
        values: { instrumentProfile: 1, reverbVoice: 3, delayMode: 2 },
        dspState: { namEffectsDspVersion: sourceVersion, reverbEngineVersion: 5 },
      }, { completePreset: true }) as { values: Record<string, number>; dspState: Record<string, number> };
      expect(migrated.values).toMatchObject({ instrumentProfile: 1, reverbVoice: 3, delayMode: 2 });
      expect(migrated.dspState.namEffectsDspVersion).toBe(11);
    }

    const v8 = migrateLegacyNAMRackPresetDspState({
      values: { instrumentProfile: 1, reverbVoice: 3 },
      dspState: { namEffectsDspVersion: 8, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(v8.values).toMatchObject({ instrumentProfile: 1, reverbVoice: 0 });

    for (const invalidVersion of [undefined, 7, 12]) {
      const migrated = migrateLegacyNAMRackPresetDspState({
        values: { instrumentProfile: 1, reverbVoice: 3, delayMode: 4 },
        dspState: invalidVersion === undefined ? {} : { namEffectsDspVersion: invalidVersion },
      }, { completePreset: true }) as { values: Record<string, number> };
      expect(migrated.values).toMatchObject({
        instrumentProfile: 0,
        reverbVoice: 0,
        delayMode: invalidVersion === 7 ? 2 : 1,
      });
    }
  });

  it("preserves V10+ Multi and Dual delay selectors across the routing-only V11 migration", () => {
    for (const sourceVersion of [10, 11]) {
      const migrated = migrateLegacyNAMRackPresetDspState({
        values: { delayMode: 4 },
        dspState: { namEffectsDspVersion: sourceVersion, reverbEngineVersion: 5 },
      }, { completePreset: true }) as { values: Record<string, number> };
      expect(migrated.values.delayMode).toBe(4);
    }
  });

  it("fills the current state contract for every version-sensitive rack component", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        compressorMix: 0.37,
        tapeEchoFeedback: 0.41,
        octaverDownMix: 0.73,
        chorusDepth: 0.64,
        delayTimeMs: 515,
        reverbDecaySec: 6.25,
        reverbCharacter: 2,
        reverbFreeze: 1,
      },
      dspState: { namEffectsDspVersion: 1, reverbEngineVersion: 1 },
    }, { completePreset: true }) as { values: Record<string, number> };

    expect(migrated.values).toMatchObject({
      compressorEnabled: 0,
      compressorAttackMs: 21.9,
      compressorReleaseMs: 149.1,
      compressorToneDb: 0,
      compressorSidechainHPF: 1,
      compressorMix: 0.37,
      compressorVolumeDb: 0,
      compressorComp: 0.35,
      tapeEchoEnabled: 0,
      tapeEchoMix: 0.28,
      tapeEchoTimeMs: 360,
      tapeEchoFeedback: 0.41,
      tapeEchoMod: 0.18,
      tapeEchoTone: 0.58,
      octaverEnabled: 0,
      octaverDownMix: 0.73,
      octaverUpMix: 0.18,
      octaverDirectMix: 1,
      cabRoomEnabled: 0,
      cabRoomAmount: 0.22,
      cabRoomWidth: 0.65,
      cabDoublerEnabled: 0,
      cabDoublerMix: 0.12,
      cabDoublerSpread: 0.65,
      modulatorEnabled: 0,
      chorusMix: 0.3,
      chorusRateHz: 0.75,
      chorusDepth: 0.64,
      chorusCharacter: 1,
      modulatorMode: 0,
      modulatorFeedback: 0.1,
      modulatorAutoRandom: 0,
      modulatorAutoSpeed: 0.35,
      modulatorPedalMode: 1,
      modulatorPedalPosition: 0.5,
      delayEnabled: 0,
      delayMix: 0.22,
      delayTimeMs: 515,
      delayFeedback: 0.22,
      delayMod: 0.18,
      delayDucker: 0.12,
      delayMode: 1,
      delayPingPong: 1,
      delayTempoSync: 0,
      reverbEnabled: 0,
      reverbVoice: 0,
      reverbMix: 0.28,
      reverbDecaySec: 6.25,
      reverbTone: 0.62,
      reverbPreDelayMs: 18,
      reverbLowCutHz: 120,
      reverbShimmer: 0,
    });
    expect(migrated.values).not.toHaveProperty("reverbCharacter");
    expect(migrated.values).not.toHaveProperty("reverbFreeze");
    expect(migrated.values).not.toHaveProperty("inputMode");
  });

  it("derives legacy Cabinet Space power once and preserves explicit bypassed settings", () => {
    const legacyActive = migrateLegacyNAMRackPresetDspState({
      values: { cabRoomAmount: 0.41, cabDoublerMix: 0.24 },
      dspState: { namEffectsDspVersion: 8, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(legacyActive.values).toMatchObject({
      cabRoomEnabled: 1,
      cabRoomAmount: 0.41,
      cabDoublerEnabled: 1,
      cabDoublerMix: 0.24,
    });

    const explicitBypass = migrateLegacyNAMRackPresetDspState({
      values: {
        cabRoomEnabled: 0,
        cabRoomAmount: 0.73,
        cabDoublerEnabled: 0,
        cabDoublerMix: 0.61,
      },
      dspState: { namEffectsDspVersion: 8, reverbEngineVersion: 4 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(explicitBypass.values).toMatchObject({
      cabRoomEnabled: 0,
      cabRoomAmount: 0.73,
      cabDoublerEnabled: 0,
      cabDoublerMix: 0.61,
    });
    expect(migrateLegacyNAMRackPresetDspState(
      explicitBypass,
      { completePreset: true },
    )).toEqual(explicitBypass);

    expect(migrateLegacyNAMRackPresetDspState({
      values: { cabRoomAmount: 0.41 },
      dspState: { namEffectsDspVersion: 6 },
    })).toEqual({
      values: { cabRoomAmount: 0.41 },
      dspState: {
        namEffectsDspVersion: 11,
        reverbEngineVersion: 5,
      },
    });
  });

  it("maps the retired Precision distortion toggle before applying current defaults", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: {
        precisionDriveEnabled: 1,
        precisionDriveMode: 1,
        precisionDriveDrive: 0.81,
        precisionDriveBright: 0.63,
      },
      dspState: { namEffectsDspVersion: 2 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(migrated.values).toMatchObject({
      precisionDriveEnabled: 0,
      precisionDriveVolumeDb: 9,
      chaosEnabled: 1,
      chaosMode: 0,
      chaosDrive: 0.81,
      chaosTone: 0.63,
      chaosGate: 0.22,
      chaosMix: 1,
      chaosLevelDb: 0,
    });
    expect(migrated.values).not.toHaveProperty("precisionDriveMode");
  });

  it("preserves explicit Distortion gate and Mix values while defaulting only absent controls", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { chaosEnabled: 1, chaosGate: 0, chaosMix: 0 },
      dspState: { namEffectsDspVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(migrated.values.chaosGate).toBe(0);
    expect(migrated.values.chaosMix).toBe(0);

    const absent = migrateLegacyNAMRackPresetDspState({
      values: { chaosEnabled: 1 },
      dspState: { namEffectsDspVersion: 5 },
    }, { completePreset: true }) as { values: Record<string, number> };
    expect(absent.values.chaosGate).toBe(0.22);
    expect(absent.values.chaosMix).toBe(1);
  });

  it("migrates complete nested baseline and A/B snapshots", () => {
    const migrated = migrateLegacyNAMRackPresetDspState({
      values: { auditionSource: 1, inputMode: 2 },
      uiState: {
        namPresetBaseline: {
          values: {
            auditionSource: 1,
            inputMode: 0,
            precisionDriveMode: 1,
            precisionDriveEnabled: 1,
            cabRoomAmount: 0.41,
          },
          dspState: { namEffectsDspVersion: 2 },
        },
        namRackCompare: {
          snapshots: {
            A: {
              values: { auditionSource: 1, inputMode: 2, precisionDriveVolumeDb: 0, cabDoublerMix: 0.24 },
              dspState: {},
            },
          },
        },
      },
    }, { completePreset: true }) as any;
    expect(migrated.values).not.toHaveProperty("auditionSource");
    expect(migrated.values).not.toHaveProperty("inputMode");
    expect(migrated.uiState.namPresetBaseline.values).toMatchObject({
      precisionDriveEnabled: 0,
      precisionDriveVolumeDb: 9,
      chaosEnabled: 1,
      chaosGate: 0.22,
      chaosLevelDb: 0,
      cabRoomEnabled: 1,
      cabRoomAmount: 0.41,
    });
    expect(migrated.uiState.namPresetBaseline.values).not.toHaveProperty("precisionDriveMode");
    expect(migrated.uiState.namPresetBaseline.values).not.toHaveProperty("auditionSource");
    expect(migrated.uiState.namPresetBaseline.values).not.toHaveProperty("inputMode");
    expect(migrated.uiState.namRackCompare.snapshots.A.dspState).toEqual({
      namEffectsDspVersion: 11,
      reverbEngineVersion: 5,
    });
    expect(migrated.uiState.namRackCompare.snapshots.A.values).toMatchObject({
      cabRoomEnabled: 0,
      cabDoublerEnabled: 1,
      cabDoublerMix: 0.24,
    });
    expect(migrated.uiState.namRackCompare.snapshots.A.values).not.toHaveProperty("auditionSource");
    expect(migrated.uiState.namRackCompare.snapshots.A.values).not.toHaveProperty("inputMode");
  });

  it("validates current native readback identities and required migrated controls", () => {
    const completeCurrent = migrateLegacyNAMRackPresetDspState({
      values: { chaosMix: 0 },
      dspState: { namEffectsDspVersion: 11, reverbEngineVersion: 5 },
    }, { completePreset: true });
    expect(isCurrentNAMRackPresetState(completeCurrent)).toBe(true);
    for (const requiredId of [
      "instrumentProfile",
      "reverbVoice",
      "cabRoomEnabled",
      "cabRoomAmount",
      "cabRoomWidth",
      "cabDoublerEnabled",
      "cabDoublerMix",
      "cabDoublerSpread",
      "delayMix",
      "delayTimeMs",
      "delayFeedback",
      "delayMod",
      "delayDucker",
      "delayMode",
      "delayPingPong",
      "delayTempoSync",
      "delayEnabled",
    ]) {
      const completeValues = (completeCurrent as { values: Record<string, number> }).values;
      const { [requiredId]: _removed, ...incompleteValues } = completeValues;
      expect(isCurrentNAMRackPresetState({
        ...(completeCurrent as Record<string, unknown>),
        values: incompleteValues,
      })).toBe(false);
    }
    expect(isCurrentNAMRackPresetState({
      values: {
        precisionDriveVolumeDb: 9,
        chaosMode: 0,
        chaosWeight: 0.5,
        chaosGate: 0.22,
        chaosMix: 1,
      },
      dspState: { namEffectsDspVersion: 11, reverbEngineVersion: 5 },
    })).toBe(false);
    expect(isCurrentNAMRackPresetState({
      values: {
        precisionDriveVolumeDb: 9,
        chaosMode: 0,
        chaosWeight: 0.5,
        chaosMix: 1,
      },
      dspState: { namEffectsDspVersion: 11, reverbEngineVersion: 5 },
    })).toBe(false);
    expect(isCurrentNAMRackPresetState({
      values: { precisionDriveVolumeDb: 9 },
      dspState: { namEffectsDspVersion: 5, reverbEngineVersion: 4 },
    })).toBe(false);
    expect(isCurrentNAMRackPresetState({
      ...(completeCurrent as Record<string, unknown>),
      values: {
        ...((completeCurrent as { values: Record<string, number> }).values),
        reverbFreeze: 1,
      },
    })).toBe(false);
    expect(isCurrentNAMRackPresetState({
      ...(completeCurrent as Record<string, unknown>),
      values: {
        ...((completeCurrent as { values: Record<string, number> }).values),
        inputMode: 2,
      },
    })).toBe(false);
  });

  it("does not invent parameters or selectors for a generic partial patch", () => {
    const partial = { values: { ampMix: 0.5 } };
    expect(sanitizeNAMRackPortableDspState(partial)).toBe(partial);
  });

  it("routes frontend snapshots and backend uiState through the complete ordered migrator", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const compareStart = panelSource.indexOf("function normalizeCompareSnapshot");
    const compareEnd = panelSource.indexOf("function normalizeCompareUiState", compareStart);
    const compareSource = panelSource.slice(compareStart, compareEnd);
    expect(compareSource).toContain("migrateLegacyNAMRackPresetDspState(");
    expect(compareSource).toContain("{ completePreset: true }");
    expect(compareSource.indexOf("migrateLegacyNAMRackPresetDspState("))
      .toBeLessThan(compareSource.indexOf("Object.entries(rawValues)"));

    const engineSource = readFileSync(
      new URL("../../../Source/AudioEngine.cpp", import.meta.url),
      "utf8",
    );
    const setterStart = engineSource.indexOf("bool AudioEngine::setBuiltInPluginState(");
    const setterEnd = engineSource.indexOf("bool AudioEngine::setPluginParameter(", setterStart);
    const setterSource = engineSource.slice(setterStart, setterEnd);
    expect(setterSource).toContain("S13NAMRack::migrateUiStateToCurrent(");
    expect(setterSource).toMatch(
      /migrateUiStateToCurrent\(\s*uiStateVar,\s*storedEffectsVersion\s*\)/,
    );
    expect(setterSource.indexOf("migrateUiStateToCurrent("))
      .toBeLessThan(setterSource.indexOf("rack->setUiStateJSON"));

    const xmlMigratorStart = engineSource.indexOf("static bool migrateXMLNAMRackPresetToCurrent");
    const xmlMigratorEnd = engineSource.indexOf("bool AudioEngine::isNAMRackPlugin", xmlMigratorStart);
    const xmlMigratorSource = engineSource.slice(xmlMigratorStart, xmlMigratorEnd);
    expect(xmlMigratorSource).toContain("S13NAMRack::migratePresetStateToCurrent(");
    expect(xmlMigratorSource).toContain("juce::TemporaryFile temporaryFile(");
    expect(xmlMigratorSource).toContain("overwriteTargetFileWithTemporary()");
    const genericListStart = engineSource.indexOf("juce::var AudioEngine::getPluginPresets(");
    const genericListEnd = engineSource.indexOf("bool AudioEngine::loadPluginPreset(", genericListStart);
    expect(engineSource.slice(genericListStart, genericListEnd)).toContain(
      "migrateXMLNAMRackPresetToCurrent(\n                            file, *xml, stateData, true)",
    );
    const genericLoadStart = genericListEnd;
    const genericLoadEnd = engineSource.indexOf("bool AudioEngine::savePluginPreset(", genericLoadStart);
    const genericLoadSource = engineSource.slice(genericLoadStart, genericLoadEnd);
    expect(genericLoadSource.indexOf("migrateXMLNAMRackPresetToCurrent("))
      .toBeLessThan(genericLoadSource.indexOf("restoreTonePresetStateInformation("));

    const rackSource = readFileSync(
      new URL("../../../Source/BuiltInEffects2.cpp", import.meta.url),
      "utf8",
    );
    const prepareStart = rackSource.indexOf("void S13NAMRack::prepareToPlay");
    const prepareEnd = rackSource.indexOf("void S13NAMRack::syncEmbeddedProcessorParameters", prepareStart);
    const processStart = rackSource.indexOf("void S13NAMRack::processBlock");
    const processEnd = rackSource.indexOf("void S13NAMRack::getStateInformation", processStart);
    const octaverStart = rackSource.indexOf("void S13NAMRack::processDualOctaverStage");
    const octaverEnd = rackSource.indexOf("static bool captureEmbeddedStageDelayedDry", octaverStart);
    expect(rackSource.slice(prepareStart, prepareEnd)).toContain(
      "namEffectsDspVersion.store(\n        currentNAMEffectsDspVersion",
    );
    expect(rackSource.slice(processStart, processEnd)).toContain(
      "reverbEngineVersion.store(\n        static_cast<float>(currentReverbEngineVersion)",
    );
    expect(rackSource.slice(octaverStart, octaverEnd)).not.toContain("namEffectsDspVersion.load");
    expect(rackSource.slice(octaverStart, octaverEnd)).toContain("rackPolyOctaver.processBlock(buffer)");
    expect(rackSource).not.toContain("resetOctaverState");
    expect(rackSource).not.toContain("octaverDetectorGateOpen");
    expect(rackSource.slice(processStart, processEnd)).not.toContain("namEffectsDspVersion.load");
    expect(rackSource.slice(processStart, processEnd)).not.toContain("reverbEngineVersion.load");

    const nativeDefaultsStart = rackSource.indexOf("kCurrentNAMRackComponentDefaults[]");
    const nativeDefaultsEnd = rackSource.indexOf("kRetiredNAMRackValueProperties[]", nativeDefaultsStart);
    const nativeDefaultsSource = rackSource.slice(nativeDefaultsStart, nativeDefaultsEnd);
    for (const id of [
      "compressorComp",
      "compressorAttackMs",
      "compressorReleaseMs",
      "compressorToneDb",
      "compressorSidechainHPF",
      "tapeEchoMod",
      "octaverDirectMix",
      "precisionDriveDrive",
      "chaosGate",
      "chorusCharacter",
      "modulatorPedalPosition",
      "delayTempoSync",
      "reverbLowCutHz",
      "reverbShimmer",
    ]) {
      expect(nativeDefaultsSource).toContain(`{ "${id}",`);
    }
    expect(nativeDefaultsSource).not.toContain('{ "compressorDetail",');
  });

  it("keeps the migrated Best-clean Precision Volume at +9 dB in every scenario", () => {
    const engineSource = readFileSync(
      new URL("../../../Source/AudioEngine.cpp", import.meta.url),
      "utf8",
    );
    const configureStart = engineSource.indexOf("auto configureBestClean =");
    const configureEnd = engineSource.indexOf("auto renderBestClean =", configureStart);
    const bestCleanSource = engineSource.slice(configureStart, configureEnd);
    expect(bestCleanSource).toContain("currentMigratedPrecisionVolumeDb = 9.0f");
    expect(bestCleanSource).toContain(
      "bestCleanRack.precisionDriveVolumeDb.store(\n            currentMigratedPrecisionVolumeDb)",
    );
    expect(engineSource).toContain(
      "bestCleanRack.precisionDriveVolumeDb.load(),\n                9.0f",
    );
  });

  it("removes the user-facing upgrade path and guards false-after-mutation loads", () => {
    const panelSource = readFileSync(
      new URL("../components/NAMRackPanel.tsx", import.meta.url),
      "utf8",
    );
    const loadStart = panelSource.indexOf("const loadUserPreset = async");
    const loadEnd = panelSource.indexOf("const applyHeaderPresetTarget", loadStart);
    const loadSource = panelSource.slice(loadStart, loadEnd);
    const nativeLoadIndex = loadSource.indexOf("nativeBridge.loadBuiltInFXPreset(");
    const factoryStart = panelSource.indexOf("const applyPreset = async");
    const factoryEnd = panelSource.indexOf("const currentRackToneSlot", factoryStart);
    const factorySource = panelSource.slice(factoryStart, factoryEnd);
    const nativeFactoryWriteIndex = factorySource.indexOf("nativeBridge.setBuiltInPluginState(");

    expect(panelSource).not.toContain("upgradeNAMEffectsDspToCurrent");
    expect(panelSource).not.toContain("nam-dsp-upgrade-notice");
    expect(panelSource).not.toContain("nam-dsp-upgrade-action");
    expect(loadSource.indexOf("rackMutated = true")).toBeLessThan(nativeLoadIndex);
    expect(loadSource.slice(nativeLoadIndex)).toContain("recoverUnverifiedPresetMutation(");
    expect(factorySource.indexOf("rackMutated = true")).toBeLessThan(nativeFactoryWriteIndex);
    expect(factorySource.slice(nativeFactoryWriteIndex)).toContain("recoverUnverifiedPresetMutation(");
  });
});
