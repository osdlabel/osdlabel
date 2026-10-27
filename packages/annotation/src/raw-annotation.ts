/** A generic interface to hold raw annotation data from rendering libraries such as Fabric.js. */
export interface RawAnnotationData<
  TFormat extends string,
  TAnnotationData extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly format: TFormat;
  readonly data: TAnnotationData;
}

/**
 * Identifier for osdlabel's own mask payload format. Masks are stored in this
 * neutral encoding rather than a downstream one (COCO RLE, PNG, …) so that the
 * choice of export format stays a pure serialization concern.
 *
 * `@osdlabel/mask` declares the same string as `CANONICAL_MASK_FORMAT`, because
 * this package has zero dependencies and that one is framework-free — neither
 * may import the other. `osdlabel`, which depends on both, asserts at compile
 * time that they still agree.
 *
 * This string is also the payload's version. Readers drop fields of `data`
 * they do not know, so a `version` field inside it would go unseen by every
 * reader already shipped; an unknown `format`, by contrast, is refused. An
 * incompatible change to the layout therefore ships under a new string (with a
 * codec registered for this one), and `'osdlabel-mask'` means exactly this
 * layout for good.
 */
export const MASK_RAW_FORMAT = 'osdlabel-mask' as const;

/**
 * The pixel payload carried by a mask annotation.
 *
 * Carries the same eight wire fields as `CanonicalMaskData` in
 * `@osdlabel/mask` — and, for the same zero-dependency reason, is declared
 * separately. `osdlabel` depends on both and asserts at compile time that
 * those eight still agree exactly, in `mask-wire-format.ts`.
 *
 * The two types are not interchangeable, and deliberately so. `fill` is an
 * annotation-only field: the codec has no business knowing how a mask is
 * tinted. And this type carries an index signature (`RawAnnotationData`
 * requires one of every payload) where `CanonicalMaskData` does not, so a
 * codec result does not assign to `data` directly — spread it:
 *
 * ```ts
 * const envelope: MaskRawAnnotationData = {
 *   format: MASK_RAW_FORMAT,
 *   data: { ...encodeCanonical(snapshot) },
 * };
 * ```
 *
 * `createMaskAnnotation` in `osdlabel` does this for you, and is the intended
 * path — it also validates the snapshot.
 */
export interface MaskRawData extends Record<string, unknown> {
  /**
   * Bounding-box placement in image-space (level-0) pixels, at every
   * downsample. At a downsample `d` above 1, `x` and `y` are multiples of `d`,
   * and the box's right and bottom edges are too unless they are the image's.
   */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Dimensions of the full image, which formats like COCO RLE require. */
  readonly imageWidth: number;
  readonly imageHeight: number;
  /**
   * Base64 of LEB128 run lengths, row-major, starting with background, over
   * the box's cell grid: `ceil(width / d) x ceil(height / d)` cells.
   */
  readonly counts: string;
  /**
   * Image pixels per stored cell along each axis: a power of two. Absent
   * means `1`, which is what every payload written before the field existed
   * meant, so it is written only when above 1.
   */
  readonly downsample?: number;
  /**
   * Tint the mask renders with, as a CSS colour. Carried here for the same
   * reason the Fabric envelope carries `fill` — the raw data is the
   * rendering-level record, so an annotation stays self-contained.
   */
  readonly fill?: string | undefined;
}

/**
 * Raw data envelope for a mask annotation — the counterpart to
 * `FabricRawAnnotationData` for annotations whose payload is pixels rather than
 * a serialized vector object.
 */
export type MaskRawAnnotationData = RawAnnotationData<typeof MASK_RAW_FORMAT, MaskRawData>;
