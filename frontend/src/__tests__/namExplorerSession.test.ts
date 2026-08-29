import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNAMExplorerSessionEpoch,
  createNAMSessionKeyedResourceCache,
  createNAMSessionResourceCache,
  getNAMExplorerSessionView,
  NAMSessionResourceInvalidatedError,
  resetNAMExplorerSessionForTests,
  setNAMExplorerSessionView,
  updateNAMExplorerSessionScroll,
  type NAMExplorerSessionView,
} from "../services/namExplorerSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function sessionView(overrides: Partial<NAMExplorerSessionView> = {}): NAMExplorerSessionView {
  return {
    tab: "trending",
    sortMode: "trending",
    query: "mesa",
    committedQuery: "mesa",
    architecture: "a2",
    gearFilter: "amp_amp-cab",
    sourceFlowCategoryFilter: "all",
    creatorFilter: "all",
    licenseFilter: "all",
    instrumentFilter: "all",
    characterFilter: "all",
    availabilityFilter: "all",
    viewMode: "list",
    filtersOpen: false,
    catalogMode: "live",
    catalog: [],
    catalogGeneratedAt: "",
    catalogSource: "tone3000-live",
    catalogRefreshedAtMs: 1,
    livePage: 3,
    liveTotalPages: 8,
    liveTotal: 80,
    liveHasMore: true,
    liveSearchSignature: "mesa:a2",
    scrollTop: 240,
    ...overrides,
  };
}

afterEach(() => {
  resetNAMExplorerSessionForTests();
  vi.restoreAllMocks();
});

describe("NAM Explorer session resources", () => {
  it("serves a fresh resource without calling the loader again", async () => {
    let now = 100;
    const cache = createNAMSessionResourceCache<number>(500, () => now);
    const loader = vi.fn(async () => 42);

    expect(await cache.load(loader)).toBe(42);
    now = 599;
    expect(await cache.load(loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps stale data readable while sharing one revalidation request", async () => {
    let now = 0;
    const cache = createNAMSessionResourceCache<string>(100, () => now);
    cache.set("stale catalog");
    now = 101;
    expect(cache.peek()?.value).toBe("stale catalog");
    expect(cache.peekFresh()).toBeUndefined();

    const next = deferred<string>();
    const loader = vi.fn(() => next.promise);
    const first = cache.load(loader);
    const second = cache.load(loader);

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.peek()?.value).toBe("stale catalog");

    next.resolve("revalidated catalog");
    await expect(first).resolves.toBe("revalidated catalog");
    expect(cache.peekFresh()?.value).toBe("revalidated catalog");
  });

  it("rejects a pre-mutation response and publishes only the replacement generation", async () => {
    const cache = createNAMSessionResourceCache<string>();
    const beforeMutation = deferred<string>();
    const afterMutation = deferred<string>();
    const firstLoader = vi.fn(() => beforeMutation.promise);
    const replacementLoader = vi.fn(() => afterMutation.promise);

    const staleRequest = cache.load(firstLoader);
    cache.invalidate();
    const replacementRequest = cache.load(replacementLoader, { force: true });

    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(replacementLoader).toHaveBeenCalledTimes(1);

    afterMutation.resolve("installed-after-mutation");
    await expect(replacementRequest).resolves.toBe("installed-after-mutation");

    beforeMutation.resolve("installed-before-mutation");
    await expect(staleRequest).rejects.toBeInstanceOf(NAMSessionResourceInvalidatedError);
    expect(cache.peekFresh()?.value).toBe("installed-after-mutation");
  });

  it("keeps an authoritative set when an older loader resolves afterward", async () => {
    const cache = createNAMSessionResourceCache<string>();
    const oldRead = deferred<string>();
    const staleRequest = cache.load(() => oldRead.promise);

    cache.set("authoritative-refresh");
    oldRead.resolve("older-catalog-read");

    await expect(staleRequest).rejects.toBeInstanceOf(NAMSessionResourceInvalidatedError);
    expect(cache.peekFresh()?.value).toBe("authoritative-refresh");
  });

  it("deduplicates keyed page requests and permits an explicit failed-entry removal", async () => {
    const cache = createNAMSessionKeyedResourceCache<number>(4);
    const next = deferred<number>();
    const loader = vi.fn(() => next.promise);

    const first = cache.load("query:page:2", loader);
    const second = cache.load("query:page:2", loader);
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);

    next.resolve(2);
    await first;
    expect(cache.peekFresh("query:page:2")?.value).toBe(2);
    cache.delete("query:page:2");
    expect(cache.peek("query:page:2")).toBeUndefined();
  });
});

describe("NAM Explorer remount view", () => {
  it("rejects a local refresh captured for an older source-flow session", () => {
    const epoch = createNAMExplorerSessionEpoch("source-flow:amp");
    const ampRefresh = epoch.capture();

    epoch.update("source-flow:pedal");

    expect(epoch.isCurrent(ampRefresh)).toBe(false);
    expect(epoch.isCurrent(epoch.capture())).toBe(true);
  });

  it("retains live search, appended-page, filter, and scroll state for the session", () => {
    setNAMExplorerSessionView("source-flow:amp", sessionView());
    updateNAMExplorerSessionScroll("source-flow:amp", 615);

    expect(getNAMExplorerSessionView("source-flow:amp")).toMatchObject({
      query: "mesa",
      architecture: "a2",
      catalogMode: "live",
      livePage: 3,
      liveSearchSignature: "mesa:a2",
      scrollTop: 615,
    });
  });
});
