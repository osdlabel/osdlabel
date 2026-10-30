import type { MaskRaster } from './mask-raster.js';

/**
 * Converts a mask between osdlabel's internal representation and an external
 * storage format.
 *
 * This is the extension point that keeps the annotator's own state independent
 * of any particular downstream format: the annotator stores masks canonically
 * (see `canonicalMaskCodec`) and codecs translate only at the boundary, so
 * adding COCO RLE, PNG, or a bespoke format never changes how painting works.
 *
 * `decode` is optional — an export-only format (say, a rendered preview) can
 * omit it.
 */

/** Limits an importer imposes on a decode. */
export interface MaskDecodeOptions {
  /**
   * Refuse to decode a mask whose box exceeds this many cells.
   *
   * A decoder reads its dimensions out of the payload, so without a ceiling
   * supplied from outside, a document decides for itself how much work it is
   * worth. Importers pass their remaining budget here, never more than the
   * format's cap (`DEFAULT_MAX_MASK_PIXELS`); a codec should check it
   * **before** allocating or scanning, not after.
   */
  readonly maxPixels?: number | undefined;
  /**
   * The downsample to decode at, for a format that cannot carry one itself —
   * COCO's runs are always image pixels. `deserialize` passes the annotation's
   * `geometry.downsample`, which is therefore what a COCO dataset builder must
   * keep alongside each segmentation for a coarse mask to come back coarse,
   * in a mask geometry: `{ type: 'mask', downsample: 4 }` at the least.
   * `deserialize` refuses a geometry with no `type` under a mask payload.
   *
   * A codec that honours it returns a raster at that downsample, and refuses a
   * payload that cannot be stored at it (one not constant within each cell)
   * rather than quietly decoding at downsample 1. Absent means 1.
   */
  readonly downsample?: number | undefined;
}

export interface MaskCodec<T = unknown> {
  /** Stable identifier, e.g. `'coco-rle'`. */
  readonly format: string;
  /**
   * Whether `encode` honours a raster's `downsample`.
   *
   * A raster's box is in cells, which are image pixels only at downsample 1.
   * A codec written before downsampled masks existed reads the box as image
   * pixels and would place such a mask at a fraction of its true position,
   * silently. So the default is "no": `serialize` refuses to hand a codec that
   * has not opted in a downsampled snapshot, rather than let it mis-export
   * one. (Upsampling for it first, through `upsampleSnapshot`, is the
   * alternative, at `downsample`-squared the memory.)
   */
  readonly encodesDownsampled?: boolean | undefined;
  /**
   * Reads the mask only through the {@link MaskRaster} interface, so it
   * works whatever stores the cells. `denseRaster` wraps a dense snapshot.
   */
  encode(raster: MaskRaster): T;
  /** Any {@link MaskRaster}; a codec need not materialise the box. */
  decode?(payload: T, options?: MaskDecodeOptions): MaskRaster;
}

/** A lookup of codecs by format, used to resolve a format name at (de)serialization time. */
export interface MaskCodecRegistry {
  register(codec: MaskCodec): void;
  get(format: string): MaskCodec | undefined;
  /** Throws a helpful error instead of returning `undefined`. */
  require(format: string): MaskCodec;
  formats(): string[];
}

export function createMaskCodecRegistry(...initial: readonly MaskCodec[]): MaskCodecRegistry {
  const codecs = new Map<string, MaskCodec>();
  for (const codec of initial) codecs.set(codec.format, codec);

  return {
    register(codec) {
      codecs.set(codec.format, codec);
    },
    get(format) {
      return codecs.get(format);
    },
    require(format) {
      const codec = codecs.get(format);
      if (!codec) {
        throw new Error(
          `No mask codec registered for format '${format}'. Registered: ${[...codecs.keys()].join(', ') || '(none)'}`,
        );
      }
      return codec;
    },
    formats() {
      return [...codecs.keys()];
    },
  };
}
