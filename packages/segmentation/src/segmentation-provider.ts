import type { Point } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';

/**
 * A label attached to a point prompt:
 * - `1` = foreground (include this region)
 * - `0` = background (exclude this region)
 */
export type SegmentationPointLabel = 0 | 1;

/** A single foreground/background point prompt in image-space pixels. */
export interface SegmentationPoint extends Point {
  readonly label: SegmentationPointLabel;
}

/** An axis-aligned box prompt in image-space pixels. */
export interface SegmentationBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The prompt handed to a {@link SegmentationProvider}. A prompt may carry a box,
 * a set of points, or both — at least one is expected to be present. All
 * coordinates are image-space pixels, matching how annotation geometry is stored.
 */
export interface SegmentationPrompt {
  readonly box?: SegmentationBox | undefined;
  readonly points?: readonly SegmentationPoint[] | undefined;
}

/**
 * The result of a single {@link SegmentationProvider.segment} call.
 *
 * The provider is responsible for converting its raw mask into one or more
 * closed contours (rings) in image-space pixels. The library consumes
 * `contours` directly — the largest ring is committed as a polygon annotation.
 * Producing contours model-side keeps mask thresholds, RLE formats, and tracing
 * heuristics next to the model rather than in the framework-agnostic core.
 */
export interface SegmentationResult {
  /**
   * Closed rings in image-space pixels, ordered largest-first by convention.
   * Each ring is an array of points; the first and last point need not repeat.
   * An empty array means the prompt produced no mask.
   */
  readonly contours: readonly (readonly Point[])[];
  /** Optional model confidence in `[0, 1]` for the returned mask. */
  readonly score?: number | undefined;
  /**
   * Optional raw mask encoding (e.g. COCO RLE) the consumer may retain for
   * audit or re-segmentation. Opaque to the library.
   */
  readonly maskRle?: string | undefined;
}

/**
 * A handle to the image a {@link SegmentationProvider} is operating on. The
 * library supplies both the source URL (so the provider may fetch full-resolution
 * pixels itself) and a best-effort snapshot of the currently-rendered image
 * (the OSD drawer canvas at the current zoom), letting the provider choose its
 * pixel source.
 */
export interface SegmentationImageRef {
  readonly imageId: ImageId;
  /** The {@link import("@osdlabel/viewer-api").ImageSource} `tileSource` URL. */
  readonly tileSource: string;
  /**
   * A snapshot of the currently-rendered image as an HTML canvas, or `null` when
   * unavailable. Resolution reflects the current viewport zoom, not full-res.
   */
  getViewportCanvas(): HTMLCanvasElement | null;
}

/**
 * Contract for an auto-segmentation backend (e.g. SAM2/SAM3), injected by the
 * consumer. Mirrors the {@link import("@osdlabel/decoration").DecorationProvider}
 * injection pattern: the library owns the interaction and annotation plumbing;
 * the provider owns inference.
 *
 * The `prepare` / `segment` split mirrors a Segment-Anything cost model: an
 * expensive image encode happens once per image (`prepare`), then a cheap
 * decoder runs per prompt (`segment`). Implementations should cache the image
 * embedding internally, keyed by {@link SegmentationImageRef.imageId}.
 */
export interface SegmentationProvider {
  /**
   * Compute and cache whatever per-image state (e.g. the embedding) `segment`
   * needs. Idempotent: calling it again for an already-prepared image should be
   * cheap. The `signal` aborts when the image is no longer active.
   */
  prepare(image: SegmentationImageRef, signal: AbortSignal): Promise<void>;
  /**
   * Run inference for the given prompt and return contours. The `signal` aborts
   * when a newer prompt supersedes this one; implementations should reject or
   * resolve promptly on abort.
   */
  segment(
    image: SegmentationImageRef,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult>;
  /** Optionally release cached per-image state. */
  dispose?(imageId: ImageId): void;
}
