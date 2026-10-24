/**
 * H1 / H2 micro-benchmarks, no OpenSeadragon: reslice cost per method and
 * orientation (CPU main thread, CPU worker pool on the shared volume, WebGL2
 * 3D texture in three formats), GPU-vs-CPU agreement, and the 3D label-map
 * comparison (dense label volume vs per-slice @osdlabel/mask buffers).
 *
 * Driven by scripts/run.mjs through `window.__poc`; every function returns
 * plain JSON.
 */
import { planeIndexMapping, type PlaneFrame } from '@osdlabel/spatial';
import {
  allocateLabelVolume,
  applyWindowLut,
  buildWindowLut,
  paintDisc,
  reslice,
  resliceLabels,
  SliceMaskStack,
  type Interpolation,
  type LabelVolume,
} from '@osdlabel/volume';
import { GlReslicer, type GlTextureFormat } from './gl-reslicer.js';
import { planeFor, type PlaneKind } from './planes.js';
import { ReslicePool } from './reslice-pool.js';
import {
  buildVolume,
  installContextCounter,
  stats,
  uaMemory,
  type BuiltVolume,
  type Stats,
} from './volume-setup.js';

const contexts = installContextCounter();
const KINDS: readonly PlaneKind[] = ['axial', 'coronal', 'sagittal', 'oblique'];
const WINDOW = { center: 40, width: 400 } as const;

let built: BuiltVolume | null = null;
const vol = (): BuiltVolume => {
  if (!built) throw new Error('call build() first');
  return built;
};

function time(fn: () => void, reps: number, warmup = 3): Stats {
  for (let i = 0; i < warmup; i++) fn();
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return stats(out);
}

async function timeAsync(fn: () => Promise<void>, reps: number, warmup = 3): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn();
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    out.push(performance.now() - t0);
  }
  return stats(out);
}

function size(f: PlaneFrame): string {
  return `${f.width}x${f.height}`;
}

async function build(): Promise<Record<string, unknown>> {
  const before = await uaMemory();
  built = buildVolume();
  const after = await uaMemory();
  return {
    dims: built.volume.grid.dimensions,
    spacing: built.volume.grid.spacing,
    bytes: built.buffer.byteLength,
    allocMs: built.allocMs,
    fillMs: built.fillMs,
    crossOriginIsolated,
    uaMemoryBefore: before,
    uaMemoryAfter: after,
  };
}

/** CPU reslice on the main thread, per orientation and interpolation. */
function cpu(reps: number): Record<string, unknown>[] {
  const { volume } = vol();
  const grid = volume.grid;
  const rows: Record<string, unknown>[] = [];
  const lut = buildWindowLut(WINDOW.center, WINDOW.width);
  for (const kind of KINDS) {
    for (const interpolation of ['linear', 'nearest'] as const satisfies readonly Interpolation[]) {
      const f = planeFor(grid, kind);
      const m = planeIndexMapping(grid, f);
      const out = new Int16Array(f.width * f.height);
      let path = '';
      const s = time(() => {
        path = reslice(volume, m, f.width, f.height, out, { interpolation });
      }, reps);
      rows.push({ method: 'cpu-main', kind, interpolation, size: size(f), path, ...s });
    }
  }
  // Display conversion costs for one 512x512 plane.
  const f = planeFor(grid, 'axial');
  const src = new Int16Array(f.width * f.height);
  reslice(volume, planeIndexMapping(grid, f), f.width, f.height, src);
  const img = new ImageData(f.width, f.height);
  const u32 = new Uint32Array(img.data.buffer);
  rows.push({
    method: 'window-lut',
    kind: 'axial',
    size: size(f),
    ...time(() => applyWindowLut(src, lut, u32), reps),
  });
  const canvas = document.createElement('canvas');
  canvas.width = f.width;
  canvas.height = f.height;
  const ctx = canvas.getContext('2d')!;
  rows.push({
    method: 'putImageData',
    kind: 'axial',
    size: size(f),
    ...time(() => ctx.putImageData(img, 0, 0), reps),
  });
  return rows;
}

