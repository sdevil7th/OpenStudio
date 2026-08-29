// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NAM_PEDAL_HARDWARE_STANDARD_PX,
  NAM_PRECISION_DRIVE_FACEPLATE_LAYOUT,
  NAM_PRECISION_DRIVE_GATE_KNOB_PX,
  NAM_PRE_SIGNAL_LAYOUT,
} from "../components/NAMRackDesignPort";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("NAM Rack Precision Drive Gate control", () => {
  it("centres a compact Gate rotary among the four main controls", () => {
    const layout = NAM_PRECISION_DRIVE_FACEPLATE_LAYOUT;
    const box = NAM_PRE_SIGNAL_LAYOUT.precisionDrive;
    const xPx = (percentage: number) => box.w * percentage / 100;
    const yPx = (percentage: number) => box.h * percentage / 100;

    expect(box).toMatchObject({ w: 120, h: 232 });
    expect(xPx(layout.gate.x)).toBeCloseTo(60, 8);
    expect(yPx(layout.gate.y)).toBeCloseTo(76.56, 8);
    expect(layout.gate.x).toBe((layout.columns[0] + layout.columns[1]) / 2);
    expect(xPx(layout.gate.size)).toBeCloseTo(NAM_PRECISION_DRIVE_GATE_KNOB_PX, 8);
    expect(NAM_PRECISION_DRIVE_GATE_KNOB_PX).toBeLessThan(
      NAM_PEDAL_HARDWARE_STANDARD_PX.knob,
    );
    expect(xPx(layout.gate.hitSize)).toBeCloseTo(20, 8);
    expect(xPx(layout.knobSize)).toBeCloseTo(28, 8);
    expect(xPx(layout.knobHitSize)).toBeCloseTo(28, 8);

    for (const mainY of [layout.topY, layout.lowerY]) {
      for (const mainX of layout.columns) {
        const centreDistance = Math.hypot(
          xPx(Math.abs(layout.gate.x - mainX)),
          yPx(Math.abs(layout.gate.y - mainY)),
        );
        expect(centreDistance).toBeGreaterThan((28 + NAM_PRECISION_DRIVE_GATE_KNOB_PX) / 2);
      }
    }
  });

  it("binds the active Design Port rotary to the existing drive-local Gate", () => {
    const designSource = readSource(
      "../components/NAMRackDesignPort.tsx",
    );
    const parameterIndex = designSource.indexOf(
      'paramId="precisionDriveGate"',
    );
    const controlStart = designSource.lastIndexOf(
      "<CompactKnob",
      parameterIndex,
    );
    const controlEnd = designSource.indexOf("/>", parameterIndex);
    const controlSource = designSource.slice(controlStart, controlEnd + 2);

    expect(parameterIndex).toBeGreaterThan(-1);
    expect(controlStart).toBeGreaterThan(-1);
    expect(controlSource).toContain('kind="black"');
    expect(controlSource).toContain('semanticLabel="Drive Gate"');
    expect(controlSource).toContain('labelText=""');
    expect(controlSource).toContain("driveLayout.gate.x");
    expect(controlSource).toContain("driveLayout.gate.y");
    expect(controlSource).toContain("driveLayout.gate.size");
    expect(controlSource).toContain("driveLayout.gate.hitSize");
    const driveStage = designSource.slice(
      designSource.indexOf('box={NAM_PRE_SIGNAL_LAYOUT.precisionDrive}'),
      designSource.indexOf("box={NAM_PRE_SIGNAL_LAYOUT.distortion}"),
    );
    expect(driveStage).not.toContain("precisionDriveVoice");
  });

  it("retains the same parameter across defaults, schema, and the active control surface", () => {
    const panelSource = readSource("../components/NAMRackPanel.tsx");
    const bridgeSource = readSource("../services/NativeBridge.ts");
    const designSource = readSource("../components/NAMRackDesignPort.tsx");

    expect(panelSource).toContain("precisionDriveGate: 0");
    expect(panelSource).toContain('"precisionDriveGate", "precisionDriveDrive"');
    expect(bridgeSource).toContain(
      'param("precisionDriveGate", "PD Gate", 0, 0, 1, "", "drive")',
    );
    expect(designSource).toContain('paramId="precisionDriveGate"');
    expect(designSource).toContain('semanticLabel="Drive Gate"');
  });
});
