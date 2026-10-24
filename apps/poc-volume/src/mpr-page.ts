/**
 * H1 + H2 in a real osdlabel layout: four cells (axial, coronal, sagittal,
 * oblique), each a stock OSD viewer + FabricOverlay + DecorationLayer whose
 * image is a reslice of one shared volume.
 *
 * - Annotations are stored once, as osdlabel annotations extended with the
 *   plane they were drawn on (`PlaneFields`). A cell shows the ones on its
 *   own plane as editable Fabric objects and the rest through two ordinary
 *   DecorationProviders: cross-view projections and reference lines.
 * - Drawing uses the unmodified osdlabel tools (Rectangle / Point / Polyline),
 *   wired the way the framework hooks wire them.
 * - Frame loops time scrolling and oblique rotation per phase.
 *
 * Query: ?drawer=canvas|webgl &nx= &ny= &nz=
 */
import OpenSeadragon from 'openseadragon';
import {
  DEFAULT_ANNOTATION_STYLE,
  createAnnotationId,
  toolTypeToGeometryType,
  type AnnotationId,
  type Geometry,
  type ToolType,
} from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { composeProviders, type DecorationProvider } from '@osdlabel/decoration';
import {
  buildFabricObjectFromGeometry,
  getFabricOptions,
  getGeometryFromFabricObject,
  PointTool,
  PolylineTool,
  RectangleTool,
  type AnnotationTool,
  type ToolCallbacks,
} from '@osdlabel/fabric-annotations';
import {
  createCrossViewProvider,
  createReferenceLineProvider,
  parsePlaneImageId,
  planeImageId,
  type PlanarAnnotation,
} from '@osdlabel/mpr';
import { isSamePlane, orthogonalPlane, type PlaneFrame } from '@osdlabel/spatial';
import { createImageId } from '@osdlabel/viewer-api';
import {
  buildWindowLut,
  permuteVolume,
  SAGITTAL_MAJOR,
  volumeByteLength,
  type ScalarVolume,
} from '@osdlabel/volume';
import { DEFAULT_KEYBOARD_SHORTCUTS, getScenePointFromEvent } from 'osdlabel';
import { installGlMemoryTracker } from './gl-memory.js';
import { GlReslicer } from './gl-reslicer.js';
import {
  createCell,
  renderPlane,
  type Drawer,
  type MprCell,
  type ResliceMethod,
} from './mpr-cell.js';
import { obliquePlane, planeFor, type PlaneKind } from './planes.js';
import { ReslicePool } from './reslice-pool.js';
import { seedAnnotations } from './seed-annotations.js';
import {
  buildVolume,
  installContextCounter,
  nextFrame,
  param,
  stats,
  uaMemory,
  type BuiltVolume,
} from './volume-setup.js';

const contexts = installContextCounter();
const glMemory = installGlMemoryTracker();
const drawer = (param('drawer', 'canvas') === 'webgl' ? 'webgl' : 'canvas') satisfies Drawer;
const WINDOW = { center: 40, width: 400 } as const;
const lut = buildWindowLut(WINDOW.center, WINDOW.width);
const COLORS: Record<PlaneKind, string> = {
  axial: '#4aa3ff',
  coronal: '#5fd35f',
  sagittal: '#ff6a5a',
  oblique: '#e0c040',
};
const KINDS: readonly PlaneKind[] = ['axial', 'coronal', 'sagittal', 'oblique'];
const CONTEXT_ID = createAnnotationContextId('poc');

let built: BuiltVolume;
const cells = new Map<PlaneKind, MprCell>();
const providers = new Map<PlaneKind, DecorationProvider>();
const annotations: PlanarAnnotation[] = [];
let obliqueSpin = 20;
let obliqueTilt = 30;
let pool: ReslicePool | undefined;
let gl: GlReslicer | undefined;
/** Sagittal-major copy of the volume, built on first use by 'cpu-transposed'. */
let transposed: { volume: ScalarVolume; buildMs: number } | undefined;
/**
 * Loop methods: the cell reslicers plus 'cpu-transposed', which is 'cpu' with
 * the sagittal cell reading a sagittal-major copy (memory for speed).
 */
