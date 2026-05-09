import { describe, expect, it } from "vitest";
import manifest from "../../../tools/assistant-runtime-profiles.json";

describe("assistant audio analyzer manifest", () => {
  it("uses MiDashengLM as the core analyzer and avoids restricted defaults", () => {
    const audioUnderstanding = manifest.audioUnderstanding;
    expect(audioUnderstanding.downloadPolicy).toBe("single_verified_profile");
    expect(audioUnderstanding.verificationRequired).toBe(true);
    expect(audioUnderstanding.nonBlocking).toBe(false);
    expect(audioUnderstanding.defaultOrder).toEqual(["midashenglm-7b-1021-bf16-local-cuda"]);
    expect(audioUnderstanding.profiles["midashenglm-7b-1021-bf16-local-cuda"].modelRepo).toBe(
      "mispeech/midashenglm-7b-1021-bf16",
    );
    expect(audioUnderstanding.profiles["midashenglm-7b-1021-bf16-local-cuda"].license).toBe(
      "apache-2.0",
    );
    expect(audioUnderstanding.profiles["midashenglm-7b-1021-bf16-local-cuda"].requiresLicenseAcceptance).toBe(
      false,
    );
    expect(audioUnderstanding.profiles["step-audio-2-mini-local-cuda"].candidateOnly).toBe(true);
    expect(JSON.stringify(audioUnderstanding).toLowerCase()).not.toContain("nvidia");
    expect(JSON.stringify(audioUnderstanding).toLowerCase()).not.toContain("flamingo");
    expect(manifest.defaultOrder.join(" ")).not.toContain("qwen25-omni-3b");
  });
});
