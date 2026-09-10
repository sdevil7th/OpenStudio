// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computePremiumStagePlacement,
  NAM_CABINET_STAGE_LAYOUT,
  NAM_PANEL_ROTARY_VARIANT_PX,
} from "../components/NAMRackDesignPort";

describe("NAM Rack physical Cabinet and Room stage", () => {
  it("fits the cabinet and foreground controller at every stage size", () => {
    const { group, cabinet, controller } = NAM_CABINET_STAGE_LAYOUT;

    expect(cabinet.h).toBeGreaterThan(200);
    expect(cabinet.w / cabinet.h).toBeGreaterThan(1.49);
    expect(cabinet.w / cabinet.h).toBeLessThan(1.6);
    expect(controller.w / controller.h).toBeGreaterThan(1.6);
    expect(controller.x).toBeLessThan(cabinet.x + cabinet.w);
    expect(controller.x + controller.w).toBe(cabinet.x + group.w);

    for (const viewport of [
      { width: 720, height: 410 },
      { width: 1010, height: 520 },
      { width: 1530, height: 775 },
    ]) {
      for (const size of [80, 100, 140, 180, 220]) {
        const placement = computePremiumStagePlacement(viewport, group, size);
        for (const box of [cabinet, controller]) {
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

  it("keeps three IR rotaries and three hardware switches evenly separated", () => {
    const layout = NAM_CABINET_STAGE_LAYOUT;
    const cabRotaryRadius = NAM_PANEL_ROTARY_VARIANT_PX.cabPanel / 2;
    expect(layout.knobXs).toHaveLength(3);
    expect(layout.switchXs).toHaveLength(3);
    expect(NAM_PANEL_ROTARY_VARIANT_PX.cabPanel).toBe(32);
    expect(layout.knobXs[0] / 100 * layout.controller.w - cabRotaryRadius).toBeGreaterThan(0);
    expect(
      layout.knobXs[layout.knobXs.length - 1] / 100 * layout.controller.w + cabRotaryRadius,
    ).toBeLessThan(layout.controller.w);
    for (let index = 1; index < layout.knobXs.length; index += 1) {
      expect(layout.knobXs[index] - layout.knobXs[index - 1]).toBeGreaterThan(12);
      expect(
        (layout.knobXs[index] - layout.knobXs[index - 1]) / 100 * layout.controller.w,
      ).toBeGreaterThan(NAM_PANEL_ROTARY_VARIANT_PX.cabPanel);
    }
    expect(Math.abs(layout.knobY - layout.switchY)).toBeLessThanOrEqual(4);
  });

  it("keeps Cab literal while exposing the separate Room processor honestly", () => {
    const source = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );
    const cabStageStart = source.indexOf("function CabStage(");
    const cabStageEnd = source.indexOf("function EqStage()", cabStageStart);
    const cabStage = source.slice(cabStageStart, cabStageEnd);

    expect(cabStage).toContain('className="cab-room-bay"');
    expect(cabStage).toContain("body={BODIES.cab}");
    expect(cabStage).toContain("body={BODIES.cabController}");
    expect(cabStage).toContain('name="cabinet"');
    expect(cabStage).toContain('paramId="cabRoomAmount"');
    expect(cabStage).toContain('paramId="cabRoomWidth"');
    expect(cabStage).toContain("<CabRoomPowerSwitch />");
    expect(cabStage).toContain('paramId="cabPan"');
    expect(cabStage.match(/panelRotaryVariant="cabPanel"/g)).toHaveLength(5);
    expect(cabStage).toContain("Doubler stays in Signal Chain");
    expect(cabStage).toContain("roomWaitingForCabSource");
    expect(cabStage).toContain("<DesignParamContext.Provider value={cabParamContext}>");
    expect(cabStage).not.toContain("<Screw");
    expect(cabStage).not.toContain('paramId="cabHPFHz"');
    expect(cabStage).not.toContain('paramId="cabLPFHz"');
    expect(cabStage).not.toContain('paramId="cabMicPosition"');
    expect(cabStage).not.toContain('paramId="cabMicDistance"');
    expect(cabStage).not.toContain('paramId="cabMicBlend"');
    expect(cabStage).not.toContain('paramId="cabRoomSend"');
  });

  it("does not retain oversized Room rotaries on the Cab faceplate", () => {
    expect(NAM_PANEL_ROTARY_VARIANT_PX.roomHero).toBeGreaterThan(60);

    const source = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );
    expect(source.match(/panelRotaryVariant="roomHero"/g) ?? []).toHaveLength(0);
  });
});
