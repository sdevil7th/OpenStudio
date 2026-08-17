import {
  type NAMCatalogTone,
  nativeBridge,
} from "./NativeBridge";

export const NAM_EXPLORER_SESSION_TTL_MS = 5 * 60 * 1000;
const NAM_LIVE_PAGE_CACHE_LIMIT = 64;
const NAM_TONE_DETAIL_CACHE_LIMIT = 128;

export type NAMSessionCacheEntry<T> = Readonly<{
  value: T;
  at: number;
}>;

export type NAMExplorerSessionEpochToken = Readonly<{
  key: string;
  generation: number;
}>;

export function createNAMExplorerSessionEpoch(initialKey: string) {
  let key = initialKey;
  let generation = 0;
  return {
    update(nextKey: string) {
      if (nextKey === key) return;
      key = nextKey;
      generation += 1;
    },
    capture(): NAMExplorerSessionEpochToken {
      return Object.freeze({ key, generation });
    },
    isCurrent(token: NAMExplorerSessionEpochToken) {
      return token.key === key && token.generation === generation;
    },
  };
}

export type NAMSessionResourceCache<T> = {
  peek: () => NAMSessionCacheEntry<T> | undefined;
  peekFresh: () => NAMSessionCacheEntry<T> | undefined;
  set: (value: T) => NAMSessionCacheEntry<T>;
  load: (loader: () => Promise<T>, options?: { force?: boolean }) => Promise<T>;
  invalidate: () => void;
  clear: () => void;
};

export class NAMSessionResourceInvalidatedError extends Error {
  constructor() {
    super("NAM session resource result was superseded by a newer mutation");
    this.name = "NAMSessionResourceInvalidatedError";
  }
}

export function createNAMSessionResourceCache<T>(
  ttlMs = NAM_EXPLORER_SESSION_TTL_MS,
  now: () => number = Date.now,
): NAMSessionResourceCache<T> {
  let entry: NAMSessionCacheEntry<T> | undefined;
  let generation = 0;
  let inFlight: { generation: number; promise: Promise<T> } | null = null;

  const peekFresh = () => (
    entry && now() - entry.at < ttlMs ? entry : undefined
  );

  return {
    peek: () => entry,
    peekFresh,
    set(value) {
      // An authoritative push (for example, a completed catalog refresh) owns
      // publication over any older loader that is still running.
      generation += 1;
      inFlight = null;
      entry = Object.freeze({ value, at: now() });
      return entry;
    },
    load(loader, options = {}) {
      if (!options.force) {
        const fresh = peekFresh();
        if (fresh) return Promise.resolve(fresh.value);
      }
      if (inFlight?.generation === generation) return inFlight.promise;

      const requestGeneration = generation;
      let request: Promise<T>;
      request = loader()
        .then((value) => {
          if (generation !== requestGeneration) {
            throw new NAMSessionResourceInvalidatedError();
          }
          entry = Object.freeze({ value, at: now() });
          return value;
        })
        .finally(() => {
          if (inFlight?.promise === request) inFlight = null;
        });
      inFlight = { generation: requestGeneration, promise: request };
      return request;
    },
    invalidate() {
      generation += 1;
      entry = undefined;
      inFlight = null;
    },
    clear() {
      generation += 1;
      entry = undefined;
      inFlight = null;
    },
  };
}

export type NAMSessionKeyedResourceCache<T> = {
  peek: (key: string) => NAMSessionCacheEntry<T> | undefined;
  peekFresh: (key: string) => NAMSessionCacheEntry<T> | undefined;
  set: (key: string, value: T) => NAMSessionCacheEntry<T>;
  load: (key: string, loader: () => Promise<T>, options?: { force?: boolean }) => Promise<T>;
  delete: (key: string) => void;
  clear: () => void;
};