type LoopMethod = ResliceMethod | 'cpu-transposed';
let nextAnnotation = 1;
/** Bumped whenever `annotations` changes; keys the cross-view memo. */
let annotationVersion = 0;
/**
 * `all`: every cell re-runs every provider each frame (what the first version
 * measured). `changed`: a cell's cross-view provider is memoised on (its
 * plane, the annotation list), so only cells whose plane moved recompute;
 * reference lines (3 per cell, cheap) are always recomputed.
 */
type DecorationMode = 'all' | 'changed';
let decorationMode: DecorationMode = 'all';
let extraIds = new Set<AnnotationId>();

const cell = (k: PlaneKind): MprCell => {
  const c = cells.get(k);
  if (!c) throw new Error(`no cell ${k}`);
  return c;
};

// ── annotations: native (Fabric) vs foreign (decorations) ───────────────

function syncNative(c: MprCell): number {
  const canvas = c.overlay.canvas;
  for (const o of [...canvas.getObjects()]) {
    if ((o as { id?: unknown }).id) canvas.remove(o);
  }
  let n = 0;
  for (const a of annotations) {
    if (a.geometry.type === 'mask' || !isSamePlane(a.plane, c.frame)) continue;
    const obj = buildFabricObjectFromGeometry(
      a.geometry,
      getFabricOptions(DEFAULT_ANNOTATION_STYLE, a.id),
    );
    c.overlay.applyModeToObject(obj, c.overlay.getMode() === 'navigation');
    canvas.add(obj);
    n++;
  }
  return n;
}

function foreignFor(c: MprCell): readonly PlanarAnnotation[] {
  return annotations.filter((a) => !isSamePlane(a.plane, c.frame));
}

function installProviders(): void {
  for (const k of KINDS) {
    const c = cell(k);
    providers.set(
      k,
      composeProviders([
        createReferenceLineProvider(
          () => c.frame,
          () =>
            KINDS.filter((o) => o !== k).map((o) => ({
              key: o,
              plane: cell(o).frame,
              color: COLORS[o],
            })),
        ),
        memoised(
          c,
          createCrossViewProvider(
            () => c.frame,
            () => foreignFor(c),
            {
              line: { stroke: '#ffd400', strokeWidth: 2 },
              marker: { color: '#ffd400', fontSize: 18, fontWeight: 700 },
              markerText: '+',
            },
          ),
        ),
      ]),
    );
  }
}

/** Memoise a cell's cross-view provider on (plane, annotation version) when decorationMode is 'changed'. */
function memoised(c: MprCell, provider: DecorationProvider): DecorationProvider {
  let cache: {
    frame: PlaneFrame;
    version: number;
    out: ReturnType<DecorationProvider>;
  } | null = null;
  return (ctx) => {
    if (
      decorationMode === 'changed' &&
      cache &&
      cache.frame === c.frame &&
      cache.version === annotationVersion
    ) {
      return cache.out;
    }
    const out = provider(ctx);
    cache = { frame: c.frame, version: annotationVersion, out };
    return out;
  };
}

/** Time spent in the last updateDecorations calls, split by stage (ms). */
const decorationSplit = { providers: 0, layer: 0 };

function updateDecorations(c: MprCell): number {
  const t0 = performance.now();
  const decorations = providers.get(c.key)!({ annotations: [], selectedAnnotationId: null });
  const t1 = performance.now();
  c.layer.setDecorations(decorations);
  decorationSplit.providers += t1 - t0;
  decorationSplit.layer += performance.now() - t1;
  return decorations.length;
}

function addAnnotation(geometry: Geometry, toolType: ToolType, plane: PlaneFrame): AnnotationId {
  const id = createAnnotationId(`a${nextAnnotation++}`);
  const now = new Date().toISOString();
  annotations.push({ id, geometry, toolType, plane, createdAt: now, updatedAt: now });
  annotationVersion++;
  return id;
}

/**
 * Replace the extra annotations with `n` axial polygons spread over the
 * volume (deterministic), for the annotation-count sweep. Returns the total
 * annotation count.
 */
