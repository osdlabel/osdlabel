import { describe, it, expect } from 'vitest';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createAnnotationId } from '@osdlabel/annotation';
import {
  BoundedDenseMaskBuffer,
  rasterPixelCount,
  stampCircle,
  strokeSegment,
  type MaskRaster,
} from '@osdlabel/mask';
import { SegmentationBrushTool } from '../../../src/tools/segmentation-brush-tool.js';
import type { BrushStrokeCommit } from '../../../src/tools/segmentation-brush-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks } from '../../../src/tools/base-tool.js';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

/**
 * The plan's progressive-painting simulation for step 6: random lesions painted
 * stroke by stroke through the real tool, under a cap that makes it coarsen
 * part-way, against the same strokes rasterized at full resolution and
 * sampled once at the final downsample. Coarsening on overflow must lose no
 * more than that one-shot sampling does: pooled Dice within 0.001 of it at
 * every d up to 16, a median absolute area error of at most 0.1%, and no
 * lesion lost at d up to 8.
 */

const IMAGE = { width: 8192, height: 8192 } as const;
const imageId = createImageId('slide');
const contextId = createAnnotationContextId('ctx');

/** A small seeded PRNG, so the simulation is the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stroke {
  readonly radius: number;
  readonly points: readonly { x: number; y: number }[];
}

/**
 * A lesion: a few fat strokes wandering around a centre, `scale` times the
 * base size. The base spans 350–550 image pixels; scaled with the target
 * downsample, every lesion spans a comparable number of cells at its final
 * grid — 100 to 300 — as the CAMELYON16 lesions the bounds come from do.
 * Left at the base size, a lesion at d=16 spans 20–35 cells, and one-shot
 * sampling itself misses the area bound there.
 */
function lesion(random: () => number, scale: number): Stroke[] {
  const reach = 450 * scale;
  const cx = reach + 200 + random() * (IMAGE.width - 2 * reach - 400);
  const cy = reach + 200 + random() * (IMAGE.height - 2 * reach - 400);
  const strokes: Stroke[] = [];
  const count = 3 + Math.floor(random() * 4);
  for (let s = 0; s < count; s++) {
    const radius = (40 + random() * 80) * scale;
    let x = cx + (random() - 0.5) * 300 * scale;
    let y = cy + (random() - 0.5) * 300 * scale;
    const points = [{ x, y }];
    const steps = 3 + Math.floor(random() * 4);
    for (let i = 0; i < steps; i++) {
      x = Math.min(cx + reach, Math.max(cx - reach, x + (random() - 0.5) * 240 * scale));
      y = Math.min(cy + reach, Math.max(cy - reach, y + (random() - 0.5) * 240 * scale));
      points.push({ x, y });
    }
    strokes.push({ radius, points });
  }
  return strokes;
}

/** The strokes at full resolution, with no cap that matters. */
function groundTruth(strokes: readonly Stroke[]): BoundedDenseMaskBuffer {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: IMAGE.width, imageHeight: IMAGE.height });
  for (const { radius, points } of strokes) {
    stampCircle(buffer, points[0]!.x, points[0]!.y, radius, 1);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      strokeSegment(buffer, a.x, a.y, b.x, b.y, radius, 1);
    }
  }
  return buffer;
}

/** The strokes painted through the tool under `maxPixels`, coarsening up to 16. */
function paintProgressively(strokes: readonly Stroke[], maxPixels: number): MaskRaster | null {
  let radius = 1;
  let committed: BrushStrokeCommit | null = null;
  const refused: unknown[] = [];
  const objects: unknown[] = [];
  const canvas = {
    add: (...added: unknown[]) => objects.push(...added),
    remove: () => {},
    getObjects: () => [],
    getActiveObjects: () => [],
    discardActiveObject: () => {},
    bringObjectToFront: () => {},
    requestRenderAll: () => {},
    // A whole-slide view: no finer grid is shown, so nothing re-grids.
    getZoom: () => 1 / 32,
  };
  const tool = new SegmentationBrushTool({
    getBrushRadius: () => radius,
    getImageSize: () => IMAGE,
    getTarget: () =>
      committed
        ? { annotationId: createAnnotationId('lesion'), snapshot: committed.snapshot }
        : null,
    onCommit: (commit) => {
      committed = commit;
    },
    onCapacityExceeded: (error) => refused.push(error),
    maxPixels,
    getMaxDownsample: () => 16,
  });
  const callbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: (type: string) => ({ type }),
    canAddAnnotation: () => true,
  } as unknown as ToolCallbacks;
  tool.activate(
    { canvas } as unknown as ToolOverlay,
    imageId,
    callbacks,
    createTestKeyboardShortcuts(),
  );
  for (const stroke of strokes) {
    radius = stroke.radius;
    const [first, ...rest] = stroke.points;
    tool.onPointerDown({} as PointerEvent, first!);
    for (const point of rest) tool.onPointerMove({} as PointerEvent, point);
    tool.onPointerUp({} as PointerEvent, rest.at(-1) ?? first!);
  }
  expect(refused).toEqual([]);
  return (committed as BrushStrokeCommit | null)?.snapshot ?? null;
}

