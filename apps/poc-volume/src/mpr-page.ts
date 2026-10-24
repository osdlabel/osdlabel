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
  type PlanarAnnotation,
} from '@osdlabel/mpr';
import { isSamePlane, orthogonalPlane, type PlaneFrame } from '@osdlabel/spatial';
import { createImageId } from '@osdlabel/viewer-api';
import { buildWindowLut } from '@osdlabel/volume';
import { DEFAULT_KEYBOARD_SHORTCUTS, getScenePointFromEvent } from 'osdlabel';
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
let nextAnnotation = 1;

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
        createCrossViewProvider(
          () => c.frame,
          () => foreignFor(c),
          {
            line: { stroke: '#ffd400', strokeWidth: 2 },
            marker: { color: '#ffd400', fontSize: 18, fontWeight: 700 },
            markerText: '+',
          },
        ),
      ]),
    );
  }
}

function updateDecorations(c: MprCell): number {
  const decorations = providers.get(c.key)!({ annotations: [], selectedAnnotationId: null });
  c.layer.setDecorations(decorations);
  return decorations.length;
}

function addAnnotation(geometry: Geometry, toolType: ToolType, plane: PlaneFrame): AnnotationId {
  const id = createAnnotationId(`a${nextAnnotation++}`);
  const now = new Date().toISOString();
  annotations.push({ id, geometry, toolType, plane, createdAt: now, updatedAt: now });
  return id;
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

type Scenario = 'scroll-axial' | 'scroll-coronal' | 'rotate-oblique' | 'pan-zoom-axial';

async function loop(
  scenario: Scenario,
  method: ResliceMethod,
  frames: number,
): Promise<Record<string, unknown>> {
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
    scenario === 'scroll-axial' || scenario === 'pan-zoom-axial'
      ? 'axial'
      : scenario === 'scroll-coronal'
        ? 'coronal'
        : 'oblique';
  const tc = cell(target);
  const ph = {
    reslice: [] as number[],
    upload: [] as number[],
    osdDraw: [] as number[],
    fabric: [] as number[],
    decorations: [] as number[],
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
    if (scenario === 'scroll-axial') {
      const nz = g.dimensions[2];
      tc.frame = orthogonalPlane(g, 'axial', Math.floor(nz / 4) + (f % Math.floor(nz / 2)));
    } else if (scenario === 'scroll-coronal') {
      const ny = g.dimensions[1];
      tc.frame = orthogonalPlane(g, 'coronal', Math.floor(ny / 4) + (f % Math.floor(ny / 2)));
    } else {
      obliqueSpin += 1;
      tc.frame = obliquePlane(g, obliqueTilt, obliqueSpin);
    }
    const p = await renderPlane(tc, built.volume, method, lut, WINDOW, { pool, gl });
    ph.reslice.push(p.reslice);
    ph.upload.push(p.upload);
    ph.osdDraw.push(p.osdDraw);
    const t1 = performance.now();
    nativeCount = syncNative(tc);
    tc.overlay.canvas.renderAll();
    const t2 = performance.now();
    decorationCount = 0;
    for (const c of cells.values()) {
      decorationCount += updateDecorations(c);
      c.overlay.canvas.renderAll();
    }
    const t3 = performance.now();
    ph.fabric.push(t2 - t1);
    ph.decorations.push(t3 - t2);
    update.push(t3 - t0);
  }
  stamps.push(await nextFrame());
  if (scenario !== 'pan-zoom-axial') {
    tc.frame =
      target === 'oblique' ? obliquePlane(g, obliqueTilt, obliqueSpin) : planeFor(g, target);
    await renderPlane(tc, built.volume, 'cpu', lut, WINDOW, {});
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
    frames,
    fps: (frames / span) * 1000,
    frameMs: stats(intervals),
    updateMs: stats(update),
    phases: {
      reslice: stats(ph.reslice),
      upload: stats(ph.upload),
      osdDraw: stats(ph.osdDraw),
      fabric: stats(ph.fabric),
      decorations: stats(ph.decorations),
    },
    decorationsPerFrame: decorationCount,
    nativeObjectsInTarget: nativeCount,
    size: `${tc.frame.width}x${tc.frame.height}`,
  };
}

// ── inspection for the cross-view check ─────────────────────────────────

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
  loop: (scenario: Scenario, method: ResliceMethod, frames: number) =>
    loop(scenario, method, frames),
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
};

document.documentElement.dataset.ready = '1';
