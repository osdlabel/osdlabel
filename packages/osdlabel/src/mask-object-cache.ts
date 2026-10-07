import type { FabricObject } from 'fabric';
import type { Annotation } from '@osdlabel/annotation';
import type { FabricFields } from '@osdlabel/fabric-annotations';

interface Entry {
  /** The payload the object was rasterized from, compared by identity. */
  readonly raw: unknown;
  /** The tint it was rasterized in: the override, or `undefined` for its own. */
  readonly fill: string | undefined;
  readonly object: FabricObject;
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
    if (!entry || entry.raw !== annotation.rawAnnotationData || entry.fill !== fill) {
      return undefined;
    }
    return entry.object;
  }

  set(annotation: Annotation<FabricFields>, fill: string | undefined, object: FabricObject): void {
    this.entries.set(annotation.id, { raw: annotation.rawAnnotationData, fill, object });
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
