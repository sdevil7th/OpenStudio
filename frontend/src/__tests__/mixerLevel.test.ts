import { describe, expect, it } from "vitest";
import { formatMixerLevel, parseMixerLevel } from "../utils/mixerLevel";

describe("numeric mixer level entry", () => {
  it.each([["-6.25", -6.25], [" +3 dB ", 3], [".5", 0.5], ["-60", -60], ["12", 12], ["-inf", -60], ["-Infinity", -60], ["-∞", -60]])(
    "accepts the bounded level %s", (draft, expected) => expect(parseMixerLevel(String(draft))).toBe(expected),
  );

  it.each(["", " ", "-", "6abc", "3,2", "1e2", "Infinity", "NaN", "12.1", "-60.01", "0x10"])(
    "keeps invalid draft %s out of the audio engine", (draft) => expect(parseMixerLevel(draft)).toBeNull(),
  );

  it("displays silence and matches the fader precision without changing the stored value", () => {
    expect(formatMixerLevel(-60)).toBe("-∞");
    expect(formatMixerLevel(-6.25)).toBe("-6.3");
    expect(formatMixerLevel(0)).toBe("0.0");
  });
});
