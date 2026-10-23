import type { MaybeFramed } from './frame-ref.js';

/**
 * Annotations of one image source grouped by frame, plus the series-level ones
 * (no `frame`) that every frame shows.
 *
 * This is a *derived* index over the existing `byImage[imageId]` bucket — the
 * store's shape does not change. Building it is O(n) in the annotations of the
 * source; after that, the annotations of any frame are an O(1) lookup, which
 * is what lets a cell scroll a 300-slice stack without re-filtering the whole
 * series on every wheel tick. Rebuild it when the source's bucket changes
 * (every reactive layer already tracks that), not when the frame changes.
 */
export interface FrameBuckets<A extends MaybeFramed> {
  readonly byFrame: ReadonlyMap<number, readonly A[]>;
  readonly seriesLevel: readonly A[];
}

const EMPTY: readonly never[] = Object.freeze([]);

/** Group annotations by frame index. Order within a frame follows input order. */
export function bucketByFrame<A extends MaybeFramed>(annotations: Iterable<A>): FrameBuckets<A> {
  const byFrame = new Map<number, A[]>();
  const seriesLevel: A[] = [];
  for (const a of annotations) {
    if (a.frame === undefined) {
      seriesLevel.push(a);
      continue;
    }
    const list = byFrame.get(a.frame.index);
    if (list) list.push(a);
    else byFrame.set(a.frame.index, [a]);
  }
  return { byFrame, seriesLevel };
}

/**
 * The annotations shown on frame `index`.
 *
 * Returns the stored per-frame array itself when there are no series-level
 * annotations (and the series-level array when the frame has none), so
 * consecutive reads of the same frame are reference-equal and downstream
 * memos do not bust. A fresh array is allocated only when both are non-empty.
 */
export function annotationsOnFrame<A extends MaybeFramed>(
  buckets: FrameBuckets<A>,
  index: number,
): readonly A[] {
  const own = buckets.byFrame.get(index) ?? EMPTY;
  if (buckets.seriesLevel.length === 0) return own;
  if (own.length === 0) return buckets.seriesLevel;
  return [...buckets.seriesLevel, ...own];
}

/** Indices of frames carrying at least one annotation, ascending (for a scrollbar heat strip). */
export function annotatedFrameIndices(buckets: FrameBuckets<MaybeFramed>): number[] {
  return [...buckets.byFrame.keys()].sort((a, b) => a - b);
}
