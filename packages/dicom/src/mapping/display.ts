import type { DicomDataset } from '../dataset.js';
import { item, num, str } from '../dataset.js';
import { TAGS } from '../tags.js';

/** One window from Window Center / Width (C.11.2.1.2). */
export interface VoiWindow {
  readonly center: number;
  readonly width: number;
  /** Window Center & Width Explanation, if any (often vendor noise like `WINDOW1`). */
  readonly label: string | undefined;
}

/** A lookup table (Modality LUT or VOI LUT). */
export interface LutTable {
  /** First stored (or modality-output) value mapped by `data[0]`. */
  readonly firstMapped: number;
  readonly bitsPerEntry: number;
  readonly data: readonly number[];
  readonly label: string | undefined;
}

export type VoiFunction = 'LINEAR' | 'LINEAR_EXACT' | 'SIGMOID';

/** What to apply when nothing else is chosen. */
export type DefaultVoi =
  | { readonly kind: 'window'; readonly window: VoiWindow }
  | { readonly kind: 'lut'; readonly lut: LutTable }
  | { readonly kind: 'range'; readonly min: number; readonly max: number };

/**
 * Everything a renderer needs to turn stored pixel values into display values
 * the way the modality intended. None of it has a home in osdlabel's core
 * today: `CellTransform` only carries CSS exposure/contrast on an already
 * rendered 8-bit image, so true windowing of 12–16-bit data is the pixel
 * pipeline's job. The adapter's responsibility ends at producing this.
 */
export interface DisplayDefaults {
  readonly photometric: string;
  readonly samplesPerPixel: number;
  readonly bitsAllocated: number;
  readonly bitsStored: number;
  readonly signed: boolean;
  /** Modality LUT as a linear rescale (stored → e.g. Hounsfield units). */
  readonly rescale: {
    readonly slope: number;
    readonly intercept: number;
    readonly type: string | undefined;
  };
  readonly modalityLut: LutTable | undefined;
  readonly windows: readonly VoiWindow[];
  readonly voiLuts: readonly LutTable[];
  readonly voiFunction: VoiFunction;
  readonly defaultVoi: DefaultVoi;
  /**
   * Display minimum as white. True for MONOCHROME1 and for Presentation LUT
   * Shape INVERSE; both express the same single inversion (a MONOCHROME1 DX
   * image carries both), so they are OR-ed, never XOR-ed.
   */
  readonly invert: boolean;
  readonly notes: readonly string[];
}

function readLut(lutItem: DicomDataset, signedInput: boolean): LutTable | undefined {
  const desc = lutItem.numbers(TAGS.LUTDescriptor.tag);
  if (!desc || desc.length < 3) return undefined;
  // LUT Descriptor is "US or SS": entry count and bit depth are always
  // unsigned, the first mapped value follows the input's signedness.
  let first = desc[1]!;
  if (signedInput && first > 0x7fff) first -= 0x10000;
  const bits = desc[2]!;
  const raw = lutItem.bytes(TAGS.LUTData.tag);
  let data: number[];
  if (raw) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    data = [];
    if (bits <= 8 && raw.length === (desc[0] === 0 ? 65536 : desc[0]!)) {
      for (let i = 0; i < raw.length; i++) data.push(raw[i]!);
    } else {
      for (let i = 0; i + 2 <= raw.length; i += 2) data.push(view.getUint16(i, true));
    }
  } else {
    data = [...(lutItem.numbers(TAGS.LUTData.tag) ?? [])];
  }
  return {
    firstMapped: first,
    bitsPerEntry: bits,
    data,
    label: str(lutItem, TAGS.LUTExplanation.tag),
  };
}

/**
 * Reads the default display transform of an image (or one frame of an
 * enhanced multi-frame image): Modality LUT, VOI windows and LUTs, VOI LUT
 * Function and polarity.
 */