export function createNAMSessionKeyedResourceCache<T>(
  limit: number,
  ttlMs = NAM_EXPLORER_SESSION_TTL_MS,
  now: () => number = Date.now,
): NAMSessionKeyedResourceCache<T> {
  const entries = new Map<string, NAMSessionCacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  const prune = () => {
    while (entries.size > Math.max(1, limit)) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  };

  const set = (key: string, value: T) => {
    const entry = Object.freeze({ value, at: now() });
    entries.delete(key);
    entries.set(key, entry);
    prune();
    return entry;
  };

  const peekFresh = (key: string) => {
    const entry = entries.get(key);
    if (!entry || now() - entry.at >= ttlMs) return undefined;
    // Fresh reads participate in the small session LRU without extending TTL.
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };

  return {
    peek: (key) => entries.get(key),
    peekFresh,
    set,
    load(key, loader, options = {}) {
      if (!options.force) {
        const fresh = peekFresh(key);
        if (fresh) return Promise.resolve(fresh.value);
      }
      const pending = inFlight.get(key);
      if (pending) return pending;

      const request = loader()
        .then((value) => {
          set(key, value);
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, request);
      return request;
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
      inFlight.clear();
    },
  };
}

type NAMLibraryInfoPayload = Awaited<ReturnType<typeof nativeBridge.getNAMLibraryInfo>>;
type NAMCatalogPayload = Awaited<ReturnType<typeof nativeBridge.getNAMCatalog>>;
type NAMLibraryPayload = Awaited<ReturnType<typeof nativeBridge.getNAMLibrary>>;
type NAMLiveSearchPayload = Awaited<ReturnType<typeof nativeBridge.searchTONE3000NAM>>;
type NAMToneDetailPayload = Awaited<ReturnType<typeof nativeBridge.getTONE3000ToneDetail>>;

export const namLibraryInfoSession = createNAMSessionResourceCache<NAMLibraryInfoPayload>();
export const namCatalogSession = createNAMSessionResourceCache<NAMCatalogPayload>();
export const namInstalledLibrarySession = createNAMSessionResourceCache<NAMLibraryPayload>();
export const namLiveSearchPageSession = createNAMSessionKeyedResourceCache<NAMLiveSearchPayload>(NAM_LIVE_PAGE_CACHE_LIMIT);
export const namToneDetailSession = createNAMSessionKeyedResourceCache<NAMToneDetailPayload>(NAM_TONE_DETAIL_CACHE_LIMIT);

export type NAMExplorerSessionView = {
  tab: string;
  sortMode: string;
  query: string;
  committedQuery: string;
  architecture: string;
  gearFilter: string;
  sourceFlowCategoryFilter: string;
  creatorFilter: string;
  licenseFilter: string;
  instrumentFilter: string;
  characterFilter: string;
  availabilityFilter: string;
  viewMode: string;
  filtersOpen: boolean;
  catalogMode: "cache" | "live";
  catalog: NAMCatalogTone[];
  catalogGeneratedAt: string;
  catalogSource: string;
  catalogRefreshedAtMs: number;
  livePage: number;
  liveTotalPages: number;
  liveTotal: number;
  liveHasMore: boolean;
  liveSearchSignature: string;
  scrollTop: number;
};

// Deliberately module-memory only. Remote TONE3000 results are never written to
// localStorage, IndexedDB, SQLite, or the filesystem by this session layer.
const explorerViews = new Map<string, NAMExplorerSessionView>();

export function getNAMExplorerSessionView(key: string) {
  return explorerViews.get(key);
}

export function setNAMExplorerSessionView(key: string, view: NAMExplorerSessionView) {
  explorerViews.set(key, view);
}

export function updateNAMExplorerSessionScroll(key: string, scrollTop: number) {
  const view = explorerViews.get(key);
  if (!view) return;
  explorerViews.set(key, { ...view, scrollTop: Math.max(0, scrollTop) });
}

export function resetNAMExplorerSessionForTests() {
  namLibraryInfoSession.clear();
  namCatalogSession.clear();
  namInstalledLibrarySession.clear();
  namLiveSearchPageSession.clear();
  namToneDetailSession.clear();
  explorerViews.clear();
}
