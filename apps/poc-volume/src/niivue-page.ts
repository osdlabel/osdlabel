/**
 * H3: an embedded third-party WebGL2 volume renderer (Niivue) in one grid
 * cell, beside three osdlabel MPR cells, all over ONE volume buffer.
 *
 * - The volume is the same SharedArrayBuffer-backed Int16Array the osdlabel
 *   cells reslice; Niivue gets it through its public `nii2volume` with a
 *   header from `createStreamingNVImage`. We check whether Niivue keeps that
 *   array (zero copy) or copies it.
 * - The 3D label map is a dense LabelVolume whose slices are views over
 *   Niivue's own drawing bitmap, so painting from any osdlabel view is
 *   immediately Niivue's drawing (one buffer, `refreshDrawing()` to upload).
 * - Points and polygon outlines are drawn in 3D as an SVG overlay positioned
 *   with Niivue's public `mmToRenderCanvas`, re-projected after every frame.
 * - WebGL contexts are counted from the first getContext call.
 */
import NiiVue, {
  NiiDataType,
  SLICE_TYPE,
  createStreamingNVImage,
  nii2volume,
} from '@niivue/niivue/webgl2';
import { DEFAULT_ANNOTATION_STYLE, createAnnotationId, type Point } from '@osdlabel/annotation';
import { composeProviders, type DecorationProvider } from '@osdlabel/decoration';
import { buildFabricObjectFromGeometry, getFabricOptions } from '@osdlabel/fabric-annotations';
import {
  createCrossViewProvider,
  createReferenceLineProvider,
  type PlanarAnnotation,
} from '@osdlabel/mpr';
import {
  imageToPatient,
  isSamePlane,
  orthogonalPlane,
  patientToIndex,
  planeIndexMapping,
  type Vec3,
} from '@osdlabel/spatial';
import { buildWindowLut, paintDisc, resliceLabels, type LabelVolume } from '@osdlabel/volume';
import { createCell, renderPlane, type MprCell } from './mpr-cell.js';
import { planeFor, type PlaneKind } from './planes.js';
import { seedAnnotations } from './seed-annotations.js';
import {
  buildVolume,
  installContextCounter,
  nextFrame,
  stats,
  uaMemory,
  type BuiltVolume,
} from './volume-setup.js';

const contexts = installContextCounter();
const WINDOW = { center: 40, width: 400 } as const;
const lut = buildWindowLut(WINDOW.center, WINDOW.width);
const KINDS2D: readonly PlaneKind[] = ['axial', 'coronal', 'sagittal'];
const COLORS: Record<string, string> = {
  axial: '#4aa3ff',
  coronal: '#5fd35f',
  sagittal: '#ff6a5a',
};

let built: BuiltVolume;
let nv: NiiVue;
const cells = new Map<PlaneKind, MprCell>();
const providers = new Map<PlaneKind, DecorationProvider>();
const annotations: PlanarAnnotation[] = [];
let labels: LabelVolume | null = null;
let svg: SVGSVGElement;
const cell = (k: PlaneKind): MprCell => cells.get(k)!;

/** Patient mm -> Niivue world mm (its streamed-volume grid: centre of voxel i at (i + 0.5) * spacing). */
function toNiivueMm(P: Vec3): [number, number, number] {
  const g = built.volume.grid;
  const idx = patientToIndex(g, P);
  return [
    (idx[0] + 0.5) * g.spacing[0],
    (idx[1] + 0.5) * g.spacing[1],
    (idx[2] + 0.5) * g.spacing[2],
  ];
}

// ── 2D cells (same wiring as mpr-page, without tools) ────────────────────

function syncNative(c: MprCell): void {
  const canvas = c.overlay.canvas;
  for (const o of [...canvas.getObjects()]) if ((o as { id?: unknown }).id) canvas.remove(o);
  for (const a of annotations) {
    if (a.geometry.type === 'mask' || !isSamePlane(a.plane, c.frame)) continue;
    const obj = buildFabricObjectFromGeometry(
      a.geometry,
      getFabricOptions(DEFAULT_ANNOTATION_STYLE, a.id),
    );
    c.overlay.applyModeToObject(obj, true);
    canvas.add(obj);
  }
}

function refresh2D(): void {
  for (const c of cells.values()) {
    syncNative(c);
    c.layer.setDecorations(providers.get(c.key)!({ annotations: [], selectedAnnotationId: null }));
    c.overlay.canvas.renderAll();
  }
}