function setExtraAnnotations(n: number): number {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (extraIds.has(annotations[i]!.id)) annotations.splice(i, 1);
  }
  extraIds = new Set();
  annotationVersion++;
  const g = built.volume.grid;
  const [nx, ny, nz] = g.dimensions;
  const frac = (x: number): number => x - Math.floor(x);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(nz * (0.1 + 0.8 * frac(i * 0.754877666)));
    const cx = nx * (0.3 + 0.4 * frac(i * 0.569840291));
    const cy = ny * (0.3 + 0.4 * frac(i * 0.618033989));
    const r = nx * 0.06;
    const points = Array.from({ length: 7 }, (_, j) => ({
      x: cx + r * Math.cos((j / 7) * 2 * Math.PI),
      y: cy + r * Math.sin((j / 7) * 2 * Math.PI) * (j % 2 ? 0.7 : 1),
    }));
    extraIds.add(
      addAnnotation({ type: 'polygon', points }, 'polyline', orthogonalPlane(g, 'axial', k)),
    );
  }
  refreshAll();
  return annotations.length;
}

function refreshAll(): void {
  for (const c of cells.values()) {
    syncNative(c);
    updateDecorations(c);
    c.overlay.canvas.renderAll();
  }
}

function seedAll(): void {
  for (const a of seedAnnotations(built.volume.grid))
    addAnnotation(a.geometry, a.toolType, a.plane);
}

// ── tools (unmodified osdlabel tools, wired like useAnnotationTool) ─────

let activeTool: { tool: AnnotationTool; dispose: () => void } | null = null;

function activateTool(k: PlaneKind, type: 'rectangle' | 'point' | 'polyline'): void {
  activeTool?.dispose();
  for (const c of cells.values()) c.overlay.setMode('navigation');
  const c = cell(k);
  const tool: AnnotationTool =
    type === 'rectangle'
      ? new RectangleTool()
      : type === 'point'
        ? new PointTool()
        : new PolylineTool();
  const imageId = createImageId(`plane:${k}`);
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => CONTEXT_ID,
    getToolConstraint: () => undefined,
    canAddAnnotation: () => true,
    addAnnotation: (p) => {
      const geometry = getGeometryFromFabricObject(p.fabricObject, toolTypeToGeometryType(p.type));
      if (geometry) addAnnotation(geometry, p.type, c.frame);
      refreshAll();
    },
    updateAnnotation: () => undefined,
    deleteAnnotation: () => undefined,
    setSelectedAnnotation: () => undefined,
    getAnnotation: () => undefined,
  };
  c.overlay.setMode('annotation');
  tool.activate(c.overlay, imageId, callbacks, DEFAULT_KEYBOARD_SHORTCUTS);
  type Opt = Parameters<typeof getScenePointFromEvent>[1];
  const toImage = (opt: Opt) => getScenePointFromEvent((pt) => c.overlay.screenToImage(pt), opt);
  const down = (opt: Opt) => tool.onPointerDown(opt.e as PointerEvent, toImage(opt));
  const move = (opt: Opt) => tool.onPointerMove(opt.e as PointerEvent, toImage(opt));
  const up = (opt: Opt) => tool.onPointerUp(opt.e as PointerEvent, toImage(opt));
  const offDbl = c.overlay.onDoubleClick((e, p, seqs) => tool.onDoubleClick?.(e, p, seqs));
  c.overlay.canvas.on('mouse:down', down);
  c.overlay.canvas.on('mouse:move', move);
  c.overlay.canvas.on('mouse:up', up);
  activeTool = {
    tool,
    dispose: () => {
      offDbl();
      c.overlay.canvas.off('mouse:down', down);
      c.overlay.canvas.off('mouse:move', move);
      c.overlay.canvas.off('mouse:up', up);
      tool.deactivate();
    },
  };
}

// ── frame loops ──────────────────────────────────────────────────────────

type Scenario =
  | 'scroll-axial'
  | 'scroll-coronal'
  | 'scroll-sagittal'
  | 'crosshair'
  | 'rotate-oblique'
  | 'pan-zoom-axial';

/** Slice index for frame `f` of a scroll through the middle half of an axis. */
const scrollIndex = (n: number, f: number): number => Math.floor(n / 4) + (f % Math.floor(n / 2));

