// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computePremiumStagePlacement,
  cycleNAMDesignEnumValue,
  distortionModeDisplayLabel,
  namRotaryValueFromDrag,
  namThreePositionSelectorDetentPlacement,
  NAM_DISTORTION_FACEPLATE_LAYOUT,
  NAM_PRE_SIGNAL_LAYOUT,
  NAM_THREE_POSITION_SELECTOR_DETENT_RADIUS_PERCENT,
  NAM_THREE_POSITION_SELECTOR_PX,
  NAM_THREE_POSITION_SELECTOR_ROTATIONS,
  snapNAMDesignEnumValue,
} from "../components/NAMRackDesignPort";
import { NAM_RACK_ADVANCED_CONTROL_IDS } from "../components/NAMRackMixer";
import {
  projectNAMRackSchemaForUI,
  type BuiltInParamDescriptor,
  type BuiltInPluginSchema,
} from "../services/NativeBridge";

const modeParam: BuiltInParamDescriptor = {
  id: "chaosMode",
  label: "Mode",
  type: "enum",
  value: 0,
  min: 0,
  max: 2,
  defaultValue: 0,
  enumOptions: [
    { value: 0, label: "Heavy" },
    { value: 1, label: "Extreme" },
    { value: 2, label: "Crunch" },
  ],
};