/** Composite the label map over a cell's grey image (red, 50%). */
function tintLabels(c: MprCell): void {
  if (!labels) return;
  const f = c.frame;
  const lab = new Uint8Array(f.width * f.height);
  resliceLabels(labels, planeIndexMapping(built.volume.grid, f), f.width, f.height, lab);
  const px = c.rgba;
  for (let i = 0; i < lab.length; i++) {
    if (lab[i]) {
      const g = px[i]! & 0xff;
      const r = Math.min(255, (g >> 1) + 128);
      px[i] = (0xff000000 | ((g >> 1) << 16) | ((g >> 1) << 8) | r) >>> 0;
    }
  }
  c.ctx.putImageData(c.image, 0, 0);
  c.viewer.forceRedraw();
}

// ── 3D overlay: annotations projected through Niivue's camera ────────────

interface Projected3D {
  readonly id: string;
  readonly kind: 'point' | 'outline';
  readonly mm: readonly [number, number, number][];
}

let projected: Projected3D[] = [];

function build3DOverlayModel(): void {
  projected = annotations.flatMap((a): Projected3D[] => {
    const g = a.geometry;
    if (g.type === 'point') {
      return [{ id: a.id, kind: 'point', mm: [toNiivueMm(imageToPatient(a.plane, g.position))] }];
    }
    let pts: readonly Point[] = [];
    if (g.type === 'polygon' || g.type === 'polyline') pts = g.points;
    else if (g.type === 'circle') {
      pts = Array.from({ length: 32 }, (_, i) => ({
        x: g.center.x + g.radius * Math.cos((i / 32) * 2 * Math.PI),
        y: g.center.y + g.radius * Math.sin((i / 32) * 2 * Math.PI),
      }));
    } else if (g.type === 'rectangle') {
      pts = [
        g.origin,
        { x: g.origin.x + g.width, y: g.origin.y },
        { x: g.origin.x + g.width, y: g.origin.y + g.height },
        { x: g.origin.x, y: g.origin.y + g.height },
      ];
    }
    return pts.length
      ? [{ id: a.id, kind: 'outline', mm: pts.map((p) => toNiivueMm(imageToPatient(a.plane, p))) }]
      : [];
  });
}

/** Re-project every 3D overlay vertex; returns [vertices projected, ms]. */
function reproject3D(): [number, number] {
  const t0 = performance.now();
  const dpr = nv.canvas ? nv.canvas.width / nv.canvas.clientWidth : 1;
  let n = 0;
  const parts: string[] = [];
  for (const p of projected) {
    const screen: [number, number][] = [];
    for (const mm of p.mm) {
      const s = nv.mmToRenderCanvas(mm);
      n++;
      if (s) screen.push([s[0] / dpr, s[1] / dpr]);
    }
    if (p.kind === 'point' && screen[0]) {
      parts.push(
        `<circle cx="${screen[0][0]}" cy="${screen[0][1]}" r="4" fill="none" stroke="#ffd400" stroke-width="2"/>`,
      );
    } else if (screen.length > 1) {
      parts.push(
        `<polygon points="${screen.map((s) => s.join(',')).join(' ')}" fill="none" stroke="#ffd400" stroke-width="1.5"/>`,
      );
    }
  }
  svg.innerHTML = parts.join('');
  return [n, performance.now() - t0];
}

// ── setup / experiments ─────────────────────────────────────────────────

