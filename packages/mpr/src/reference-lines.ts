import type { Decoration, DecorationProvider } from '@osdlabel/decoration';
import { referenceLine, type PlaneFrame } from '@osdlabel/spatial';

/** Another view whose plane should be drawn as a reference line / crosshair arm. */
export interface ReferenceView {
  /** Stable key, e.g. the cell id; becomes part of the decoration id. */
  readonly key: string;
  readonly plane: PlaneFrame;
  readonly color: string;
}

/**
 * Reference lines (crosshairs, in an orthogonal MPR layout) for `others` in
 * `view`: one dashed `LineDecoration` per intersecting plane. Purely
 * contextual, so `relatedAnnotationIds` is empty.
 */
export function referenceLineDecorations(
  view: PlaneFrame,
  others: readonly ReferenceView[],
): Decoration[] {
  const out: Decoration[] = [];
  for (const o of others) {
    const seg = referenceLine(view, o.plane);
    if (!seg) continue;
    out.push({
      type: 'line',
      id: `ref:${o.key}`,
      relatedAnnotationIds: [],
      start: seg.start,
      end: seg.end,
      dashed: true,
      style: { stroke: o.color, strokeWidth: 1, opacity: 0.8 },
    });
  }
  return out;
}

export function createReferenceLineProvider<E extends object = Record<never, never>>(
  getView: () => PlaneFrame,
  getOthers: () => readonly ReferenceView[],
): DecorationProvider<E> {
  return () => referenceLineDecorations(getView(), getOthers());
}
