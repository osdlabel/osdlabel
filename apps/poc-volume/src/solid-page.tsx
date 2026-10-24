/**
 * The binding test: three STOCK `@osdlabel/solid` ViewerCells (axial,
 * coronal, sagittal) under one AnnotatorProvider, each showing a volume
 * plane, with no MPR-specific component.
 *
 * The mapping onto osdlabel's existing model:
 * - one `ImageId` per plane position (`vol:axial:200`). Scrolling swaps the
 *   cell's `imageSource.id` while its `tileSource` stays the same instance, so
 *   ViewerCell does not reopen the image, and the annotation store's per-image
 *   buckets are exactly "the annotations on this plane".
 * - a host registry maps each such id to its `PlaneFrame`; annotations need
 *   no extra field (the plane is a property of the image they belong to).
 * - shared decoration providers find their view through the new
 *   `DecorationContext.imageId` and read the other planes' annotations from
 *   the store; Solid tracks those reads, so they re-run on any change.
 * - the host writes reslices into the plane canvas and redraws through the
 *   new `FabricOverlay.viewer`.
 */
import { createEffect, createSignal, For, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { AnnotatorProvider, ViewerCell, useAnnotator } from '@osdlabel/solid';
import {
  createAnnotationContextId,
  createImageId,
  type AnnotationContext,
  type DecorationProvider,
  type FabricOverlay,
  type ImageId,
  type ImageSource,
  type OsdFields,
} from 'osdlabel';
import { projectAnnotations, referenceLineDecorations, type PlanarAnnotation } from '@osdlabel/mpr';
import { orthogonalPlane, planeIndexMapping, type PlaneFrame } from '@osdlabel/spatial';
import { applyWindowLut, buildWindowLut, reslice } from '@osdlabel/volume';
import { createCanvasTileSource, invalidateTile } from './canvas-tile-source.js';
import { installGlMemoryTracker } from './gl-memory.js';
import { planeFor, type PlaneKind } from './planes.js';
import { buildVolume, installContextCounter, nextFrame, stats } from './volume-setup.js';

const contexts = installContextCounter();
const glMemory = installGlMemoryTracker();
const built = buildVolume();
const grid = built.volume.grid;
const lut = buildWindowLut(40, 400);
const KINDS: readonly PlaneKind[] = ['axial', 'coronal', 'sagittal'];
const COLORS: Record<string, string> = {
  axial: '#4aa3ff',
  coronal: '#5fd35f',
  sagittal: '#ff6a5a',
};
const CONTEXT_ID = createAnnotationContextId('volume');
const CONTEXTS: readonly AnnotationContext[] = [
  { id: CONTEXT_ID, label: 'Volume', tools: [{ type: 'rectangle' }, { type: 'point' }] },
];

/** imageId -> the plane that image is. The host's half of the model. */
const planeOf = new Map<ImageId, PlaneFrame>();
const kindOf = new Map<ImageId, PlaneKind>();

interface PlaneCell {
  readonly kind: PlaneKind;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly image: ImageData;
  readonly hu: Int16Array;
  readonly tileSource: object;
  readonly index: () => number;
  readonly setIndex: (i: number) => void;
  overlay: FabricOverlay | undefined;
}

function idFor(kind: PlaneKind, index: number): ImageId {
  const id = createImageId(`vol:${kind}:${index}`);
  if (!planeOf.has(id)) {
    planeOf.set(id, orthogonalPlane(grid, kind === 'oblique' ? 'axial' : kind, index));
    kindOf.set(id, kind);
  }
  return id;
}

const cells: PlaneCell[] = KINDS.map((kind) => {
  const f = planeFor(grid, kind);
  const canvas = document.createElement('canvas');
  canvas.width = f.width;
  canvas.height = f.height;
  const ctx = canvas.getContext('2d')!;
  const [index, setIndex] = createSignal(
    kind === 'axial'
      ? Math.floor(grid.dimensions[2] / 2)
      : kind === 'coronal'
        ? Math.floor(grid.dimensions[1] / 2)
        : Math.floor(grid.dimensions[0] / 2),
  );
  return {
    kind,
    canvas,
    ctx,
    image: new ImageData(f.width, f.height),
    hu: new Int16Array(f.width * f.height),
    tileSource: createCanvasTileSource(canvas, ctx),
    index,
    setIndex,
    overlay: undefined,
  };
});

/** Reslice a cell's current plane into its canvas and ask OSD to redraw. */
function paint(c: PlaneCell): number {
  const t0 = performance.now();
  const f = planeOf.get(idFor(c.kind, c.index()))!;
  reslice(built.volume, planeIndexMapping(grid, f), f.width, f.height, c.hu);
  applyWindowLut(c.hu, lut, new Uint32Array(c.image.data.buffer));
  c.ctx.putImageData(c.image, 0, 0);
  if (c.overlay) {
    // ViewerCell opens OSD with its default drawer (WebGL), which caches a
    // texture per tile canvas: refreshing it needs OSD 5's private hook.
    invalidateTile(c.overlay.viewer, c.canvas);
    c.overlay.viewer.forceRedraw();
  }
  return performance.now() - t0;
}

let annotationStateRef: ReturnType<typeof useAnnotator>['annotationState'] | null = null;

/** Every annotation on every registered plane except `exclude`'s, as PlanarAnnotations. */
function foreignAnnotations(exclude: ImageId): PlanarAnnotation[] {
  const st = annotationStateRef;
  if (!st) return [];
  const out: PlanarAnnotation[] = [];
  for (const [imageId, plane] of planeOf) {
    if (imageId === exclude) continue;
    const bucket = st.byImage[imageId];
    if (!bucket) continue;
    for (const a of Object.values(bucket)) out.push({ ...a, plane });
  }
  return out;
}

let providerRuns = 0;
const crossView: DecorationProvider<OsdFields> = (ctx) => {
  providerRuns++;
  const view = ctx.imageId ? planeOf.get(ctx.imageId) : undefined;
  if (!view || !ctx.imageId) return [];
  return projectAnnotations(foreignAnnotations(ctx.imageId), view, {
    line: { stroke: '#ffd400', strokeWidth: 2 },
    marker: { color: '#ffd400', fontSize: 18 },
  });
};
const referenceLines: DecorationProvider<OsdFields> = (ctx) => {
  const view = ctx.imageId ? planeOf.get(ctx.imageId) : undefined;
  const self = ctx.imageId ? kindOf.get(ctx.imageId) : undefined;
  if (!view) return [];
  return referenceLineDecorations(
    view,
    cells
      .filter((c) => c.kind !== self)
      .map((c) => ({
        key: c.kind,
        plane: planeOf.get(idFor(c.kind, c.index()))!,
        color: COLORS[c.kind]!,
      })),
  );
};

function Harness(): JSX.Element {
  const annotator = useAnnotator();
  annotationStateRef = annotator.annotationState;
  annotator.actions.setContexts([...CONTEXTS]);
  annotator.actions.setActiveContext(CONTEXT_ID);
  const [active, setActive] = createSignal(0);
  // The provider derives tool constraints from the active cell's assigned
  // image, so each cell's current plane image is assigned to it (and
  // re-assigned as it scrolls).
  createEffect(() => {
    cells.forEach((c, i) => annotator.actions.assignImageToCell(i, idFor(c.kind, c.index())));
  });
  createEffect(() => annotator.actions.setActiveCell(active()));

  window.__poc = {
    ready: () => cells.every((c) => c.overlay !== undefined),
    paintAll: () => cells.map(paint),
    setTool: (tool: 'rectangle' | 'point' | 'select') => annotator.actions.setActiveTool(tool),
    setActiveCell: (i: number) => setActive(i),
    cellGeometry: (i: number, pts: readonly { x: number; y: number }[]) => {
      const c = cells[i]!;
      const el = c.overlay!.overlayElement.getBoundingClientRect();
      return pts.map((p) => {
        const s = c.overlay!.imageToScreen(p);
        return { x: el.left + s.x, y: el.top + s.y };
      });
    },
    inspect: () =>
      cells.map((c) => {
        const objs = c.overlay!.canvas.getObjects();
        return {
          kind: c.kind,
          imageId: idFor(c.kind, c.index()),
          annotationObjects: objs.filter((o) => (o as { id?: unknown }).id).length,
          decorationLines: objs
            .filter((o) => !(o as { id?: unknown }).id && o.type === 'line')
            .map((o) => {
              const l = o as unknown as {
                x1: number;
                y1: number;
                x2: number;
                y2: number;
                stroke: string;
              };
              return { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, stroke: l.stroke };
            }),
          markers: [...c.overlay!.overlayElement.querySelectorAll('div')].filter(
            (d) => d.textContent === '+',
          ).length,
        };
      }),
    store: () =>
      Object.fromEntries(
        Object.entries(annotator.annotationState.byImage).map(([k, v]) => [
          k,
          Object.values(v ?? {}).map((a) => ({
            id: a.id,
            geometry: a.geometry,
            imageId: a.imageId,
          })),
        ]),
      ),
    scroll: async (frames: number) => {
      const c = cells[0]!;
      const start = c.index();
      const sync: number[] = [];
      const pix: number[] = [];
      const stamps: number[] = [];
      const runsBefore = providerRuns;
      for (let f = 0; f < frames; f++) {
        stamps.push(await nextFrame());
        const t0 = performance.now();
        c.setIndex(start + 1 + (f % 40)); // Solid effects run synchronously here
        const t1 = performance.now();
        pix.push(paint(c));
        sync.push(t1 - t0);
      }
      stamps.push(await nextFrame());
      c.setIndex(start);
      paint(c);
      const span = stamps[stamps.length - 1]! - stamps[0]!;
      return {
        frames,
        fps: (frames / span) * 1000,
        frameMs: stats(stamps.slice(1).map((s, i) => s - stamps[i]!)),
        setImageSourceSyncMs: stats(sync),
        resliceAndRedrawMs: stats(pix),
        providerRunsPerFrame: (providerRuns - runsBefore) / frames,
      };
    },
    contexts: () => ({
      created: contexts.created(),
      live: contexts.live(),
      byKind: contexts.byKind(),
    }),
    glMemory: () => glMemory.snapshot(),
  };

  return (
    <div style={{ display: 'grid', 'grid-template-columns': '512px 512px', gap: '4px' }}>
      <For each={cells}>
        {(c, i) => {
          const source = (): ImageSource => ({
            id: idFor(c.kind, c.index()),
            tileSource: c.tileSource,
          });
          return (
            <div
              style={{ position: 'relative', width: '512px', height: '512px' }}
              data-cell={c.kind}
            >
              <ViewerCell
                imageSource={source()}
                isActive={active() === i()}
                cellIndex={i()}
                onActivate={() => setActive(i())}
                onOverlayReady={(ov) => {
                  c.overlay = ov;
                  paint(c);
                }}
              />
            </div>
          );
        }}
      </For>
    </div>
  );
}

declare global {
  interface Window {
    __poc: Record<string, (...args: never[]) => unknown>;
  }
}

render(
  () => (
    <AnnotatorProvider decorationProviders={[referenceLines, crossView]}>
      <Harness />
    </AnnotatorProvider>
  ),
  document.getElementById('app')!,
);
document.documentElement.dataset.ready = '1';
