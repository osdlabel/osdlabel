/**
 * Modality rescale and VOI (value-of-interest) functions, as DICOM defines
 * them (PS3.3 C.11.1 Modality LUT, C.11.2.1.2 Window Center and Window Width).
 *
 * These are the *semantics*; `voi-lut.ts` turns them into a lookup table a hot
 * loop or a shader can apply. Nothing here knows about DICOM files: a caller
 * that has the tags (or any other source of a window) passes plain numbers.
 */

/** Rescale Slope / Rescale Intercept: stored value to modality units (HU for CT). */
export interface ModalityRescale {
  readonly slope: number;
  readonly intercept: number;
}

export const IDENTITY_RESCALE: ModalityRescale = { slope: 1, intercept: 0 } as const;

/** DICOM VOI LUT Function (0028,1056). `LINEAR` is the default when absent. */
export type VoiFunction = 'LINEAR' | 'LINEAR_EXACT' | 'SIGMOID';

/** A window in *modality* units (after rescale): HU for CT. */
export interface VoiWindow {
  readonly center: number;
  readonly width: number;
  readonly fn?: VoiFunction | undefined;
}

export function applyRescale(stored: number, rescale: ModalityRescale): number {
  return stored * rescale.slope + rescale.intercept;
}

/**
 * DICOM `LINEAR` (C.11.2.1.2.1). Note the `-0.5` and `width - 1` terms: they
 * place the window's edges on pixel-value boundaries, so `W=1` is a hard
 * threshold. `width` must be >= 1.
 */
export function voiLinear(
  x: number,
  center: number,
  width: number,
  yMin: number,
  yMax: number,
): number {
  const w = Math.max(1, width);
  const lo = center - 0.5 - (w - 1) / 2;
  const hi = center - 0.5 + (w - 1) / 2;
  if (x <= lo) return yMin;
  if (x > hi) return yMax;
  return ((x - (center - 0.5)) / (w - 1) + 0.5) * (yMax - yMin) + yMin;
}

/** DICOM `LINEAR_EXACT` (C.11.2.1.3.2). `width` must be > 0. */
export function voiLinearExact(
  x: number,
  center: number,
  width: number,
  yMin: number,
  yMax: number,
): number {
  const w = Math.max(Number.EPSILON, width);
  if (x <= center - w / 2) return yMin;
  if (x > center + w / 2) return yMax;
  return ((x - center) / w + 0.5) * (yMax - yMin) + yMin;
}

/** DICOM `SIGMOID` (C.11.2.1.3.1). */
export function voiSigmoid(
  x: number,
  center: number,
  width: number,
  yMin: number,
  yMax: number,
): number {
  const w = Math.max(Number.EPSILON, width);
  return (yMax - yMin) / (1 + Math.exp((-4 * (x - center)) / w)) + yMin;
}

/** Apply a window to one modality value, producing a continuous output in [yMin, yMax]. */
export function applyVoi(x: number, window: VoiWindow, yMin = 0, yMax = 255): number {
  switch (window.fn ?? 'LINEAR') {
    case 'LINEAR':
      return voiLinear(x, window.center, window.width, yMin, yMax);
    case 'LINEAR_EXACT':
      return voiLinearExact(x, window.center, window.width, yMin, yMax);
    case 'SIGMOID':
      return voiSigmoid(x, window.center, window.width, yMin, yMax);
  }
}

/**
 * Standard CT windows used throughout the report (center / width in HU).
 * Values are the common radiology defaults; sites vary them.
 */
export const CT_WINDOW_PRESETS = {
  brain: { center: 40, width: 80 },
  subdural: { center: 75, width: 200 },
  lung: { center: -600, width: 1500 },
  bone: { center: 300, width: 2000 },
  abdomen: { center: 50, width: 400 },
} as const satisfies Record<string, VoiWindow>;

export type CtWindowPresetName = keyof typeof CT_WINDOW_PRESETS;
