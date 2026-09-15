import { useState } from "react";
import { useShallow } from "zustand/shallow";
import { useDAWStore } from "../store/useDAWStore";
import { getMouseBehaviorProfile, toMouseBehaviorPlatform } from "../utils/mouseBehaviorProfiles";
import { getShortcutPlatform } from "../utils/platform";
import { resolveWheelGesture, type WheelSurface, type WheelSubtarget } from "../utils/wheelGestureResolver";
import { NativeSelect } from "./ui";

const surfaces: { value: string; label: string; surface: WheelSurface; subtarget: WheelSubtarget }[] = [
  { value: "timeline", label: "Timeline", surface: "timeline", subtarget: "track" },
  { value: "ruler", label: "Timeline ruler", surface: "timeline", subtarget: "ruler" },
  { value: "piano_roll", label: "Piano Roll", surface: "piano_roll", subtarget: "grid" },
  { value: "pitch_editor", label: "Pitch Editor", surface: "pitch_editor", subtarget: "grid" },
  { value: "tcp", label: "Track headers", surface: "tcp", subtarget: "track" },
  { value: "parameter", label: "Parameter controls", surface: "parameter", subtarget: "control" },
  { value: "fade", label: "Selected clip fade handle", surface: "timeline", subtarget: "fade_handle" },
  { value: "volume", label: "Selected clip volume handle", surface: "timeline", subtarget: "event_volume" },
];

export function InputGestureReference() {
  const [surfaceId, setSurfaceId] = useState("timeline");
  const { profileId } = useDAWStore(useShallow((s) => ({ profileId: s.mouseBehaviorProfileId })));
  const platform = getShortcutPlatform();
  const profile = getMouseBehaviorProfile(profileId, platform);
  const context = surfaces.find((s) => s.value === surfaceId)!;
  const primary = platform === "macos" ? "Cmd" : "Ctrl";
  const alt = platform === "macos" ? "Option" : "Alt";
  const masks = [0, 1, 2, 4, 5, 3, 6, 7];
  if (platform === "macos" || profile.wheel.rules.some((rule) => rule.modifiers?.secondary)) masks.push(8, 9, 10, 12, 11, 13, 14, 15);
  const rows = masks.map((mask) => {
    const keys = [mask & 1 ? primary : "", mask & 8 ? (platform === "macos" ? "Ctrl" : "Win") : "", mask & 2 ? alt : "", mask & 4 ? "Shift" : ""].filter(Boolean);
    const gesture = resolveWheelGesture({
      deltaY: 100, ctrlKey: Boolean(mask & (platform === "macos" ? 8 : 1)),
      metaKey: Boolean(mask & (platform === "macos" ? 1 : 8)), altKey: Boolean(mask & 2), shiftKey: Boolean(mask & 4),
    }, { ...context, platform: toMouseBehaviorPlatform(platform) }, profile.wheel);
    const action = gesture.operation === "native-scroll"
      ? (mask & 13 || ["piano_roll", "pitch_editor"].includes(context.surface) ? "No assigned action" : "Standard scrolling")
      : gesture.operation === "suppress" ? "No assigned action"
      : gesture.target === "track-height" ? "Resize track height"
      : gesture.target === "midi-note-height" ? "Zoom note height"
      : gesture.target === "waveform-amplitude" ? "Zoom waveform height"
      : gesture.operation === "zoom" ? "Zoom horizontally"
      : gesture.operation === "scroll" ? `Scroll ${gesture.axis === "horizontal" ? "horizontally" : "vertically"}`
      : gesture.target === "fade-value" ? "Adjust fade length"
      : gesture.target === "event-volume" ? "Adjust clip volume"
      : gesture.operation === "reorder" ? "Reorder hovered track"
      : gesture.operation === "adjust" ? `Adjust value${gesture.precision === "fine" ? " (fine)" : ""}`
      : "No assigned action";
    return { label: [...keys, "Wheel"].join(" + "), action };
  });
  return <div className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-sm text-xs leading-relaxed text-neutral-400">Current mappings for {profile.name}. Behavior depends on where the pointer is.</p>
      <NativeSelect label="Gesture surface" size="sm" options={surfaces} value={surfaceId} onChange={(value) => setSurfaceId(String(value))} showPlaceholder={false} />
    </div>
    <table className="w-full text-left text-xs">
      <thead className="border-b border-daw-border text-neutral-500"><tr><th className="py-2 font-medium">Gesture</th><th className="py-2 font-medium">Action</th></tr></thead>
      <tbody className="divide-y divide-white/5">{rows.map((row) => <tr key={row.label}>
        <td className="py-2.5 pr-4 font-mono text-neutral-300">{row.label}</td><td className="py-2.5 text-neutral-300">{row.action}</td>
      </tr>)}</tbody>
    </table>
    <p className="rounded-md bg-daw-dark/50 p-3 text-xs leading-relaxed text-neutral-400">
      Trackpads: two-finger scrolling moves horizontally and vertically; pinch zooms the timeline or note editor.
      Piano Roll and Pitch Editor navigation adapts the selected timeline profile. Touchscreen multi-touch gestures are not currently supported.
    </p>
  </div>;
}