/** CPU reslice split across N workers that share the volume buffer. */
async function workers(sizes: readonly number[], reps: number): Promise<Record<string, unknown>[]> {
  const { volume, buffer } = vol();
  const grid = volume.grid;
  const rows: Record<string, unknown>[] = [];
  for (const n of sizes) {
    const pool = new ReslicePool(n, grid, buffer);
    const tReady = performance.now();
    await pool.ready;
    const readyMs = performance.now() - tReady;
    for (const kind of KINDS) {
      const f = planeFor(grid, kind);
      const m = planeIndexMapping(grid, f);
      const out = new SharedArrayBuffer(f.width * f.height * 2);
      const s = await timeAsync(() => pool.run(m, f.width, f.height, out, 'linear'), reps);
      // Agreement with the main-thread result.
      const ref = new Int16Array(f.width * f.height);
      reslice(volume, m, f.width, f.height, ref);
      const got = new Int16Array(out);
      let mismatches = 0;
      for (let i = 0; i < ref.length; i++) if (ref[i] !== got[i]) mismatches++;
      rows.push({
        method: `cpu-workers-${n}`,
        kind,
        interpolation: 'linear',
        size: size(f),
        poolReadyMs: readyMs,
        mismatches,
        ...s,
      });
    }
    pool.terminate();
  }
  return rows;
}

let gl: GlReslicer | null = null;

/** Upload the volume to a 3D texture in `format`, then time every orientation. */
function glRun(format: GlTextureFormat, reps: number): Record<string, unknown> {
  const { volume } = vol();
  const grid = volume.grid;
  gl ??= new GlReslicer(1024, 1024);
  const upload = gl.upload(volume, format);
  const rows: Record<string, unknown>[] = [];
  if (!upload.error) {
    const lut = buildWindowLut(WINDOW.center, WINDOW.width);
    for (const kind of KINDS) {
      const f = planeFor(grid, kind);
      const m = planeIndexMapping(grid, f);
      const g = gl;
      const submit = time(
        () => g.render(m, f.width, f.height, WINDOW.center, WINDOW.width, false),
        reps,
      );
      g.finish();
      const drawFinish = time(() => {
        g.render(m, f.width, f.height, WINDOW.center, WINDOW.width, false);
        g.finish();
      }, reps);
      const rgba = new Uint8Array(f.width * f.height * 4);
      const drawRead = time(() => {
        g.render(m, f.width, f.height, WINDOW.center, WINDOW.width, false);
        g.readPixels(f.width, f.height, rgba);
      }, reps);
      // Readback alone (the draw above already completed): separates the
      // copy-out from the shading in draw+readPixels.
      const readOnly = time(() => g.readPixels(f.width, f.height, rgba), reps);
      // Into a 2D canvas the way an OSD tile would consume it.
      const tile = document.createElement('canvas');
      tile.width = f.width;
      tile.height = f.height;
      const tctx = tile.getContext('2d')!;
      const drawBlit = time(() => {
        g.render(m, f.width, f.height, WINDOW.center, WINDOW.width, true);
        tctx.drawImage(g.canvas, 0, 0, f.width, f.height, 0, 0, f.width, f.height);
        tctx.getImageData(0, 0, 1, 1); // force the copy to complete
      }, reps);
      // Agreement with CPU reslice + LUT, in grey levels.
      g.render(m, f.width, f.height, WINDOW.center, WINDOW.width, false);
      g.readPixels(f.width, f.height, rgba);
      const ref = new Int16Array(f.width * f.height);
      reslice(volume, m, f.width, f.height, ref);
      const refRgba = new Uint32Array(f.width * f.height);
      applyWindowLut(ref, lut, refRgba);
      let maxDiff = 0;
      let over1 = 0;
      for (let i = 0; i < ref.length; i++) {
        const d = Math.abs((refRgba[i]! & 0xff) - rgba[i * 4]!);
        if (d > maxDiff) maxDiff = d;
        if (d > 1) over1++;
      }
      rows.push({
        method: `webgl2-${format}`,
        kind,
        size: size(f),
        submit,
        drawFinish,
        drawReadPixels: drawRead,
        readPixelsOnly: readOnly,
        drawImageToCanvas: drawBlit,
        maxGreyDiffVsCpu: maxDiff,
        fractionDiffOver1: over1 / ref.length,
      });
    }
  }
  return {
    upload,
    info: gl.info(),
    rows,
    contextsCreated: contexts.created(),
    contextsLost: contexts.lost(),
  };
}