/** Level-0 pixels of `truth` inside the set cells of `raster`, a row of a span at a time. */
function overlap(raster: MaskRaster, truth: BoundedDenseMaskBuffer): number {
  const d = raster.downsample;
  let count = 0;
  let row = new Uint8Array(0);
  raster.forEachSpan((cy, x0, x1) => {
    const left = x0 * d;
    const right = Math.min(x1 * d, IMAGE.width);
    if (row.length < right - left) row = new Uint8Array(right - left);
    const bottom = Math.min((cy + 1) * d, IMAGE.height);
    for (let y = cy * d; y < bottom; y++) {
      truth.copyRow(y, left, right, row);
      for (let i = 0; i < right - left; i++) count += row[i]!;
    }
  });
  return count;
}

/** `truth` sampled once at each cell's centre at `d`: the one-shot reference. */
function centreSampled(truth: BoundedDenseMaskBuffer, d: number): MaskRaster {
  const box = truth.raster().cells;
  const sampled = new BoundedDenseMaskBuffer({
    imageWidth: IMAGE.width,
    imageHeight: IMAGE.height,
    downsample: d,
  });
  for (let cy = Math.floor(box.y / d); cy * d < box.y + box.height; cy++) {
    for (let cx = Math.floor(box.x / d); cx * d < box.x + box.width; cx++) {
      const x = Math.min(Math.floor((cx + 0.5) * d), IMAGE.width - 1);
      const y = Math.min(Math.floor((cy + 0.5) * d), IMAGE.height - 1);
      if (truth.get(x, y)) sampled.set(cx, cy, 1);
    }
  }
  return sampled.raster();
}

interface Bucket {
  dice: { twice: number; total: number };
  oneShot: { twice: number; total: number };
  areaErrors: number[];
  lost: number;
}

describe('coarsening on overflow, painted progressively', () => {
  it('loses no more than sampling once at the final downsample', { timeout: 120_000 }, () => {
    const random = mulberry32(0xc0a25e);
    const buckets = new Map<number, Bucket>();
    for (const target of [2, 4, 8, 16]) {
      for (let trial = 0; trial < 10; trial++) {
        const strokes = lesion(random, Math.max(1, target / 4));
        const truth = groundTruth(strokes);
        const box = truth.raster().cells;
        // A cap a little above the lesion's box at `target`, so it must
        // coarsen to about there, and well under it at half that.
        const cells = Math.ceil(box.width / target + 2) * Math.ceil(box.height / target + 2);
        const painted = paintProgressively(strokes, Math.ceil(cells * 1.3));
        const d = painted?.downsample ?? 1;
        const bucket = buckets.get(d) ?? {
          dice: { twice: 0, total: 0 },
          oneShot: { twice: 0, total: 0 },
          areaErrors: [],
          lost: 0,
        };
        buckets.set(d, bucket);
        const truthArea = truth.cellCount;
        if (!painted || painted.cellCount === 0) {
          bucket.lost++;
          continue;
        }
        const area = rasterPixelCount(painted);
        bucket.dice.twice += 2 * overlap(painted, truth);
        bucket.dice.total += area + truthArea;
        const oneShot = centreSampled(truth, d);
        bucket.oneShot.twice += 2 * overlap(oneShot, truth);
        bucket.oneShot.total += rasterPixelCount(oneShot) + truthArea;
        bucket.areaErrors.push(Math.abs(area - truthArea) / truthArea);
      }
    }

    // Every target was reached: the simulation covers d = 2 through 16.
    expect([...buckets.keys()].sort((a, b) => a - b)).toEqual([2, 4, 8, 16]);
    for (const [d, bucket] of buckets) {
      const dice = bucket.dice.twice / bucket.dice.total;
      const oneShot = bucket.oneShot.twice / bucket.oneShot.total;
      const errors = [...bucket.areaErrors].sort((a, b) => a - b);
      const median = errors[Math.floor(errors.length / 2)]!;
      expect(dice, `pooled Dice at d=${d}`).toBeGreaterThanOrEqual(oneShot - 0.001);
      expect(median, `median area error at d=${d}`).toBeLessThanOrEqual(0.001);
      if (d <= 8) expect(bucket.lost, `lesions lost at d=${d}`).toBe(0);
    }
  });
});
