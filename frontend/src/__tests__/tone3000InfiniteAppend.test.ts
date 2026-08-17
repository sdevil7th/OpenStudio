// @ts-expect-error The app tsconfig omits Node builtin typings, while Vitest runs this source audit in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createTONE3000AppendGate,
  observeTONE3000AppendSentinel,
  shouldRetryTONE3000Append,
} from "../utils/tone3000InfiniteAppend";

describe("TONE3000 infinite append gate", () => {
  it("allows one request per search/page and advances only to a new key", () => {
    const gate = createTONE3000AppendGate();
    const first = gate.begin("mesa:a2:page:2");

    expect(first).not.toBeNull();
    expect(gate.begin("mesa:a2:page:2")).toBeNull();
    gate.settle(first!, "success");
    expect(gate.begin("mesa:a2:page:2")).toBeNull();
    expect(gate.begin("mesa:a2:page:3")).not.toBeNull();
  });

  it("blocks an automatic error loop but allows the accessible manual retry", () => {
    const gate = createTONE3000AppendGate();
    const first = gate.begin("clean:a1:page:4");
    gate.settle(first!, "error");

    expect(gate.begin("clean:a1:page:4")).toBeNull();
    expect(gate.begin("clean:a1:page:4", true)).not.toBeNull();
  });

  it("releases stale work and resets state for a changed search signature", () => {
    const gate = createTONE3000AppendGate();
    const first = gate.begin("old:page:2");
    gate.settle(first!, "stale");
    expect(gate.begin("old:page:2")).not.toBeNull();

    gate.reset();
    expect(gate.begin("old:page:2")).not.toBeNull();
  });

  it("routes only the matching failed append through manual load-more retry", () => {
    const failure = {
      mode: "append" as const,
      page: 3,
      signature: "mesa:a2",
      status: "Live TONE3000 search failed",
    };

    expect(shouldRetryTONE3000Append(
      failure,
      "mesa:a2",
      "Live TONE3000 search failed",
      true,
    )).toBe(true);
    expect(shouldRetryTONE3000Append(failure, "clean:a2", failure.status, true)).toBe(false);
    expect(shouldRetryTONE3000Append(failure, failure.signature, "Catalog unavailable", true)).toBe(false);
    expect(shouldRetryTONE3000Append({ ...failure, mode: "replace" }, failure.signature, failure.status, true)).toBe(false);
    expect(shouldRetryTONE3000Append(failure, failure.signature, failure.status, false)).toBe(false);
  });
});

describe("TONE3000 append sentinel", () => {
  it("observes the real scroll root at the viewport edge and disconnects cleanly", () => {
    const target = {} as Element;
    const root = {} as Element;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const onIntersect = vi.fn();
    let callback!: IntersectionObserverCallback;
    let options!: IntersectionObserverInit;

    const cleanup = observeTONE3000AppendSentinel(target, root, onIntersect, (nextCallback, nextOptions) => {
      callback = nextCallback;
      options = nextOptions;
      return { observe, disconnect };
    });

    expect(observe).toHaveBeenCalledWith(target);
    expect(options).toMatchObject({ root, rootMargin: "0px", threshold: 0.01 });

    callback([{ isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(onIntersect).not.toHaveBeenCalled();
    callback([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(onIntersect).toHaveBeenCalledTimes(1);

    cleanup();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the sentinel is not mounted", () => {
    const factory = vi.fn();
    const cleanup = observeTONE3000AppendSentinel(null, null, vi.fn(), factory);

    expect(factory).not.toHaveBeenCalled();
    expect(cleanup()).toBeUndefined();
  });

  it("re-arms source-flow observation when the search/page request signature changes", () => {
    const explorerSource = readFileSync(
      new URL("../components/NAMExplorer.tsx", import.meta.url),
      "utf8",
    );
    const designPortSource = readFileSync(
      new URL("../components/NAMRackDesignPort.tsx", import.meta.url),
      "utf8",
    );

    expect(explorerSource).toContain('requestKey: `${currentLiveSearchSignature}:page:${livePage + 1}`');
    expect(designPortSource).toContain("requestKey: string");
    expect(designPortSource).toContain("config.pagination?.requestKey]);");
  });
});
