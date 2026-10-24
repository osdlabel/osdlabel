import type { Point } from '@osdlabel/annotation';

/**
 * Image identity as the provider sees it. Deliberately a plain string rather
 * than `@osdlabel/viewer-api`'s branded `ImageId`: providers run in workers
 * and on servers, where the id arrives over the wire, and this package stays
 * free of viewer state. Callers pass their `ImageId` (a string) unchanged.
 */
export type SegmentationImageKey = string;

/** An axis-aligned rectangle in level-0 image pixels. */
export interface ImageRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** `1` = foreground (include), `0` = background (exclude). */
export type PromptPointLabel = 0 | 1;

export interface PromptPoint extends Point {
  readonly label: PromptPointLabel;
}

/** A box prompt in level-0 image pixels. */
export type PromptBox = ImageRegion;

/**
 * What the user asked for, in image space. Every SAM-family model accepts this
 * shape; a provider that cannot honour part of it (e.g. negative points)
 * reports so through {@link ProviderCapabilities}.
 */
export interface SegmentationPrompt {
  readonly points?: readonly PromptPoint[] | undefined;
  readonly box?: PromptBox | undefined;
  /**
   * The previous result's raster for iterative refinement (SAM's
   * `mask_input`). Providers that cannot use it ignore it.
   */
  readonly previous?: RasterMask | undefined;
}

/**
 * The part of the image an encoder looks at, and how finely.
 *
 * `region` is in level-0 image pixels. `scale` is model-input pixels per image
 * pixel along the longer side (a 16384 px wide region encoded at 1024 px has
 * scale 1/16). The encoder reads pixels at that resolution — never from the
 * screen — so overlays and the drawer's level blending do not leak into the
 * embedding.
 */
export interface EncodeView {
  readonly imageKey: SegmentationImageKey;
  /**
   * Everything besides the region that changes the pixels the encoder sees,
   * as an opaque key: the window/level a CT is rendered with, the channel
   * mapping of a multiplex image, the slice of a stack or the frame of a cine.
   * Embeddings are reused only for an equal variant. Omitted means "the one
   * rendering of a plain RGB image".
   */
  readonly variant?: string | undefined;
  readonly imageSize: ImageSize;
  readonly region: ImageRegion;
  readonly scale: number;
}

/**
 * Where a raster sits in image space: raster pixel (u, v) covers the image
 * rectangle starting at (`originX + u * pixelWidth`, `originY + v * pixelHeight`).
 * One raster pixel may cover many image pixels (a coarse encode) or a fraction
 * of one (an encode zoomed past 1:1).
 */
export interface RasterFrame {
  readonly originX: number;
  readonly originY: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A mask in its native resolution plus its placement in the image.
 *
 * Float data are logits (foreground where `> 0` unless a threshold is given);
 * Uint8 data are 0/1. This is the provider's output currency: resolution-
 * independent, cheap to transfer, and convertible to either a
 * `@osdlabel/mask` snapshot or polygons only when the host commits.
 */
export interface RasterMask {
  readonly frame: RasterFrame;
  readonly data: Float32Array | Uint8Array;
}

export interface MaskCandidate {
  readonly mask: RasterMask;
  /** The model's own estimate of mask IoU (SAM's `iou_predictions`). */
  readonly predictedIou: number;
  /** IoU between the mask thresholded at +offset and -offset (SAM's stability score). */
  readonly stability?: number | undefined;
}

export interface SegmentationResult {
  /** Best first. SAM returns 3–4 candidates for an ambiguous single click. */
  readonly candidates: readonly MaskCandidate[];
  /** The view the embedding that produced this result covered. */
  readonly view: EncodeView;
  /** Stage timings in ms (read, preprocess, encode, decode, …), when measured. */
  readonly timings?: Readonly<Record<string, number>> | undefined;
  /** Whether the embedding came from the cache. */
  readonly cached?: boolean | undefined;
}