describe("NAM Rack current Distortion controls", () => {
  it("uses the clean-room mode order and cycles every enum option", () => {
    expect(modeParam.enumOptions?.map((option) => option.label)).toEqual([
      "Heavy",
      "Extreme",
      "Crunch",
    ]);
    expect(cycleNAMDesignEnumValue(modeParam)).toBe(1);
    expect(cycleNAMDesignEnumValue({ ...modeParam, value: 1 })).toBe(2);
    expect(cycleNAMDesignEnumValue({ ...modeParam, value: 2 })).toBe(0);
    expect(cycleNAMDesignEnumValue(modeParam, -1)).toBe(2);
    expect(snapNAMDesignEnumValue(modeParam, -1)).toBe(0);
    expect(snapNAMDesignEnumValue(modeParam, 0.49)).toBe(0);
    expect(snapNAMDesignEnumValue(modeParam, 0.51)).toBe(1);
    expect(snapNAMDesignEnumValue(modeParam, 1.49)).toBe(1);
    expect(snapNAMDesignEnumValue(modeParam, 1.51)).toBe(2);
    expect(snapNAMDesignEnumValue(modeParam, 3)).toBe(2);
    expect([0, 1, 2].map((value) => distortionModeDisplayLabel(value)))
      .toEqual(["HEAVY", "XTREME", "CRUNCH"]);
  });

  it("snaps normal rotary drags to stable enum detents", () => {
    const drag = {
      pointerId: 1,
      centerX: 100,
      centerY: 100,
      startX: 100,
      startY: 100,
      startValue: 0,
      startNormalized: 0,
      lastAngle: 0,
      accumulatedAngle: 0,
      mode: "pending" as const,
    };

    const firstDetent = namRotaryValueFromDrag(modeParam, drag, 100, 60);
    const lastDetent = namRotaryValueFromDrag(modeParam, drag, 100, -15);
    expect(firstDetent.mode).toBe("vertical");
    expect(snapNAMDesignEnumValue(modeParam, firstDetent.value)).toBe(1);
    expect(snapNAMDesignEnumValue(modeParam, lastDetent.value)).toBe(2);
  });

  it("exposes Mode and Weight in the schema-driven advanced group", () => {
    expect(NAM_RACK_ADVANCED_CONTROL_IDS.chaos).toEqual([
      "chaosEnabled",
      "chaosMode",
      "chaosDrive",
      "chaosWeight",
      "chaosTone",
      "chaosGate",
      "chaosMix",
      "chaosLevelDb",
    ]);
  });

  it("uses a top-left mode header and balanced control/footer zones", () => {
    const layout = NAM_DISTORTION_FACEPLATE_LAYOUT;
    expect(layout.columns).toEqual([22, 50, 78]);
    expect(layout.columns[1] - layout.columns[0]).toBe(
      layout.columns[2] - layout.columns[1],
    );
    expect(layout.columns[1]).toBe(50);

    // Displays use the Chorus pedal's safe 7% edge; rotary hardware uses a
    // centre anchor and shares the display's physical lower baseline.
    const box = NAM_PRE_SIGNAL_LAYOUT.distortion;
    const displayLeft = layout.modeDisplay.x;
    const displayRight = (layout.modeDisplay.x + layout.modeDisplay.w) * box.w / 100;
    const selectorLeft = (layout.modeSelector.x - layout.modeSelector.size / 2) * box.w / 100;
    const selectorRight = (layout.modeSelector.x + layout.modeSelector.size / 2) * box.w / 100;
    const displayBottom = (layout.modeDisplay.y + layout.modeDisplay.h) * box.h / 100;
    const selectorBottom = layout.modeSelector.y * box.h / 100 + layout.modeSelector.size * box.w / 200;
    expect(displayLeft).toBe(7);
    expect(selectorLeft - displayRight).toBeGreaterThanOrEqual(5.5);
    expect(box.w - selectorRight).toBeGreaterThanOrEqual(30);
    expect(selectorBottom).toBeCloseTo(displayBottom, 4);
    expect(layout.modeSelector.size * box.w / 100).toBeCloseTo(NAM_THREE_POSITION_SELECTOR_PX, 8);
    expect(layout.modeSelector.size).toBeLessThan(layout.topKnobSize);
    expect(layout.modeDisplay.y + layout.modeDisplay.h).toBeLessThan(
      layout.topY - layout.topKnobSize / 2,
    );

    const topLabelY = layout.topY + layout.topLabelOffset;
    const lowerLabelY = layout.lowerY + layout.lowerLabelOffset;
    expect(layout.lowerY - layout.topY).toBeGreaterThan(0);
    expect(layout.lowerY - layout.topY).toBeLessThanOrEqual(20);
    expect(topLabelY).toBeLessThan(layout.lowerY);
    expect(lowerLabelY).toBeLessThan(layout.titleY);
    expect(layout.titleY).toBeLessThan(layout.led.y);
    expect(layout.led.y).toBeLessThan(layout.stateLabelY);
    expect(layout.stateLabelY).toBeLessThan(layout.foot.y);

    expect(NAM_THREE_POSITION_SELECTOR_ROTATIONS).toEqual([-52, 0, 52]);
    expect(NAM_THREE_POSITION_SELECTOR_ROTATIONS[1] - NAM_THREE_POSITION_SELECTOR_ROTATIONS[0])
      .toBeGreaterThanOrEqual(50);
    expect(NAM_THREE_POSITION_SELECTOR_ROTATIONS[2] - NAM_THREE_POSITION_SELECTOR_ROTATIONS[1])
      .toBeGreaterThanOrEqual(50);
    for (const rotation of NAM_THREE_POSITION_SELECTOR_ROTATIONS) {
      const detent = namThreePositionSelectorDetentPlacement(rotation);
      const dx = detent.x - 50;
      const dy = 50 - detent.y;
      expect(Math.hypot(dx, dy)).toBeCloseTo(NAM_THREE_POSITION_SELECTOR_DETENT_RADIUS_PERCENT, 8);
      expect(Math.atan2(dx, dy) * 180 / Math.PI).toBeCloseTo(rotation, 8);
    }

    const designSource = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");
    expect(designSource).toContain('labelText="WGHT"');
    expect(designSource).toContain('labelText="LVL"');
    expect(designSource).toContain('className="distortion-mode-display"');
    expect(designSource).toContain("<ThreePositionRotarySelector");
    expect(designSource).toContain("NAM_DISTORTION_FACEPLATE_LAYOUT.modeSelector");
    expect(designSource).toContain('paramId="chaosMode"');
    expect(designSource).toContain("stateRotations={NAM_THREE_POSITION_SELECTOR_ROTATIONS}");
    expect(designSource).toContain('assetId={CONTROLS.knobBlueSteel}');
    expect(designSource).toContain("enableButtonDrag");
    expect(designSource).toContain("snapNAMDesignEnumValue(param, next.value)");
    expect(designSource).toContain("suppressNextButtonClickRef");
    expect(designSource).toContain("(isButtonLike && !enableButtonDrag)");
    expect(designSource).not.toContain("three-position-selector-pointer");
    expect(designSource).not.toContain('className="distortion-mode-control"');
  });

  it("fits every pedal-stage size inside the canvas reserved before the library drawer", () => {
    const viewport = { width: 3530, height: 1946 };
    const pedalGroup = { x: 40, y: 3, w: 724, h: 271 };
    const sizes = [80, 100, 140, 180, 220];
    const placements = sizes.map((size) =>
      computePremiumStagePlacement(viewport, pedalGroup, size),
    );

    for (const placement of placements) {
      const left = placement.left + pedalGroup.x * placement.scale;
      const right = left + pedalGroup.w * placement.scale;
      const top = placement.top + pedalGroup.y * placement.scale;
      const bottom = top + pedalGroup.h * placement.scale;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(viewport.width);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThanOrEqual(viewport.height);
    }

    expect(placements.map(({ scale }) => scale)).toEqual(
      [...placements.map(({ scale }) => scale)].sort((a, b) => a - b),
    );
    expect(placements[placements.length - 1].scale).toBeGreaterThan(placements[0].scale);
  });

  it("gives Weight and the Distortion gate explicit current-control semantics", () => {
    const schema: BuiltInPluginSchema = {
      schemaVersion: 1,
      name: "OpenStudio NAM Rack",
      category: "Built-in",
      chain: "track",
      fxIndex: 0,
      parameters: [
        {
          id: "chaosWeight",
          label: "Weight",
          type: "continuous",
          value: 0.5,
          min: 0,
          max: 1,
          defaultValue: 0.5,
        },
        {
          id: "chaosGate",
          label: "Gate",
          type: "continuous",
          value: 0.22,
          min: 0,
          max: 1,
          defaultValue: 0.22,
          graphRole: "distortion",
        },
      ],
      modelState: { namEffectsDspVersion: 8 },
    };
    const projected = projectNAMRackSchemaForUI(schema);
    expect(projected.parameters[0].label).toBe("Weight (Tight to Thick)");
    expect(projected.parameters[1]).toMatchObject({
      id: "chaosGate",
      label: "Dist Gate",
      type: "continuous",
      value: 0.22,
      min: 0,
      max: 1,
      defaultValue: 0.22,
      graphRole: "distortion",
    });
    expect(projectNAMRackSchemaForUI({ ...schema, parameters: [] }).parameters)
      .toEqual([]);
  });

  it("wires the current controls through defaults, templates, mock schema, and every pedal surface", () => {
    const panelSource = readFileSync(new URL("../components/NAMRackPanel.tsx", import.meta.url), "utf8");
    const bridgeSource = readFileSync(new URL("../services/NativeBridge.ts", import.meta.url), "utf8");
    const designSource = readFileSync(new URL("../components/NAMRackDesignPort.tsx", import.meta.url), "utf8");

    expect(panelSource).toContain("chaosMode: 0");
    expect(panelSource).toContain("chaosWeight: 0.5");
    expect(panelSource).toContain("chaosWeight: 0.28");
    expect(panelSource).toContain("chaosGate: 0.22");
    expect(panelSource).toContain('"chaosTone", "chaosGate", "chaosMix"');
    expect(bridgeSource).toContain('chaosMode: [{ value: 0, label: "Heavy" }, { value: 1, label: "Extreme" }, { value: 2, label: "Crunch" }]');
    expect(bridgeSource).toContain('param("chaosWeight", "Weight (Tight to Thick)", 0.5, 0, 1');
    expect(bridgeSource).toContain('param("chaosGate", "Dist Gate", 0.22, 0, 1, "", "distortion")');
    expect(designSource).toContain('paramId="chaosMode"');
    expect(designSource).toContain('paramId="chaosWeight"');
    expect(designSource).toContain('paramId="chaosGate"');
  });
});
