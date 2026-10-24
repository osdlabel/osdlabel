/**
 * H1 model costs, measured in the page: the frame-axis model (ONE ImageId,
 * annotations carry `frame`) against the alternative (one ImageId per slice,
 * no `frame`, a series grouping kept by the host).
 *
 * Every number is the median of `reps` timed repetitions of one operation on
 * the same state, so it is the operation's own CPU cost, not a frame time:
 *
 * - `index`: what a cell does once per annotation change (frame-axis builds
 *   the per-frame bucket index; per-slice has nothing to build: `byImage`
 *   keyed by slice id already is the index).
 * - `step`: what a cell does per frame step to find the annotations to show
 *   (frame-axis: indexed lookup, or the naive filter without the index;
 *   per-slice: the slice's own bucket).
 * - `constraints`: one `computeConstraintStatus` (a toolbar recompute) with a
 *   per-slice limit — `'per-frame'` on the series vs `'per-image'` on the
 *   slice — and with a per-series limit — `'per-image'` on the series vs
 *   `'global'` over the series' 300 slice ids.
 * - `serialize` / `deserialize`: the whole document, with its JSON size.
 * - `reconcile`: re-deriving every `frame.index` from keys when the axis is
 *   loaded in reverse order (all move) or in the same order (none move).
 */
import type { AnnotationId } from '@osdlabel/annotation';
import type { AnnotationContext, ContextState } from '@osdlabel/annotation-context';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationState, ImageId } from '@osdlabel/viewer-api';
import { createImageId } from '@osdlabel/viewer-api';
import type { FrameAxis } from '@osdlabel/frame';
import { annotationsOnFrame, bucketByFrame, isOnFrame, reconcileFrameRefs } from '@osdlabel/frame';
import type { OsdAnnotation, OsdFields } from 'osdlabel';
import { computeConstraintStatus, deserialize, serialize } from 'osdlabel';
import { fixtureGeometry } from './annotations/fixtures.js';
import { buildAnnotation } from './annotations/layers.js';
import { lesionsOnSlice } from './data/ct-phantom.js';
import { roundDeep } from './instrument/stats.js';

