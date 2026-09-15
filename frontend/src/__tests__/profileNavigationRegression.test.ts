import { describe, expect, it, vi } from "vitest";
import { getMouseBehaviorProfile } from "../utils/mouseBehaviorProfiles";
import { KEYBOARD_SHORTCUT_PROFILES } from "../utils/shortcutProfiles";
import { resolveWheelGesture } from "../utils/wheelGestureResolver";
import { installBrowserZoomWheelGuard } from "../utils/browserWheelGuard";

describe("profile navigation regressions", () => {
  it.each(["windows", "macos"] as const)("keeps Cubase navigation distinct on %s across the actual editor surface names", (platform) => {
    const profile = getMouseBehaviorProfile("cubase", platform).wheel;
    const primary = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    for (const surface of ["timeline", "piano_roll", "pitch_editor"] as const) {
      const context = { surface, subtarget: surface === "timeline" ? "track" as const : "grid" as const, platform };
      expect(resolveWheelGesture({deltaY:100},context,profile)).toMatchObject({operation:"scroll",axis:"vertical"});
      expect(resolveWheelGesture({deltaY:100,...primary},context,profile)).toMatchObject({operation:"zoom",target:"timeline"});
      expect(resolveWheelGesture({deltaY:100,shiftKey:true},context,profile)).toMatchObject({operation:"scroll",axis:"horizontal",amount:100});
      expect(resolveWheelGesture({deltaY:100,shiftKey:true,...primary},context,profile)).toMatchObject({
        operation:surface === "timeline" ? "resize" : "zoom", target:surface === "timeline" ? "track-height" : "midi-note-height",
      });
    }
  });

  it("retains both axes of horizontal and diagonal wheel packets for every built-in profile", () => {
    for (const profile of KEYBOARD_SHORTCUT_PROFILES) {
      for (const surface of ["timeline", "piano_roll", "pitch_editor"] as const) {
        for (const delta of [{deltaX:35,deltaY:0},{deltaX:0.5,deltaY:-2.5}]) {
          expect(resolveWheelGesture(delta,{surface,subtarget:"content",platform:"windows"},getMouseBehaviorProfile(profile.id,"windows").wheel))
            .toMatchObject({operation:"scroll",axis:"horizontal",amount:delta.deltaX,delta:{x:delta.deltaX,y:delta.deltaY},preventDefault:true});
        }
      }
    }
  });

  it("does not mistake Ctrl+wheel notches or Ctrl+Shift for pinch when focus missed the keydown", () => {
    const listeners = new Map<string, EventListener>();
    const target = {addEventListener:vi.fn((type,listener)=>listeners.set(type,listener)),removeEventListener:vi.fn()} as unknown as Document;
    const cleanup=installBrowserZoomWheelGuard(target);
    const send=(data: object) => {
      const event={deltaX:0,deltaY:120,deltaMode:0,ctrlKey:true,preventDefault:vi.fn(),stopPropagation:vi.fn(),...data};
      listeners.get("wheel")!(event as unknown as Event);
      return event as typeof event & {openStudioPinch?: boolean};
    };
    expect(send({}).openStudioPinch).toBeUndefined();
    expect(send({deltaY:3,deltaMode:1}).openStudioPinch).toBeUndefined();
    expect(send({deltaY:3,shiftKey:true}).openStudioPinch).toBeUndefined();
    expect(send({deltaY:1.5}).openStudioPinch).toBe(true);
    cleanup();
  });
});
