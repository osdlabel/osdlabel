import type { StoredRange } from './raster.js';
import type { VoiWindow } from './voi.js';
import { applyVoi } from './voi.js';

/**
 * The analysis behind hypothesis H1 of the pixel-pipeline report: what a
 * window looks like when it is applied correctly to high-bit-depth data,
 * versus emulated on tiles that were already quantised to 8 bits over the
 * data's full range (what a CSS filter on OpenSeadragon's canvas sees).
 */

/** Full-range 8-bit quantisation: how an 8-bit PNG/JPEG tile of the data is made. */
export function quantize8(value: number, range: StoredRange): number {
  const t = (value - range.min) / (range.max - range.min);
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}

/** The modality value an 8-bit level stands for (centre of its bin). */
export function dequantize8(level: number, range: StoredRange): number {
  return range.min + (level / 255) * (range.max - range.min);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * CSS `brightness(b) contrast(c)` on one 8-bit grey, in that order (osdlabel's
 * `composeImageFilterCss` order). Each filter primitive clamps to [0, 1], per
 * Filter Effects Level 1; the result is quantised back to 8 bits.
 */
export function cssBrightnessThenContrast8(
  level: number,
  brightness: number,
  contrast: number,
): number {
  const afterB = clamp01((level / 255) * brightness);
  const afterC = clamp01((afterB - 0.5) * contrast + 0.5);
  return Math.round(afterC * 255);
}

/** CSS parameters that best reproduce a window on full-range 8-bit data. */
export interface CssWindowEmulation {
  readonly brightness: number;
  readonly contrast: number;
  /** The slope the window needs, in output/input units of the 0..1 domain. */
  readonly requiredSlope: number;
  /** The slope `brightness * contrast` actually gives. */
  readonly achievedSlope: number;
  /** True when the exact window is expressible with these bounds and this order. */
  readonly exact: boolean;
}

/**
 * Solve `brightness`/`contrast` (in that order) so the 8-bit full-range image
 * displays `window`. `maxFactor` bounds both factors: osdlabel's
 * `CellTransform` caps them at 2 (`exposure`/`contrast` in [-1, 1] map to
 * `1 + value`); CSS itself has no upper bound (`Infinity`).
 *
 * With `out = in*b*c + 0.5*(1-c)` the window needs `b*c = range/W` and
 * `c = 2(L - min)/W`. Exactness also needs `in*b <= 1` at the window's top,
 * i.e. `W <= 2(L - min)`, or brightness clips before contrast stretches.
 */
export function solveCssWindowEmulation(
  window: VoiWindow,
  range: StoredRange,
  maxFactor = Infinity,
): CssWindowEmulation {
  const span = range.max - range.min;
  const requiredSlope = span / window.width;
  const idealC = (2 * (window.center - range.min)) / window.width;
  const contrast = Math.max(0, Math.min(maxFactor, idealC));
  const idealB = contrast > 0 ? requiredSlope / contrast : 0;
  const brightness = Math.max(0, Math.min(maxFactor, idealB));
  const noClip = window.width <= 2 * (window.center - range.min);
  const exact = contrast === idealC && brightness === idealB && idealC > 0 && noClip;
  return { brightness, contrast, requiredSlope, achievedSlope: brightness * contrast, exact };
}

/** How a window renders over every integer modality value inside it. */
export interface BandingStats {
  /** Integer modality values inside the window (and the data range). */
  readonly inputValues: number;
  /** Distinct grey levels those values display as. */
  readonly distinctLevels: number;
  /** Largest jump between adjacent displayed levels, in grey levels (the visible band edge). */
  readonly maxStep: number;
  /** Widest run of consecutive modality values that share one grey level (HU per band). */
  readonly maxBandWidth: number;
  /** Worst deviation from the exact continuous window, in grey levels. */
  readonly maxAbsError: number;
  readonly meanAbsError: number;
}

/**
 * Evaluate `display` (modality value -> 8-bit grey) over every integer value
 * in `window` that the data range contains.
 */
export function bandingStats(
  window: VoiWindow,
  range: StoredRange,
  display: (value: number) => number,
): BandingStats {
  const lo = Math.max(range.min, Math.ceil(window.center - window.width / 2));
  const hi = Math.min(range.max, Math.floor(window.center + window.width / 2));
  const levels = new Set<number>();
  let maxBandWidth = 0;
  let run = 0;
  let prev = NaN;
  let errSum = 0;
  let maxAbsError = 0;
  let n = 0;
  for (let v = lo; v <= hi; v++) {
    const g = display(v);
    levels.add(g);
    run = g === prev ? run + 1 : 1;
    prev = g;
    if (run > maxBandWidth) maxBandWidth = run;
    const err = Math.abs(g - applyVoi(v, window, 0, 255));
    errSum += err;
    if (err > maxAbsError) maxAbsError = err;
    n++;
  }
  const sorted = [...levels].sort((a, b) => a - b);
  let maxStep = 0;
  for (let i = 1; i < sorted.length; i++) {
    const step = sorted[i]! - sorted[i - 1]!;
    if (step > maxStep) maxStep = step;
  }
  return {
    inputValues: n,
    distinctLevels: levels.size,
    maxStep,
    maxBandWidth,
    maxAbsError,
    meanAbsError: n === 0 ? 0 : errSum / n,
  };
}

/** The three display paths H1 compares. */
export interface WindowComparison {
  /** Exact window on the high-bit-depth value. */
  readonly correct: BandingStats;
  /**
   * The best any per-pixel function of the 8-bit value can do: the exact
   * window applied to the 8-bit level's dequantised value. Every CSS filter
   * chain is such a function, so this bounds them all.
   */
  readonly best8bit: BandingStats;
  /** CSS brightness->contrast with osdlabel's [0, 2] bounds. */
  readonly osdlabelCss: BandingStats;
  readonly osdlabelCssParams: CssWindowEmulation;
  /** CSS brightness->contrast with unbounded factors. */
  readonly unboundedCss: BandingStats;
  readonly unboundedCssParams: CssWindowEmulation;
}

export function compareWindowPaths(window: VoiWindow, range: StoredRange): WindowComparison {
  const correct = bandingStats(window, range, (v) => Math.round(applyVoi(v, window, 0, 255)));
  const best8bit = bandingStats(window, range, (v) =>
    Math.round(applyVoi(dequantize8(quantize8(v, range), range), window, 0, 255)),
  );
  const osdlabelCssParams = solveCssWindowEmulation(window, range, 2);
  const osdlabelCss = bandingStats(window, range, (v) =>
    cssBrightnessThenContrast8(
      quantize8(v, range),
      osdlabelCssParams.brightness,
      osdlabelCssParams.contrast,
    ),
  );
  const unboundedCssParams = solveCssWindowEmulation(window, range);
  const unboundedCss = bandingStats(window, range, (v) =>
    cssBrightnessThenContrast8(
      quantize8(v, range),
      unboundedCssParams.brightness,
      unboundedCssParams.contrast,
    ),
  );
  return {
    correct,
    best8bit,
    osdlabelCss,
    osdlabelCssParams,
    unboundedCss,
    unboundedCssParams,
  };
}
