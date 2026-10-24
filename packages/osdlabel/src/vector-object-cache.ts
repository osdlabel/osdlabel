import type { FabricObject } from 'fabric';

/** Default bound of {@link VectorObjectCache}: about 100 slices of 50 annotations. */
export const DEFAULT_VECTOR_OBJECT_CACHE_SIZE = 5000;

/**
 * Revived vector annotation objects, reused across canvas rebuilds and keyed
 * by the payload (`rawAnnotationData`) they were revived from — the object is
 * a function of it alone, and every edit writes a new payload, so a changed
 * annotation misses.
 *
 * Scrolling a stack back to a frame then re-adds that frame's objects instead
 * of reviving them from JSON again.
 *
 * Bounded, least-recently-used first out, because a revived Fabric object is
 * not small: with Fabric's per-object render caching on, each one also holds
 * a cache canvas. Unbounded reuse over a 300-slice stack of 50 annotations
 * each measured 2.4 GB of renderer memory in the frame-axis PoC.
 */
export class VectorObjectCache {
  private readonly entries = new Map<object, FabricObject>();
  constructor(private readonly limit: number = DEFAULT_VECTOR_OBJECT_CACHE_SIZE) {}

  get(payload: object): FabricObject | undefined {
    const obj = this.entries.get(payload);
    if (obj !== undefined) {
      // Most recently used goes to the back of the eviction order.
      this.entries.delete(payload);
      this.entries.set(payload, obj);
    }
    return obj;
  }

  /** Whether `payload` has an object, without touching the eviction order. */
  has(payload: object): boolean {
    return this.entries.has(payload);
  }

  set(payload: object, obj: FabricObject): void {
    this.entries.delete(payload);
    this.entries.set(payload, obj);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
