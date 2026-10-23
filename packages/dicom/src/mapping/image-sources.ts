import type { ImageId, ImageSource, TileSourceSpec } from '@osdlabel/viewer-api';
import { createImageId } from '@osdlabel/viewer-api';
import type { DicomDataset } from '../dataset.js';
import { num, str } from '../dataset.js';
import { TAGS } from '../tags.js';
import { derivePixelSpacing, type PixelSpacingOptions } from './pixel-spacing.js';
import { buildStack, readPlaneGeometry } from './plane.js';

/** One displayable frame: an instance and a 1-based frame number (DICOM's convention). */
export interface DicomFrameRef {
  readonly dataset: DicomDataset;
  readonly frameNumber: number;
}

export interface ToImageSourcesOptions {
  /**
   * What OpenSeadragon should open for a frame. The adapter does not decide
   * how pixels reach the viewer — a DICOMweb `/rendered` URL, a blob URL from
   * a client-side renderer, or a custom tile source (see `@osdlabel/dicom-wsi`)
   * are all valid — it only describes the frame.
   */
  readonly tileSource: (ref: DicomFrameRef) => TileSourceSpec;
  /** Default: the SOP Instance UID, with `/frames/<n>` appended for multi-frame instances. */
  readonly imageId?: (ref: DicomFrameRef) => ImageId;
  readonly label?: (ref: DicomFrameRef) => string;
  /** Expand every frame of multi-frame instances (default) or only the first. */
  readonly frames?: 'all' | 'first';
  readonly pixelSpacing?: PixelSpacingOptions;
}

export function defaultImageId(ref: DicomFrameRef): ImageId {
  const uid = str(ref.dataset, TAGS.SOPInstanceUID.tag) ?? 'unknown';
  const multi = (num(ref.dataset, TAGS.NumberOfFrames.tag) ?? 1) > 1;
  return createImageId(multi ? `${uid}/frames/${ref.frameNumber}` : uid);
}

/**
 * Maps DICOM instances to osdlabel `ImageSource`s: one per frame, ordered
 * geometrically when the instances form a stack (else by Instance Number),
 * each with its physical `pixelSpacing`.
 *
 * Everything osdlabel's core needs comes out as plain osdlabel types; nothing
 * DICOM-shaped crosses into the annotator.
 */
export function toImageSources(
  instances: readonly DicomDataset[],
  options: ToImageSourcesOptions,
): ImageSource[] {
  const stack = buildStack(instances, (ds) => readPlaneGeometry(ds));
  const ordered =
    stack.sameOrientation &&
    stack.sameFrameOfReference &&
    stack.unplaced.length === 0 &&
    stack.slices.length > 1
      ? stack.slices.map((s) => s.item)
      : [...instances].sort(
          (a, b) => (num(a, TAGS.InstanceNumber.tag) ?? 0) - (num(b, TAGS.InstanceNumber.tag) ?? 0),
        );
  const out: ImageSource[] = [];
  for (const ds of ordered) {
    const count = options.frames === 'first' ? 1 : (num(ds, TAGS.NumberOfFrames.tag) ?? 1);
    for (let f = 1; f <= count; f++) {
      const ref: DicomFrameRef = { dataset: ds, frameNumber: f };
      const spacing = derivePixelSpacing(ds, { ...options.pixelSpacing, frame: f - 1 });
      out.push({
        id: (options.imageId ?? defaultImageId)(ref),
        tileSource: options.tileSource(ref),
        label: options.label?.(ref),
        pixelSpacing: spacing?.spacing,
      });
    }
  }
  return out;
}
