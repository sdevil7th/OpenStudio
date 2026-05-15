function clampVelocity(value: number): number {
  return Math.max(0, Math.min(127, value));
}

export function velocityColor(velocity: number): string {
  const v = clampVelocity(velocity);
  const t = v / 127;
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.25) {
    const s = t / 0.25;
    r = 60;
    g = Math.round(100 + 155 * s);
    b = 240;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    r = Math.round(60 + 40 * s);
    g = 255;
    b = Math.round(240 - 140 * s);
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    r = Math.round(100 + 155 * s);
    g = 255;
    b = Math.round(100 - 100 * s);
  } else {
    const s = (t - 0.75) / 0.25;
    r = 255;
    g = Math.round(255 - 200 * s);
    b = 0;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export function velocityStrokeColor(velocity: number): string {
  const t = clampVelocity(velocity) / 127;
  if (t < 0.5) return "#3b82f6";
  if (t < 0.75) return "#22c55e";
  return "#ef4444";
}
