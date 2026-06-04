import type { Annotation, AnnotationId } from '@osdlabel/annotation';
import { toolTypeToGeometryType } from '@osdlabel/annotation';
import type { Decoration, DecorationProvider } from '@osdlabel/decoration';
import { getGeometryFromFabricObject } from '@osdlabel/fabric-annotations';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { FabricObject } from 'fabric';

/**
 * Options for {@link enableLiveDecorationUpdates}.
 *
 * The accessors are called on every drag frame, so they should be cheap.
 * Framework integrations typically wire them to a current-value ref so
 * the handler always sees the latest reactive state.
 */
export interface LiveDecorationUpdateOptions<E extends object = Record<string, never>> {
  readonly overlay: FabricOverlay;
  /** Returns the annotations currently visible in the overlay's cell. */
  readonly getVisibleAnnotations: () => readonly Annotation<E>[];
  /** Returns the active image's pixel spacing, or `undefined`. */
  readonly getPixelSpacing: () => PixelSpacing | undefined;
  /** Returns the active decoration providers. */
  readonly getProviders: () => readonly DecorationProvider<E>[];
  /** Called with the newly-computed decorations on each throttled tick. */
  readonly onDecorations: (decorations: readonly Decoration[]) => void;
  /** Returns the currently selected annotation ID, if any. */
  readonly getSelectedAnnotationId?: (() => AnnotationId | null | undefined) | undefined;
}

/**
 * Subscribe to Fabric `object:moving` / `object:scaling` / `object:rotating`
 * on the overlay's canvas. While the user drags, the moving annotation's
 * geometry in state is stale (state only updates on `object:modified`); this
 * helper overlays the *live* Fabric geometry on top of the state-derived
 * annotations, re-runs the decoration providers, and calls `onDecorations`.
 *
 * Recomputation is throttled to one call per `requestAnimationFrame` so the
 * cost is bounded at 60fps regardless of how often Fabric fires the event.
 *
 * On `object:modified` (commit), the host framework's reactive effect
 * already re-runs the providers from state — no override is needed and
 * none is applied here.
 *
 * Returns a teardown function that unsubscribes and cancels any pending
 * scheduled tick.
 */
export function enableLiveDecorationUpdates<E extends object = Record<string, never>>(
  options: LiveDecorationUpdateOptions<E>,
): () => void {
  const {
    overlay,
    getVisibleAnnotations,
    getPixelSpacing,
    getProviders,
    onDecorations,
    getSelectedAnnotationId,
  } = options;
  const canvas = overlay.canvas;

  let scheduled = false;
  let pendingTarget: FabricObject | undefined;
  let rafHandle = 0;
  let disposed = false;

  const flush = (): void => {
    scheduled = false;
    rafHandle = 0;
    if (disposed) return;
    const target = pendingTarget;
    pendingTarget = undefined;

    const providers = getProviders();
    if (providers.length === 0) {
      onDecorations([]);
      return;
    }

    const annotations = applyLiveOverride(getVisibleAnnotations(), target);
    const pixelSpacing = getPixelSpacing();
    const selectedAnnotationId = getSelectedAnnotationId?.() ?? null;
    const ctx = { annotations, pixelSpacing, selectedAnnotationId };
    const decorations = providers.flatMap((p) => p(ctx));
    onDecorations(decorations);
  };

  const handler = (e: { target?: FabricObject }): void => {
    if (disposed) return;
    // Fast exit when no providers are configured — drag events fire up to
    // 60×/sec; skipping rAF scheduling avoids per-frame allocations entirely.
    if (getProviders().length === 0) return;
    pendingTarget = e.target;
    if (scheduled) return;
    scheduled = true;
    rafHandle = requestAnimationFrame(flush);
  };

  canvas.on('object:moving', handler);
  canvas.on('object:scaling', handler);
  canvas.on('object:rotating', handler);

  return () => {
    disposed = true;
    canvas.off('object:moving', handler);
    canvas.off('object:scaling', handler);
    canvas.off('object:rotating', handler);
    if (rafHandle !== 0) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    scheduled = false;
    pendingTarget = undefined;
  };
}

/**
 * Replace the moving annotation(s) geometry in `annotations` with live
 * geometry extracted from the Fabric target. Allocates at most one shallow
 * array copy (and only when at least one override is applied); non-target
 * items keep their identity for downstream memo-stability.
 *
 * Handles multi-select drag: when Fabric fires `object:moving` with an
 * `ActiveSelection` target (which carries no `.id`), we iterate its
 * children and override each one that has an annotation id.
 *
 * Caveat for `ActiveSelection`: child objects' `left/top` are reported
 * relative to the parent group, not the canvas. `getGeometryFromFabricObject`
 * is matrix-based for line/polyline/polygon (exact under groups) but reads
 * `left/top` / `getCenterPoint()` directly for rectangle/circle/point — those
 * may be slightly off during a multi-select drag. The commit on mouse-up
 * (via `object:modified`) is always correct because Fabric dissolves the
 * ActiveSelection before firing it.
 */
function applyLiveOverride<E extends object>(
  annotations: readonly Annotation<E>[],
  target: FabricObject | undefined,
): readonly Annotation<E>[] {
  if (!target) return annotations;
  const targets = childrenOfDragTarget(target);
  let next: Annotation<E>[] | undefined;
  for (const t of targets) {
    const targetId = t.id as AnnotationId | undefined;
    if (!targetId) continue;
    const source = next ?? annotations;
    const idx = source.findIndex((a) => a.id === targetId);
    if (idx === -1) continue;
    const original = source[idx]!;
    const geometry = getGeometryFromFabricObject(t, toolTypeToGeometryType(original.toolType));
    if (!geometry) continue;
    if (!next) next = [...annotations];
    next[idx] = { ...original, geometry };
  }
  return next ?? annotations;
}

/**
 * Returns the Fabric objects to apply live geometry overrides to. For a
 * normal drag this is just `[target]`. For an `ActiveSelection` (multi-drag)
 * it's the group's children. Detected via duck-typing on `getObjects()` to
 * avoid coupling to Fabric's `type` string casing.
 */
function childrenOfDragTarget(target: FabricObject): readonly FabricObject[] {
  const maybeGroup = target as FabricObject & { getObjects?: () => FabricObject[] };
  if (target.id === undefined && typeof maybeGroup.getObjects === 'function') {
    return maybeGroup.getObjects();
  }
  return [target];
}
