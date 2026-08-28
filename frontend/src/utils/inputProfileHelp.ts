import { getEffectiveActionShortcut } from "../store/actionRegistry";
import { getMouseBehaviorProfile } from "./mouseBehaviorProfiles";
import {
  formatShortcut,
  type ShortcutPlatform,
} from "./platform";
import type { KeyboardShortcutProfileId } from "./shortcutProfiles";
import type {
  WheelBehaviorRule,
  WheelModifierPredicate,
} from "./wheelGestureResolver";

export interface TimelineWheelHelpItem {
  gesture: string;
  action: string;
}

export interface TimelineWheelHelp {
  profileName: string;
  items: readonly TimelineWheelHelpItem[];
}

function modifierLabel(
  modifiers: WheelModifierPredicate | undefined,
  platform: ShortcutPlatform,
): string {
  const labels: string[] = [];
  if (modifiers?.primary) labels.push(platform === "macos" ? "Cmd" : "Ctrl");
  if (modifiers?.secondary) labels.push(platform === "macos" ? "Ctrl" : "Win");
  if (modifiers?.alt) labels.push(platform === "macos" ? "Option" : "Alt");
  if (modifiers?.shift) labels.push("Shift");
  return labels.length > 0 ? `${labels.join("+")}+Scroll` : "Scroll";
}

function wheelActionLabel(rule: WheelBehaviorRule): string {
  if (rule.operation === "scroll" || rule.operation === "native-scroll") {
    const direction = rule.axis === "horizontal" ? "horizontally" : "vertically";
    if (rule.id.includes("slow-")) return `scroll ${direction} more slowly`;
    if (rule.id.includes("fast-")) return `scroll ${direction} faster`;
    return `scroll ${direction}`;
  }
  if (rule.operation === "zoom" && rule.target === "waveform-amplitude") {
    return "zoom waveform height";
  }
  if (rule.operation === "zoom" && rule.target === "midi-note-height") {
    return "resize MIDI note and key height";
  }
  if (rule.operation === "zoom" && rule.target === "waveform-scale") {
    return "zoom the waveform scale vertically";
  }
  if (rule.operation === "zoom" && rule.target === "spectrogram-scale") {
    return "zoom the spectrogram scale vertically";
  }
  if (rule.operation === "zoom") {
    return rule.id.includes("fast-") ? "zoom the timeline faster" : "zoom the timeline";
  }
  if (rule.operation === "resize" && rule.target === "track-height") {
    if (rule.id.includes("selected-track")) return "resize selected track height";
    if (rule.anchor === "hovered-track") return "resize hovered track height";
    return "resize track height";
  }
  if (rule.operation === "resize" && rule.target === "lane-height") {
    return "resize the hovered automation lane";
  }
  if (rule.operation === "reorder" && rule.target === "track-order") {
    return "reorder the hovered track";
  }
  if (rule.operation === "nudge" && rule.target === "clip-position") {
    return "nudge the hovered clip";
  }
  if (rule.operation === "nudge" && rule.target === "note-position") {
    return "nudge the hovered MIDI note";
  }
  if (rule.operation === "pan" && rule.target === "waveform-scale") {
    return "pan the waveform scale vertically";
  }
  if (rule.operation === "pan" && rule.target === "spectrogram-scale") {
    return "pan the spectrogram scale vertically";
  }
  if (rule.operation === "adjust" && rule.target === "spectrogram-db-floor") {
    return "adjust the spectrogram lower dB limit";
  }
  if (rule.operation === "adjust" && rule.target === "fade-value") {
    return "adjust the hovered fade length";
  }
  if (rule.operation === "adjust" && rule.target === "event-volume") {
    return "adjust the hovered event volume";
  }
  if (rule.operation === "adjust" && rule.target === "note-property") {
    return "adjust the hovered MIDI note property";
  }
  if (rule.operation === "adjust") return "adjust the hovered parameter";
  return "reserved by this profile";
}

function wheelSubtargetLabel(rule: WheelBehaviorRule): string {
  const labels: Partial<Record<NonNullable<WheelBehaviorRule["subtargets"]>[number], string>> = {
    track: "over a track",
    clip: "over a clip",
    note: "over a note",
    waveform_scale: "over a waveform scale",
    spectrogram_scale: "over a spectrogram scale",
    automation_lane: "over an automation lane",
    fade_handle: "over a fade handle",
    event_volume: "over an event-volume handle",
    console_fader: "over a console fader",
    ruler: "over the ruler",
  };
  const contextual = rule.subtargets
    ?.map((subtarget) => labels[subtarget])
    .filter((label): label is string => Boolean(label));
  return contextual?.length ? ` ${contextual.join(" or ")}` : "";
}

function modifierCount(rule: WheelBehaviorRule): number {
  return Object.values(rule.modifiers ?? {}).filter((value) => value === true).length;
}

export function getTimelineWheelHelp(
  profileId: KeyboardShortcutProfileId,
  platform: ShortcutPlatform,
  limit = 5,
): TimelineWheelHelp {
  const profile = getMouseBehaviorProfile(profileId, platform);
  const timelineRules = profile.wheel.rules
    .filter((rule) => rule.surface === "timeline")
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => (
      modifierCount(left.rule) - modifierCount(right.rule) || left.index - right.index
    ));

  const items = timelineRules.slice(0, limit).map(({ rule }) => ({
    gesture: `${modifierLabel(rule.modifiers, platform)}${wheelSubtargetLabel(rule)}`,
    action: wheelActionLabel(rule),
  }));

  if (items.length === 0) {
    items.push({
      gesture: "Wheel gestures",
      action: "use native scrolling when no supported item-specific action matches",
    });
  } else if (!timelineRules.some(({ rule }) => modifierCount(rule) === 0)) {
    items.push({
      gesture: "Other wheel gestures",
      action: "use native scrolling",
    });
  }

  return {
    profileName: profile.name,
    items: items.slice(0, limit),
  };
}

export function getTimelineWheelHelpSentence(
  profileId: KeyboardShortcutProfileId,
  platform: ShortcutPlatform,
): string {
  const help = getTimelineWheelHelp(profileId, platform);
  return `${help.profileName}: ${help.items
    .map((item) => `${item.gesture} ${item.action}`)
    .join("; ")}.`;
}

export function getEffectiveShortcutLabel(
  actionId: string,
  fallback: string,
): string {
  const binding = getEffectiveActionShortcut(actionId);
  if (binding === "") return "Unassigned";
  return formatShortcut(binding ?? fallback);
}