async function setup(): Promise<Record<string, unknown>> {
  const mem0 = await uaMemory();
  built = buildVolume();
  const g = built.volume.grid;
  const grid = document.getElementById('grid')!;
  // Niivue cell first (top-left).
  const nvHost = document.createElement('div');
  nvHost.className = 'cell';
  grid.appendChild(nvHost);
  const canvas = document.createElement('canvas');
  canvas.style.width = '512px';
  canvas.style.height = '512px';
  nvHost.appendChild(canvas);
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '512');
  svg.setAttribute('height', '512');
  svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
  nvHost.appendChild(svg);

  for (const k of KINDS2D) {
    const el = document.createElement('div');
    el.className = 'cell';
    grid.appendChild(el);
    const c = await createCell(k, planeFor(g, k), el, 'canvas');
    cells.set(k, c);
    await renderPlane(c, built.volume, 'cpu', lut, WINDOW, {});
  }
  for (const k of KINDS2D) {
    const c = cell(k);
    providers.set(
      k,
      composeProviders([
        createReferenceLineProvider(
          () => c.frame,
          () =>
            KINDS2D.filter((o) => o !== k).map((o) => ({
              key: o,
              plane: cell(o).frame,
              color: COLORS[o]!,
            })),
        ),
        createCrossViewProvider(
          () => c.frame,
          () => annotations.filter((a) => !isSamePlane(a.plane, c.frame)),
          {
            line: { stroke: '#ffd400', strokeWidth: 2 },
            marker: { color: '#ffd400', fontSize: 18 },
          },
        ),
      ]),
    );
  }
  let n = 1;
  const now = new Date().toISOString();
  for (const s of seedAnnotations(g)) {
    annotations.push({ id: createAnnotationId(`s${n++}`), ...s, createdAt: now, updatedAt: now });
  }
  refresh2D();
  const contexts2D = contexts.live();
  const mem1 = await uaMemory();

  // ── Niivue ──
  const t0 = performance.now();
  nv = new NiiVue({ backgroundColor: [0, 0, 0, 1], isDragDropEnabled: false, logLevel: 'error' });
  await nv.attachToCanvas(canvas);
  const t1 = performance.now();
  const [nx, ny, nz] = g.dimensions;
  const skeleton = createStreamingNVImage({
    shape: [nx, ny, nz],
    spacing: [g.spacing[0], g.spacing[1], g.spacing[2]],
    datatypeCode: NiiDataType.DT_INT16,
    calMin: -100,
    calMax: 1100,
    name: 'phantom',
  });
  const image = nii2volume(skeleton.hdr, built.voxels, 'phantom');
  const tNii = performance.now();
  image.calMin = -100;
  image.calMax = 1100;
  await nv.addVolume(image);
  nv.sliceType = SLICE_TYPE.RENDER;
  nv.drawScene();
  await nextFrame();
  await nextFrame();
  const t2 = performance.now();
  const held = nv.volumes[0]?.img ?? null;
  const mem2 = await uaMemory();
  build3DOverlayModel();
  await nextFrame();
  const [vertices, projMs] = reproject3D();
  return {
    dims: g.dimensions,
    volumeBytes: built.buffer.byteLength,
    niivue: {
      version: '1.0.0-rc.37',
      attachMs: t1 - t0,
      nii2volumeMs: tNii - t1,
      addVolumeAndFirstFramesMs: t2 - tNii,
      imgIsOurArray: held === built.voxels,
      imgSharesOurBuffer: held !== null && held.buffer === built.buffer,
      imgType: held ? held.constructor.name : null,
      imgBufferIsShared: held !== null && held.buffer instanceof SharedArrayBuffer,
    },
    contexts: {
      before3D: contexts2D,
      created: contexts.created(),
      live: contexts.live(),
      lost: contexts.lost(),
      byKind: contexts.byKind(),
    },
    uaMemory: { start: mem0, after2DCells: mem1, afterNiivue: mem2 },
    overlay3D: { annotations: projected.length, vertices, firstProjectionMs: projMs },
  };
}

/** Rotate the 3D view; re-project the overlay after each frame. */
async function rotate(frames: number): Promise<Record<string, unknown>> {
  const stamps: number[] = [];
  const draw: number[] = [];
  const proj: number[] = [];
  let missing = 0;
  for (let f = 0; f < frames; f++) {
    stamps.push(await nextFrame());
    const t0 = performance.now();
    nv.azimuth = (nv.azimuth + 3) % 360;
    nv.drawScene();
    draw.push(performance.now() - t0);
    const [n, ms] = reproject3D();
    proj.push(ms);
    if (n === 0) missing++;
  }
  stamps.push(await nextFrame());
  const span = stamps[stamps.length - 1]! - stamps[0]!;
  const intervals = stamps.slice(1).map((s, i) => s - stamps[i]!);
  return {
    frames,
    fps: (frames / span) * 1000,
    frameMs: stats(intervals),
    drawSceneCallMs: stats(draw),
    reprojectMs: stats(proj),
    framesWithoutProjection: missing,
  };
}

/**
 * One label map for both renderers: a LabelVolume whose slices are views over
 * Niivue's drawing bitmap. Paint a blob from the osdlabel axial view; it is
 * then (a) resliced into the 2D cells and (b) uploaded to Niivue.
 */