function glDispose(): void {
  gl?.dispose();
}

/**
 * H2 label maps. A stroke is `stamps` brush discs of `radius` px along a
 * line; paint it on each view into both representations, then reslice both
 * for display in every view. Memory is the bytes each representation holds.
 */
function labels(stamps: number, radius: number, reps: number): Record<string, unknown> {
  const grid = vol().volume.grid;
  const rows: Record<string, unknown>[] = [];
  const tAlloc = performance.now();
  const dense: LabelVolume = allocateLabelVolume(grid);
  const denseAllocMs = performance.now() - tAlloc;
  const stack = new SliceMaskStack(grid);
  for (const kind of KINDS) {
    const f = planeFor(grid, kind);
    const strokeAt = (rep: number, i: number) => ({
      x: f.width * 0.3 + (i / stamps) * f.width * 0.4,
      y: f.height * 0.35 + rep * 2,
    });
    const denseMs: number[] = [];
    const stackMs: number[] = [];
    for (let rep = 0; rep < reps; rep++) {
      let t0 = performance.now();
      for (let i = 0; i < stamps; i++) paintDisc(dense, f, strokeAt(rep, i), radius, 1);
      denseMs.push((performance.now() - t0) / stamps);
      t0 = performance.now();
      for (let i = 0; i < stamps; i++) stack.paintDisc(f, strokeAt(rep, i), radius);
      stackMs.push((performance.now() - t0) / stamps);
    }
    rows.push({ op: 'paint-stamp', kind, radius, representation: 'dense', ...stats(denseMs) });
    rows.push({
      op: 'paint-stamp',
      kind,
      radius,
      representation: 'slice-masks',
      ...stats(stackMs),
    });
  }
  // Agreement: identical voxel sets after all strokes.
  let mismatches = 0;
  let painted = 0;
  const nx = grid.dimensions[0];
  for (let k = 0; k < grid.dimensions[2]; k++) {
    const m = stack.masks.get(k);
    const s = dense.slices[k]!;
    for (let o = 0; o < s.length; o++) {
      const a = s[o]!;
      if (a) painted++;
      const b = m ? m.get(o % nx, Math.floor(o / nx)) : 0;
      if (a !== b) mismatches++;
    }
  }
  // Display: reslice each representation into every view.
  for (const kind of KINDS) {
    const f = planeFor(grid, kind);
    const m = planeIndexMapping(grid, f);
    const out = new Uint8Array(f.width * f.height);
    rows.push({
      op: 'reslice-for-display',
      kind,
      representation: 'dense',
      ...time(() => resliceLabels(dense, m, f.width, f.height, out), reps),
    });
    rows.push({
      op: 'reslice-for-display',
      kind,
      representation: 'slice-masks',
      ...time(() => stack.reslice(m, f.width, f.height, out), reps),
    });
  }
  const denseBytes = dense.slices.reduce((n, s) => n + s.byteLength, 0);
  return {
    rows,
    stamps,
    radius,
    paintedVoxels: painted,
    voxelMismatches: mismatches,
    memory: {
      denseBytes,
      denseAllocMs,
      sliceMaskBytes: stack.byteLength(),
      sliceMasksAllocated: stack.masks.size,
      bitPackedDenseBytes: Math.ceil(denseBytes / 8),
    },
  };
}

declare global {
  interface Window {
    __poc: Record<string, (...args: never[]) => unknown>;
  }
}

window.__poc = {
  build,
  cpu: (reps: number) => cpu(reps),
  workers: (sizes: readonly number[], reps: number) => workers(sizes, reps),
  gl: (format: GlTextureFormat, reps: number) => glRun(format, reps),
  glDispose,
  labels: (stamps: number, radius: number, reps: number) => labels(stamps, radius, reps),
  contexts: () => ({
    created: contexts.created(),
    lost: contexts.lost(),
    byKind: contexts.byKind(),
  }),
  uaMemory,
};
document.documentElement.dataset.ready = '1';
