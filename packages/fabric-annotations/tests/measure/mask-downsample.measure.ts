/**
 * Measures what a mask `downsample` buys on the case that motivated it: a
 * SAM-like prediction made at overview zoom on a whole-slide image, whose
 * level-0 bounding box is ~34x the 64 Mi-pixel mask cap.
 *
 * Not a unit test: it prints a report. Run it with
 *
 *   pnpm --filter @osdlabel/fabric-annotations measure:mask-downsample
 *
 * after `pnpm build` (it imports the built `@osdlabel/mask`).
 *
 * The synthetic prediction is a 256x160 binary raster (MobileSAM's low-res
 * mask grid is 256x256; the SAM prototype's overview raster was 256x160) of
 * one irregular blob with 4 holes plus 14 separate islands — 15 rings, 4
 * holes, the topology the prototype's polygon fallback lost. It is placed on
 * a 60000x44000 image so that its level-0 box is 56000x40600 px.
 */
import { describe, it, expect } from 'vitest';
import { Point, util, type FabricImage } from 'fabric';
import { MASK_RAW_FORMAT, createAnnotationId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  chooseMaskDownsample,
  cocoRleCodec,
  decodeCanonical,
  encodeCanonical,
  isCocoInteropSafe,
  maskGridSize,
  snapshotCellCount,
  snapshotImageBox,
  snapshotPixelCount,
  type MaskSnapshot,
} from '@osdlabel/mask';
import { buildMaskFabricObject } from '../../src/mask-fabric-object.js';
import { initFabricModule } from '../../src/fabric-module.js';
import { SegmentationBrushTool } from '../../src/tools/segmentation-brush-tool.js';
import type { BrushStrokeCommit } from '../../src/tools/segmentation-brush-tool.js';
import type { ToolOverlay } from '../../src/types.js';
import type { ToolCallbacks } from '../../src/tools/base-tool.js';
import { createTestKeyboardShortcuts } from '../unit/test-helpers.js';

initFabricModule();

// ── The synthetic prediction ───────────────────────────────────────────────

const RASTER_W = 256;
const RASTER_H = 160;
const IMAGE_W = 60_000;
const IMAGE_H = 44_000;
/** Where the model's raster frame sits on the image, in image pixels. */
const FRAME = { x: 2000, y: 1700, width: 56_000, height: 40_600 } as const;
const CELL_W = FRAME.width / RASTER_W; // 218.75 image px per raster px
const CELL_H = FRAME.height / RASTER_H; // 253.75

function makeRaster(): Uint8Array {
  const raster = new Uint8Array(RASTER_W * RASTER_H);
  const set = (u: number, v: number, value: 0 | 1) => {
    if (u >= 0 && v >= 0 && u < RASTER_W && v < RASTER_H) raster[v * RASTER_W + u] = value;
  };
  // Main blob: a wobbly star-ish outline around the frame centre.
  for (let v = 0; v < RASTER_H; v++) {
    for (let u = 0; u < RASTER_W; u++) {
      const dx = u + 0.5 - 128;
      const dy = v + 0.5 - 80;
      const theta = Math.atan2(dy, dx);
      const r =
        48 + 12 * Math.sin(3 * theta) + 7 * Math.sin(5 * theta + 1) + 4 * Math.sin(9 * theta + 2);
      if (Math.hypot(dx, dy) <= r) set(u, v, 1);
    }
  }
  const ellipse = (cu: number, cv: number, ru: number, rv: number, value: 0 | 1) => {
    for (let v = Math.floor(cv - rv - 1); v <= cv + rv + 1; v++) {
      for (let u = Math.floor(cu - ru - 1); u <= cu + ru + 1; u++) {
        const nx = (u + 0.5 - cu) / ru;
        const ny = (v + 0.5 - cv) / rv;
        if (nx * nx + ny * ny <= 1) set(u, v, value);
      }
    }
  };
  // Four holes, well inside the blob.
  ellipse(116, 76, 5, 3, 0);
  ellipse(140, 86, 4, 5, 0);
  ellipse(126, 92, 3, 3, 0);
  ellipse(134, 70, 5, 2.5, 0);
  // Fourteen islands; four of them touch the frame's edges, so the mask's box
  // is the whole frame, as the prototype's overview masks' were.
  const islands: readonly (readonly [number, number, number])[] = [
    [1.5, 20, 3], // left edge
    [254.5, 140, 3], // right edge
    [40, 1.5, 2.5], // top edge
    [210, 158.5, 2.5], // bottom edge
    [20, 70, 4],
    [30, 130, 3],
    [60, 150, 2.5],
    [100, 152, 2],
    [170, 6, 3],
    [222, 30, 4],
    [238, 80, 3.5],
    [228, 112, 2.5],
    [12, 100, 2],
    [80, 10, 3],
  ];
  for (const [cu, cv, r] of islands) ellipse(cu, cv, r, r, 1);
  return raster;
}