async function loop(
  scenario: Scenario,
  method: LoopMethod,
  frames: number,
  mode: DecorationMode = 'all',
): Promise<Record<string, unknown>> {
  decorationMode = mode;
  if (method === 'cpu-transposed' && !transposed) {
    const t = performance.now();
    const volume = permuteVolume(built.volume, SAGITTAL_MAJOR);
    transposed = { volume, buildMs: performance.now() - t };
  }
  const cellMethod: ResliceMethod = method === 'cpu-transposed' ? 'cpu' : method;
  const volumeFor = (k: PlaneKind): ScalarVolume =>
    method === 'cpu-transposed' && k === 'sagittal' && transposed
      ? transposed.volume
      : built.volume;
  if (method === 'workers' && !pool) {
    pool = new ReslicePool(Number(param('workers', '3')), built.volume.grid, built.buffer);
    await pool.ready;
  }
  if (method === 'gl' && !gl) {
    gl = new GlReslicer(1024, 1024);
    const report = gl.upload(built.volume, 'r16f');
    if (report.error) throw new Error(report.error);
  }
  const g = built.volume.grid;
  const target: PlaneKind =
    scenario === 'scroll-axial' || scenario === 'pan-zoom-axial' || scenario === 'crosshair'
      ? 'axial'
      : scenario === 'scroll-coronal'
        ? 'coronal'
        : scenario === 'scroll-sagittal'
          ? 'sagittal'
          : 'oblique';
  const tc = cell(target);
  // The linked crosshair moves one point through the volume: all three
  // orthogonal planes change every frame.
  const moved: readonly PlaneKind[] =
    scenario === 'crosshair' ? ['axial', 'coronal', 'sagittal'] : [target];
  const ph = {
    render: [] as number[],
    reslice: [] as number[],
    upload: [] as number[],
    osdDraw: [] as number[],
    fabric: [] as number[],
    decorations: [] as number[],
    decoProviders: [] as number[],
    decoLayer: [] as number[],
    decoRenderAll: [] as number[],
  };
  const update: number[] = [];
  const stamps: number[] = [];
  let decorationCount = 0;
  let nativeCount = 0;
  const viewport = tc.viewer.viewport;
  const home = viewport.getZoom();
  for (let f = 0; f < frames; f++) {
    stamps.push(await nextFrame());
    const t0 = performance.now();
    if (scenario === 'pan-zoom-axial') {
      // Navigation only: OSD + overlay sync + decoration reposition, no reslice.
      viewport.zoomTo(home * (1.5 + 0.5 * Math.sin(f / 10)), undefined, true);
      viewport.panBy(new OpenSeadragon.Point(Math.sin(f / 7) * 0.002, 0), true);
      viewport.applyConstraints(true);
      tc.viewer.forceRedraw();
      update.push(performance.now() - t0);
      continue;
    }
    const [nx, ny, nz] = g.dimensions;
    if (scenario === 'scroll-axial') {
      tc.frame = orthogonalPlane(g, 'axial', scrollIndex(nz, f));
    } else if (scenario === 'scroll-coronal') {
      tc.frame = orthogonalPlane(g, 'coronal', scrollIndex(ny, f));
    } else if (scenario === 'scroll-sagittal') {
      tc.frame = orthogonalPlane(g, 'sagittal', scrollIndex(nx, f));
    } else if (scenario === 'crosshair') {
      cell('axial').frame = orthogonalPlane(g, 'axial', scrollIndex(nz, f));
      cell('coronal').frame = orthogonalPlane(g, 'coronal', scrollIndex(ny, f));
      cell('sagittal').frame = orthogonalPlane(g, 'sagittal', scrollIndex(nx, f));
    } else {
      obliqueSpin += 1;
      tc.frame = obliquePlane(g, obliqueTilt, obliqueSpin);
    }
    // CPU and GL render the moved planes one after another; workers get all
    // of them at once (each plane is split into row bands across the pool).
    const tr = performance.now();
    const parts =
      method === 'workers'
        ? await Promise.all(
            moved.map((k) =>
              renderPlane(cell(k), volumeFor(k), cellMethod, lut, WINDOW, { pool, gl }),
            ),
          )
        : await (async () => {
            const acc: Awaited<ReturnType<typeof renderPlane>>[] = [];
            for (const k of moved) {
              acc.push(
                await renderPlane(cell(k), volumeFor(k), cellMethod, lut, WINDOW, { pool, gl }),
              );
            }
            return acc;
          })();
    ph.render.push(performance.now() - tr);
    ph.reslice.push(parts.reduce((a, p) => a + p.reslice, 0));
    ph.upload.push(parts.reduce((a, p) => a + p.upload, 0));
    ph.osdDraw.push(parts.reduce((a, p) => a + p.osdDraw, 0));
    const t1 = performance.now();
    nativeCount = 0;
    for (const k of moved) {
      nativeCount += syncNative(cell(k));
      cell(k).overlay.canvas.renderAll();
    }
    const t2 = performance.now();
    decorationCount = 0;
    decorationSplit.providers = 0;
    decorationSplit.layer = 0;
    let renderAllMs = 0;
    for (const c of cells.values()) {
      decorationCount += updateDecorations(c);
      const tr0 = performance.now();
      c.overlay.canvas.renderAll();
      renderAllMs += performance.now() - tr0;
    }
    const t3 = performance.now();
    ph.fabric.push(t2 - t1);
    ph.decorations.push(t3 - t2);
    ph.decoProviders.push(decorationSplit.providers);
    ph.decoLayer.push(decorationSplit.layer);
    ph.decoRenderAll.push(renderAllMs);
    update.push(t3 - t0);
  }
  stamps.push(await nextFrame());
  decorationMode = 'all';
  if (scenario !== 'pan-zoom-axial') {
    for (const k of moved) {
      cell(k).frame = k === 'oblique' ? obliquePlane(g, obliqueTilt, obliqueSpin) : planeFor(g, k);
      await renderPlane(cell(k), built.volume, 'cpu', lut, WINDOW, {});
    }
    refreshAll();
  } else {
    viewport.goHome(true);
  }
  const intervals = stamps.slice(1).map((s, i) => s - stamps[i]!);
  const span = stamps[stamps.length - 1]! - stamps[0]!;
  return {
    scenario,
    method,
    drawer,
    decorationMode: mode,
    annotations: annotations.length,
    planesPerFrame: moved.length,
    frames,
    fps: (frames / span) * 1000,
    frameMs: stats(intervals),
    updateMs: stats(update),
    phases: {
      render: stats(ph.render),
      reslice: stats(ph.reslice),
      upload: stats(ph.upload),
      osdDraw: stats(ph.osdDraw),
      fabric: stats(ph.fabric),
      decorations: stats(ph.decorations),
      decoProviders: stats(ph.decoProviders),
      decoLayer: stats(ph.decoLayer),
      decoRenderAll: stats(ph.decoRenderAll),
    },
    decorationsPerFrame: decorationCount,
    nativeObjectsInTarget: nativeCount,
    ...(method === 'cpu-transposed' && transposed
      ? {
          sagittalCopyBuildMs: transposed.buildMs,
          sagittalCopyBytes: volumeByteLength(transposed.volume),
        }
      : {}),
    size: moved.map((k) => `${cell(k).frame.width}x${cell(k).frame.height}`).join('+'),
  };
}

