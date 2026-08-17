export type TONE3000AppendToken = Readonly<{
  key: string;
  generation: number;
}>;

export type TONE3000LiveSearchFailure = Readonly<{
  mode: "replace" | "append";
  page: number;
  signature: string;
  status: string;
}>;

export function shouldRetryTONE3000Append(
  failure: TONE3000LiveSearchFailure | null,
  currentSignature: string,
  currentStatus: string,
  canLoadMore: boolean,
) {
  return Boolean(
    canLoadMore
    && failure?.mode === "append"
    && failure.signature === currentSignature
    && failure.status === currentStatus,
  );
}

export type TONE3000AppendGate = {
  begin: (key: string, allowFailedRetry?: boolean) => TONE3000AppendToken | null;
  settle: (token: TONE3000AppendToken, outcome: "success" | "error" | "stale") => void;
  reset: () => void;
};

export function createTONE3000AppendGate(): TONE3000AppendGate {
  let generation = 0;
  let inFlightKey = "";
  const completed = new Set<string>();
  const failed = new Set<string>();

  return {
    begin(key, allowFailedRetry = false) {
      if (!key || inFlightKey === key || completed.has(key)) return null;
      if (failed.has(key) && !allowFailedRetry) return null;
      if (allowFailedRetry) failed.delete(key);
      generation += 1;
      inFlightKey = key;
      return Object.freeze({ key, generation });
    },
    settle(token, outcome) {
      if (token.generation !== generation || token.key !== inFlightKey) return;
      inFlightKey = "";
      if (outcome === "success") completed.add(token.key);
      else if (outcome === "error") failed.add(token.key);
    },
    reset() {
      generation += 1;
      inFlightKey = "";
      completed.clear();
      failed.clear();
    },
  };
}

type IntersectionObserverFactory = (
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit,
) => Pick<IntersectionObserver, "observe" | "disconnect">;

export function observeTONE3000AppendSentinel(
  target: Element | null,
  root: Element | null,
  onIntersect: () => void,
  factory?: IntersectionObserverFactory,
) {
  if (!target) return () => undefined;
  const makeObserver = factory ?? ((callback, options) => new IntersectionObserver(callback, options));
  if (!factory && typeof IntersectionObserver === "undefined") return () => undefined;

  const observer = makeObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) {
      onIntersect();
    }
  }, {
    root,
    rootMargin: "0px",
    threshold: 0.01,
  });
  observer.observe(target);
  return () => observer.disconnect();
}