/**
 * Foreground components (8-connected) and holes — background components
 * (4-connected, the dual) that do not reach the box edge, where the
 * background outside the box joins them.
 */
function topology(
  width: number,
  height: number,
  isSet: (i: number) => boolean,
): { rings: number; holes: number; labels: Int32Array } {
  const labels = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  let rings = 0;
  let holes = 0;
  let next = 1;
  for (let start = 0; start < width * height; start++) {
    if (labels[start] !== 0) continue;
    const fg = isSet(start);
    const label = next++;
    labels[start] = fg ? label : -label;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    let touchesEdge = false;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % width;
      const y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!fg && dx !== 0 && dy !== 0) continue; // background is 4-connected
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (labels[j] !== 0 || isSet(j) !== fg) continue;
          labels[j] = fg ? label : -label;
          queue[tail++] = j;
        }
      }
    }
    if (fg) rings++;
    else if (!touchesEdge) holes++;
  }
  return { rings, holes, labels };
}

// Raster index of an image-space point; -1 outside the frame.
const rasterU = (x: number) => Math.floor((x - FRAME.x) / CELL_W);
const rasterV = (y: number) => Math.floor((y - FRAME.y) / CELL_H);
function rasterAt(raster: Uint8Array, u: number, v: number): 0 | 1 {
  if (u < 0 || v < 0 || u >= RASTER_W || v >= RASTER_H) return 0;
  return raster[v * RASTER_W + u] === 1 ? 1 : 0;
}

/**
 * Commits the raster as a mask at `downsample`: each cell takes the raster
 * value under its centre (nearest-neighbour, as a raster->snapshot commit
 * does), over the cells that cover the frame.
 */
function rasterToSnapshot(raster: Uint8Array, downsample: number): MaskSnapshot {
  const grid = maskGridSize(IMAGE_W, IMAGE_H, downsample);
  const left = Math.floor(FRAME.x / downsample);
  const top = Math.floor(FRAME.y / downsample);
  const right = Math.min(grid.width, Math.ceil((FRAME.x + FRAME.width) / downsample));
  const bottom = Math.min(grid.height, Math.ceil((FRAME.y + FRAME.height) / downsample));
  const width = right - left;
  const height = bottom - top;
  const data = new Uint8Array(width * height);
  const columnU = new Int32Array(width);
  for (let col = 0; col < width; col++) {
    columnU[col] = rasterU((left + col + 0.5) * downsample);
  }
  for (let row = 0; row < height; row++) {
    const v = rasterV((top + row + 0.5) * downsample);
    if (v < 0 || v >= RASTER_H) continue;
    const offset = row * width;
    for (let col = 0; col < width; col++) {
      if (rasterAt(raster, columnU[col]!, v) === 1) data[offset + col] = 1;
    }
  }
  const loose: MaskSnapshot = {
    x: left,
    y: top,
    width,
    height,
    data,
    imageWidth: IMAGE_W,
    imageHeight: IMAGE_H,
    ...(downsample !== 1 ? { downsample } : {}),
  };
  // Through the buffer, which crops to the tight box — the commit path.
  return BoundedDenseMaskBuffer.fromSnapshot(loose).snapshot();
}

