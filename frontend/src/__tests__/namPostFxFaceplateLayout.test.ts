// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computePremiumStagePlacement,
  NAM_PEDAL_HARDWARE_STANDARD_PX,
  NAM_POST_FX_FACEPLATE_LAYOUT,
} from "../components/NAMRackDesignPort";

describe("NAM Rack tall Post FX faceplates", () => {
  it("uses taller, non-overlapping boxes contained by the Post FX group", () => {
    const { group, modules } = NAM_POST_FX_FACEPLATE_LAYOUT;
    const boxes = Object.values(modules).map(({ box }) => box);

    expect(modules.modulator.box.h).toBeGreaterThan(157);
    expect(modules.delay.box.h).toBeGreaterThan(182);
    expect(modules.reverb.box.h).toBeGreaterThan(177);

    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(group.x);
      expect(box.y).toBeGreaterThanOrEqual(group.y);
      expect(box.x + box.w).toBeLessThanOrEqual(group.x + group.w);
      expect(box.y + box.h).toBeLessThanOrEqual(group.y + group.h);
    }

    expect(modules.modulator.box.x + modules.modulator.box.w)
      .toBeLessThan(modules.delay.box.x);
    expect(modules.delay.box.x + modules.delay.box.w)
      .toBeLessThan(modules.reverb.box.x);
  });

  it("reserves visible title and lower-edge padding on every faceplate", () => {
    const layout = NAM_POST_FX_FACEPLATE_LAYOUT;

    for (const module of Object.values(layout.modules)) {
      expect(module.titleY).toBeGreaterThanOrEqual(9);
      expect(module.titleY).toBeLessThan(13);
    }

    for (const controls of [layout.modulator, layout.delay, layout.reverb]) {
      expect(controls.topRowY).toBeGreaterThan(controls === layout.reverb ? 25 : 30);
      expect(controls.stateLabelY).toBeGreaterThan(controls.ledY);
      expect(controls.footY).toBeGreaterThan(controls.stateLabelY);
      expect(controls.footY).toBeLessThanOrEqual(96);
    }

    const footBottomClearanceInDesignPixels = (
      box: { w: number; h: number },
      footY: number,
      footSize: number,
    ) => box.h - (footY * box.h / 100 + footSize * box.w / 200);

    expect(footBottomClearanceInDesignPixels(layout.modules.modulator.box, layout.modulator.footY, layout.modulator.footSize)).toBeGreaterThanOrEqual(6);
    expect(footBottomClearanceInDesignPixels(layout.modules.delay.box, layout.delay.footY, layout.delay.footSize)).toBeGreaterThanOrEqual(6);
    expect(footBottomClearanceInDesignPixels(layout.modules.reverb.box, layout.reverb.footY, layout.reverb.footSize)).toBeGreaterThanOrEqual(6);
    expect(footBottomClearanceInDesignPixels(layout.modules.modulator.box, layout.modulator.footY, layout.modulator.footerToggleSize)).toBeGreaterThanOrEqual(6);

    // Percentage ordering alone missed real rendered collisions. Model the
    // square LED/footswitch boxes and the measured label heights in each
    // faceplate's own design pixels, and require a visible gap at every seam.
    // The approved faceplate uses a compact 7 px label rhythm so the physical
    // LED and switch photographs can retain realistic diameters.
    const postLabelHeight = 6.2;
    const stateLabelHeight = 8;
    const expectFooterGaps = (
      box: { w: number; h: number },
      controls: { lowerRowY: number; lowerLabelOffset: number; ledY: number; ledSize: number; stateLabelY: number; footY: number; footSize: number },
    ) => {
      const lowerLabelBottom = (controls.lowerRowY + controls.lowerLabelOffset) * box.h / 100 + postLabelHeight / 2;
      const ledTop = controls.ledY * box.h / 100 - controls.ledSize * box.w / 200;
      const ledBottom = controls.ledY * box.h / 100 + controls.ledSize * box.w / 200;
      const stateCenter = controls.stateLabelY * box.h / 100;
      const footTop = controls.footY * box.h / 100 - controls.footSize * box.w / 200;
      const stateTop = stateCenter - stateLabelHeight / 2;
      const stateBottom = stateCenter + stateLabelHeight / 2;

      expect(ledTop - lowerLabelBottom).toBeGreaterThanOrEqual(.75);
      expect(stateTop - ledBottom).toBeGreaterThanOrEqual(1);
      expect(footTop - stateBottom).toBeGreaterThanOrEqual(1);
    };

    expectFooterGaps(layout.modules.modulator.box, layout.modulator);
    expectFooterGaps(layout.modules.delay.box, layout.delay);
    expectFooterGaps(layout.modules.reverb.box, layout.reverb);
  });

  it("keeps each label outside its knob and leaves a measured gap before the next row", () => {
    const { modules, modulator, delay, reverb } = NAM_POST_FX_FACEPLATE_LAYOUT;
    const postLabelHeight = 6.2;

    const expectSeparatedRows = (
      box: { w: number; h: number },
      controls: {
        topRowY: number;
        topKnobSize: number;
        topLabelOffset: number;
        lowerRowY: number;
        lowerKnobSize: number;
        lowerLabelOffset: number;
      },
    ) => {
      const topKnobBottom = controls.topRowY * box.h / 100 + controls.topKnobSize * box.w / 200;
      const topLabelTop = (controls.topRowY + controls.topLabelOffset) * box.h / 100 - postLabelHeight / 2;
      const topLabelBottom = topLabelTop + postLabelHeight;
      const lowerKnobTop = controls.lowerRowY * box.h / 100 - controls.lowerKnobSize * box.w / 200;
      const lowerKnobBottom = controls.lowerRowY * box.h / 100 + controls.lowerKnobSize * box.w / 200;
      const lowerLabelTop = (controls.lowerRowY + controls.lowerLabelOffset) * box.h / 100 - postLabelHeight / 2;

      expect(topLabelTop - topKnobBottom).toBeGreaterThanOrEqual(2);
      expect(lowerKnobTop - topLabelBottom).toBeGreaterThanOrEqual(3.25);
      expect(lowerLabelTop - lowerKnobBottom).toBeGreaterThanOrEqual(2);
    };

    expectSeparatedRows(modules.modulator.box, modulator);
    expectSeparatedRows(modules.delay.box, delay);
    expectSeparatedRows(modules.reverb.box, reverb);
  });

  it("gives every Post pedal one physical knob, toggle, footswitch, and LED size", () => {
    const { modules, modulator, delay, reverb } = NAM_POST_FX_FACEPLATE_LAYOUT;
    const entries = [
      { box: modules.modulator.box, controls: modulator },
      { box: modules.delay.box, controls: delay },
      { box: modules.reverb.box, controls: reverb },
    ];
    const physical = entries.map(({ box, controls }) => ({
      footDiameter: controls.footSize * box.w / 100,
      ledDiameter: controls.ledSize * box.w / 100,
      topKnobDiameter: controls.topKnobSize * box.w / 100,
      lowerKnobDiameter: controls.lowerKnobSize * box.w / 100,
      ledBaseline: box.y + controls.ledY * box.h / 100,
      labelBaseline: box.y + controls.stateLabelY * box.h / 100,
      footBaseline: box.y + controls.footY * box.h / 100,
    }));

    for (const item of physical.slice(1)) {
      expect(item.footDiameter).toBeCloseTo(physical[0].footDiameter, 3);
      expect(item.ledDiameter).toBeCloseTo(physical[0].ledDiameter, 3);
      expect(item.topKnobDiameter).toBeCloseTo(physical[0].topKnobDiameter, 3);
      expect(item.lowerKnobDiameter).toBeCloseTo(physical[0].lowerKnobDiameter, 3);
      expect(Math.abs(item.ledBaseline - physical[0].ledBaseline)).toBeLessThanOrEqual(.1);
      expect(Math.abs(item.labelBaseline - physical[0].labelBaseline)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(item.footBaseline - physical[0].footBaseline)).toBeLessThanOrEqual(.6);
    }

    expect(physical[0].footDiameter).toBe(NAM_PEDAL_HARDWARE_STANDARD_PX.footswitch);
    expect(physical[0].ledDiameter).toBe(NAM_PEDAL_HARDWARE_STANDARD_PX.led);
    expect(physical[0].topKnobDiameter).toBe(NAM_PEDAL_HARDWARE_STANDARD_PX.knob);
    expect(physical[0].lowerKnobDiameter).toBe(NAM_PEDAL_HARDWARE_STANDARD_PX.knob);
    expect(modulator.footerToggleSize * modules.modulator.box.w / 100)
      .toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.toggle, 8);
    expect(delay.secondaryFootSize * modules.delay.box.w / 100)
      .toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.footswitch, 8);
    expect(delay.secondaryLedSize * modules.delay.box.w / 100)
      .toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.led, 8);
    expect(modulator.headerToggleSize * modules.modulator.box.w / 100)
      .toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.toggle, 8);
  });

  it("shares one optical centreline across the Modulator display and header toggles", () => {
    const { modulator } = NAM_POST_FX_FACEPLATE_LAYOUT;
    const displayCenterY = modulator.headerDisplayY + modulator.headerDisplayH / 2;

    expect(displayCenterY).toBeCloseTo(modulator.headerCenterY, 5);
    expect(modulator.headerDisplayY).toBeGreaterThan(14);
    expect(modulator.headerCenterY).toBeLessThan(modulator.topRowY - 12);
  });

  it("fits all three taller bodies within compact through Max stage placements", () => {
    const viewports = [
      { width: 720, height: 410 },
      { width: 1010, height: 520 },
      { width: 3530, height: 1946 },
    ];
    const sizes = [80, 100, 140, 180, 220];
    const { group, modules } = NAM_POST_FX_FACEPLATE_LAYOUT;

    for (const viewport of viewports) {
      for (const size of sizes) {
        const placement = computePremiumStagePlacement(viewport, group, size);
        for (const { box } of Object.values(modules)) {
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

  it("binds every Post FX title and control row to the shared geometry contract", () => {
    const source = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/name="(?:modulator|delay|reverb)"[^>]*titleY=\{7\}/);
    expect(source).toContain("titleY={postLayout.modules.modulator.titleY}");
    expect(source).toContain("titleY={postLayout.modules.delay.titleY}");
    expect(source).toContain("titleY={postLayout.modules.reverb.titleY}");
    expect(source).toContain("y={postLayout.modulator.footY}");
    expect(source).toContain("y={postLayout.delay.footY}");
    expect(source).toContain("y={postLayout.reverb.footY}");
    expect(source).toContain("size={postLayout.modulator.ledSize}");
    expect(source).toContain("size={postLayout.delay.ledSize}");
    expect(source).toContain("size={postLayout.reverb.ledSize}");
    expect(source).toContain("x={postLayout.modulator.primaryX}");
    expect(source).toContain("x={postLayout.delay.primaryX}");
    expect(source).toContain("x={postLayout.reverb.primaryX}");
    expect(source).toContain("size={postLayout.delay.secondaryFootSize}");
    expect(source).toContain("size={postLayout.delay.secondaryLedSize}");
    expect(source).toContain("size={postLayout.modulator.topKnobSize}");
    expect(source).toContain("size={postLayout.delay.lowerKnobSize}");
    expect(source).toContain("labelOffset={postLayout.reverb.lowerLabelOffset}");

    const widePedalSource = source.match(/function WidePedal\([\s\S]*?\n}\n\nfunction TopShell/)?.[0] ?? "";
    expect(widePedalSource).not.toContain("<Screw");
    expect(NAM_POST_FX_FACEPLATE_LAYOUT).not.toHaveProperty("screws");
  });
});