// ── inspection for the cross-view check ─────────────────────────────────

/**
 * Each cell's current plane through the reversible ImageId scheme: the id,
 * its form, and whether decoding it gives the same plane back and re-encoding
 * gives the same id (what reloading a saved annotation relies on).
 */
function planeIds(): Record<string, unknown>[] {
  const g = built.volume.grid;
  return [...cells].map(([k, c]) => {
    const id = planeImageId('phantom', c.frame, g);
    const parsed = parsePlaneImageId(id, (series) => (series === 'phantom' ? g : undefined));
    return {
      kind: k,
      id,
      form: parsed?.form ?? null,
      samePlane: parsed ? isSamePlane(parsed.plane, c.frame, 1e-3) : false,
      sameSize: parsed
        ? parsed.plane.width === c.frame.width && parsed.plane.height === c.frame.height
        : false,
      reencodes: parsed ? planeImageId('phantom', parsed.plane, g) === id : false,
    };
  });
}

function inspect(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, c] of cells) {
    const decorations = providers.get(k)!({ annotations: [], selectedAnnotationId: null });
    const objs = c.overlay.canvas.getObjects();
    const host = c.overlay.overlayElement;
    const textEls = [...host.querySelectorAll('div')].filter((d) => d.textContent === '+');
    const rect = host.getBoundingClientRect();
    out[k] = {
      frameOrigin: c.frame.origin,
      frame: {
        origin: c.frame.origin,
        rowDirection: c.frame.rowDirection,
        columnDirection: c.frame.columnDirection,
        pixelSpacing: c.frame.pixelSpacing,
        thickness: c.frame.thickness,
      },
      native: objs.filter((o) => (o as { id?: unknown }).id).length,
      fabricLineObjects: objs.filter((o) => !(o as { id?: unknown }).id).length,
      decorations: decorations.map((d) =>
        d.type === 'line'
          ? { id: d.id, type: d.type, start: d.start, end: d.end, related: d.relatedAnnotationIds }
          : d.type === 'text'
            ? {
                id: d.id,
                type: d.type,
                anchor: d.anchor,
                screen: c.overlay.imageToScreen(d.anchor),
                related: d.relatedAnnotationIds,
              }
            : { id: d.id, type: d.type },
      ),
      markerElements: textEls.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top };
      }),
    };
  }
  return out;
}

