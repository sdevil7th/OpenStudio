import { describe, expect, it } from "vitest";
import { tone3000OriginFromRecord } from "../utils/tone3000Attribution";

describe("saved TONE3000 attribution", () => {
  it("recovers artwork and creator from an installed manifest after reload", () => {
    const manifest = JSON.parse(JSON.stringify({
      sourceProvider: "tone3000", toneId: 123, toneTitle: "Community Amp", localPath: "amp.nam",
      lastSeenMetadata: { imageUrl: "https://cdn.example/amp.png", creator: "ampmaker", gearType: "amp", format: "nam" },
    }));
    expect(tone3000OriginFromRecord(manifest)).toEqual({
      toneId: 123, title: "Community Amp", imageUrl: "https://cdn.example/amp.png", creator: "ampmaker", gear: "amp", format: "NAM",
    });
  });

  it("recognizes legacy provider URLs and cabinet IR file types", () => {
    expect(tone3000OriginFromRecord({ name: "Cabinet", sourceUrl: "https://www.tone3000.com/tones/456", localPath: "cab.wav" }))
      .toMatchObject({ title: "Cabinet", format: "IR" });
  });

  it.each(["https://tone3000.com.example/tones/1", "http://tone3000.com/tones/1", "https://example.com/tone3000.com"])("keeps unrelated local sources unbranded: %s", (sourceUrl) => {
    expect(tone3000OriginFromRecord({ name: "My capture", sourceUrl })).toBeUndefined();
  });

  it("keeps origin attribution for older manifests without artwork", () => {
    expect(tone3000OriginFromRecord({ sourceProvider: "tone3000", name: "Older tone" }))
      .toMatchObject({ title: "Older tone", format: "NAM", imageUrl: undefined });
  });
});
