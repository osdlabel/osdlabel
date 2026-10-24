/**
 * H1 / H2 micro-benchmarks, no OpenSeadragon: reslice cost per method and
 * orientation (CPU main thread, CPU worker pool on the shared volume, WebGL2
 * 3D texture in three formats), GPU-vs-CPU agreement, and the 3D label-map
 * comparison (dense label volume vs per-slice @osdlabel/mask buffers).
 *
 * Driven by scripts/run.mjs through `window.__poc`; every function returns
 * plain JSON.
 */
import { planeIndexMapping, type PlaneFrame, type Point2 } from '@osdlabel/spatial';
import {
  allocateLabelVolume,
  applyWindowLut,
  BrickedLabelVolume,
  buildWindowLut,
  fillDisc,
  paintDisc,
  permuteVolume,
  reslice,
  SAGITTAL_MAJOR,
  resliceLabels,
  volumeByteLength,
  type Interpolation,
  type LabelVolume,
} from '@osdlabel/volume';
import { installGlMemoryTracker } from './gl-memory.js';
import { GlReslicer, type GlTextureFormat } from './gl-reslicer.js';
import { obliquePlane, planeFor, type PlaneKind } from './planes.js';
import { ReslicePool } from './reslice-pool.js';
import { SliceMaskStack } from './slice-mask-stack.js';
import {
  buildVolume,
  installContextCounter,
  stats,
  uaMemory,
  type BuiltVolume,
  type Stats,
} from './volume-setup.js';

