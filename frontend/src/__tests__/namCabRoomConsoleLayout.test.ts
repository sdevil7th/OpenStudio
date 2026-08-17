// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computePremiumStagePlacement,
  NAM_CAB_ROOM_CONSOLE_LAYOUT,
  NAM_PANEL_ROTARY_VARIANT_PX,
} from "../components/NAMRackDesignPort";

describe("NAM Rack integrated Cab and Room console", () => {
  it("fits the approved single IR shaper and Room console at every stage size", () => {
    const { group, console } = NAM_CAB_ROOM_CONSOLE_LAYOUT;

    expect(console).toEqual(group);
    expect(console.h).toBeGreaterThan(390);
    expect(console.w / console.h).toBeGreaterThan(1.6);
    expect(console.w / console.h).toBeLessThan(1.7);

    for (const viewport of [
      { width: 720, height: 410 },
      { width: 1010, height: 520 },
      { width: 1530, height: 775 },
    ]) {
      for (const size of [80, 100, 140, 180, 220]) {
        const placement = computePremiumStagePlacement(viewport, group, size);
        for (const box of [console]) {
          const left = placement.left + box.x * placement.scale;
          const right = left + box.w * placement.scale;
          const top = placement.top + box.y * placement.scale;
          const bottom = top + box.h * placement.scale;
          expect(left).toBeGreaterThanOrEqual(0);
          expect(right).toBeLessThanOrEqual(viewport.width);
          expect(top).toBeGreaterThanOrEqual(0);
          expect(bottom).toBeLessThanOrEqual(viewport.height);
        }
      }
    }
  });

  it("keeps seven evenly separated primary controls above a full-width Room bay", () => {
    const layout = NAM_CAB_ROOM_CONSOLE_LAYOUT;
    const cabRotaryRadius = NAM_PANEL_ROTARY_VARIANT_PX.cabPanel / 2;
    expect(layout.topKnobXs).toHaveLength(7);
    expect(NAM_PANEL_ROTARY_VARIANT_PX.cabPanel).toBe(42);
    expect(layout.topKnobXs[0] / 100 * layout.console.w - cabRotaryRadius).toBeGreaterThan(0);
    expect(
      layout.topKnobXs[layout.topKnobXs.length - 1] / 100 * layout.console.w + cabRotaryRadius,
    ).toBeLessThan(layout.console.w);
    for (let index = 1; index < layout.topKnobXs.length; index += 1) {
      expect(layout.topKnobXs[index] - layout.topKnobXs[index - 1]).toBeGreaterThan(12);
      expect(
        (layout.topKnobXs[index] - layout.topKnobXs[index - 1]) / 100 * layout.console.w,
      ).toBeGreaterThan(NAM_PANEL_ROTARY_VARIANT_PX.cabPanel);
    }
    expect(layout.topKnobY).toBeLessThan(layout.utilityY);
    expect(layout.utilityY).toBeLessThan(layout.roomBayTop);
  });

  it("binds the approved Room controls independently from the external IR lock", () => {
    const source = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );
    const cabStageStart = source.indexOf("function CabStage(");
    const cabStageEnd = source.indexOf("function EqStage()", cabStageStart);
    const cabStage = source.slice(cabStageStart, cabStageEnd);

    expect(cabStage).toContain('className="cab-room-bay"');
    expect(cabStage).toContain("<CabRoomPowerSwitch />");
    expect(cabStage).toContain("body={BODIES.cabRoomIntegrated}");
    expect(cabStage).not.toContain('name="cabinet"');
    expect(cabStage).toContain('paramId="cabRoomAmount"');
    expect(cabStage).toContain('paramId="cabRoomWidth"');
    expect(cabStage).toContain('paramId="cabPan"');
    expect(cabStage.match(/panelRotaryVariant="cabPanel"/g)).toHaveLength(7);
    expect(cabStage).toContain("POST-CAB AMBIENCE");
    expect(cabStage).toContain("<DesignParamContext.Provider value={cabParamContext}>");
    expect(cabStage.indexOf('className="cab-room-bay"'))
      .toBeGreaterThan(cabStage.indexOf("</DesignParamContext.Provider>"));
    expect(cabStage).not.toContain("<Screw");
  });

  it("uses two large Room hero rotaries and keeps their readouts clear of the lower edge", () => {
    expect(NAM_PANEL_ROTARY_VARIANT_PX.roomHero).toBeGreaterThan(60);

    const source = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );
    expect(source.match(/panelRotaryVariant="roomHero"/g)).toHaveLength(2);
    expect(source).toMatch(/\.cab-room-control > \.cab-room-value[\s\S]*?bottom: 13%;/);
  });
});
