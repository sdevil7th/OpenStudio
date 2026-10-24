import { useLayoutEffect, useState, type RefObject } from "react";

/** Extra space exposes real secondary controls; resizing never changes processor state. */
export function useEditorOverview(root: RefObject<HTMLElement | null>) {
  const [overview, setOverview] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const initial = element.getBoundingClientRect();
    setOverview(initial.width >= 1600 && initial.height >= 900);
    const observer = new ResizeObserver(([entry]) => {
      setOverview(entry.contentRect.width >= 1600 && entry.contentRect.height >= 900);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return overview;
}
