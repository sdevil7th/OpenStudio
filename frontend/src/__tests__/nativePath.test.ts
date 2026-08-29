import { describe, expect, it } from "vitest";
import { joinNativePath } from "../utils/nativePath";

describe("joinNativePath", () => {
  it("preserves native Windows and UNC separators", () => {
    expect(joinNativePath("C:\\Renders", "mix.wav")).toBe("C:\\Renders\\mix.wav");
    expect(joinNativePath("\\\\server\\share\\", "stem.wav"))
      .toBe("\\\\server\\share\\stem.wav");
  });

  it("uses POSIX separators for macOS/Linux and forward-slash Windows paths", () => {
    expect(joinNativePath("/home/user/renders/", "mix.wav"))
      .toBe("/home/user/renders/mix.wav");
    expect(joinNativePath("C:/Users/example/Renders", "mix.wav"))
      .toBe("C:/Users/example/Renders/mix.wav");
  });

  it("handles an empty directory and strips accidental leading separators", () => {
    expect(joinNativePath("", "/mix.wav")).toBe("mix.wav");
    expect(joinNativePath("/tmp/", "\\mix.wav")).toBe("/tmp/mix.wav");
  });
});
