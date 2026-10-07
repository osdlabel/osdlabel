import type { Canvas, FabricObject } from 'fabric';
import type { Annotation } from '@osdlabel/annotation';
import { createFabricObjectFromRawData, type FabricFields } from '@osdlabel/fabric-annotations';
import type { MaskStyle } from './brush-options.js';
import type { MaskObjectCache } from './mask-object-cache.js';

/** Opacity of the masks that are not selected, while one is. */
export const DEFAULT_UNSELECTED_MASK_OPACITY = 0.4;

/** The configured dimming, clamped to `0`–`1`, or the default. */
export function unselectedMaskOpacity(style: MaskStyle | undefined): number {
  const value = style?.unselectedOpacity;
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_UNSELECTED_MASK_OPACITY;
  return Math.min(1, Math.max(0, value));
}

/**
 * The opacity a mask renders at: full when no mask is selected or it is the
 * selection, dimmed otherwise.
 *
 * `selectedMaskId` is the selected annotation *if it is one of this image's
 * masks*, else `null` — see {@link selectedMaskOn}. Passing the raw global
 * selection would dim every mask when a rectangle, or a mask in another grid
 * cell, is selected; a selected rectangle already shows Fabric's handles.
 */
export function maskOpacityFor(
  annotationId: string,
  selectedMaskId: string | null,
  style: MaskStyle | undefined,
): number {
  if (selectedMaskId === null || selectedMaskId === annotationId) return 1;
  return unselectedMaskOpacity(style);
}

/**
 * Narrows the global selection to "a mask on this image": the selected id if
 * `maskIds` holds it, else `null`. Selection is one value for the whole
 * annotator, so without this a selection in another grid cell, of a vector
 * annotation, or of a mask that has since been deleted, would dim this cell's
 * masks with nothing visibly selected.
 */
export function selectedMaskOn<Id extends string>(
  selectedId: Id | null,
  maskIds: ReadonlySet<Id>,
): Id | null {
  return selectedId !== null && maskIds.has(selectedId) ? selectedId : null;
}

/** The one mask drawn in an override tint, and which tint. */
export interface MaskTintOverride {
  readonly id: string;
  readonly fill: string;
}

/** The override the current selection and style call for, if any. */
export function desiredMaskTint(
  selectedMaskId: string | null,
  style: MaskStyle | undefined,
): MaskTintOverride | null {
  const fill = style?.selectedFill;
  return selectedMaskId !== null && fill !== undefined ? { id: selectedMaskId, fill } : null;
}

/**
 * The re-tints that take the canvas from `applied` to `desired`: the mask that
 * loses its override goes back to its own tint (`fill: undefined`), the one
 * that gains or changes it is drawn in the new tint. Pure, so the bookkeeping
 * that both bindings keep across selection changes, style changes and rebuilds
 * has one implementation — and turning `selectedFill` off reverts the mask it
 * was applied to, which a check on the new style alone would never do.
 */
export function planMaskTintSwaps(
  applied: MaskTintOverride | null,
  desired: MaskTintOverride | null,
): readonly { readonly id: string; readonly fill: string | undefined }[] {
  const swaps: { id: string; fill: string | undefined }[] = [];
  if (applied && applied.id !== desired?.id) swaps.push({ id: applied.id, fill: undefined });
  if (desired && (applied?.id !== desired.id || applied.fill !== desired.fill)) {
    swaps.push({ id: desired.id, fill: desired.fill });
  }
  return swaps;
}

/** The tint override for a mask: `selectedFill` when it is the selection, else none. */
export function maskFillFor(
  annotationId: string,
  selectedId: string | null,
  style: MaskStyle | undefined,
): string | undefined {
  return selectedId !== null && selectedId === annotationId ? style?.selectedFill : undefined;
}

/**
 * Sets each mask object's opacity for the current selection.
 *
 * Cheap enough to run on every selection change: Fabric's `opacity` is a
 * per-object render property, so no pixel is touched. Returns whether anything
 * changed, so the caller can skip the re-render when nothing did.
 */
export function applyMaskSelectionStyle(
  objects: readonly FabricObject[],
  maskIds: ReadonlySet<string>,
  selectedId: string | null,
  style: MaskStyle | undefined,
): boolean {
  let changed = false;
  for (const obj of objects) {
    const id = obj.id;
    if (typeof id !== 'string' || !maskIds.has(id)) continue;
    const opacity = maskOpacityFor(id, selectedId, style);
    if (obj.opacity !== opacity) {
      obj.set('opacity', opacity);
      changed = true;
    }
  }
  return changed;
}

/**
 * What became of a {@link replaceMaskObject} call: the canvas now shows the
 * new tint (`replaced`); the mask is not on the canvas, before or after the
 * decode (`absent`); a stroke has it hidden (`hidden`); or the caller moved on
 * while the decode ran (`cancelled`). Only `replaced` changes what is shown.
 */
export type MaskSwapOutcome = 'replaced' | 'absent' | 'hidden' | 'cancelled';