/** Image columns (or rows) grouped by (level-0 raster index, cell raster index). */
function axisGroups(
  start: number,
  end: number,
  downsample: number,
  toRaster: (p: number) => number,
): Map<string, { a: number; b: number; count: number }> {
  const groups = new Map<string, { a: number; b: number; count: number }>();
  for (let p = start; p < end; p++) {
    const a = toRaster(p + 0.5); // level-0 pixel centre
    const b = toRaster((Math.floor(p / downsample) + 0.5) * downsample); // its cell's centre
    const key = `${a},${b}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { a, b, count: 1 });
  }
  return groups;
}

const median = (values: number[]) => [...values].sort((x, y) => x - y)[values.length >> 1]!;
function timed<T>(reps: number, run: () => T): { ms: number; value: T } {
  let value = run(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    value = run();
    times.push(performance.now() - t0);
  }
  return { ms: median(times), value };
}

function varintBytes(n: number): number {
  let bytes = 1;
  while (n >= 128) {
    n = Math.floor(n / 128);
    bytes++;
  }
  return bytes;
}

/**
 * Level-0 agreement between the mask stored at `downsample` and the exact
 * level-0 rasterization of the same raster, without materialising either:
 * image columns (and rows) are grouped by the raster index of the pixel and
 * of its cell, and each pair of groups is one block of identical answers.
 */
function fidelity(raster: Uint8Array, downsample: number) {
  const cols = axisGroups(
    FRAME.x - downsample,
    FRAME.x + FRAME.width + downsample,
    downsample,
    rasterU,
  );
  const rows = axisGroups(
    FRAME.y - downsample,
    FRAME.y + FRAME.height + downsample,
    downsample,
    rasterV,
  );
  let intersection = 0;
  let union = 0;
  let level0Area = 0;
  let cellArea = 0;
  for (const c of cols.values()) {
    for (const r of rows.values()) {
      const fine = rasterAt(raster, c.a, r.a);
      const coarse = rasterAt(raster, c.b, r.b);
      const n = c.count * r.count;
      if (fine) level0Area += n;
      if (coarse) cellArea += n;
      if (fine && coarse) intersection += n;
      if (fine || coarse) union += n;
    }
  }
  return { intersection, union, level0Area, cellArea };
}

// ── The brush on the same image ────────────────────────────────────────────

function brushHarness(viewport: { zoom: number; width: number; height: number } | null) {
  const commits: BrushStrokeCommit[] = [];
  const capacity: MaskCapacityExceededError[] = [];
  const canvas = {
    add: () => {},
    remove: () => {},
    getObjects: () => [],
    getActiveObjects: () => [],
    discardActiveObject: () => {},
    bringObjectToFront: () => {},
    requestRenderAll: () => {},
    ...(viewport
      ? {
          viewportTransform: [viewport.zoom, 0, 0, viewport.zoom, 0, 0],
          getWidth: () => viewport.width,
          getHeight: () => viewport.height,
        }
      : {}),
  };
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => createAnnotationContextId('ctx'),
    getToolConstraint: (type) => ({ type }),
    canAddAnnotation: () => true,
    addAnnotation: () => {},
    updateAnnotation: () => {},
    deleteAnnotation: () => {},
    setSelectedAnnotation: () => {},
    getAnnotation: () => undefined,
  };
  const tool = new SegmentationBrushTool({
    getBrushRadius: () => 200,
    getImageSize: () => ({ width: IMAGE_W, height: IMAGE_H }),
    getTarget: () => null,
    onCommit: (commit) => commits.push(commit),
    onCapacityExceeded: (error) => capacity.push(error),
  });
  tool.activate(
    { canvas } as unknown as ToolOverlay,
    createImageId('wsi'),
    callbacks,
    createTestKeyboardShortcuts(),
  );
  return { tool, commits, capacity };
}

/** Traces a circle of `radius` image px around (cx, cy) in `steps` moves. */
function traceCircle(
  tool: SegmentationBrushTool,
  cx: number,
  cy: number,
  radius: number,
  steps: number,
): void {
  tool.onPointerDown({ altKey: false } as PointerEvent, { x: cx + radius, y: cy });
  for (let i = 1; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    tool.onPointerMove({} as PointerEvent, {
      x: cx + radius * Math.cos(t),
      y: cy + radius * Math.sin(t),
    });
  }
  tool.onPointerUp({} as PointerEvent, { x: cx + radius, y: cy });
}

// ── The measurement ────────────────────────────────────────────────────────

describe('mask downsample measurement', () => {
  it('reports', () => {
    const out: Record<string, unknown> = {};
    const raster = makeRaster();
    const rasterTopology = topology(RASTER_W, RASTER_H, (i) => raster[i] === 1);
    out.raster = {
      size: `${RASTER_W}x${RASTER_H}`,
      rings: rasterTopology.rings,
      holes: rasterTopology.holes,
    };
    expect(rasterTopology.rings).toBe(15);
    expect(rasterTopology.holes).toBe(4);

    // Level 0: what the mask would have to be without a downsample.
    const level0Box = FRAME.width * FRAME.height;
    out.level0 = {
      box: `${FRAME.width}x${FRAME.height}`,
      boxPixels: level0Box,
      timesCap: +(level0Box / DEFAULT_MAX_MASK_PIXELS).toFixed(2),
    };
    let forcedError: unknown = null;
    try {
      new BoundedDenseMaskBuffer({ imageWidth: IMAGE_W, imageHeight: IMAGE_H }).reserve(FRAME);
    } catch (error) {
      forcedError = error;
    }
    expect(forcedError).toBeInstanceOf(MaskCapacityExceededError);
    out.forcedDownsample1 = {
      throws: (forcedError as Error).name,
      requestedPixels: (forcedError as MaskCapacityExceededError).requestedPixels,
      maxPixels: (forcedError as MaskCapacityExceededError).maxPixels,
    };

    // The canonical RLE the level-0 mask *would* encode to, computed row by
    // row without materialising it: the wire format is not what fails.
    {
      const columnRuns: { u: number; count: number }[] = [];
      for (let x = FRAME.x; x < FRAME.x + FRAME.width; x++) {
        const u = rasterU(x + 0.5);
        const last = columnRuns[columnRuns.length - 1];
        if (last && last.u === u) last.count++;
        else columnRuns.push({ u, count: 1 });
      }
      let value = 0;
      let length = 0;
      let runs = 0;
      let bytes = 0;
      let area = 0;
      const flush = () => {
        runs++;
        bytes += varintBytes(length);
      };
      for (let y = FRAME.y; y < FRAME.y + FRAME.height; y++) {
        const v = rasterV(y + 0.5);
        for (const { u, count } of columnRuns) {
          const pixel = rasterAt(raster, u, v);
          if (pixel === 1) area += count;
          if (pixel === value) length += count;
          else {
            flush();
            value = pixel;
            length = count;
          }
        }
      }
      flush();
      out.level0Rle = {
        runs,
        bytes,
        base64Chars: 4 * Math.ceil(bytes / 3),
        exactArea: area,
      };
    }

    // Commit at the finest downsample that fits.
    const downsample = chooseMaskDownsample(FRAME, IMAGE_W, IMAGE_H, DEFAULT_MAX_MASK_PIXELS);
    const commit = timed(3, () => rasterToSnapshot(raster, downsample));
    const snapshot = commit.value;
    const grid = `${snapshot.width}x${snapshot.height}`;
    const encode = timed(5, () => encodeCanonical(snapshot));
    const payload = encode.value;
    const decode = timed(5, () => decodeCanonical(payload));
    // By hand: vitest's deep equality walks a typed array through
    // `Object.entries`, which runs a 35 M-cell mask out of heap.
    const back = decode.value;
    expect([back.x, back.y, back.width, back.height, back.downsample]).toEqual([
      snapshot.x,
      snapshot.y,
      snapshot.width,
      snapshot.height,
      snapshot.downsample,
    ]);
    let mismatches = 0;
    for (let i = 0; i < snapshot.data.length; i++)
      if (back.data[i] !== snapshot.data[i]) mismatches++;
    expect(mismatches).toBe(0);
    const envelopeJson = JSON.stringify({ format: MASK_RAW_FORMAT, data: payload });

    // Areas: stored (exact image pixels its cells cover), the exact level-0
    // rasterization, and the continuous area the model raster describes.
    const storedArea = snapshotPixelCount(snapshot);
    const analyticArea = raster.reduce((sum, value) => sum + value, 0) * CELL_W * CELL_H; // continuous
    const { intersection, union, level0Area, cellArea } = fidelity(raster, downsample);
    expect(cellArea).toBe(storedArea);
    // Largest-ring polygon (the prototype's fallback), ideal: exact outline,
    // holes filled, the other rings dropped.
    let largestArea = 0;
    let largestHolesArea = 0;
    {
      // Recompute per-label level-0 areas.
      const colCount = new Map<number, number>();
      for (let x = FRAME.x; x < FRAME.x + FRAME.width; x++) {
        const u = rasterU(x + 0.5);
        colCount.set(u, (colCount.get(u) ?? 0) + 1);
      }
      const rowCount = new Map<number, number>();
      for (let y = FRAME.y; y < FRAME.y + FRAME.height; y++) {
        const v = rasterV(y + 0.5);
        rowCount.set(v, (rowCount.get(v) ?? 0) + 1);
      }
      const areaByLabel = new Map<number, number>();
      for (let v = 0; v < RASTER_H; v++) {
        for (let u = 0; u < RASTER_W; u++) {
          const label = rasterTopology.labels[v * RASTER_W + u]!;
          const n = (colCount.get(u) ?? 0) * (rowCount.get(v) ?? 0);
          areaByLabel.set(label, (areaByLabel.get(label) ?? 0) + n);
        }
      }
      let best = 0;
      for (const [label, area] of areaByLabel) {
        if (label > 0 && area > largestArea) {
          largestArea = area;
          best = label;
        }
      }
      // Holes inside the largest ring: background labels fully bordered by it.
      const holeLabels = new Set<number>();
      for (let v = 1; v < RASTER_H - 1; v++) {
        for (let u = 1; u < RASTER_W - 1; u++) {
          const label = rasterTopology.labels[v * RASTER_W + u]!;
          if (label >= 0) continue;
          const neighbours = [
            rasterTopology.labels[v * RASTER_W + u - 1]!,
            rasterTopology.labels[v * RASTER_W + u + 1]!,
            rasterTopology.labels[(v - 1) * RASTER_W + u]!,
            rasterTopology.labels[(v + 1) * RASTER_W + u]!,
          ];
          if (neighbours.some((n) => n === best)) holeLabels.add(label);
        }
      }
      // The outside background borders the blob too; keep only the enclosed
      // components, which never reach the raster's edge.
      for (let u = 0; u < RASTER_W; u++) {
        holeLabels.delete(rasterTopology.labels[u]!);
        holeLabels.delete(rasterTopology.labels[(RASTER_H - 1) * RASTER_W + u]!);
      }
      for (let v = 0; v < RASTER_H; v++) {
        holeLabels.delete(rasterTopology.labels[v * RASTER_W]!);
        holeLabels.delete(rasterTopology.labels[v * RASTER_W + RASTER_W - 1]!);
      }
      expect(holeLabels.size).toBe(rasterTopology.holes);
      for (const label of holeLabels) largestHolesArea += areaByLabel.get(label) ?? 0;
    }

    // Topology of what was stored.
    const stored = topology(snapshot.width, snapshot.height, (i) => snapshot.data[i] === 1);

    // Renderer: build the Fabric object and check where cell centres land.
    const build = timed(1, () =>
      buildMaskFabricObject(
        { format: MASK_RAW_FORMAT, data: { ...payload } },
        { id: createAnnotationId('sam-overview') },
      ),
    );
    const object = build.value as FabricImage;
    const matrix = object.calcTransformMatrix();
    let worst = 0;
    let sampled = 0;
    const stride = 37;
    for (let row = 0; row < snapshot.height; row += row + stride < snapshot.height ? stride : 1) {
      for (let col = 0; col < snapshot.width; col += col + stride < snapshot.width ? stride : 1) {
        const placed = util.transformPoint(
          new Point(col + 0.5 - snapshot.width / 2, row + 0.5 - snapshot.height / 2),
          matrix,
        );
        const expectedX = (snapshot.x + col + 0.5) * downsample;
        const expectedY = (snapshot.y + row + 0.5) * downsample;
        worst = Math.max(worst, Math.abs(placed.x - expectedX), Math.abs(placed.y - expectedY));
        sampled++;
      }
    }

    // COCO export at level 0 (the format has no downsample).
    const coco = timed(3, () => cocoRleCodec.encode(snapshot));

    const box = snapshotImageBox(snapshot);
    out.committed = {
      downsample,
      grid,
      gridCells: snapshot.width * snapshot.height,
      capFraction: +((snapshot.width * snapshot.height) / DEFAULT_MAX_MASK_PIXELS).toFixed(3),
      boxImagePx: box,
      setCells: snapshotCellCount(snapshot),
      rasterToSnapshotMs: +commit.ms.toFixed(1),
      canonical: {
        countsChars: payload.counts.length,
        envelopeJsonBytes: envelopeJson.length,
        encodeMs: +encode.ms.toFixed(1),
        decodeMs: +decode.ms.toFixed(1),
      },
      area: {
        stored: storedArea,
        exactLevel0Rasterization: level0Area,
        continuousModelRaster: analyticArea,
        storedVsLevel0: +((storedArea - level0Area) / level0Area).toExponential(3),
        storedVsContinuous: +((storedArea - analyticArea) / analyticArea).toExponential(3),
        iouVsLevel0: +(intersection / union).toFixed(6),
        symmetricDifferencePx: union - intersection,
      },
      topology: { rings: stored.rings, holes: stored.holes },
      renderer: {
        buildMs: +build.ms.toFixed(1),
        sampledCellCentres: sampled,
        maxPlacementErrorImagePx: worst,
        scaleX: object.scaleX,
        left: object.left,
        top: object.top,
      },
      cocoLevel0: {
        encodeMs: +coco.ms.toFixed(1),
        countsChars: coco.value.counts.length,
        interopSafe: isCocoInteropSafe(snapshot),
      },
    };
    out.polygonFallbackIdeal = {
      ringsKept: `1 of ${rasterTopology.rings}`,
      holesKept: `0 of ${rasterTopology.holes}`,
      area: largestArea + largestHolesArea,
      iouVsLevel0: +(largestArea / (level0Area + largestHolesArea)).toFixed(4),
      droppedRingAreaPx: level0Area - largestArea,
      filledHoleAreaPx: largestHolesArea,
      note: 'exact outline of the largest ring; the prototype traced and simplified it to 114 vertices',
    };
    // The same prediction stored at coarser grids: size against fidelity.
    // 16 is the first grid under iOS Safari's 16,777,216-pixel canvas-area
    // limit, which the renderer's one-pixel-per-cell canvas runs into; 256 is
    // about the model raster's own resolution (218.75 x 253.75 px per pixel).
    out.sweep = [downsample, 16, 32, 64, 128, 256].map((d) => {
      const s = rasterToSnapshot(raster, d);
      const enc = timed(3, () => encodeCanonical(s));
      const dec = timed(3, () => decodeCanonical(enc.value));
      const f = fidelity(raster, d);
      expect(f.cellArea).toBe(snapshotPixelCount(s));
      const t = topology(s.width, s.height, (i) => s.data[i] === 1);
      return {
        downsample: d,
        grid: `${s.width}x${s.height}`,
        cells: s.width * s.height,
        countsChars: enc.value.counts.length,
        encodeMs: +enc.ms.toFixed(1),
        decodeMs: +dec.ms.toFixed(1),
        iouVsLevel0: +(f.intersection / f.union).toFixed(5),
        areaVsLevel0: +((f.cellArea - f.level0Area) / f.level0Area).toExponential(2),
        rings: t.rings,
        holes: t.holes,
      };
    });
    expect(stored.rings).toBe(rasterTopology.rings);
    expect(stored.holes).toBe(rasterTopology.holes);
    expect(worst).toBeLessThan(1e-6);

    // The brush on the same image: trace a 12000 px-diameter outline (3 mm at
    // 0.25 um/px) with a 200 px brush.
    {
      const level0 = brushHarness(null);
      const t0 = performance.now();
      traceCircle(level0.tool, 20_000, 20_000, 6000, 240);
      const level0Ms = performance.now() - t0;
      // Zoom 0.1 on a 1600x1000 canvas: 16000x10000 image px in view.
      const zoomed = brushHarness({ zoom: 0.1, width: 1600, height: 1000 });
      const t1 = performance.now();
      traceCircle(zoomed.tool, 20_000, 20_000, 6000, 240);
      const zoomedMs = performance.now() - t1;
      const committedStroke = zoomed.commits[0]?.snapshot;
      out.brush = {
        stroke: 'circle, diameter 12000 image px, brush radius 200, 240 moves',
        withoutViewport: {
          downsample: 1,
          capacityErrors: level0.capacity.length,
          requestedPixels: level0.capacity[0]?.requestedPixels,
          commits: level0.commits.length,
          ms: +level0Ms.toFixed(0),
        },
        zoom0p1: {
          downsample: committedStroke?.downsample ?? 1,
          capacityErrors: zoomed.capacity.length,
          commits: zoomed.commits.length,
          grid: committedStroke ? `${committedStroke.width}x${committedStroke.height}` : null,
          boxImagePx: committedStroke ? snapshotImageBox(committedStroke) : null,
          ms: +zoomedMs.toFixed(0),
        },
      };
      expect(level0.capacity.length).toBe(1);
      expect(zoomed.commits.length).toBe(1);
    }

    // Straight to stdout: vitest captures `console` in a jsdom environment.
    (
      globalThis as unknown as { process: { stdout: { write(text: string): void } } }
    ).process.stdout.write(`\nMASK-DOWNSAMPLE-MEASUREMENT ${JSON.stringify(out, null, 2)}\n`);
  });
});
