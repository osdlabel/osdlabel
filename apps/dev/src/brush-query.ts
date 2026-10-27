/**
 * The brush's cell cap from the page's `?brushMaxPixels=` query, read once at
 * module load, or `undefined` when absent or unusable. Lets an E2E spec reach
 * the cap with a stroke that fits on screen. Shared by both dev apps.
 */
export const BRUSH_MAX_PIXELS: number | undefined = (() => {
  const raw = new URLSearchParams(window.location.search).get('brushMaxPixels');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
})();

/** The text of the notice a coarsened stroke shows. */
export function coarsenNotice(from: number, to: number): string {
  return `The mask was coarsened from ${from}x to ${to}x to fit its cap.`;
}