/** Client-space rectangle of a cell and the client position of an image point in it. */
function cellGeometry(
  k: PlaneKind,
  imagePoints: readonly { x: number; y: number }[],
): Record<string, unknown> {
  const c = cell(k);
  const rect = c.viewer.element.getBoundingClientRect();
  return {
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    points: imagePoints.map((p) => {
      const s = c.overlay.imageToScreen(p);
      return { x: rect.left + s.x, y: rect.top + s.y };
    }),
    frame: { width: c.frame.width, height: c.frame.height },
  };
}

function setSlice(k: PlaneKind, index: number): void {
  const c = cell(k);
  const g = built.volume.grid;
  c.frame = k === 'oblique' ? obliquePlane(g, obliqueTilt, index) : orthogonalPlane(g, k, index);
  void renderPlane(c, built.volume, 'cpu', lut, WINDOW, {}).then(refreshAll);
}

async function setup(): Promise<Record<string, unknown>> {
  const memBefore = await uaMemory();
  built = buildVolume();
  const g = built.volume.grid;
  const grid = document.getElementById('grid')!;
  const t0 = performance.now();
  for (const k of KINDS) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.cell = k;
    grid.appendChild(el);
    const frame = k === 'oblique' ? obliquePlane(g, obliqueTilt, obliqueSpin) : planeFor(g, k);
    const c = await createCell(k, frame, el, drawer);
    cells.set(k, c);
    await renderPlane(c, built.volume, 'cpu', lut, WINDOW, {});
  }
  const cellsMs = performance.now() - t0;
  installProviders();
  seedAll();
  refreshAll();
  const memAfter = await uaMemory();
  return {
    drawer,
    volumeFillMs: built.fillMs,
    cellsSetupMs: cellsMs,
    sizes: Object.fromEntries(
      [...cells].map(([k, c]) => [k, `${c.frame.width}x${c.frame.height}`]),
    ),
    contexts: {
      created: contexts.created(),
      lost: contexts.lost(),
      live: contexts.live(),
      byKind: contexts.byKind(),
    },
    uaMemoryBefore: memBefore,
    uaMemoryAfter: memAfter,
    perCellPlaneBytes: Object.fromEntries(
      [...cells].map(([k, c]) => [k, c.frame.width * c.frame.height * (4 + 4 + 2)]),
    ),
  };
}

declare global {
  interface Window {
    __poc: Record<string, (...args: never[]) => unknown>;
  }
}

window.__poc = {
  setup,
  loop: (scenario: Scenario, method: LoopMethod, frames: number, mode?: DecorationMode) =>
    loop(scenario, method, frames, mode ?? 'all'),
  planeIds,
  setExtraAnnotations: (n: number) => setExtraAnnotations(n),
  activateTool: (k: PlaneKind, type: 'rectangle' | 'point' | 'polyline') => activateTool(k, type),
  deactivateTool: () => {
    activeTool?.dispose();
    activeTool = null;
    for (const c of cells.values()) c.overlay.setMode('navigation');
  },
  inspect,
  cellGeometry: (k: PlaneKind, pts: readonly { x: number; y: number }[]) => cellGeometry(k, pts),
  setSlice: (k: PlaneKind, i: number) => setSlice(k, i),
  setTilt: (deg: number) => {
    obliqueTilt = deg;
  },
  annotations: () =>
    annotations.map((a) => ({ id: a.id, type: a.geometry.type, geometry: a.geometry })),
  contexts: () => ({
    created: contexts.created(),
    lost: contexts.lost(),
    live: contexts.live(),
    byKind: contexts.byKind(),
  }),
  uaMemory,
  glMemory: () => glMemory.snapshot(),
};

document.documentElement.dataset.ready = '1';
