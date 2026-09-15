export const TIMELINE_MIN_HEIGHT = 180;
export const PANEL_MIN_HEIGHT = 96;

/** Redistribute space above usable minima. Never hide an open panel. */
export function allocatePanelHeights(available: number, requested: Record<string, number>): Record<string, number> {
  const entries = Object.entries(requested).filter(([, height]) => Number.isFinite(height) && height > 0);
  const budget = Math.max(0, Number.isFinite(available) ? available - TIMELINE_MIN_HEIGHT : 0);
  const minimum = entries.length * PANEL_MIN_HEIGHT;
  const wanted = entries.reduce((sum, [, height]) => sum + Math.max(PANEL_MIN_HEIGHT, height), 0);
  const scale = wanted > minimum ? Math.min(1, Math.max(0, (budget - minimum) / (wanted - minimum))) : 0;
  return Object.fromEntries(entries.map(([id, height]) => [id,
    PANEL_MIN_HEIGHT + Math.max(0, height - PANEL_MIN_HEIGHT) * scale,
  ]));
}
