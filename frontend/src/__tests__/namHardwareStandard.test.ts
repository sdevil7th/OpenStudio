import { describe, expect, it } from "vitest";
import {
  NAM_COMPRESSOR_FACEPLATE_LAYOUT,
  NAM_DISTORTION_FACEPLATE_LAYOUT,
  NAM_PANEL_ROTARY_VARIANT_PX,
  NAM_PEDAL_HARDWARE_STANDARD_PX,
  NAM_POST_FX_FACEPLATE_LAYOUT,
  NAM_PRE_FX_HARDWARE_LAYOUT,
  NAM_PRE_SIGNAL_LAYOUT,
  NAM_THREE_POSITION_SELECTOR_PX,
} from "../components/NAMRackDesignPort";

describe("NAM physical pedal hardware standard", () => {
  const diameter = (width: number, percentage: number) => width * percentage / 100;

  it("defines one publishable physical size per hardware class", () => {
    expect(NAM_PEDAL_HARDWARE_STANDARD_PX).toEqual({
      knob: 28,
      footswitch: 25,
      toggle: 24,
      led: 12,
    });
  });

  it("renders all shared pedal-control components from fixed artboard pixels", async () => {
    // The layout conversion protects declarative geometry; the actual asset
    // renderer is the final authority and must not fall back to local `%`.
    const source = (await import("../components/NAMRackDesignPort.tsx?raw")).default as string;
    expect(source).toContain("const visualSize = panelRotaryVariant");
    expect(source).toContain('hardwareKind="knob"');
    expect(source).toContain('hardwareKind="footswitch"');
    expect(source).toContain('hardwareKind="toggle"');
    expect(source).toContain('hardwareKind="led"');
    expect(source).toContain('"data-nam-hardware-standard-px"');
  });

  it("keeps deliberate console rotaries separate from pedal hardware", async () => {
    expect(NAM_PANEL_ROTARY_VARIANT_PX).toEqual({
      cabPanel: 42,
      roomHero: 68,
      ampPanel: 44,
    });

    const source = (await import("../components/NAMRackDesignPort.tsx?raw")).default as string;
    expect(source.match(/panelRotaryVariant="cabPanel"/g)).toHaveLength(7);
    expect(source.match(/panelRotaryVariant="roomHero"/g)).toHaveLength(2);
    expect(source.match(/panelRotaryVariant="ampPanel"/g)).toHaveLength(1);
    expect(source).toContain('"data-nam-panel-rotary-variant"');
  });

  it("converts every Pre pedal width back to the same physical dimensions", () => {
    for (const name of Object.keys(NAM_PRE_SIGNAL_LAYOUT) as Array<keyof typeof NAM_PRE_SIGNAL_LAYOUT>) {
      const box = NAM_PRE_SIGNAL_LAYOUT[name];
      const hardware = NAM_PRE_FX_HARDWARE_LAYOUT[name];
      expect(diameter(box.w, hardware.knobSize)).toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.knob, 8);
      expect(diameter(box.w, hardware.footSize)).toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.footswitch, 8);
      expect(diameter(box.w, hardware.toggleSize)).toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.toggle, 8);
      expect(diameter(box.w, hardware.ledSize)).toBeCloseTo(NAM_PEDAL_HARDWARE_STANDARD_PX.led, 8);
    }
  });

  it("uses that contract for compressor and distortion controls", () => {
    const compressorWidth = NAM_PRE_SIGNAL_LAYOUT.compressor.w;
    const distortionWidth = NAM_PRE_SIGNAL_LAYOUT.distortion.w;
    expect(diameter(compressorWidth, NAM_COMPRESSOR_FACEPLATE_LAYOUT.knobSize)).toBeCloseTo(28, 8);
    expect(diameter(compressorWidth, NAM_COMPRESSOR_FACEPLATE_LAYOUT.hpfSelector.size)).toBeCloseTo(NAM_THREE_POSITION_SELECTOR_PX, 8);
    expect(diameter(compressorWidth, NAM_COMPRESSOR_FACEPLATE_LAYOUT.led.size)).toBeCloseTo(12, 8);
    expect(diameter(compressorWidth, NAM_COMPRESSOR_FACEPLATE_LAYOUT.foot.size)).toBeCloseTo(25, 8);
    expect(diameter(distortionWidth, NAM_DISTORTION_FACEPLATE_LAYOUT.topKnobSize)).toBeCloseTo(28, 8);
    expect(diameter(distortionWidth, NAM_DISTORTION_FACEPLATE_LAYOUT.gateKnobSize)).toBeCloseTo(28, 8);
    expect(diameter(distortionWidth, NAM_DISTORTION_FACEPLATE_LAYOUT.lowerKnobSize)).toBeCloseTo(28, 8);
    expect(diameter(distortionWidth, NAM_DISTORTION_FACEPLATE_LAYOUT.modeSelector.size)).toBeCloseTo(NAM_THREE_POSITION_SELECTOR_PX, 8);
    expect(NAM_THREE_POSITION_SELECTOR_PX).toBe(20);
    expect(NAM_THREE_POSITION_SELECTOR_PX).toBeLessThan(NAM_PEDAL_HARDWARE_STANDARD_PX.knob);
    expect(diameter(distortionWidth, NAM_DISTORTION_FACEPLATE_LAYOUT.led.size)).toBeCloseTo(12, 8);
    expect(diameter(distortionWidth, NAM_DISTORTION_FACEPLATE_LAYOUT.foot.size)).toBeCloseTo(25, 8);
  });

  it("uses that contract for every Post control, including Sync and ENS", () => {
    const { modules, modulator, delay, reverb } = NAM_POST_FX_FACEPLATE_LAYOUT;
    const checks = [
      [modules.modulator.box.w, modulator],
      [modules.delay.box.w, delay],
      [modules.reverb.box.w, reverb],
    ] as const;
    for (const [width, controls] of checks) {
      expect(diameter(width, controls.topKnobSize)).toBeCloseTo(28, 8);
      expect(diameter(width, controls.lowerKnobSize)).toBeCloseTo(28, 8);
      expect(diameter(width, controls.footSize)).toBeCloseTo(25, 8);
      expect(diameter(width, controls.ledSize)).toBeCloseTo(12, 8);
    }
    expect(diameter(modules.modulator.box.w, modulator.headerToggleSize)).toBeCloseTo(24, 8);
    expect(diameter(modules.modulator.box.w, modulator.footerToggleSize)).toBeCloseTo(24, 8);
    expect(diameter(modules.delay.box.w, delay.secondaryFootSize)).toBeCloseTo(25, 8);
    expect(diameter(modules.delay.box.w, delay.secondaryLedSize)).toBeCloseTo(12, 8);
  });
});
