export const TONE3000_QUERY_DEBOUNCE_MS = 400;

export type TONE3000LiveSearchSnapshotInput = {
  query: string;
  page: number;
  pageSize: number;
  targetPageSize: number;
  requestedSort: string;
  sortMode: string;
  tab: string;
  gearFilter: string;
  format: string;
  architecture: string;
  sourceFlow: string;
  sourceFlowCategoryFilter: string;
  includeModels: boolean;
};

export type TONE3000LiveSearchSnapshot = Readonly<{
  query: string;
  page: number;
  pageSize: number;
  targetPageSize: number;
  sort: string;
  sortMode: string;
  tab: string;
  gearFilter: string;
  format: string;
  architecture: string;
  sourceFlow: string;
  sourceFlowCategoryFilter: string;
  includeModels: boolean;
  signature: string;
  cacheKey: string;
}>;

function stableSearchFields(input: TONE3000LiveSearchSnapshotInput) {
  const query = input.query.trim();
  return {
    query,
    pageSize: Math.max(1, Math.floor(input.pageSize)),
    targetPageSize: Math.max(1, Math.floor(input.targetPageSize)),
    sort: query ? "best-match" : input.requestedSort,
    sortMode: input.sortMode,
    tab: input.tab,
    gearFilter: input.gearFilter,
    format: input.format,
    architecture: input.architecture,
    sourceFlow: input.sourceFlow,
    sourceFlowCategoryFilter: input.sourceFlowCategoryFilter,
    includeModels: input.includeModels,
  };
}

export function buildTONE3000LiveSearchSnapshot(
  input: TONE3000LiveSearchSnapshotInput,
): TONE3000LiveSearchSnapshot {
  const stable = stableSearchFields(input);
  const page = Math.max(1, Math.floor(input.page));
  const signature = JSON.stringify(stable);
  const cacheKey = JSON.stringify({ ...stable, page });
  return Object.freeze({ ...stable, page, signature, cacheKey });
}

export type TONE3000SearchEpochToken = Readonly<{
  generation: number;
  signature: string;
}>;

export type TONE3000SearchEpoch = {
  begin: (signature: string) => TONE3000SearchEpochToken;
  invalidate: () => number;
  isCurrent: (token: TONE3000SearchEpochToken) => boolean;
};

export function createTONE3000SearchEpoch(): TONE3000SearchEpoch {
  let generation = 0;
  let activeSignature = "";

  return {
    begin(signature) {
      generation += 1;
      activeSignature = signature;
      return Object.freeze({ generation, signature });
    },
    invalidate() {
      generation += 1;
      activeSignature = "";
      return generation;
    },
    isCurrent(token) {
      return token.generation === generation && token.signature === activeSignature;
    },
  };
}

export type TONE3000QueryDebouncer = {
  schedule: (query: string) => void;
  flush: (query: string) => void;
  cancel: () => void;
};

export function createTONE3000QueryDebouncer(
  onCommit: (query: string) => void,
  delayMs = TONE3000_QUERY_DEBOUNCE_MS,
): TONE3000QueryDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingQuery = "";

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule(query) {
      pendingQuery = query;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        onCommit(pendingQuery);
      }, Math.max(0, delayMs));
    },
    flush(query) {
      pendingQuery = query;
      cancel();
      onCommit(pendingQuery);
    },
    cancel,
  };
}
