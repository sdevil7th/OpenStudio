import { describe, expect, it, vi } from "vitest";
import { installWebViewUUID } from "../utils/webViewCompatibility";

describe("embedded WebKit UUID compatibility", () => {
  it("preserves a platform implementation", () => {
    const randomUUID = vi.fn();
    const target = { randomUUID } as unknown as Crypto;
    installWebViewUUID(target);
    expect(target.randomUUID).toBe(randomUUID);
  });
  it("uses Web Crypto randomness with RFC v4 and variant bits", () => {
    let seed = 0;
    const random = vi.fn((bytes: Uint8Array) => { bytes.fill(++seed); return bytes; });
    const target = { getRandomValues: random } as unknown as Crypto;
    installWebViewUUID(target);
    const first = target.randomUUID();
    const second = target.randomUUID();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    expect(random).toHaveBeenCalledTimes(2);
  });
});