const contexts = installContextCounter();
const glMemory = installGlMemoryTracker();
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
  // Scrolling: a different plane every rep (cold-ish caches), slice-major vs
  // a sagittal-major copy of the same volume for the sagittal view, in
  // alternating order. The copy costs the volume's bytes again.
  const tCopy = performance.now();
  const transposed = permuteVolume(volume, SAGITTAL_MAJOR);
  const copyMs = performance.now() - tCopy;
  const [nx, ny, nz] = grid.dimensions;
  const scrollFrame = (kind: PlaneKind, r: number): PlaneFrame => {
    const n = kind === 'axial' ? nz : kind === 'coronal' ? ny : nx;
    return kind === 'oblique'
      ? obliquePlane(grid, 30, 20 + r)
      : planeFor(grid, kind, Math.floor(n / 4) + ((r * 7) % Math.floor(n / 2)));
  };
  const scrollSamples = new Map<string, number[]>();
  const add = (key: string, v: number): void => {
    const a = scrollSamples.get(key);
    if (a) a.push(v);
    else scrollSamples.set(key, [v]);
  };
  const sizes = new Map<string, string>();
  for (let r = -3; r < reps; r++) {
    for (const kind of KINDS) {
      const f = scrollFrame(kind, r);
      const out = new Int16Array(f.width * f.height);
      const variants: [string, () => void][] = [
        [
          'slice-major',
          () => void reslice(volume, planeIndexMapping(grid, f), f.width, f.height, out),
        ],
      ];
      if (kind === 'sagittal') {
        variants.push([
          'sagittal-major-copy',
          () =>
            void reslice(transposed, planeIndexMapping(transposed.grid, f), f.width, f.height, out),
        ]);
      }
      for (const [name, fn] of rotated(variants, r < 0 ? 0 : r)) {
        const t0 = performance.now();
        fn();
        if (r >= 0) add(`${kind}|${name}`, performance.now() - t0);
        sizes.set(`${kind}|${name}`, size(f));
      }
    }
  }
  for (const [key, samples] of scrollSamples) {
    const [kind, storage] = key.split('|') as [string, string];
    rows.push({
      method: storage === 'slice-major' ? 'cpu-main-scroll' : 'cpu-main-scroll-sagittal-copy',
      kind,
      interpolation: 'linear',
      size: sizes.get(key),
      storage,
      ...stats(samples),
      ...(storage === 'slice-major' ? {} : { copyMs, copyBytes: volumeByteLength(transposed) }),
    });
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
  const glMemoryAfterUpload = glMemory.snapshot();
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
    glMemoryAfterUpload,
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
 * H2 label maps: a dense uint8 volume against one @osdlabel/mask buffer per
 * axial slice. A stroke is `stamps` brush discs of `radius` px along a line on
 * one view; one sample is that stroke's time divided by `stamps`.
 *
 * Fairness rules (from the review of the first version):
 * - Both representations are painted through the SAME voxel enumerator:
 *   `voxel` visits voxels one by one (dense `paintDisc` vs mask `set`), `span`
 *   visits row runs (dense `fill` vs mask `reserve` + `set`). The mask
 *   package's own `stampCircle` (axial only) is reported separately.
 * - Steady state ("warm") pre-touches the dense buffer, so first-touch page
 *   faults are not billed to whichever representation runs first, and paints
 *   `warmup` untimed strokes per view into both before timing.
 * - Every rep rotates the view sequence and alternates which representation
 *   (and which algorithm) goes first.
 * - First-stroke ("cold") cost is measured separately on fresh structures: a
 *   freshly allocated (lazily committed) dense buffer against an empty stack.
 * - Display reslices hoist the per-slice lookup in both representations, and
 *   time the dense map both committed (written everywhere, e.g. loaded from
 *   a file) and lazily committed (fresh, only painted pages touched).
 */
type LabelAlgorithm = 'voxel' | 'span';
type Representation = 'dense' | 'slice-masks' | 'bricked';
const ALGORITHMS: readonly LabelAlgorithm[] = ['voxel', 'span'];

function rotated<T>(xs: readonly T[], by: number): T[] {
  return xs.map((_, i) => xs[(i + by) % xs.length]!);
}

function labels(
  stamps: number,
  radius: number,
  reps: number,
  coldTrials: number,
  warmup = 4,
): Record<string, unknown> {
  const grid = vol().volume.grid;
  const frames = new Map<PlaneKind, PlaneFrame>(KINDS.map((k) => [k, planeFor(grid, k)]));
  const frameOf = (k: PlaneKind): PlaneFrame => frames.get(k)!;
  const strokeAt = (f: PlaneFrame, pos: number, i: number): Point2 => ({
    x: f.width * 0.3 + (i / stamps) * f.width * 0.4,
    y: f.height * 0.35 + pos * 2,
  });
  interface Pair {
    readonly dense: LabelVolume;
    readonly stack: SliceMaskStack;
    /** Sparse 32^3 bricks, painted through the span enumerator only. */
    readonly bricked: BrickedLabelVolume;
  }
  const paint = (
    alg: LabelAlgorithm,
    rep: Representation,
    pair: Pair,
    f: PlaneFrame,
    c: Point2,
  ): void => {
    if (rep === 'bricked') {
      pair.bricked.fillDisc(f, c, radius, 1);
    } else if (rep === 'dense') {
      if (alg === 'voxel') paintDisc(pair.dense, f, c, radius, 1);
      else fillDisc(pair.dense, f, c, radius, 1);
    } else if (alg === 'voxel') pair.stack.paintDiscVoxels(f, c, radius);
    else pair.stack.paintDiscSpans(f, c, radius);
  };
  const stroke = (
    alg: LabelAlgorithm,
    rep: Representation,
    pair: Pair,
    f: PlaneFrame,
    pos: number,
  ): number => {
    const t0 = performance.now();
    for (let i = 0; i < stamps; i++) paint(alg, rep, pair, f, strokeAt(f, pos, i));
    return (performance.now() - t0) / stamps;
  };
  // Bricks are compared through the span enumerator only (their natural writer).
  const repsFor = (alg: LabelAlgorithm): readonly Representation[] =>
    alg === 'span' ? ['dense', 'slice-masks', 'bricked'] : ['dense', 'slice-masks'];
  const orderOf = (alg: LabelAlgorithm, t: number): Representation[] =>
    rotated(repsFor(alg), t >> 1);
  const newPair = (dense: LabelVolume): Pair => ({
    dense,
    stack: new SliceMaskStack(grid),
    bricked: new BrickedLabelVolume(grid),
  });
  const rows: Record<string, unknown>[] = [];

  // ── cold: the first stroke into fresh structures ──
  const cold = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, key: string, v: number): void => {
    const a = m.get(key);
    if (a) a.push(v);
    else m.set(key, [v]);
  };
  const tCold = performance.now();
  for (let t = 0; t < coldTrials; t++) {
    for (const kind of rotated(KINDS, t)) {
      for (const alg of t % 2 ? [...ALGORITHMS].reverse() : ALGORITHMS) {
        const fresh: Pair = newPair(allocateLabelVolume(grid));
        for (const rep of orderOf(alg, t)) {
          push(cold, `${kind}|${alg}|${rep}`, stroke(alg, rep, fresh, frameOf(kind), 0));
        }
      }
    }
  }
  const coldWallMs = performance.now() - tCold;

  // ── warm: pre-touched dense, warmed-up masks, alternating order ──
  const tTouch = performance.now();
  const pairs = new Map<LabelAlgorithm, Pair>();
  for (const alg of ALGORITHMS) {
    const dense = allocateLabelVolume(grid);
    for (const sl of dense.slices) {
      sl.fill(1);
      sl.fill(0);
    }
    pairs.set(alg, newPair(dense));
  }
  const pretouchMs = performance.now() - tTouch;
  for (const alg of ALGORITHMS)
    for (const kind of KINDS)
      for (let pos = 0; pos < warmup; pos++)
        for (const rep of repsFor(alg)) stroke(alg, rep, pairs.get(alg)!, frameOf(kind), pos);
  const warm = new Map<string, number[]>();
  for (let r = 0; r < reps; r++) {
    const pos = warmup + r;
    for (const kind of rotated(KINDS, r)) {
      for (const alg of r % 2 ? [...ALGORITHMS].reverse() : ALGORITHMS) {
        for (const rep of orderOf(alg, r)) {
          push(
            warm,
            `${kind}|${alg}|${rep}`,
            stroke(alg, rep, pairs.get(alg)!, frameOf(kind), pos),
          );
        }
      }
    }
  }
  for (const kind of KINDS)
    for (const alg of ALGORITHMS)
      for (const rep of repsFor(alg)) {
        rows.push({
          op: 'paint-stamp',
          state: 'warm',
          kind,
          algorithm: alg,
          representation: rep,
          radius,
          ...stats(warm.get(`${kind}|${alg}|${rep}`)!),
        });
        rows.push({
          op: 'paint-stamp',
          state: 'cold',
          kind,
          algorithm: alg,
          representation: rep,
          radius,
          ...stats(cold.get(`${kind}|${alg}|${rep}`)!),
        });
      }

  // ── library reference: @osdlabel/mask's stampCircle on the axial view ──
  {
    const f = frameOf('axial');
    const pair = pairs.get('span')!;
    const lib: number[] = [];
    const dense: number[] = [];
    for (let r = 0; r < reps; r++) {
      const pos = warmup + reps + r;
      const runLib = (): void => {
        const t0 = performance.now();
        for (let i = 0; i < stamps; i++) pair.stack.paintDisc(f, strokeAt(f, pos, i), radius);
        lib.push((performance.now() - t0) / stamps);
      };
      const runDense = (): void => {
        dense.push(stroke('span', 'dense', pair, f, pos));
      };
      if (r % 2) {
        runDense();
        runLib();
      } else {
        runLib();
        runDense();
      }
      // Untimed: keep the bricked map holding the span pair's voxels.
      for (let i = 0; i < stamps; i++) pair.bricked.fillDisc(f, strokeAt(f, pos, i), radius, 1);
    }
    rows.push({
      op: 'paint-stamp',
      state: 'warm',
      kind: 'axial',
      algorithm: 'mask-stampCircle',
      representation: 'slice-masks',
      radius,
      ...stats(lib),
    });
    rows.push({
      op: 'paint-stamp',
      state: 'warm',
      kind: 'axial',
      algorithm: 'span (paired with stampCircle)',
      representation: 'dense',
      radius,
      ...stats(dense),
    });
  }

  // ── agreement: every representation and algorithm holds the same voxels ──
  const nx = grid.dimensions[0];
  let mismatches = 0;
  let brickMismatches = 0;
  let painted = 0;
  const a = pairs.get('voxel')!;
  const b = pairs.get('span')!;
  for (let k = 0; k < grid.dimensions[2]; k++) {
    const sv = a.dense.slices[k]!;
    const ss = b.dense.slices[k]!;
    const mv = a.stack.masks.get(k);
    const ms = b.stack.masks.get(k);
    for (let o = 0; o < sv.length; o++) {
      const v = sv[o]!;
      if (v) painted++;
      const i = o % nx;
      const j = (o - i) / nx;
      // The stampCircle reference strokes went into the span pair only, at
      // positions no other stroke used, so compare those rows by span pair.
      if (ss[o] !== (ms ? ms.get(i, j) : 0)) mismatches++;
      if (ss[o] !== b.bricked.get(i, j, k)) brickMismatches++;
      if (v !== (mv ? mv.get(i, j) : 0)) mismatches++;
    }
  }
  // Voxel vs span enumerators: same strokes before the reference block.
  let algorithmMismatches = 0;
  {
    const ref = allocateLabelVolume(grid);
    const viaVoxel = allocateLabelVolume(grid);
    for (const kind of KINDS)
      for (let pos = 0; pos < warmup + reps; pos++)
        for (let i = 0; i < stamps; i++) {
          const f = frameOf(kind);
          fillDisc(ref, f, strokeAt(f, pos, i), radius, 1);
          paintDisc(viaVoxel, f, strokeAt(f, pos, i), radius, 1);
        }
    for (let k = 0; k < grid.dimensions[2]; k++) {
      const x = ref.slices[k]!;
      const y = viaVoxel.slices[k]!;
      for (let o = 0; o < x.length; o++) if (x[o] !== y[o]) algorithmMismatches++;
    }
  }

  // ── display: nearest reslice into every view, alternating order ──
  // `lazy` is a fresh dense map holding the same voxels as the span pair,
  // written only where painted, so its untouched pages are still unmapped.
  const lazy = allocateLabelVolume(grid);
  for (let k = 0; k < grid.dimensions[2]; k++) {
    const m = b.stack.masks.get(k);
    if (!m) continue;
    const bd = m.bounds;
    const sl = lazy.slices[k]!;
    for (let j = bd.y; j < bd.y + bd.height; j++)
      for (let i = bd.x; i < bd.x + bd.width; i++) if (m.get(i, j)) sl[j * nx + i] = 1;
  }
  for (const kind of KINDS) {
    const f = frameOf(kind);
    const m = planeIndexMapping(grid, f);
    const out = new Uint8Array(f.width * f.height);
    const variants: readonly [string, () => void][] = [
      ['dense', () => resliceLabels(b.dense, m, f.width, f.height, out)],
      ['dense-lazily-committed', () => resliceLabels(lazy, m, f.width, f.height, out)],
      ['slice-masks', () => b.stack.reslice(m, f.width, f.height, out)],
      ['bricked', () => b.bricked.reslice(m, f.width, f.height, out)],
    ];
    for (const [, fn] of variants) for (let w = 0; w < 3; w++) fn();
    const samples = new Map<string, number[]>();
    for (let r = 0; r < reps; r++) {
      for (const [name, fn] of rotated(variants, r)) {
        const t0 = performance.now();
        fn();
        push(samples, name, performance.now() - t0);
      }
    }
    for (const [name] of variants) {
      rows.push({
        op: 'reslice-for-display',
        kind,
        representation: name,
        size: size(f),
        ...stats(samples.get(name)!),
      });
    }
  }
  const denseBytes = b.dense.slices.reduce((n, sl) => n + sl.byteLength, 0);
  return {
    rows,
    stamps,
    radius,
    reps,
    coldTrials,
    warmup,
    coldWallMs,
    pretouchMs,
    paintedVoxels: painted,
    voxelMismatches: mismatches,
    brickMismatches,
    algorithmMismatches,
    memory: {
      denseBytes,
      sliceMaskBytesVoxel: a.stack.byteLength(),
      sliceMaskBytesSpan: b.stack.byteLength(),
      sliceMasksAllocated: b.stack.masks.size,
      brickedBytes: b.bricked.byteLength(),
      bricksAllocated: b.bricked.allocatedBricks(),
      brickSlots: b.bricked.bricks.length,
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
  labels: (stamps: number, radius: number, reps: number, coldTrials: number) =>
    labels(stamps, radius, reps, coldTrials),
  contexts: () => ({
    created: contexts.created(),
    lost: contexts.lost(),
    byKind: contexts.byKind(),
  }),
  uaMemory,
  glMemory: () => glMemory.snapshot(),
};
document.documentElement.dataset.ready = '1';