async function sharedLabels(): Promise<Record<string, unknown>> {
  const g = built.volume.grid;
  const [nx, ny, nz] = g.dimensions;
  const memBefore = await uaMemory();
  const t0 = performance.now();
  nv.createEmptyDrawing();
  const tCreate = performance.now() - t0;
  const dv = nv.drawingVolume;
  const bitmap = dv?.img ?? null;
  const per = nx * ny;
  const ok = bitmap instanceof Uint8Array && bitmap.length === per * nz;
  if (!ok || !bitmap) {
    return {
      ok: false,
      reason: 'drawing bitmap not a Uint8Array of nVox',
      type: bitmap?.constructor.name,
    };
  }
  const slices: Uint8Array[] = [];
  for (let k = 0; k < nz; k++) slices.push(bitmap.subarray(k * per, (k + 1) * per));
  labels = { grid: g, slices };
  // A roughly spherical lesion painted slice by slice from the axial view,
  // centred off-axis so it shows in all three 2D views.
  const cx = nx * 0.42;
  const cy = ny * 0.5;
  const ck = Math.floor(nz / 2);
  const rMm = 12;
  const tPaint = performance.now();
  let voxels = 0;
  for (let dk = -10; dk <= 10; dk++) {
    const zMm = dk * g.spacing[2];
    if (Math.abs(zMm) >= rMm) continue;
    const rPx = Math.sqrt(rMm * rMm - zMm * zMm) / g.spacing[0];
    voxels += paintDisc(labels, orthogonalPlane(g, 'axial', ck + dk), { x: cx, y: cy }, rPx, 1);
  }
  const paintMs = performance.now() - tPaint;
  // Same buffer: Niivue sees the voxels without any copy; upload on refresh.
  const sameBuffer = nv.drawingVolume?.img === bitmap;
  const tRefresh = performance.now();
  nv.refreshDrawing();
  nv.drawScene();
  await nextFrame();
  await nextFrame();
  const refreshMs = performance.now() - tRefresh;
  // 2D: put the slices through the blob and composite the label map.
  for (const c of cells.values()) {
    c.frame =
      c.key === 'axial'
        ? orthogonalPlane(g, 'axial', ck)
        : c.key === 'coronal'
          ? orthogonalPlane(g, 'coronal', Math.round(cy))
          : orthogonalPlane(g, 'sagittal', Math.round(cx));
    await renderPlane(c, built.volume, 'cpu', lut, WINDOW, {});
  }
  const tTint = performance.now();
  for (const c of cells.values()) tintLabels(c);
  const tintMs = (performance.now() - tTint) / cells.size;
  refresh2D();
  await nextFrame();
  const memAfter = await uaMemory();
  return {
    ok: true,
    createEmptyDrawingMs: tCreate,
    bitmapBytes: bitmap.byteLength,
    paintedVoxels: voxels,
    paintMs,
    niivueStillHoldsSameBitmap: sameBuffer,
    refreshAndTwoFramesMs: refreshMs,
    tint2DPerCellMs: tintMs,
    uaMemoryDeltaBytes: memBefore !== null && memAfter !== null ? memAfter - memBefore : null,
  };
}

/**
 * Accuracy of the 3D overlay: compare where `mmToRenderCanvas` puts the
 * lesion centre with the centroid of the rendered lesion's red pixels, read
 * back from Niivue's canvas right after a synchronous draw.
 */
async function overlayAccuracy(): Promise<Record<string, unknown>> {
  const g = built.volume.grid;
  const [nx, ny, nz] = g.dimensions;
  const centre = imageToPatient(orthogonalPlane(g, 'axial', Math.floor(nz / 2)), {
    x: nx * 0.42,
    y: ny * 0.5,
  });
  const results: Record<string, unknown>[] = [];
  // Isolate the lesion: hide the volume, the orientation cube and the red
  // crosshair so the only red pixels left are the drawing.
  await nv.setVolume(0, { opacity: 0 });
  nv.isOrientCubeVisible = false;
  nv.crosshairWidth = 0;
  for (const az of [30, 110, 200, 290]) {
    nv.azimuth = az;
    nv.drawScene();
    await nextFrame();
    nv.drawScene();
    const c = nv.canvas!;
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const px = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    let sx = 0;
    let sy = 0;
    let n = 0;
    let nonBlack = 0;
    for (let y = 0; y < tmp.height; y++) {
      for (let x = 0; x < tmp.width; x++) {
        const o = (y * tmp.width + x) * 4;
        const r = px[o]!;
        const gg = px[o + 1]!;
        const b = px[o + 2]!;
        if (r + gg + b > 30) nonBlack++;
        if (r > 120 && r > 2 * gg && r > 2 * b) {
          sx += x;
          sy += y;
          n++;
        }
      }
    }
    const proj = nv.mmToRenderCanvas(toNiivueMm(centre));
    const centroid = n ? [sx / n, sy / n] : null;
    results.push({
      azimuth: az,
      redPixels: n,
      nonBlackPixels: nonBlack,
      centroid,
      projected: proj,
      errorPx: centroid && proj ? Math.hypot(centroid[0]! - proj[0], centroid[1]! - proj[1]) : null,
    });
  }
  await nv.setVolume(0, { opacity: 1 });
  nv.isOrientCubeVisible = true;
  nv.crosshairWidth = 1;
  nv.drawScene();
  return { centrePatientMm: centre, results };
}

declare global {
  interface Window {
    __poc: Record<string, (...args: never[]) => unknown>;
  }
}

window.__poc = {
  setup,
  rotate: (frames: number) => rotate(frames),
  sharedLabels,
  overlayAccuracy,
  contexts: () => ({
    created: contexts.created(),
    live: contexts.live(),
    lost: contexts.lost(),
    byKind: contexts.byKind(),
  }),
  uaMemory,
};
document.documentElement.dataset.ready = '1';
