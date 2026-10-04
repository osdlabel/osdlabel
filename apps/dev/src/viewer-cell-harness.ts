import {
  createAnnotationContextId,
  createAnnotationFromGeometry,
  createAnnotationId,
  createImageId,
  type AnnotationContext,
  type AnnotationId,
  type FabricOverlay,
  type ImageId,
  type ImageSource,
  type OsdAnnotation,
} from 'osdlabel';

/**
 * The framework-neutral half of the `viewer-cell.html` harness, shared by the
 * SolidJS page here and the React page in `apps/dev-react`, so both mount the
 * same cell over the same fixtures and one spec (`viewer-cell-rebuild.spec.ts`)
 * runs against each (#152). Imports only from `osdlabel`.
 */

/** What `window.__viewerCell` exposes to specs, identically in both apps. */
export interface ViewerCellHarness {
  /**
   * Replaces the image's annotations with `count` rectangles, plus `broken`
   * and `malformed` annotations that cannot be rendered. Each call is its own
   * committed state change, so two calls in one task start two rebuilds.
   */
  readonly load: (count: number, broken?: number, malformed?: number) => void;
  /** Ids `onAnnotationRenderError` has received (empty with `?errors=default`). */
  readonly renderErrors: readonly string[];
  /** The mounted cell's overlay, once OSD has opened the image. */
  overlay: FabricOverlay | undefined;
  /** Unmounts the cell, which destroys its viewer and overlay. */
  readonly unmount: () => void;
}

export const HARNESS_IMAGE_ID = createImageId('landscape');
export const HARNESS_CONTEXT_ID = createAnnotationContextId('rebuild-context');

export const HARNESS_IMAGE: ImageSource = {
  id: HARNESS_IMAGE_ID,
  tileSource: './sample-data/landscape.png',
  label: 'Landscape',
};

export const HARNESS_CONTEXTS: readonly AnnotationContext[] = [
  { id: HARNESS_CONTEXT_ID, label: 'Rebuild', tools: [{ type: 'rectangle' }] },
];

/**
 * Whether the page mounts the provider with an `onAnnotationRenderError` that
 * records into `renderErrors`. `?errors=default` leaves it out, so a spec can
 * check the default `console.warn` instead.
 */
export const reportsRenderErrorsToHarness = (): boolean =>
  new URLSearchParams(window.location.search).get('errors') !== 'default';

const rectangle = (id: AnnotationId, i: number): OsdAnnotation =>
  createAnnotationFromGeometry(
    { type: 'rectangle', origin: { x: 40 + i * 60, y: 40 }, width: 40, height: 40, rotation: 0 },
    { id, imageId: HARNESS_IMAGE_ID, contextId: HARNESS_CONTEXT_ID, toolType: 'rectangle' },
  );

/**
 * `count` rectangles on the image, then two kinds of annotation that cannot
 * be rendered: `broken` ones whose stored Fabric data names a class Fabric
 * does not have, and `malformed` polygons whose `points` are missing, which
 * Fabric's own loader drops silently unless told otherwise. Ids are stable
 * (`rect-<i>`, `broken-<i>`, `malformed-<i>`), so a reload replaces them.
 */
export function harnessAnnotations(
  count: number,
  broken: number,
  malformed: number,
): Record<ImageId, Record<AnnotationId, OsdAnnotation>> {
  const forImage: Record<AnnotationId, OsdAnnotation> = {};
  for (let i = 0; i < count; i++) {
    const id = createAnnotationId(`rect-${i}`);
    forImage[id] = rectangle(id, i);
  }
  for (let i = 0; i < broken; i++) {
    const id = createAnnotationId(`broken-${i}`);
    const valid = rectangle(id, count + i);
    forImage[id] = {
      ...valid,
      rawAnnotationData: {
        ...valid.rawAnnotationData,
        data: { ...valid.rawAnnotationData.data, type: 'NotAFabricClass' },
      },
    };
  }
  for (let i = 0; i < malformed; i++) {
    const id = createAnnotationId(`malformed-${i}`);
    const valid = createAnnotationFromGeometry(
      {
        type: 'polygon',
        points: [
          { x: 300, y: 300 + i * 60 },
          { x: 340, y: 300 + i * 60 },
          { x: 320, y: 340 + i * 60 },
        ],
      },
      { id, imageId: HARNESS_IMAGE_ID, contextId: HARNESS_CONTEXT_ID, toolType: 'polyline' },
    );
    forImage[id] = {
      ...valid,
      rawAnnotationData: {
        ...valid.rawAnnotationData,
        data: { ...valid.rawAnnotationData.data, points: null },
      },
    };
  }
  return { [HARNESS_IMAGE_ID]: forImage };
}

/** Publishes the harness for specs. */
export function exposeHarness(harness: ViewerCellHarness): void {
  (window as unknown as { __viewerCell: ViewerCellHarness }).__viewerCell = harness;
}
