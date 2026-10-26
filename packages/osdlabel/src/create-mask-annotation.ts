import {
  createAnnotationId,
  generateId,
  MASK_RAW_FORMAT,
  type AnnotationId,
  type MaskGeometry,
  type MaskRawAnnotationData,
} from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId } from '@osdlabel/viewer-api';
import {
  encodeCanonical,
  snapshotImageBox,
  snapshotPixelCount,
  type MaskRasterInput,
} from '@osdlabel/mask';
import type { OsdAnnotation } from './types.js';

/** Options for {@link createMaskAnnotation}. */
export interface CreateMaskAnnotationOptions {
  readonly imageId: ImageId;
  readonly contextId: AnnotationContextId;
  /** Explicit id. A fresh id is generated when omitted. */
  readonly id?: AnnotationId | undefined;
  readonly label?: string | undefined;
  /**
   * Tint the mask renders with, recorded on the annotation. Omit to leave the
   * choice to the renderer, which applies its own default.
   */
  readonly fill?: string | undefined;
  /** Tool recorded on the annotation. Defaults to `'segmentationBrush'`. */
  readonly toolType?: 'segmentationBrush' | undefined;
}

/**
 * The two annotation fields a mask owns, derived from painted pixels.
 *
 * Shared by creation and by in-place updates, so a stroke that refines an
 * existing mask writes exactly the same shape of data as one that starts a new
 * one.
 *
 * `fill` is written only when the caller asks for one. The default tint belongs
 * to the renderer (`DEFAULT_MASK_FILL` in `@osdlabel/fabric-annotations`), and
 * stamping it into the payload here would both invert the layering — this
 * package is framework-free and has no business naming a colour — and record a
 * deliberate choice where none was made, freezing today's default into every
 * mask ever saved.
 */
export interface MaskAnnotationFields {
  readonly geometry: MaskGeometry;
  readonly rawAnnotationData: MaskRawAnnotationData;
}

/**
 * Geometry alone, for a payload that is already canonical.
 *
 * Re-encoding a canonical payload reproduces the bytes it came from, and
 * encoding is the expensive half: on a mask whose runs are pathological for
 * row-major RLE it dominates the decode it follows. Import needs the geometry
 * recomputed from the pixels, not the payload rewritten.
 */
export function maskGeometryFromSnapshot(snapshot: MaskRasterInput): MaskGeometry {
  // A snapshot's box is in cells; the geometry's is in image pixels at every
  // downsample, as is `pixelCount`, so every consumer of the geometry —
  // `area()`, a label anchor, a constraint — reads it without knowing the
  // payload's resolution.
  const box = snapshotImageBox(snapshot);
  const downsample = snapshot.downsample ?? 1;
  return {
    type: 'mask',
    origin: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    pixelCount: snapshotPixelCount(snapshot),
    ...(downsample !== 1 && box.width > 0 ? { downsample } : {}),
  };
}

export function maskAnnotationFields(
  snapshot: MaskRasterInput,
  fill?: string,
): MaskAnnotationFields {
  return {
    geometry: maskGeometryFromSnapshot(snapshot),
    rawAnnotationData: {
      format: MASK_RAW_FORMAT,
      data: { ...encodeCanonical(snapshot), ...(fill !== undefined ? { fill } : {}) },
    },
  };
}

/**
 * Builds a complete mask {@link OsdAnnotation} from painted pixels.
 *
 * This is the mask counterpart to `createAnnotationFromGeometry`, which cannot
 * serve masks: it renders geometry through Fabric and serializes the resulting
 * object, but a mask has no meaningful Fabric object to serialize (an image
 * would embed a huge data URL). Here the geometry is the bounding-box summary
 * and the pixels go into the raw-data envelope in osdlabel's canonical
 * encoding — export formats are applied later, at serialization.
 */
export function createMaskAnnotation(
  snapshot: MaskRasterInput,
  options: CreateMaskAnnotationOptions,
): OsdAnnotation {
  const id = options.id ?? createAnnotationId(generateId());
  const { geometry, rawAnnotationData } = maskAnnotationFields(snapshot, options.fill);

  const now = new Date().toISOString();
  return {
    id,
    geometry,
    toolType: options.toolType ?? 'segmentationBrush',
    imageId: options.imageId,
    contextId: options.contextId,
    rawAnnotationData,
    createdAt: now,
    updatedAt: now,
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}
