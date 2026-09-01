import type { MaskSnapshot } from './mask-buffer.js';

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
   * Refuse to decode a mask larger than this, in pixels.
   *
   * A decoder reads its dimensions out of the payload, so without a ceiling
   * supplied from outside, a document decides for itself how much work it is
   * worth. Importers pass their remaining budget here; a codec should check it
   * **before** allocating or scanning, not after.
   */
  readonly maxPixels?: number | undefined;
}

export interface MaskCodec<T = unknown> {
  /** Stable identifier, e.g. `'coco-rle'`. */
  readonly format: string;
  encode(snapshot: MaskSnapshot): T;
  decode?(payload: T, options?: MaskDecodeOptions): MaskSnapshot;
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
