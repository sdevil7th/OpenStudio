import { nativeBridge, type BuiltInPluginAddress } from "./NativeBridge";
import { parsePitchCorrectorPreset, type PitchCorrectorPreset } from "../components/pitchCorrectorPresets";

type Params = PitchCorrectorPreset["params"];

/** Read controls together from the native schema, including edits in another editor. */
export async function capturePitchCorrectorPreset(address: BuiltInPluginAddress) {
  const schema = await nativeBridge.getBuiltInPluginSchema(address);
  if (schema.name !== "OpenStudio Pitch Correct"
    || (address.instanceId && schema.instanceId !== address.instanceId))
    throw new Error("This Pitch Correct instance was removed or replaced. Reopen it from the FX chain.");
  const values = Object.fromEntries(schema.parameters.map(parameter => [parameter.id, parameter.value]));
  const toggle = (id: string) => {
    if (!Number.isFinite(values[id])) throw new Error(`Pitch Correct did not return its ${id} setting.`);
    return values[id] >= 0.5;
  };
  const params = parsePitchCorrectorPreset({ name: "Snapshot", params: {
    key: values.key, scale: values.scale, retuneSpeed: values.retuneSpeed,
    correctionStrength: values.correctionStrength, humanize: values.humanize,
    formantCorrection: toggle("formantCorrection"), formantShift: values.formantShift,
    mix: values.mix, transpose: values.transpose, signalPath: values.signalPath,
    noteEnables: Array.from({ length: 12 }, (_, index) => toggle(`noteEnable_${index}`)),
    midiOutput: toggle("midiOutputEnabled"), midiChannel: values.midiOutputChannel,
    bypass: toggle("bypass"), sensitivity: values.sensitivity,
    minFreqParam: values.minFreqParam, maxFreqParam: values.maxFreqParam,
    detectionSource: values.detectionSource, humanizeMode: values.humanizeMode,
  } }).params;
  return { address: { ...address, fxIndex: schema.fxIndex, instanceId: schema.instanceId }, params };
}

/** The native transaction holds the processor lock across mode preparation and mask restore. */
export async function applyPitchCorrectorPreset(address: BuiltInPluginAddress, params: Params): Promise<void> {
  const valid = parsePitchCorrectorPreset({ name: "Snapshot", params }).params;
  const values: Record<string, number> = {
    signalPath: valid.signalPath ?? 0,
    retuneSpeed: valid.retuneSpeed, correctionStrength: valid.correctionStrength,
    humanize: valid.humanize, formantCorrection: valid.formantCorrection ? 1 : 0,
    formantShift: valid.formantShift, mix: valid.mix,
  };
  for (const id of ["key", "scale", "transpose", "sensitivity", "minFreqParam", "maxFreqParam", "detectionSource", "humanizeMode"] as const)
    if (valid[id] !== undefined) values[id] = valid[id];
  valid.noteEnables?.forEach((enabled, index) => { values[`noteEnable_${index}`] = enabled ? 1 : 0; });
  if (valid.midiOutput !== undefined) values.midiOutputEnabled = valid.midiOutput ? 1 : 0;
  if (valid.midiChannel !== undefined) values.midiOutputChannel = valid.midiChannel;
  if (valid.bypass !== undefined) values.bypass = valid.bypass ? 1 : 0;
  if (!await nativeBridge.setBuiltInPluginState(address, { values }))
    throw new Error("Pitch Correct could not restore the preset. Its current settings were not confirmed.");
}

export async function savePitchCorrectorPreset(path: string, params: Params): Promise<void> {
  const preset = parsePitchCorrectorPreset({
    name: path.split(/[/\\]/).pop()?.replace(/\.ospreset$/i, "") || "User Preset",
    category: "User", params,
  });
  if (!await nativeBridge.saveJsonDocumentToFile(path, JSON.stringify(preset, null, 2)))
    throw new Error("The Pitch Correct preset could not be saved. Choose another location and try again.");
}