export interface ModelBenchOptions {
  readonly frames: number;
  readonly perFrame: number;
  readonly reps?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median wall time of `fn` over `reps` runs (after one warm-up), in ms. */
function time(reps: number, fn: () => unknown): number {
  fn();
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

/** Median per-call time of `fn(i)` over every frame, repeated `reps` times, in µs. */
function timePerFrame(reps: number, frames: number, fn: (i: number) => unknown): number {
  let sink = 0;
  const ts: number[] = [];
  for (let r = 0; r <= reps; r++) {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      const out = fn(i);
      if (Array.isArray(out)) sink += out.length;
    }
    if (r > 0) ts.push(((performance.now() - t0) / frames) * 1000);
  }
  if (sink < 0) console.log(sink);
  return median(ts);
}

export function modelBench(opts: ModelBenchOptions): Record<string, unknown> {
  const reps = opts.reps ?? 15;
  const width = opts.width ?? 512;
  const height = opts.height ?? 512;
  const contextId = createAnnotationContextId('lesions');
  const series = createImageId('series');
  const sliceIds: ImageId[] = Array.from({ length: opts.frames }, (_, f) =>
    createImageId(`slice-${f}`),
  );
  const keys = Array.from({ length: opts.frames }, (_, f) => `1.2.826.0.1.3680043.2.1125.${f}`);

  const t0 = performance.now();
  const framed: AnnotationState<OsdFields> = { byImage: {}, changeCounter: 0 };
  const perSlice: AnnotationState<OsdFields> = { byImage: {}, changeCounter: 0 };
  const seriesBucket: Record<AnnotationId, OsdAnnotation> = {};
  framed.byImage[series] = seriesBucket;
  for (let f = 0; f < opts.frames; f++) {
    const specs = fixtureGeometry(
      f,
      opts.perFrame,
      width,
      height,
      lesionsOnSlice(f, opts.frames, width, height),
    );
    const sliceBucket: Record<AnnotationId, OsdAnnotation> = {};
    for (const spec of specs) {
      const a = buildAnnotation(spec, series, contextId, keys[f]);
      seriesBucket[a.id] = a;
      const { frame: _frame, ...rest } = a;
      sliceBucket[a.id] = { ...rest, imageId: sliceIds[f]! };
    }
    perSlice.byImage[sliceIds[f]!] = sliceBucket;
  }
  const buildMs = performance.now() - t0;
  const total = opts.frames * opts.perFrame;
  const all = Object.values(seriesBucket);

  // ── index + step ────────────────────────────────────────────────────────
  const indexMs = time(reps, () => bucketByFrame(Object.values(seriesBucket)));
  const buckets = bucketByFrame(all);
  const stepIndexedUs = timePerFrame(reps, opts.frames, (i) => annotationsOnFrame(buckets, i));
  const stepNaiveUs = timePerFrame(Math.min(reps, 5), opts.frames, (i) =>
    Object.values(seriesBucket).filter((a) => isOnFrame(a, i)),
  );
  const stepPerSliceUs = timePerFrame(reps, opts.frames, (i) =>
    Object.values(perSlice.byImage[sliceIds[i]!] ?? {}),
  );

  // ── constraints ─────────────────────────────────────────────────────────
  const ctxState = (ctx: AnnotationContext): ContextState => ({
    contexts: [ctx],
    activeContextId: ctx.id,
    displayedContextIds: [ctx.id],
  });
  const limit = (countScope: 'per-image' | 'per-frame' | 'global', imageIds?: ImageId[]) =>
    ctxState({
      id: contextId,
      label: 'Lesions',
      tools: [{ type: 'rectangle', maxCount: 5, countScope }],
      ...(imageIds ? { imageIds } : {}),
    });
  const mid = opts.frames >> 1;
  const constraints = {
    perSliceLimit: {
      frameAxisPerFrameMs: time(reps, () =>
        computeConstraintStatus(limit('per-frame'), framed, series, null, mid),
      ),
      // What 'per-frame' would cost counted from the bucket index the cell
      // already keeps (a production change the PoC does not make).
      frameAxisFromIndexMs: time(
        reps,
        () =>
          annotationsOnFrame(buckets, mid).filter(
            (a) => a.contextId === contextId && a.toolType === 'rectangle',
          ).length,
      ),
      perSlicePerImageMs: time(reps, () =>
        computeConstraintStatus(limit('per-image'), perSlice, sliceIds[mid]!, null),
      ),
    },
    perSeriesLimit: {
      frameAxisPerImageMs: time(reps, () =>
        computeConstraintStatus(limit('per-image'), framed, series, null, mid),
      ),
      perSliceGlobalOverSeriesMs: time(reps, () =>
        computeConstraintStatus(limit('global', sliceIds), perSlice, sliceIds[mid]!, null),
      ),
    },
  };

  // ── serialization ───────────────────────────────────────────────────────
  const docs = {
    frameAxis: JSON.stringify(serialize(framed)),
    perSlice: JSON.stringify(serialize(perSlice)),
  };
  const serialization = {
    frameAxis: {
      bytes: docs.frameAxis.length,
      serializeMs: time(Math.min(reps, 5), () => JSON.stringify(serialize(framed))),
      deserializeMs: time(Math.min(reps, 5), () => deserialize(JSON.parse(docs.frameAxis))),
    },
    perSlice: {
      bytes: docs.perSlice.length,
      serializeMs: time(Math.min(reps, 5), () => JSON.stringify(serialize(perSlice))),
      deserializeMs: time(Math.min(reps, 5), () => deserialize(JSON.parse(docs.perSlice))),
    },
  };
  const roundTrip = deserialize(JSON.parse(docs.frameAxis)).byImage[series] ?? {};
  const framesKept = Object.values(roundTrip).every((a) => a.frame !== undefined);

  // ── reconcile ───────────────────────────────────────────────────────────
  const sameAxis: FrameAxis = { kind: 'spatial', count: opts.frames, keys };
  const reversedAxis: FrameAxis = {
    kind: 'spatial',
    count: opts.frames,
    keys: [...keys].reverse(),
  };
  const reversed = reconcileFrameRefs(all, reversedAxis);
  const same = reconcileFrameRefs(all, sameAxis);
  const reconcile = {
    reversedMs: time(reps, () => reconcileFrameRefs(all, reversedAxis)),
    reversedMoved: reversed.moved,
    sameOrderMs: time(reps, () => reconcileFrameRefs(all, sameAxis)),
    sameOrderMoved: same.moved,
    sameOrderIdentityKept: same.annotations.every((a, i) => a === all[i]),
  };

  return roundDeep({
    frames: opts.frames,
    perFrame: opts.perFrame,
    annotations: total,
    reps,
    buildMs,
    indexMs,
    stepUs: {
      frameAxisIndexed: stepIndexedUs,
      frameAxisNaiveFilter: stepNaiveUs,
      perSlice: stepPerSliceUs,
    },
    constraints,
    serialization,
    serializationKeepsFrames: framesKept,
    reconcile,
  });
}
