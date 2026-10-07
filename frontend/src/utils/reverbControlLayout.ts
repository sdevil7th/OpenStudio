import type { BuiltInPluginSchema } from "../services/NativeBridge";
import { findBuiltInParameter } from "./builtInExpandedSelectors";

export type ReverbControl = { id: string; label?: string };
export type ReverbPage = { id: string; label: string; controls: ReverbControl[]; help?: string };
const controls = (...ids: string[]): ReverbControl[] => ids.map(id => ({ id }));

/** Applicability follows BuiltInEffects2::processStandaloneSpaces and each engine's settings.
 * Bank memories and legacy normalized aliases are state, not extra front-panel controls.
 */
export function reverbControlLayout(schema: BuiltInPluginSchema) {
  const p = (id: string) => findBuiltInParameter(schema, id);
  const v = (id: string, fallback = 0) => p(id)?.value ?? fallback;
  const type = Math.round(v("algorithm"));
  const studio = [0, 1, 3, 8, 9].includes(type);
  const studioPrepared = studio && (type >= 8 || v("spaceEngine", 1) >= .5);
  const plate = type === 2, plateEngine = v("plateEngine", 1);
  const modal = plate && plateEngine >= 1.5;
  const studioPlate = plate && plateEngine >= .5 && !modal;
  const spring = type === 4, dispersive = spring && v("springEngine") >= .5;
  const spatial = type >= 12 && type <= 14;
  const ambient = type >= 17 && type <= 20;
  const retro = type >= 27 && type <= 40;
  const shaped = type === 36;
  const sync = spatial ? "spatialSync" : "predelaySync";
  const time = spatial ? "spatialDelay" : "preDelay";
  const division = spatial ? "spatialDivision" : "predelayDivision";
  const capacity = spatial ? "spatialDelayCapacity" : "predelayCapacity";
  const hold = ambient ? "ambHold" : dispersive ? "springHold" : type === 5 ? "shimmerHold" : type === 6 ? "nonlinearHold"
    : type === 15 ? "magneticHold" : type === 16 ? "positionedHold"
    : studioPrepared || (plate && plateEngine >= .5) || [12, 13, 21, 22, 23, 24, 25, 26].includes(type) || (retro && !shaped) ? "freezeMode" : null;
  const legacyFreeze = (studio && !studioPrepared) || (plate && plateEngine < .5);
  const primary: ReverbControl = type === 16 ? { id: "roomSize", label: "Room size" }
    : type === 15 ? { id: "headTime", label: "Head time" }
    : type === 14 ? { id: "spatialAmount", label: "Reverb amount" }
    : shaped ? { id: "retroAttack", label: "Envelope shape" }
    : { id: retro ? "retroDecay" : type === 19 ? "ambCloudDecay" : "decayTime", label: type === 6 ? "Length" : "Decay" };
  const shape = type === 7 ? controls("lowCut", "highCut")
    : type === 16 ? [{ id: "sourceX", label: "Source L / R" }, { id: "sourceY", label: "Source F / B" }]
    : modal ? controls("modalLength", "modalAspect")
    : studioPlate ? controls("plateModulation", "diffusion")
    : dispersive ? controls("springDwell", "springDispersion")
    : spring ? [{ id: "roomSize", label: "Dispersion" }, { id: "damping" }]
    : type === 5 ? controls("shimmerAmount", "damping")
    : type === 6 ? controls("nonlinearFeedback", "nonlinearDiffusion")
    : type === 15 ? controls("headFeedback", "diffusion")
    : shaped ? [{ id: "roomSize", label: "Duration" }, { id: "highCut" }]
    : controls("roomSize", "diffusion");
  const pages: ReverbPage[] = [];
  const page = (id: string, label: string, ids: string[], help?: string) => pages.push({ id, label, controls: controls(...ids), help });
  let tone = ["damping", "lowCut", "highCut"];
  if (studio) {
    page("character", "Character", [...(type < 8 ? ["spaceEngine"] : []), ...(type === 0 && studioPrepared ? ["roomCharacter"] : []), "earlyLevel", ...(studioPrepared ? ["spaceModulation", "spaceBassRatio"] : [])]);
  } else if (plate) {
    page("character", "Character", ["plateEngine", ...(studioPlate ? ["plateCharacter"] : []), ...(plateEngine >= .5 ? ["plateDrive", "plateInputCut", "plateChorus"] : ["earlyLevel"])]);
    if (modal) {
      page("geometry", "Geometry", ["modalLength", "modalAspect", "modalTension", ...(v("modalMaterial") < .5 ? ["modalRigidity"] : []), "modalModes"]);
      page("material", "Material", ["modalMaterial", ...(v("modalMaterial") >= .5 ? ["modalYoung", "modalDensity", "modalPoisson", "modalThickness"] : [])]);
      page("exciters", "Exciters", ["modalExciterX", "modalExciterY", "modalExciterRadius"]);
      page("pickups", "Pickups", ["modalLeftX", "modalLeftY", "modalRightX", "modalRightY", "modalPickupRadius"]);
    }
    if (plateEngine >= .5) {
      page("chorus", "Chorus", ["plateChorus", ...(v("plateChorus") >= .5 ? ["plateChorusPosition", "plateChorusAmount"] : [])]);
      page("wet-eq", "Wet EQ", ["plateEQOn", ...(v("plateEQOn") >= .5 ? ["plateLowFrequency", "plateLowGain", "plateHighFrequency", "plateHighGain"] : [])]);
    }
  } else if (spring) {
    page("character", "Character", ["springEngine", ...(dispersive ? ["springCount", "springTension", "springBass", "springMotion"] : [])], dispersive ? "Hold suspends damping and motion. Spring count, tension and dispersion changes take effect on release." : "Legacy spring uses Dispersion and Damping above; the Dispersive engine adds Dwell and independent spring controls.");
  } else if (type === 5) {
    page("character", "Character", ["shimmerVoiceEngine", "shimmerRouting", ...(v("shimmerVoiceEngine") >= .5 ? ["shimmerPitchA", "shimmerPitchB", "shimmerVoiceMix"] : [])], "Hold sustains the unpitched tank. Pitch processing resumes when Hold releases.");
  } else if (type === 6) {
    page("character", "Character", ["nonlinearShape", "nonlinearLateLevel", "nonlinearLateDecay"], "Length sets the early envelope. Feedback repeats it; Late level adds an independent tail. Hold defers Length and Envelope changes.");
    page("motion", "Motion", ["nonlinearModulation", "nonlinearRate"]);
  } else if (type === 7) {
    page("character", "Impulse response", []);
    page("motion", "Motion & tail", ["irModDepth", "irModRate", "irExtension0", "irExtension1", "irExtension2", "irExtension3", "irExtension4", "irExtension5"], "Motion and synthetic tail enhancement follow convolution. The embedded original and isolated IR audition remain unchanged.");
    tone = [];
  } else if ([10, 11].includes(type)) {
    page("character", "Character", ["vintageColour", "vintageConversion", "vintageTankRate", "vintageModulation", "vintageRate"]);
    page("buildup", "Buildup", ["vintageBuildUp", "vintageInputDiffusion"]);
    tone.push("vintageBassRatio", "vintageBassFrequency");
  } else if (spatial) {
    page("character", "Character", ["spatialFeedback", "spatialModulation", "spatialRate", ...(type < 14 ? ["spatialDensity", "spatialAmount"] : [])]);
    tone.push("spatialLowShelf");
  } else if (type === 15) {
    page("character", "Character", ["headCount", "headSpacing", "headMotion"], "Hold preserves the echo history. Time, head count and spacing changes take effect on release.");
  } else if (type === 16) {
    page("character", "Character", ["roomShape", "sourceX", "sourceY"], "Room size, shape, source positions and damping take effect after Hold releases. Output cuts and width stay active.");
  } else if (ambient) {
    page("character", "Character", [...(type === 17 ? ["ambRise", "ambSwellMode"] : type === 18 ? ["ambLength", "ambFeedback"] : type === 20 ? ["ambVowel", "ambResonance"] : []), "ambDepth", "ambRate"]);
    tone.push("ambBass");
  } else if (type >= 21 && type <= 23) {
    page("character", "Character", ["driftDrive", "driftEmphasis", "driftWow", "driftFlutter", "driftRate"]);
    tone.push("driftBassRatio", "driftBassFrequency");
  } else if (type >= 24 && type <= 26) {
    page("character", "Character", ["clearInputDiffusion", "clearOnset", "clearDepth", "clearRate", ...(type === 25 ? ["earlyLevel"] : [])]);
    tone.push("clearBassRatio", "clearBassFrequency");
  } else if (retro) {
    page("character", "Character", ["retroEra", ...(!shaped ? ["retroAttack", "retroEarlyDiffusion", "retroDepth", "retroRate", ...(type !== 32 ? ["earlyLevel"] : []), ...([39, 40].includes(type) ? ["retroAperture"] : [])] : [])]);
    if (shaped) tone = ["lowCut"];
    else tone.push("retroBassRatio", "retroBassFrequency");
  }
  const filterPrefix = studioPrepared ? "studio" : studioPlate ? "plate" : null;
  if (filterPrefix && p(`${filterPrefix}DecayFilter`)) {
    tone = ["lowCut", ...(v(`${filterPrefix}DecayFilter`) < .5 ? ["damping"] : []), `${filterPrefix}DecayFilter`, ...(v(`${filterPrefix}DecayFilter`) >= 1.5 ? [`${filterPrefix}DecayCutoff`] : []), `${filterPrefix}OutputCutOff`, ...(v(`${filterPrefix}OutputCutOff`) < .5 ? ["highCut"] : [])];
  }
  if (tone.length) page("tone", "Tone", tone);
  page("timing", "Timing & ducking", [sync, v(sync) >= .5 ? division : time, ...(v(sync) >= .5 ? [capacity] : []), "wetDuckDepth", "wetDuckThreshold", "wetDuckRelease"], "Free time is retained while synced. Capacity limits long divisions and changing capacity clears delay history; the current effective time is shown below.");
  page("routing", hold || legacyFreeze ? "Hold & routing" : "Routing", [...(hold && !ambient ? ["holdInputMode"] : []), ...(legacyFreeze ? ["freezeMode"] : []), "sendMode", "mixLock", "tailSpillover"], legacyFreeze ? "Legacy Freeze sustains the original tank. Prepared Hold and its input behavior are available with the Studio engine." : ambient ? "Off releases the tail; Infinite accepts new input; Freeze sustains the captured texture. Lock balance preserves wet/dry while browsing." : hold ? "Freeze closes new excitation; Infinite keeps feeding the held tail. Spillover retains supported outgoing tails. Send mode stores your insert balance and restores it when disabled." : "Spillover retains supported outgoing tails. Send mode stores your insert balance and restores it when disabled. Lock balance preserves wet/dry while browsing.");
  return { type, studio, studioPrepared, modal, dispersive, spatial, ambient, hold, sync, time, division, capacity, primary, shape, pages };
}