export function deriveDisplayDefaults(
  ds: DicomDataset,
  options: { readonly frame?: number } = {},
): DisplayDefaults {
  const notes: string[] = [];
  const photometric = str(ds, TAGS.PhotometricInterpretation.tag) ?? 'MONOCHROME2';
  const spp = num(ds, TAGS.SamplesPerPixel.tag) ?? 1;
  const bitsAllocated = num(ds, TAGS.BitsAllocated.tag) ?? 8;
  const bitsStored = num(ds, TAGS.BitsStored.tag) ?? bitsAllocated;
  const signed = num(ds, TAGS.PixelRepresentation.tag) === 1;

  // Enhanced objects move these into functional groups; per-frame wins.
  const perFrame =
    options.frame !== undefined
      ? ds.sequence(TAGS.PerFrameFunctionalGroupsSequence.tag)?.[options.frame]
      : undefined;
  const shared = item(ds, TAGS.SharedFunctionalGroupsSequence.tag);
  const fg = (seqTag: number): DicomDataset | undefined =>
    (perFrame && item(perFrame, seqTag)) ?? (shared && item(shared, seqTag));
  const voiSrc = fg(TAGS.FrameVOILUTSequence.tag) ?? ds;
  const rescaleSrc = fg(TAGS.PixelValueTransformationSequence.tag) ?? ds;
  if (voiSrc !== ds) notes.push('VOI from functional groups');

  const slope = num(rescaleSrc, TAGS.RescaleSlope.tag) ?? 1;
  const intercept = num(rescaleSrc, TAGS.RescaleIntercept.tag) ?? 0;
  const rescaleType = str(rescaleSrc, TAGS.RescaleType.tag);
  const mlutItem = item(ds, TAGS.ModalityLUTSequence.tag);
  const modalityLut = mlutItem ? readLut(mlutItem, signed) : undefined;
  if (modalityLut && (slope !== 1 || intercept !== 0)) {
    notes.push('both Modality LUT Sequence and Rescale present: the LUT takes precedence');
  }

  const centers = voiSrc.numbers(TAGS.WindowCenter.tag) ?? [];
  const widths = voiSrc.numbers(TAGS.WindowWidth.tag) ?? [];
  const explanations = voiSrc.strings(TAGS.WindowCenterWidthExplanation.tag) ?? [];
  if (centers.length !== widths.length) {
    notes.push(`${centers.length} window centers but ${widths.length} widths: pairing the shorter`);
  }
  const windows: VoiWindow[] = [];
  for (let i = 0; i < Math.min(centers.length, widths.length); i++) {
    const c = centers[i]!;
    const w = widths[i]!;
    if (!Number.isFinite(c) || !Number.isFinite(w) || w <= 0) continue;
    windows.push({ center: c, width: w, label: explanations[i] || undefined });
  }
  const voiLuts = (voiSrc.sequence(TAGS.VOILUTSequence.tag) ?? []).flatMap((i) => {
    const l = readLut(i, signed);
    return l ? [l] : [];
  });

  const fnRaw = str(voiSrc, TAGS.VOILUTFunction.tag);
  const voiFunction: VoiFunction =
    fnRaw === 'SIGMOID' || fnRaw === 'LINEAR_EXACT' ? fnRaw : 'LINEAR';
  if (fnRaw !== undefined && fnRaw !== voiFunction)
    notes.push(`unknown VOI LUT Function '${fnRaw}'`);

  let defaultVoi: DefaultVoi;
  if (windows[0]) defaultVoi = { kind: 'window', window: windows[0] };
  else if (voiLuts[0]) defaultVoi = { kind: 'lut', lut: voiLuts[0] };
  else {
    const lo = signed ? -(2 ** (bitsStored - 1)) : 0;
    const hi = signed ? 2 ** (bitsStored - 1) - 1 : 2 ** bitsStored - 1;
    const a = lo * slope + intercept;
    const b = hi * slope + intercept;
    defaultVoi = { kind: 'range', min: Math.min(a, b), max: Math.max(a, b) };
    if (photometric.startsWith('MONOCHROME')) {
      notes.push(
        'no VOI in the header: full stored range (a renderer should prefer the pixel min/max)',
      );
    }
  }

  const shape = str(ds, TAGS.PresentationLUTShape.tag);
  const invert = photometric === 'MONOCHROME1' || shape === 'INVERSE';
  if (photometric === 'MONOCHROME1' && shape === 'INVERSE') {
    notes.push('MONOCHROME1 with Presentation LUT Shape INVERSE: one inversion, not two');
  }

  return {
    photometric,
    samplesPerPixel: spp,
    bitsAllocated,
    bitsStored,
    signed,
    rescale: { slope, intercept, type: rescaleType },
    modalityLut,
    windows,
    voiLuts,
    voiFunction,
    defaultVoi,
    invert,
    notes,
  };
}

/**
 * The VOI LUT function of PS3.3 C.11.2.1.2.1, mapping a modality value to
 * `[0, 1]`.
 */
export function applyWindow(x: number, w: VoiWindow, fn: VoiFunction): number {
  const c = w.center;
  const width = w.width;
  if (fn === 'SIGMOID') return 1 / (1 + Math.exp((-4 * (x - c)) / width));
  if (fn === 'LINEAR_EXACT') {
    if (x <= c - width / 2) return 0;
    if (x > c + width / 2) return 1;
    return (x - c) / width + 0.5;
  }
  // LINEAR: the "−0.5 / w−1" form, defined for width >= 1.
  const ww = Math.max(width, 1);
  if (x <= c - 0.5 - (ww - 1) / 2) return 0;
  if (x > c - 0.5 + (ww - 1) / 2) return 1;
  return (x - (c - 0.5)) / (ww - 1 || 1) + 0.5;
}
