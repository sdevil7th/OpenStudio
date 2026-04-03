/**
 * Fade curve math utilities for Timeline visualization.
 *
 * Shape values match AudioClip.fadeInShape / fadeOutShape:
 *   0 = linear (default)
 *   1 = equal power
 *   2 = S-curve (smooth)
 *   3 = logarithmic
 *   4 = exponential
 */

/** Map a normalised position (0-1) through a fade curve. Returns 0-1. */
export function fadeCurve(t: number, shape: number): number {
  // Clamp input
  const s = Math.max(0, Math.min(1, t));

  switch (shape) {
    case 1: // Equal power
      return Math.sqrt(s);
    case 2: // S-curve (cubic Hermite)
      return s * s * (3 - 2 * s);
    case 3: // Logarithmic (fast attack)
      return Math.log10(1 + s * 9); // 0..1 mapped via log10(1..10)
    case 4: // Exponential (slow attack)
      return (Math.pow(10, s) - 1) / 9;
    case 0: // Linear
    default:
      return s;
  }
}

/**
 * Generate an array of (x, y) points for a fade-in curve overlay.
 *
 * @param clipX      left edge of clip in canvas pixels
 * @param clipY      top edge of clip in canvas pixels
 * @param fadeWidth  fade region width in pixels
 * @param clipHeight clip height in pixels
 * @param shape      fade shape index (0-4)
 * @param steps      number of line segments (higher = smoother)
 * @returns flat [x1,y1, x2,y2, ...] array suitable for Konva <Line>
 */
export function fadeInCurvePoints(
  clipX: number,
  clipY: number,
  fadeWidth: number,
  clipHeight: number,
  shape: number = 0,
  steps: number = 24,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gain = fadeCurve(t, shape);
    // Fade-in: gain goes from 0 (silence at left) to 1 (full at right)
    // Y maps top=silence, bottom=full — inverted
    pts.push(clipX + t * fadeWidth, clipY + clipHeight * (1 - gain));
  }
  return pts;
}

/**
 * Generate an array of (x, y) points for a fade-out curve overlay.
 *
 * @param clipX      left edge of clip in canvas pixels
 * @param clipY      top edge of clip in canvas pixels
 * @param clipWidth  full clip width in pixels
 * @param fadeWidth  fade region width in pixels
 * @param clipHeight clip height in pixels
 * @param shape      fade shape index (0-4)
 * @param steps      number of line segments
 * @returns flat [x1,y1, x2,y2, ...] array suitable for Konva <Line>
 */
export function fadeOutCurvePoints(
  clipX: number,
  clipY: number,
  clipWidth: number,
  fadeWidth: number,
  clipHeight: number,
  shape: number = 0,
  steps: number = 24,
): number[] {
  const pts: number[] = [];
  const startX = clipX + clipWidth - fadeWidth;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gain = fadeCurve(1 - t, shape); // inverted: full at left, silence at right
    pts.push(startX + t * fadeWidth, clipY + clipHeight * (1 - gain));
  }
  return pts;
}
