import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { allocatePanelHeights } from "./panelLayout";

export function usePanelLayout(requested: Record<string, number>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      let chrome = 0;
      for (const child of root.children) {
        if (!(child instanceof HTMLElement) || child.hasAttribute("data-layout-pane")) continue;
        const style = getComputedStyle(child);
        if (style.position === "fixed" || style.position === "absolute" || style.display === "none") continue;
        chrome += child.getBoundingClientRect().height;
      }
      setAvailable(Math.max(0, root.clientHeight - chrome));
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(root);
      for (const child of root.children) resize.observe(child);
      measure();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(root, { childList: true });
    observe();
    return () => { resize.disconnect(); mutation.disconnect(); };
  }, []);
  const signature = JSON.stringify(requested);
  const heights = useMemo(() => allocatePanelHeights(available, JSON.parse(signature)), [available, signature]);
  return { rootRef, heights, available };
}
