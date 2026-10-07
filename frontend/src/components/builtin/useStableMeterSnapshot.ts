import { useCallback, useRef, useState } from "react";
import type { BuiltInPluginSchema } from "../../services/NativeBridge";

// Native meter replies are fresh objects even when an idle processor has not
// changed. Preserve the snapshot identity so polling does not redraw controls.
export function useStableMeterSnapshot(keepSpectrumClock = false) {
  const [snapshot, setSnapshot] = useState<BuiltInPluginSchema["visualization"] | null>(null);
  const previous = useRef("");
  const publish = useCallback((next: BuiltInPluginSchema["visualization"] | null) => {
    const signature = JSON.stringify(next) ?? "";
    // EQ peak-release animation advances with each valid spectrum frame, even
    // when the incoming bins happen to be identical.
    if (signature === previous.current && !(keepSpectrumClock && next?.spectrumReady)) return;
    previous.current = signature;
    setSnapshot(next);
  }, [keepSpectrumClock]);
  return [snapshot, publish] as const;
}
