import { Color, FabricImage, type FabricObject } from 'fabric';
import { MASK_RAW_FORMAT, type MaskRawAnnotationData } from '@osdlabel/annotation';
import { decodeCanonical } from '@osdlabel/mask';

/** Tint used when a mask envelope carries no `fill` of its own. */
export const DEFAULT_MASK_FILL = 'rgba(33, 150, 243, 0.45)';

export interface BuildMaskFabricObjectOptions {
  /** Annotation id, stored on the object so it is recognised as an annotation. */
  readonly id: string;
  /** Overrides the tint recorded in the envelope. */
  readonly fill?: string | undefined;
}

/**
 * Renders a mask as a Fabric `Image` backed by an offscreen canvas.
 *
 * Going through a regular Fabric object rather than a bespoke canvas layer
 * means the mask inherits everything the overlay already does correctly —
 * pan, zoom, rotation, and flip all come from the existing viewport transform,
 * and selection, z-ordering, and the `id`-based clear filter keep working
 * unchanged.
 *
 * The object is deliberately not transformable: a mask is edited by painting,
 * not by dragging handles, so moving or scaling it would silently desynchronise
 * the pixels from their image-space coordinates.
 *
 * Returns `null` for an empty mask, which has no pixels to draw. Throws if
 * handed raw data that is not a mask payload.
 */
export function buildMaskFabricObject(
  raw: MaskRawAnnotationData,
  options: BuildMaskFabricObjectOptions,
): FabricObject | null {
  // Unreachable for a TypeScript caller — `MaskRawAnnotationData.format` is
  // the literal — so this is here for JavaScript ones. It throws rather than
  // returning null because `null` already means "an empty mask, nothing to
  // draw": conflating the two would render a Fabric envelope as silence
  // instead of naming the mistake. Same reasoning as
  // `buildFabricObjectFromGeometry`'s default branch.
  if (raw.format !== MASK_RAW_FORMAT) {
    throw new TypeError(
      `buildMaskFabricObject needs ${MASK_RAW_FORMAT} raw data, got ${String(raw.format)}`,
    );
  }

  const snapshot = decodeCanonical(raw.data);
  if (snapshot.width === 0 || snapshot.height === 0) return null;

  const [red, green, blue, alpha] = new Color(
    options.fill ?? raw.data.fill ?? DEFAULT_MASK_FILL,
  ).getSource();
  const alphaByte = Math.round((alpha ?? 1) * 255);

  const canvas = document.createElement('canvas');
  canvas.width = snapshot.width;
  canvas.height = snapshot.height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const imageData = context.createImageData(snapshot.width, snapshot.height);
  const pixels = imageData.data;
  for (let i = 0; i < snapshot.data.length; i++) {
    if (snapshot.data[i] !== 1) continue;
    const offset = i * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = alphaByte;
  }
  context.putImageData(imageData, 0, 0);

  return new FabricImage(canvas, {
    left: snapshot.x,
    top: snapshot.y,
    originX: 'left',
    originY: 'top',
    id: options.id,
    selectable: true,
    evented: true,
    // Painting is the only way to change a mask.
    lockMovementX: true,
    lockMovementY: true,
    lockScalingX: true,
    lockScalingY: true,
    lockRotation: true,
    hasControls: false,
    // Mask edges should stay crisp when zoomed in; blockiness is correct for
    // pixel data, and caching a canvas-backed image buys nothing.
    imageSmoothing: false,
    objectCaching: false,
  });
}
