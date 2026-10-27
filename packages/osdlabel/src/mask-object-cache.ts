import type { FabricObject } from 'fabric';
import type { Annotation } from '@osdlabel/annotation';
import type { MaskObjectSeed } from './brush-config.js';
import {
  MAX_MASK_CANVAS_PIXELS,
  MAX_MASK_CANVAS_SIDE,
  type FabricFields,
} from '@osdlabel/fabric-annotations';

interface Entry {
  /** The payload the object was rasterized from, compared by identity. */
  raw: unknown;
  /** The tint it was rasterized in: the override, or `undefined` for its own. */
  readonly fill: string | undefined;
  readonly object: FabricObject;
  /**
   * Seeded from the brush's commit rather than built from state: the store
   * may hand back a different object for the same payload (Solid's are
   * proxies), so the first lookup matches by content, then by identity.
   */
  seeded: boolean;
}

/** The fields of a canonical mask payload that decide its pixels and tint. */
const PAYLOAD_FIELDS = [
  'x',
  'y',
  'width',
  'height',
  'imageWidth',
  'imageHeight',
  'counts',
  'downsample',
  'fill',
] as const;

/** Whether two mask envelopes hold the same payload, field for field. */
function samePayload(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const left = a as { format?: unknown; data?: Record<string, unknown> };
  const right = b as { format?: unknown; data?: Record<string, unknown> };
  if (left.format !== right.format || !left.data || !right.data) return false;
  // `counts` is a string: equal ones read from the same write compare by
  // reference first, so this is cheap in the case it exists for.
  return PAYLOAD_FIELDS.every((field) => left.data![field] === right.data![field]);
}

/**
 * Rasterized mask objects, reused across `ViewerCell` rebuilds.
 *
 * A rebuild clears and re-adds every annotation object on the image, and a
 * mask's object is a decode plus a full raster — with 200 masks on an image,
 * one brush stroke cost ~230 ms of re-rasterizing the 199 that did not change.
 * The pixels of a mask change only when its `rawAnnotationData` does, and
 * every write replaces that object (`maskAnnotationFields` builds a fresh
 * one; both stores replace the annotation), so identity of the payload plus
 * the tint it was drawn in is an exact key: a hit is pixel-identical to what
 * a rebuild would produce.
 *
 * What the cache does not own, the rebuild still does on every run: clearing
 * the canvas and re-adding, `applyModeToObject` and `_readOnly` (the mode or
 * context may have changed while the pixels did not), and opacity. Entries
 * for masks no longer on the image are dropped each rebuild, so memory stays
 * bounded by the visible masks; `clear()` on unmount releases the rest.
 */
export class MaskObjectCache {
  private readonly entries = new Map<string, Entry>();

  /** The object built for this payload in this tint, or `undefined`. */
  get(annotation: Annotation<FabricFields>, fill: string | undefined): FabricObject | undefined {
    const entry = this.entries.get(annotation.id);
    if (!entry || entry.fill !== fill) return undefined;
    if (entry.raw === annotation.rawAnnotationData) return entry.object;
    if (entry.seeded && samePayload(entry.raw, annotation.rawAnnotationData)) {
      entry.raw = annotation.rawAnnotationData;
      entry.seeded = false;
      return entry.object;
    }
    return undefined;
  }

  set(annotation: Annotation<FabricFields>, fill: string | undefined, object: FabricObject): void {
    this.entries.set(annotation.id, {
      raw: annotation.rawAnnotationData,
      fill,
      object,
      seeded: false,
    });
  }

  /**
   * Stores an object for a payload that has not reached the cell's state yet:
   * a brush commit, whose mask its preview already holds. The next rebuild
   * then shows it without decoding and re-rasterizing — the most expensive
   * part of a commit on a large mask (#238). Matched by content once, since
   * the store may return a different object for the same payload.
   */
  seed(seed: MaskObjectSeed, maxCanvasPixels: number = MAX_MASK_CANVAS_PIXELS): void {
    // The preview is at the mask's own resolution; a mask the cell draws from
    // a display mip must not be shown at that resolution instead. Decided
    // from the seed's size, before anything is cropped.
    const { width, height } = seed;
    const budget =
      Number.isFinite(maxCanvasPixels) && maxCanvasPixels > 0 ? maxCanvasPixels : Infinity;
    if (width > MAX_MASK_CANVAS_SIDE || height > MAX_MASK_CANVAS_SIDE || width * height > budget) {
      return;
    }
    const object = seed.object();
    if (!object) return;
    this.entries.set(seed.annotationId, {
      raw: seed.rawAnnotationData,
      fill: seed.fill,
      object,
      seeded: true,
    });
  }

  /** Drops every entry whose id is not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!keep.has(id)) this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