/**
 * Re-renders one mask's object in a different tint, in place.
 *
 * A tint lives in the raster, so changing it means decoding the mask again —
 * one mask, on a click, which is cheap; a full rebuild of every annotation
 * on each selection change is what this avoids. The replacement takes the
 * old object's position in the stack. `prepare` receives the new object and
 * the one it replaces, so the caller can carry over `_readOnly`, apply the
 * overlay mode and set the opacity before it is shown.
 *
 * Nothing happens if the object is hidden by a stroke in progress, is no
 * longer on the canvas by the time the replacement is ready (a rebuild
 * replaced it, or the cell went away), or if `isCancelled()` says the caller
 * has moved on; the outcome says which, so the caller can keep an accurate
 * record of what the canvas shows.
 */
export async function replaceMaskObject(
  canvas: Pick<Canvas, 'getObjects' | 'insertAt' | 'remove' | 'requestRenderAll'>,
  annotation: Annotation<FabricFields>,
  fill: string | undefined,
  prepare: (next: FabricObject, previous: FabricObject) => void,
  isCancelled: () => boolean,
): Promise<MaskSwapOutcome> {
  const previous = canvas.getObjects().find((obj) => obj.id === annotation.id);
  if (!previous) return 'absent';
  // Hidden means a stroke is refining this mask right now: the brush hides the
  // committed object by reference and shows its own preview. Swapping it would
  // show committed and preview together and leave the brush restoring a
  // detached object. The stroke's commit rebuilds in the right tint anyway.
  if (previous.visible === false) return 'hidden';
  const next = await createFabricObjectFromRawData(annotation, { maskFill: fill });
  if (isCancelled() || !next) return 'cancelled';
  const index = canvas.getObjects().indexOf(previous);
  if (index < 0) return 'absent';
  prepare(next, previous);
  canvas.insertAt(index, next);
  canvas.remove(previous);
  canvas.requestRenderAll();
  return 'replaced';
}

/**
 * Which mask a cell's canvas shows in the override tint, and which swaps are
 * still allowed to land.
 *
 * The record is updated only when a swap has actually replaced an object, or
 * when a rebuild has put objects of a known tint on the canvas. Recording the
 * *wanted* tint instead, as the cell once did, left it claiming a tint the
 * canvas did not show whenever a swap was skipped — the mask hidden by a
 * stroke in progress, say — so the swap that should have followed was never
 * planned and the mask kept a stale colour.
 *
 * Every plan starts a new generation and a swap lands only if its generation
 * is still current, so a swap issued for one selection or style cannot land
 * after a later change made it wrong, whichever effect issued it. The cell's
 * two effects — the rebuild, which re-applies the tint when its objects land,
 * and the selection effect — share one instance.
 */
export class MaskTintState {
  private applied: MaskTintOverride | null = null;
  private generation = 0;

  /**
   * The canvas was just rebuilt with objects carrying `tint`. Every swap still
   * in flight was aimed at objects that are no longer there.
   */
  rebuilt(tint: MaskTintOverride | null): void {
    this.applied = tint;
    this.generation += 1;
  }

  /**
   * The swaps that take the canvas from what it shows to `desired`, in a new
   * generation; every swap still in flight is superseded.
   */
  plan(desired: MaskTintOverride | null): {
    readonly swaps: ReturnType<typeof planMaskTintSwaps>;
    readonly generation: number;
  } {
    this.generation += 1;
    return { swaps: planMaskTintSwaps(this.applied, desired), generation: this.generation };
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** A swap of `generation` replaced `id`'s object: it now shows `fill`. */
  landed(id: string, fill: string | undefined, generation: number): void {
    if (!this.isCurrent(generation)) return;
    if (fill === undefined) {
      if (this.applied?.id === id) this.applied = null;
    } else {
      this.applied = { id, fill };
    }
  }
}

/** What {@link swapMaskTints} needs from a cell. */
export interface MaskTintSwapHost {
  readonly canvas: Pick<Canvas, 'getObjects' | 'insertAt' | 'remove' | 'requestRenderAll'>;
  /** The overlay's single authority over interaction flags. */
  readonly applyModeToObject: (obj: FabricObject, readOnly: boolean) => void;
  /** Receives the replacement, under the tint it was drawn in. */
  readonly cache: MaskObjectCache;
  /** The masks the swaps may name, by id. */
  readonly annotations: ReadonlyMap<string, Annotation<FabricFields>>;
  /** The opacity a replacement renders at, by id. */
  readonly opacityFor: (id: string) => number;
  /** Whether the effect that issued the swaps has been cleaned up. */
  readonly isCancelled: () => boolean;
}

/**
 * Plans and runs the swaps that bring the canvas to `desired`; see
 * {@link MaskTintState}. Each replacement is cached, carries over the old
 * object's `_readOnly`, goes through the overlay mode, and takes the opacity
 * `host.opacityFor` gives it before it is shown.
 */
export function swapMaskTints(
  state: MaskTintState,
  desired: MaskTintOverride | null,
  host: MaskTintSwapHost,
): void {
  const { swaps, generation } = state.plan(desired);
  for (const { id, fill } of swaps) {
    const annotation = host.annotations.get(id);
    if (!annotation) continue;
    void replaceMaskObject(
      host.canvas,
      annotation,
      fill,
      (next, previous) => {
        host.cache.set(annotation, fill, next);
        next._readOnly = previous._readOnly === true;
        host.applyModeToObject(next, previous._readOnly === true);
        next.set('opacity', host.opacityFor(id));
      },
      () => host.isCancelled() || !state.isCurrent(generation),
    ).then((outcome) => {
      if (outcome === 'replaced') state.landed(id, fill, generation);
    });
  }
}
