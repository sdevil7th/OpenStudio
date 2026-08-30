import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TONE3000_QUERY_DEBOUNCE_MS,
  buildTONE3000LiveSearchSnapshot,
  createTONE3000QueryDebouncer,
  createTONE3000SearchEpoch,
} from "../utils/tone3000LiveSearch";

function snapshot(overrides: Partial<Parameters<typeof buildTONE3000LiveSearchSnapshot>[0]> = {}) {
  return buildTONE3000LiveSearchSnapshot({
    query: "",
    page: 1,
    pageSize: 12,
    targetPageSize: 24,
    requestedSort: "trending",
    sortMode: "trending",
    tab: "trending",
    gearFilter: "amp_amp-cab",
    format: "nam",
    architecture: "a2",
    sourceFlow: "amp",
    sourceFlowCategoryFilter: "all",
    includeModels: false,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TONE3000 live search request snapshots", () => {
  it("trims text and requests best-match for every non-empty query", () => {
    const request = snapshot({ query: "  mesa lead  ", requestedSort: "newest" });

    expect(request.query).toBe("mesa lead");
    expect(request.sort).toBe("best-match");
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("preserves the selected API sort for an empty query", () => {
    expect(snapshot({ query: "   ", requestedSort: "downloads-all-time" }).sort).toBe("downloads-all-time");
  });

  it("uses one search signature across pages and a distinct cache key per page", () => {
    const first = snapshot({ query: "clean", page: 1 });
    const second = snapshot({ query: "clean", page: 2 });

    expect(first.signature).toBe(second.signature);
    expect(first.cacheKey).not.toBe(second.cacheKey);
  });
});

describe("TONE3000 live search request epochs", () => {
  it("rejects stale success, error, and finally handlers after a replacement starts", () => {
    const epoch = createTONE3000SearchEpoch();
    const first = epoch.begin(snapshot({ architecture: "a1" }).signature);
    const second = epoch.begin(snapshot({ architecture: "a2" }).signature);

    expect(epoch.isCurrent(first)).toBe(false);
    expect(epoch.isCurrent(second)).toBe(true);

    epoch.invalidate();
    expect(epoch.isCurrent(second)).toBe(false);
  });
});

describe("TONE3000 query debounce", () => {
  it("commits only the latest value after 400 ms", () => {
    vi.useFakeTimers();
    const committed = vi.fn();
    const debounce = createTONE3000QueryDebouncer(committed);

    debounce.schedule("m");
    debounce.schedule("me");
    debounce.schedule("mesa");
    vi.advanceTimersByTime(TONE3000_QUERY_DEBOUNCE_MS - 1);
    expect(committed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenLastCalledWith("mesa");
  });

  it("flushes Enter/search immediately and cancels the pending duplicate", () => {
    vi.useFakeTimers();
    const committed = vi.fn();
    const debounce = createTONE3000QueryDebouncer(committed);

    debounce.schedule("modern high gain");
    debounce.flush("modern high gain");
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenLastCalledWith("modern high gain");

    vi.advanceTimersByTime(TONE3000_QUERY_DEBOUNCE_MS * 2);
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("does not commit after cancellation", () => {
    vi.useFakeTimers();
    const committed = vi.fn();
    const debounce = createTONE3000QueryDebouncer(committed);

    debounce.schedule("a2 clean");
    debounce.cancel();
    vi.runAllTimers();

    expect(committed).not.toHaveBeenCalled();
  });
});
