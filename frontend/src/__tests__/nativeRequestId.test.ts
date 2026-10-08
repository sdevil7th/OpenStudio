import { afterEach, describe, expect, it, vi } from "vitest";
import { nextNativeRequestId } from "../utils/nativeRequestId";
afterEach(() => vi.restoreAllMocks());
describe("native request correlation", () => {
  it("keeps burst calls distinct across callers and backward clock changes", () => {
    const backend = {};
    const clock = vi.spyOn(Date, "now").mockReturnValue(1791225000000);
    const ids = Array.from({length:4000}, () => nextNativeRequestId(backend));
    expect(new Set(ids).size).toBe(ids.length);
    clock.mockReturnValue(1791224999000);
    expect(nextNativeRequestId(backend)).toBe(ids[ids.length-1]+1);
    expect(ids.every(Number.isSafeInteger)).toBe(true);
  });
  it("shares the sequence with the injected wrapper rather than starting another counter", () => {
    vi.spyOn(Date,"now").mockReturnValue(1791225000000);
    const backend={__openStudioLastNativeCallId:1791225000000500};
    expect(nextNativeRequestId(backend)).toBe(1791225000000501);
  });
});
